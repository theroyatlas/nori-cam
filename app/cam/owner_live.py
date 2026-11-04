"""Persistent owner-only local Live runner. No key/provider access unless serve --live."""
import argparse
import hashlib
import html
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from . import local_e2e as r
from .owner_budget import Ledger
from .owner_core import Core
from .owner_status import hud
from .ui_local_e2e import multipart_evidence

SHARED_BUDGET = Path.home() / '.nori-cam' / 'owner-live' / 'budget.sqlite'
PLAN = {"mode":"LIVE only on serve --live", "started":False,"bind":"127.0.0.1", "default_port":8807,
        "clock":"normal wall clock; no fixture/seed/clock injection", "aggregate_ceiling_usd":20,
        "budget_file":str(SHARED_BUDGET), "keys":"inherited MODEL_API_KEY or --key-file (plain UTF-8 / JSON MODEL_API_KEY); memory only",
        "models":{"Spark":"muse-spark-1.3 high, max16384 output","Image":"muse-image-1.0 max4096 output","Wonder":"muse-wonder-1.0 high max16384 output"},
        "limits":"one Spark/Image attempted call per gift; one Wonder per first actual photo-gift experience; no retries;180s/request;10min/event",
        "cost_limit":"local shared reservation/accounting guard, NOT provider hard billing cap"}


def load_key(file=None):
    # Called only by explicit authorized serve. Never call during plan/tests/probes.
    value=Path(file).read_text(encoding='utf-8').strip() if file else os.environ.get('MODEL_API_KEY','').strip()
    if value.startswith('{'):
        value=json.loads(value).get('MODEL_API_KEY','')
    if not isinstance(value,str) or len(value)<8 or len(value)>4096 or any(c.isspace() for c in value):
        raise SystemExit('valid key delivery required; value is never displayed')
    return value


def private_value(path):
    if path.exists():return path.read_text().strip()
    value=secrets.token_urlsafe(32)
    path.write_text(value,encoding='utf-8')
    try:path.chmod(0o600)
    except OSError:pass
    return value


def config_for(state, owner, token, assets_dir=None):
    return {"name":"nori-owner-live-local","main":str(r.ROOT/'app/cam/owner_worker.ts'),"compatibility_date":"2026-10-01",
        "assets":{"directory":str(assets_dir or r.SITE/'public'),"binding":"ASSETS","run_worker_first":["/api/*","/media/*"]},
        "d1_databases":[{"binding":"DB","database_name":"nori-owner-live-local","database_id":"00000000-0000-0000-0000-000000000038","migrations_dir":str(r.SITE/'migrations')}],
        "kv_namespaces":[{"binding":"MEDIA","id":"00000000000000000000000000000038"}],
        "vars":{"CAM_LOCAL_PIPELINE":"1","CAM_LOCAL_WALL_CLOCK":"1","CAM_OWNER_LIVE":"1",
            "CAM_SPARK_ENABLED":"0","CAM_BROWSE_ENABLED":"0","CAM_REFLECT_ENABLED":"0",
            "CAM_DAILY_USD":"20","CAM_WONDER_MAX_USD":"2","MODEL_API_BASE":"http://127.0.0.1:9",
            "MODEL_API_KEY":"keyless-local-dispatch-sentinel","MEDIA_UPLOAD_TOKEN":token,
            "OWNER_CODE_SHA256":hashlib.sha256(owner.encode()).hexdigest()}}


