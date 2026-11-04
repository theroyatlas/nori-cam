"""One real owner-UI photo gift in the R40 observatory renderer, recorded as video.
One upload attempt per --out folder, never retried automatically. Works against MOCK (8811) or LIVE (8810)."""
from pathlib import Path
import argparse, json, hashlib, urllib.request, time, base64
from playwright.sync_api import sync_playwright

p = argparse.ArgumentParser()
p.add_argument('--port', type=int, required=True)
p.add_argument('--state', required=True)
p.add_argument('--out', required=True)
p.add_argument('--photo', required=True)
p.add_argument('--hold', type=int, default=40)
p.add_argument('--browser', choices=('shell', 'edge'), default='edge')
p.add_argument('--gl', choices=('swiftshader', 'd3d11'), default='d3d11')
p.add_argument('--no-upload', action='store_true', help='room-only fps probe')
a = p.parse_args()
assert a.port in (8810, 8811)
base = f'http://127.0.0.1:{a.port}'
state = Path(a.state); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
if not a.no_upload and (out / 'upload-attempt.json').exists():
    raise SystemExit('one upload already attempted in this folder; no automatic retry')
code = (state / 'owner-code.txt').read_text().strip()
src = Path(a.photo); sha = hashlib.sha256(src.read_bytes()).hexdigest()
log = []
t0 = time.time()


def note(kind, **kw):
    row = {'t': round(time.time() - t0, 2), 'kind': kind, **kw}
    log.append(row); print('LOG', json.dumps(row, ensure_ascii=False), flush=True)


def status():
    req = urllib.request.Request(base + '/owner/status', headers={'Cookie': 'nori_owner=' + code})
    return json.load(urllib.request.urlopen(req, timeout=10))


def shot(page, name):
    data = page.evaluate('document.querySelector("#cam-observatory").toDataURL("image/png").split(",")[1]')
    (out / name).write_bytes(base64.b64decode(data))


gl = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] if a.gl == 'swiftshader' else \
     ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
