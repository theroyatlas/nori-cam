"""Local observatory candidate: existing owner UI/pipeline/Worker, isolated fresh layout."""
from pathlib import Path
import argparse,json,math,sqlite3,time,shutil,collections
from .owner_live import serve,load_key
from .room_art import RoomArt

ROOT=Path(__file__).resolve().parents[2]
MODEL=ROOT/'site/observatory/model'
SCALE=.8

def layout_cells(contract):
    items=[]
    for i,c in enumerate(contract['colliders']):
        a,b=c['aabb_min_blender'],c['aabb_max_blender']
        cells=[]
        for x in range(10):
            for y in range(8):
                cx,cy=(9-x)*.4,(y+.5)*.4
                if cx-.2<b[0]*SCALE-1e-6 and cx+.2>a[0]*SCALE+1e-6 and cy-.2<b[1]*SCALE-1e-6 and cy+.2>a[1]*SCALE+1e-6:
                    cells.append((x,y))
        if cells:items.append((f'r40_{i}',c['name'],cells,(b[2]-a[2])*SCALE))
    items.append(('r40_boundary','room boundary',[(9,y) for y in range(8)],1))
    blocked={c for _,_,cells,_ in items for c in cells}
    free={(x,y) for x in range(10) for y in range(8)}-blocked
    spawn=(1,6)
    if spawn not in free or (0,7) not in free:raise RuntimeError('room spawn/door blocked')
    seen={spawn};q=collections.deque([spawn])
    while q:
        x,y=q.popleft()
        for n in [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]:
            if n in free and n not in seen:seen.add(n);q.append(n)
    if (0,7) not in seen:raise RuntimeError('room door unreachable')
    # The incumbent placement gate requires one connected free component and
    # an operation cell per object. Keep its gate unchanged: represent the
    # static room as one immovable compound, conservatively excluding islands.
    compound=sorted({(x,y) for x in range(10) for y in range(8)}-seen)
    items=[('r40_static_compound','static observatory compound',compound,2.0)]
    return items,spawn,{'free_cells':len(seen),'conservatively_excluded_floor_cells':len(free-seen),'reachable_spawn_component':len(seen),'door_reachable':True,'scale':SCALE,'grid':[10,8],'world_to_blender':'[(9-x)*0.5,(y+0.5)*0.5,z*0.25]','collision':'conservative scaled mesh compound; connected floor-only candidate; furniture climbing not implemented'}

def prepare_world(state):
    state=Path(state).resolve()
    if state.name!='world' or not state.parent.name.startswith('nori-observatory-'):
        raise RuntimeError('observatory bootstrap requires its own named isolated state')
    if (state/'r40-layout.json').exists():return
    files=[p for p in (state/'persist/v3/d1/miniflare-D1DatabaseObject').glob('*.sqlite') if p.name!='metadata.sqlite']
    if len(files)!=1:raise RuntimeError('one isolated world DB required')
    contract=json.loads((MODEL/'room-contract.json').read_text())
    items,spawn,checks=layout_cells(contract);db=sqlite3.connect(files[0]);now=int(time.time()*1000)
    try:
        if db.execute('SELECT COUNT(*) FROM gifts').fetchone()[0]:raise RuntimeError('never replace a world with gifts')
        backup=sqlite3.connect(state/'before-room-bootstrap.sqlite');db.backup(backup);backup.close()
        with db:
            for table in ['interactions','object_states','object_cards','objects','segments','experiences','events','intents','weather']:
                db.execute('DELETE FROM '+table)
            row=db.execute('SELECT state_json FROM world WHERE id=1').fetchone();world=json.loads(row[0]);world['settled_through']=now;world['nori']['z']=0
            db.execute("UPDATE world SET version=0,writer='observatory-bootstrap',timeline_until=?,state_json=?,updated_at=? WHERE id=1",(now+1000,json.dumps(world),now))
            for ident,name,cells,height in items:
                x,y=min(cells);foot=[[a-x,b-y] for a,b in cells];card_id='card:'+ident
                card={'name':name,'category':'furniture','size':'L','height':'low','tags':[],'sensations':{},'parts':[],'states':['default'],'hazards':[],
                      'space':{'cm':{'w':40,'d':40,'h':max(1,round(height*100))},'blocks':True,'placement':'floor','movable':{'push':False,'rotate':False,'stack':False},'state_cm':{}},'affordances':[],'beyond_executor':['custom furniture climbing not part of this floor-only photo test'],'summary':'R40 conservative static room collider'}
                db.execute('INSERT INTO object_cards(id,object_id,created_at,source,card) VALUES(?,?,?,?,?)',(card_id,ident,now,'prefab',json.dumps(card)))
                vals=(ident,'r40_static','[]','L',x,y,0,json.dumps(foot),0,1,'floor','placed','default','procedural:room_collider',card_id,json.dumps({'type':'r40_layout'}),now)
                db.execute('INSERT INTO objects(id,kind,tags,size,x,y,z,footprint,rotation,blocks,placement,status,state,sprite,card_id,origin,created_at) VALUES('+','.join('?'*17)+')',vals)
                db.execute('INSERT INTO object_states(object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(ident,now,x,y,0,json.dumps(foot),0,'placed','default','procedural:room_collider','r40-layout-bootstrap'))
            db.execute("INSERT INTO segments(start_at,end_at,action,primitive,pose,facing,path,z,effects,source,debug,world_version) VALUES(?,?,'idle','wait','sit',1,?,0,'[]','safe',?,0)",(now,now+1000,json.dumps([spawn]),json.dumps({'initial_room_spawn':True})))
        (state/'r40-layout.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
    finally:db.close()

def main():
    p=argparse.ArgumentParser();p.add_argument('--state',required=True);p.add_argument('--assets',required=True);p.add_argument('--port',type=int,default=8810);p.add_argument('--key-file',required=True)
    p.add_argument('--reflect',action='store_true',help='automatically reflect on each new photo object; omit for bounded manual probe')
    a=p.parse_args()
    from openai import OpenAI
    sdk=OpenAI(api_key=load_key(a.key_file),base_url='https://api.meta.ai/v1',timeout=180,max_retries=0)
    try:serve(a.state,a.port,sdk,art_profile=RoomArt(MODEL/'render-front.png'),assets_dir=Path(a.assets),prepare_world=prepare_world,reflect=a.reflect)
    finally:sdk.close()

if __name__=='__main__':main()
