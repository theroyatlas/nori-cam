import {it,expect} from 'vitest';
import catalog from '../public/cam/catalog.json';
import {initialState} from '../src/worker/cam/engine.ts';
import {settle} from '../src/worker/cam/settle.ts';
import {safeSegment,advance,tick} from '../src/worker/cam/timeline.ts';
import {weatherEffects,weatherRowsToUpsert} from '../src/worker/cam/weather.ts';
import {planNext} from '../src/worker/cam/plan.ts';
import {snapshot} from '../src/worker/cam/store.ts';
import {database,NOW} from '../scripts/cam-test-db.ts';
import type {CatalogEntry} from '../src/worker/cam/types.ts';
const entries=catalog.entries as unknown as CatalogEntry[];
it('interrupted carry drops at nearest legal cell, with no preference gain; settled once',()=>{
 const objects=structuredClone(entries.map(e=>e.object)),carried=objects[1];carried.status='carried';
 const s={...safeSegment(0,500,1,1,[2,6]),primitive:'carry',target:carried.id,carrying:carried.id,interaction:'carry:test',cut_at:500,effects:[{e:'move_object',dx:7}]};
 const input=initialState(),r=settle(input,s,objects,500);expect(r.objects[1]).toMatchObject({status:'placed',x:3,y:6});expect(r.events.some(e=>e.type==='interaction_interrupted')).toBe(true);expect(r.state.prefs).toEqual(input.prefs);expect(settle(r.state,r.segment,r.objects,500).events).toEqual([]);
});
it('overcast with zero measured cloud still suppresses sun interaction',()=>{
 const input={state:initialState(NOW),objects:entries.map(e=>e.object),interactions:entries.filter(e=>e.object.id==='env:sun').flatMap(e=>e.interactions),position:[2,6] as [number,number],start_at:NOW,world_version:1,weather:{condition:'overcast',cloud_pct:0}};
 // Lane F helper uses cloud percentage: normalize the semantic condition in caller.
 expect(planNext(input).every(s=>s.target!=='env:sun')).toBe(true);
});
it('thunder uses stored deterministic timestamps, reacts only at actual time, and persists settlement',async()=>{
 const {env,sql}=database();
 const hour=Array.from({length:24},(_,i)=>NOW+i*3600000).find(hour_utc=>weatherEffects({condition:'thunder',hour_utc}).startleEvents.length)!;
 const storm=weatherEffects({condition:'thunder',hour_utc:hour}).startleEvents[0];
 const start=storm.at_ms-10000;sql.prepare('UPDATE world SET timeline_until=?,state_json=?').run(start,JSON.stringify(initialState(start)));
 for(const row of weatherRowsToUpsert([{hour_utc:hour,condition:'thunder',temp_c:10,cloud_pct:100,precip_mm:2,wind_kph:10,is_day:1}],start))sql.prepare(row.sql).run(...row.params);
 await advance(env,start,'read');expect(sql.prepare("SELECT count(*) AS n FROM events WHERE type='weather_startle'").get()?.n).toBe(0);
 const planned=await snapshot(env.DB);expect(planned.segments.some(s=>s.start_at===storm.at_ms&&s.action==='startled')).toBe(true);
 await advance(env,storm.at_ms+2000,'cron');expect(sql.prepare("SELECT count(*) AS n FROM events WHERE type='weather_startle'").get()?.n).toBe(1);
 await advance(env,storm.at_ms+2000,'cron');expect(sql.prepare("SELECT count(*) AS n FROM events WHERE type='weather_startle'").get()?.n).toBe(1);
});
it('object history tracks actual per-segment changes without forecast writes',async()=>{
 const {env,sql}=database();const old=await snapshot(env.DB);const object=old.objects.find(o=>o.id==='o_slipper')||old.objects[1];
 const s={...safeSegment(NOW,NOW+500,1,0,[2,6]),target:object.id,effects:[{e:'move_object',dx:1}]};
 const cols=['id','start_at','end_at','action','primitive','pose','path','effects','target','source','world_version'];
 sql.prepare(`INSERT INTO segments (${cols}) VALUES (${cols.map(()=>'?')})`).run(s.id,s.start_at,s.end_at,s.action,s.primitive,s.pose,JSON.stringify(s.path),JSON.stringify(s.effects),s.target,s.source,0);
 sql.prepare('UPDATE world SET timeline_until=?').run(s.end_at);
 await advance(env,NOW+600,'cron');const history=sql.prepare('SELECT * FROM object_states WHERE object_id=? ORDER BY id').all(object.id);
 expect(history).toHaveLength(2);expect(history[0].valid_to).toBe(s.end_at);expect(history[1].valid_from).toBe(s.end_at);expect(history[1].x).toBe(object.x+1);
});