def make_server(core, owner, stop, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass  # no URLs, headers, photo text, codes or keys in access logs.
        def reply(self, status, body, mime='application/json', extra=()):
            if isinstance(body,str):body=body.encode()
            self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            for key,value in extra:self.send_header(key,value)
            self.end_headers();self.wfile.write(body)
        def authorized(self):
            try:
                cookie=SimpleCookie(self.headers.get('Cookie',''));value=cookie.get('nori_owner')
                return value is not None and secrets.compare_digest(value.value,owner)
            except Exception:return False
        def body(self, maximum=6*1024*1024):
            size=int(self.headers.get('Content-Length','0'))
            if size<0 or size>maximum:raise ValueError('bounded body')
            return self.rfile.read(size)
        def do_GET(self): self.route()
        def do_POST(self): self.route()
        def route(self):
            if self.headers.get('Host') != f'127.0.0.1:{port}':
                self.reply(403,'{"error":"loopback host required"}');return
            path=urlsplit(self.path).path
            if self.command=='POST' and path=='/owner/login':
                values=parse_qs(self.body(4096).decode())
                if secrets.compare_digest(values.get('code',[''])[0],owner):
                    self.reply(303,b'',extra=(('Location','/'),('Set-Cookie','nori_owner='+owner+'; HttpOnly; SameSite=Strict; Path=/')))
                else:self.reply(403,'Owner code invalid','text/plain')
                return
            if not self.authorized():
                self.reply(401,'<!doctype html><meta charset="utf-8"><title>Nori owner</title><h1>Nori 私人本機入口</h1><p>輸入本機 owner-code.txt 的代碼。這不是 Meta API key。</p><form action="/owner/login" method="post"><input type="password" name="code" autocomplete="off" required><button>進入</button></form>','text/html; charset=utf-8');return
            if path=='/owner/status' and self.command=='GET':
                self.reply(200,json.dumps(core.snapshot(),ensure_ascii=False));return
            if path=='/owner/reflect/experiences' and self.command=='GET':
                self.reply(200,json.dumps({'automatic_reflection':core.reflect,
                    'experiences':core.settled_photo_experiences()},ensure_ascii=False));return
            if path=='/owner/reflect' and self.command=='POST':
                origin=self.headers.get('Origin')
                if origin and origin!=f'http://127.0.0.1:{port}':self.reply(403,'{}');return
                try:
                    value=json.loads(self.body(4096))
                    if not isinstance(value,dict) or set(value)!={'experience_id'} or not isinstance(value['experience_id'],str):
                        raise ValueError('exactly one experience_id required')
                    core.reflect_one(value['experience_id'])
                    self.reply(200,json.dumps(core.snapshot(),ensure_ascii=False))
                except ValueError as error:self.reply(409,json.dumps({'error':str(error)}))
                return
            if path=='/owner/stop' and self.command=='POST':
                origin=self.headers.get('Origin')
                if origin and origin!=f'http://127.0.0.1:{port}':self.reply(403,'{}');return
                stop.set();self.reply(200,'{"stopping":true}');return
            allowed=path=='/api/cam' or path in ('/api/gift/photo','/api/gift','/api/replay','/api/record') or path.startswith(('/api/gift/status/','/api/interaction/')) or not path.startswith('/api/')
            if not allowed or (self.command=='POST' and path not in ('/api/gift/photo','/api/gift')):
                self.reply(403,'{"error":"owner proxy route blocked"}');return
            if self.command=='POST':
                origin=self.headers.get('Origin')
                if origin and origin!=f'http://127.0.0.1:{port}':self.reply(403,'{}');return
            try:
                body=self.body() if self.command=='POST' else None
                headers={'X-Nori-Code':owner}
                if self.headers.get('Content-Type'):headers['Content-Type']=self.headers['Content-Type']
                status,data,response_headers=r._http(self.command,core.base+self.path,headers,body,timeout=30)
                if path=='/api/gift/photo' and status==200:
                    gift=json.loads(data)['gift_id'];receipt=multipart_evidence(headers['Content-Type'],body)['fields']['file']
                    core.receipt(gift,receipt['sha256'],receipt['bytes'])
                mime=response_headers.get('Content-Type','application/octet-stream')
                if path=='/' and status==200 and 'html' in mime:
                    # A private operator HUD, never the cat's verbal thoughts. No API secret is embedded.
                    addon=hud(core.mode)
                    data=data.replace(b'</body>',addon.encode()+b'</body>')
                self.reply(status,data,mime)
            except Exception:
                self.reply(502,'{"error":"local operation failed; see owner status"}')
    return ThreadingHTTPServer(('127.0.0.1',port),Handler)


def serve(state, port, sdk, *, mode='LIVE', factory=None, ledger=None, art_profile=None, assets_dir=None, prepare_world=None, reflect=True):
    state=Path(state).resolve()
    if state.is_relative_to(r.ROOT) or port==8798 or not 1024<=port<=65535:
        raise SystemExit('use isolated external state and own loopback port (not8798)')
    state.mkdir(parents=True,exist_ok=True)
    if list(state.glob('.dev.vars*')) or list(state.glob('.env*')):
        raise SystemExit('keep provider key delivery outside Worker state; dotenv files prohibited here')
    lock=(state/'runner.lock').open('a+b')
    if sys.platform=='win32':
        import msvcrt
        lock.seek(0);lock.write(b'1');lock.flush();lock.seek(0)
        try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        except OSError:raise SystemExit('this persistent state already has a runner')
    else:
        import fcntl
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    owner=private_value(state/'owner-code.txt');token=private_value(state/'ingest-token.txt')
    config=state/'worker-config.json';config.write_text(json.dumps(config_for(state,owner,token,assets_dir),indent=2))
    system_vars={'SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','COMSPEC',
        'NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','HOMEDRIVE','HOMEPATH','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','OS'}
    env={k:os.environ[k] for k in os.environ if k.upper() in system_vars}
    env.update(NORI_CAM_LOCAL_CONFIG=str(config),NORI_CAM_LOCAL_PERSIST=str(state/'persist'),WRANGLER_SEND_METRICS='false',NORI_CAM_ALLOW_LOCAL_HTTP='1')
    os.environ['NORI_CAM_ALLOW_LOCAL_HTTP']='1'  # Python pipeline explicitly permits only this local transport.
    # Explicit sanitized env for BOTH migrations and Worker; never inherit the API key.
    subprocess.run(['node',str(r.SITE/'node_modules/wrangler/bin/wrangler.js'),'d1','migrations','apply','DB','--local',
        '--config',str(config),'--persist-to',str(state/'persist')],cwd=state,env=env,check=True)
    if prepare_world:prepare_world(state)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));worker_port=sock.getsockname()[1]
    log=(state/'worker.log').open('a',encoding='utf-8')
    child=subprocess.Popen(['node',str(r.SITE/'node_modules/wrangler/bin/wrangler.js'),'dev','--local','--ip','127.0.0.1','--port',str(worker_port),'--config',str(config),'--persist-to',str(state/'persist')],cwd=state,env=env,stdout=log,stderr=subprocess.STDOUT)
    stop=threading.Event();server=None
    try:
        r._wait_worker(f'http://127.0.0.1:{worker_port}')
        core=Core(state,f'http://127.0.0.1:{worker_port}',token,ledger or Ledger(SHARED_BUDGET),sdk,mode=mode,factory=factory,stop_event=stop,art_profile=art_profile,reflect=reflect)
        server=make_server(core,owner,stop,port)
        (state/'runner-status.json').write_text(json.dumps({'mode':mode,'pid':os.getpid(),'worker_pid':child.pid,'url':f'http://127.0.0.1:{port}/','owner_code_file':str(state/'owner-code.txt'),'budget_file':str(core.ledger.path),'key_persisted':False,'clock':'wall'}))
        def dispatch():
            while not stop.is_set():
                try:core.tick();core.latest_error=None
                except Exception as error:core.latest_error=type(error).__name__
                stop.wait(2)
        threading.Thread(target=dispatch,daemon=True).start()
        threading.Thread(target=server.serve_forever,daemon=True).start()
        print(json.dumps({'ready':True,'mode':mode,'url':f'http://127.0.0.1:{port}/','owner_code_file':str(state/'owner-code.txt'),'key_persisted':False}),flush=True)
        while not stop.wait(1):pass
    finally:
        stop.set()
        if server:server.shutdown();server.server_close()
        if sys.platform=='win32':subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],capture_output=True)
        else:child.terminate()
        child.wait(timeout=20);log.close();lock.close()
        status_path=state/'runner-status.json'
        if status_path.exists():
            value=json.loads(status_path.read_text());value['stopped']=True;status_path.write_text(json.dumps(value))


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',nargs='?',choices=('plan','serve','stop'),default='plan')
    parser.add_argument('--live',action='store_true');parser.add_argument('--state');parser.add_argument('--port',type=int,default=8807);parser.add_argument('--key-file')
    args=parser.parse_args(argv)
    if args.command=='plan':print(json.dumps(PLAN,indent=2));return 0
    if not args.state:parser.error('--state required')
    if args.command=='stop':
        state=Path(args.state);status=json.loads((state/'runner-status.json').read_text());owner=(state/'owner-code.txt').read_text().strip()
        req=Request(status['url']+'owner/stop',data=b'',method='POST',headers={'Cookie':'nori_owner='+owner})
        with urlopen(req,timeout=10) as response:print(response.status)
        return 0
    if not args.live:parser.error('serve requires explicit --live; this entry has no Mock fallback')
    key=load_key(args.key_file)
    from openai import OpenAI
    sdk=OpenAI(api_key=key,base_url='https://api.meta.ai/v1',timeout=180,max_retries=0)
    try:serve(args.state,args.port,sdk)
    except KeyboardInterrupt:pass
    finally:sdk.close()
    return 0


if __name__=='__main__':raise SystemExit(main())