errors, external = [], []
with sync_playwright() as w:
    if a.browser == 'edge':
        browser = w.chromium.launch(channel='msedge', headless=True, args=['--headless=new'] + gl)
    else:
        browser = w.chromium.launch(headless=True, args=gl)  # Playwright's bundled Chromium
    context = browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1,
                                  record_video_dir=str(out / 'video'), record_video_size={'width': 1280, 'height': 720})
    context.add_cookies([{'name': 'nori_owner', 'value': code, 'url': base, 'httpOnly': True, 'sameSite': 'Strict'}])
    page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))

    def route(r):
        if r.request.url.startswith(('http://', 'https://')) and not r.request.url.startswith(base + '/'):
            external.append(r.request.url); r.abort()
        else:
            r.continue_()
    page.route('**/*', route)
    camlog = []

    def on_resp(r):
        if '/api/cam' in r.url and r.request.method == 'GET':
            try:
                b = r.json() if r.status == 200 else {}
            except Exception:
                b = {}
            camlog.append({'t': round(time.time() - t0, 2), 'url': r.url.split('/api/cam')[1][:40], 'status': r.status,
                           'server_now': b.get('server_now'), 'until': b.get('timeline_until'),
                           'segs': [[s.get('id'), s.get('start_at'), s.get('end_at'), s.get('action'), s.get('cut_at')]
                                    for s in b.get('segments', [])]})
    page.on('response', on_resp)
    page.goto(base + '/?scene=miniature', wait_until='domcontentloaded', timeout=30000)
    page.wait_for_function('window.noriObservatory?.ready', timeout=60000)
    f0 = page.evaluate('window.noriObservatory.frames'); time.sleep(5); f1 = page.evaluate('window.noriObservatory.frames')
    note('room_ready', fps=round((f1 - f0) / 5, 1), errors=page.evaluate('window.noriObservatory.errors'))
    shot(page, 'room-before.png')
    gift = None; terminal = None
    if not a.no_upload:
        page.locator('.nori-gift-open').click(); time.sleep(1.5)
        page.locator('.nori-gift-photo summary').click(); time.sleep(1)
        page.locator('.nori-gift-photo input[type=password]').fill('owner-session')
        page.locator('.nori-gift-photo input[type=file]').set_input_files(str(src)); time.sleep(1.5)
        (out / 'upload-attempt.json').write_text(json.dumps({'input_sha256': sha, 'port': a.port, 'attempts': 1,
            'source': 'real existing Nori photo UI multipart'}), encoding='utf-8')
        with page.expect_response(lambda r: r.request.method == 'POST' and '/api/gift/photo' in r.url, timeout=30000) as rr:
            page.get_by_role('button', name='Send photo', exact=True).click()
        res = rr.value; body = res.json(); gift = body.get('gift_id')
        note('upload_response', status=res.status, body=body)
        (out / 'upload-response.json').write_text(json.dumps({'status': res.status, 'body': body}), encoding='utf-8')
        if res.status != 200 or not gift:
            raise RuntimeError('real UI upload failed')
        last = None
        deadline = time.time() + 300
        while time.time() < deadline:
            d = page.evaluate("async id=>{const r=await fetch('/api/gift/status/'+id);return await r.json();}", gift)
            if d.get('status') != last:
                note('gift_status', status=d.get('status'), name=d.get('name'), reason=d.get('reason')); last = d.get('status')
            if d.get('status') in ('ready', 'failed'):
                terminal = d; break
            time.sleep(1.5)
        if terminal is None:
            (out / 'timeout-status.json').write_text(json.dumps(status(), ensure_ascii=False, indent=2), encoding='utf-8')
            note('timeout')
        if terminal and terminal.get('status') == 'ready':
            deadline = time.time() + 90; loaded = False
            while time.time() < deadline:
                loaded = page.evaluate("id=>window.noriObservatory?.objects.some(o=>o.id==='o_'+id&&o.loaded)", gift)
                if loaded:
                    break
                time.sleep(1)
            note('renderer_loaded', loaded=loaded)
    end = time.time() + a.hold; k = 0; lastpose = None
    while time.time() < end:
        r = page.evaluate('window.noriObservatory')
        pose = r.get('pose') or {}
        key = (pose.get('action'), pose.get('pose'), pose.get('x'), pose.get('y'), pose.get('target'))
        if key != lastpose:
            note('nori', action=pose.get('action'), pose=pose.get('pose'), x=pose.get('x'), y=pose.get('y'),
                 target=pose.get('target'), part=pose.get('part')); lastpose = key
        if k % 10 == 0:
            shot(page, f'room-hold-{k // 10}.png')
        k += 1; time.sleep(1)
    report = page.evaluate('window.noriObservatory'); backend = status()
    job = next((j for j in backend['jobs'] if gift and j['id'] == 'photo:' + gift), None)
    detail = json.loads(job['detail']) if job else {}
    result = {'gift_id': gift, 'input_sha256': sha, 'receiver_sha256': detail.get('receiver_sha256'),
              'source_hash_matches': detail.get('receiver_sha256') == sha, 'terminal': terminal, 'photo_job': job,
              'renderer': report, 'page_errors': errors, 'external_browser_requests': external,
              'budget': backend['budget'], 'mode': backend.get('mode'), 'log': log, 'camlog': camlog}
    (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    video = page.video
    context.close()
    vpath = video.path() if video else None
    browser.close()
    print('FINAL', json.dumps({'gift_id': gift, 'terminal': (terminal or {}).get('status'), 'mode': backend.get('mode'),
        'source_hash_matches': result['source_hash_matches'], 'renderer_objects': len(report['objects']),
        'page_errors': errors, 'external_requests': len(external), 'video': str(vpath),
        'budget_reserved': backend['budget'].get('accounted_and_reserved_usd')}, ensure_ascii=False), flush=True)
