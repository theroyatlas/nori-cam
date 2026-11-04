import {it, expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import catalog from '../public/cam/catalog.json';
import manifest from '../public/cam/manifest.json';
import {planNext, plan} from '../src/worker/cam/plan.ts';
import {settle,settleEnded} from '../src/worker/cam/settle.ts';
import {initialState} from '../src/worker/cam/engine.ts';
import {validate} from '../src/worker/cam/validate.ts';
import {operationCells, EXECUTOR} from '../public/cam-shared.js';
import {simulate} from '../scripts/simulate.ts';
import type {CatalogEntry, Segment} from '../src/worker/cam/types.ts';
const entries = catalog.entries as unknown as CatalogEntry[];
const input = () => ({state:initialState(), objects:structuredClone(entries.map(e=>e.object)), interactions:entries.flatMap(e=>e.interactions), position:[2,6] as [number,number], start_at:0, world_version:1});
it('r2.1 migration persists completion',()=>{
 const sql=readFileSync(new URL('../migrations/0002_cam.sql',import.meta.url),'utf8');
 const db=new DatabaseSync(':memory:');
 try {
   db.exec(sql);
   const completion=JSON.stringify({last:true,segment_ids:[1],sensations:{soft:.5}});
   db.prepare('INSERT INTO segments (id,start_at,end_at,action,pose,path,source,world_version,completion) VALUES (1,0,1000,?,?,?,?,?,?)').run('interact','sit','[[2,6]]','routine',1,completion);
   expect(db.prepare('SELECT completion FROM segments WHERE id=1').get()?.completion).toBe(completion);
 } finally {db.close();}
});
it('r2.2 nonblocking top uses only occupied cells',()=>{
 const i=input(), bed=i.objects.find(o=>o.id==='o_bed')!;
 expect(operationCells(bed,'top',i)).toEqual(bed.footprint.map(([x,y])=>[bed.x+x,bed.y+y]));
});
it('r2.3 recovers from a newly blocked start',()=>{
 const i=input();i.objects.push({...i.objects[0],id:'block',x:2,y:6,tags:['blocker']});
 const a=planNext(i);expect(a[0].action).toBe('recover');expect(a[0].path.at(-1)).not.toEqual(i.position);
});
it('r2.3 planner rejects an effect that expands onto Nori',()=>{
 const i=input(),o=structuredClone(i.objects[0]);o.x=1;o.y=6;o.tags=[];
 o.card.states=['default','open'];o.state_sprites={open:'open.png'};o.card.space.state_cm.open={w:80,d:40,h:20};
 i.objects=[o];i.position=[2,6];i.interactions=[{id:'expand',object_id:o.id,spec:{verb:'open',sensations:{},steps:[{p:'touch',part:'inside',ms:500},{p:'set_object_state',state:'open'}],end_state:'open',cooldown_min:25}}];
 expect(validate(i,o,i.interactions[0].spec,i.position).checks.some(c=>c.check.endsWith('.placement')&&!c.ok)).toBe(true);
 expect(planNext(i).some(s=>s.effects.some(e=>e.e==='set_state'))).toBe(false);
});
it('r2.4 settles ended backlog before planning and returns typed gap errors',()=>{
 const i=input(),ended=planNext({...i,interactions:[entries[2].interactions[0]]});
 const start=ended.at(-1)!.end_at;
 const result=plan({...i,start_at:start,position:ended.at(-1)!.path.at(-1)!,unsettled:ended} as any,start+1000);
 expect(Array.isArray(result)).toBe(true);
 const gap=plan({...i,start_at:1000},2000) as any;expect(gap.error?.code).toBe('settlement_gap');
});
it('r2.5 clamps default drop duration',()=>{
 const i=input(),a=planNext({...i,interactions:[entries[1].interactions.find(x=>x.action==='carry')!]});
 const drop=a.find(s=>s.primitive==='drop')!;expect(drop).toBeDefined();expect(drop.end_at-drop.start_at).toBe(EXECUTOR.drop.max_ms);
});
it('r2.6 skips stationary movement and completed carry destinations',()=>{
 const i=input(),ix=entries[1].interactions.find(x=>x.action==='carry')!;
 const a=planNext({...i,interactions:[ix]});expect(a.flatMap(s=>s.effects).filter(e=>e.e==='move_object').every(e=>e.dx||e.dy)).toBe(true);
 const target=ix.spec.steps.find(s=>s.p==='drop')!.at!;i.objects.find(o=>o.id===ix.object_id)!.x=target[0];i.objects.find(o=>o.id===ix.object_id)!.y=target[1];
 expect(planNext({...i,interactions:[ix]}).some(s=>s.primitive==='carry')).toBe(false);
});
it('r2.7 seed 1 life pacing meets frozen targets',()=>{
 const r=simulate(72,1) as any;
 expect(r.asleep_hours_per_day).toBeGreaterThanOrEqual(12);expect(r.asleep_hours_per_day).toBeLessThanOrEqual(16);
 expect(r.night_asleep_share).toBeGreaterThan(r.midday_asleep_share);
 expect(r.interactions_per_awake_hour).toBeGreaterThanOrEqual(6);expect(r.interactions_per_awake_hour).toBeLessThanOrEqual(15);
 expect(r.rest_choices).toBeGreaterThan(0);
});
it('r2.8 waking lowers security and neutral week drift stays bounded',()=>{
 const i=input();i.state.nori.asleep=true;i.state.nori.sleep_started_at=0;
 const seg=planNext({...i,reaction:{event_id:'wake',pose:'startled'}})[0];
 expect(settle(i.state,seg,i.objects,seg.end_at).state.nori.security).toBeLessThan(i.state.nori.security);
 const r=simulate(168,1);expect(Math.max(...Object.values(r.preference_drift).map(Math.abs))).toBeLessThan(.15);
});
it('r2.9 all poses in a 24 hour simulation exist in manifest',()=>{
 const r=simulate(24,1) as any;expect(r.pose_names?.length).toBeGreaterThan(0);
 for(const pose of r.pose_names)expect(Object.keys(manifest)).toContain(pose);
});
it('r2.10 rejects a wait only spec',()=>{
 const i=input();expect(validate(i,i.objects[0],{verb:'wait',sensations:{},steps:[{p:'wait',ms:1000}],end_state:null,cooldown_min:25},i.position).status).toBe('rejected');
});
it('r2.11 segment ids increase across versions and duplicate event types stay unique',()=>{
 const i=input(),a=planNext(i),b=planNext({...i,world_version:2});
 expect(Math.min(...b.map(s=>s.id))).toBeGreaterThan(Math.max(...a.map(s=>s.id)));
 const s={...a[0],effects:[{e:'emit_sound',pattern:'a'},{e:'emit_sound',pattern:'b'}]};
 const events=settle(i.state,s,i.objects,s.end_at).events.filter(e=>e.type==='sound_played');
 expect(events).toHaveLength(2);expect(new Set(events.map(e=>e.id)).size).toBe(2);
});

it('r2.4 backlog settlement exposes durable memory, effects, events and settled rows',()=>{
 const i=input(),segments=planNext({...i,interactions:[entries[1].interactions.find(ix=>ix.action==='carry')!]});
 const now=segments.at(-1)!.end_at,r=settleEnded(i.state,segments,i.objects,now);
 expect(r.error).toBeUndefined();expect(r.experiences).toHaveLength(1);
 expect(r.segments.every(s=>s.settled_at===now)).toBe(true);
 expect(r.events.some(e=>e.type==='interaction_done')).toBe(true);
 expect(r.objects.find(o=>o.id==='o_slipper')).toMatchObject({x:4,y:2,status:'placed'});
 expect(r.state.settled_through).toBe(now);
 const gap=settleEnded(i.state,segments.slice(1),i.objects,now);
 expect(gap.error?.code).toBe('settlement_gap');expect(gap.state).toBe(i.state);expect(gap.events).toEqual([]);
});
it('r2.5 and r2.6 every emitted primitive stays within caps and every move changes position',()=>{
 const i=input();let state=i.state,objects=i.objects,position=i.position;
 for(let n=0;n<400;n++){
   const segments=planNext({...i,state,objects,position,start_at:state.settled_through});
   for(const seg of segments){
     const cap=EXECUTOR[seg.primitive],duration=seg.end_at-seg.start_at;
     expect(duration).toBeGreaterThanOrEqual(cap.min_ms);expect(duration).toBeLessThanOrEqual(cap.max_ms);
     for(const effect of seg.effects.filter(e=>e.e==='move_object'))expect(!!effect.dx||!!effect.dy).toBe(true);
     const r=settle(state,seg,objects,seg.end_at);expect(r.error).toBeUndefined();state=r.state;objects=r.objects;
   }
   position=segments.at(-1)!.path.at(-1)!;
 }
});
it('r2.11 distinct effects of the same event type never collapse',()=>{
 const i=input(),s=planNext(i)[0];
 s.effects=[{e:'emit_sound',pattern:'a'},{e:'emit_sound',pattern:'b'}];
 const events=settle(i.state,s,i.objects,s.end_at).events.filter(e=>e.type==='sound_played');
 expect(events).toHaveLength(2);expect(new Set(events.map(e=>e.id)).size).toBe(2);
});

it('r2.7 cooldown exhaustion does not force sleep in a rested cat',()=>{
 const i=input();i.state.nori.energy=1;i.interactions=[entries[2].interactions.find(ix=>ix.action==='sleep')!];
 for(const ix of i.interactions)i.state.habits[ix.id]={n:1,good:0,last_at:0};
 let rests=0;
 for(let version=1;version<=100;version++){
   const a=planNext({...i,world_version:version});
   if(a.some(s=>s.action==='idle_sit'))rests++;
 }
 expect(rests).toBeGreaterThan(75);
 i.state.nori.energy=.2;
 let tiredRests=0;
 for(let version=1;version<=100;version++)if(planNext({...i,world_version:version}).some(s=>s.action==='idle_sit'))tiredRests++;
 expect(rests).toBeGreaterThan(tiredRests);
});
