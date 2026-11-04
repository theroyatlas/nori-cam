import { initialState } from '../src/worker/cam/engine.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe,it,expect,vi } from 'vitest';
import { tick,advance } from '../src/worker/cam/timeline.ts';
import { snapshot,claimWorld,insertSegment,insertEvent } from '../src/worker/cam/store.ts';
import { safeSegment } from '../src/worker/cam/timeline.ts';
import { handle } from '../src/worker/index.ts';
import { dispatchStartedSegments } from '../src/worker/cam/triggers.ts';

import {database,NOW} from '../scripts/cam-test-db.ts';
const offline=vi.fn<typeof fetch>(async()=>{throw new Error('offline fixture');});
const rows=(sql:DatabaseSync)=>sql.prepare('SELECT * FROM segments WHERE superseded_at IS NULL ORDER BY start_at').all() as {start_at:number;end_at:number}[];
function contiguous(a:{start_at:number;end_at:number}[]){expect(a.length).toBeGreaterThan(0);for(let i=1;i<a.length;i++)expect(a[i].start_at).toBe(a[i-1].end_at);}
describe('D1 timeline (node:sqlite)',()=>{
 it.each([[40,0],[59,5]])('dispatches a cut long sleep once, including after a missed short fragment (%s)',async(minute,delay)=>{
  const start=NOW+minute*60000; const {env,sql}=database(start);
  const local={...env,CAM_LOCAL_PIPELINE:'1',CAM_REFLECT_ENABLED:'1'};
  let offset=0;
  await advance(local,start,'read',{planner:(input)=>[{...safeSegment(input.start_at,input.start_at+40*60000,
   input.world_version*1000000000+offset++,input.world_version,input.position),action:'sleep',primitive:'sleep',pose:'sleepy',
   trigger:{kind:'reflect'}}]});
  const s=sql.prepare("SELECT * FROM segments WHERE primitive='sleep' ORDER BY start_at LIMIT 1").get()!;
  expect(Number(s.end_at)-Number(s.start_at)).toBe((60-minute)*60000);
  expect(JSON.parse(String(s.trigger)).planned_end_at).toBe(start+40*60000);
  const dispatchAt=delay ? Number(s.end_at)+delay*60000 : start;
  await Promise.all([dispatchStartedSegments(local,dispatchAt),dispatchStartedSegments(local,dispatchAt)]);
  await dispatchStartedSegments(local,dispatchAt+1);
  expect(sql.prepare("SELECT trigger_status FROM segments WHERE id=?").get(s.id)?.trigger_status).toBe('dispatched');
  expect(sql.prepare("SELECT count(*) n FROM model_calls WHERE id LIKE 'reflect-day:%'").get()?.n).toBe(1);
 });
 it('cron runs 30 minutes without visitors, contiguous and advancing, settles once',async()=>{
  const {env,sql}=database();await tick(env,NOW,{fetch:offline});const before=await snapshot(env.DB);
  expect(before.state).toEqual(initialState(NOW));
  for(let m=5;m<=30;m+=5)await tick(env,NOW+m*60000,{fetch:offline});
  const after=await snapshot(env.DB);expect(after.world.timeline_until).toBeGreaterThan(before.world.timeline_until);contiguous(rows(sql));
  const count=sql.prepare('SELECT count(*) AS n FROM experiences').get();expect(Number(count?.n)).toBeGreaterThan(0);await advance(env,NOW+30*60000,'cron');expect(sql.prepare('SELECT count(*) AS n FROM experiences').get()).toEqual(count);
 });
 it('two simultaneous ticks: one wins, loser leaves no duplicate segments',async()=>{
  const {env,sql}=database();const results=await Promise.all([advance(env,NOW,'cron'),advance(env,NOW,'cron')]);
  expect(results.filter(r=>r.won)).toHaveLength(1);expect((await snapshot(env.DB)).world.version).toBe(1);contiguous(rows(sql));
 });
 it('all stale CAS statements affect zero rows, including event inserts',async()=>{
  const {db,sql}=database();const snap=await snapshot(db);
  const batch=(token:string,id:number)=>[claimWorld(db,snap.world,token,snap.state,NOW+1, NOW),insertSegment(db,safeSegment(NOW,NOW+1,id,1,[2,6]),token),insertEvent(db,{id:token,at:NOW,type:'test',actor:'system',payload:{}},1,token)];
  await db.batch(batch('winner',1));const lost=await db.batch(batch('loser',2));expect(lost.map(r=>r.meta.changes)).toEqual([0,0,0]);expect(sql.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(1);
 });
 it('backfills a 30 minute missed cron gap and a >6h outage',async()=>{
  for(const minutes of [30,420]){const {env,sql}=database();const response=await handle(new Request('http://local/api/cam'),env,{now:()=>NOW+minutes*60000});expect(response.status).toBe(200);const body=await response.json() as any;expect(body.timeline_until).toBeGreaterThanOrEqual(NOW+(minutes+10)*60000);expect(body.segments.some((s:any)=>s.start_at<=NOW+minutes*60000&&s.end_at>NOW+minutes*60000)).toBe(true);contiguous(rows(sql));}
 });
 it('API returns no-store, public whitelist, 304 and valid from handling',async()=>{
  const {env}=database();const req=new Request('http://local/api/cam');const response=await handle(req,env,{now:()=>NOW});const body=await response.json() as any;
  expect(response.headers.get('cache-control')).toBe('no-store');expect(body.weather.condition).toBe('clear');expect(body.objects[0].card.summary).toBeTypeOf('string');
  for(const s of body.segments){expect(s).not.toHaveProperty('completion');expect(s).not.toHaveProperty('trigger');expect(s).not.toHaveProperty('settled_at');expect(s).toHaveProperty('primitive');}
  const etag=response.headers.get('etag')!;expect((await handle(new Request(req,{headers:{'If-None-Match':etag}}),env,{now:()=>NOW})).status).toBe(304);
  expect((await handle(new Request('http://local/api/cam?from=bad'),env)).status).toBe(400);
 });
 it('planner errors write safe segments and events, weather error is stored clear',async()=>{
  const {env,sql}=database();await tick(env,NOW,{fetch:offline,planner:()=>{throw new Error('fixture');}});const a=rows(sql);contiguous(a);expect(a.at(-1)!.end_at).toBe(NOW+45*60000);expect(sql.prepare("SELECT count(*) AS n FROM events WHERE type='safe_fallback'").get()?.n).toBeGreaterThan(0);expect(sql.prepare('SELECT condition FROM weather').get()?.condition).toBe('clear');
 });
 it('seed can be reapplied without resetting a live world or history',async()=>{
  const {env,sql}=database();await advance(env,NOW,'cron');const before=await snapshot(env.DB);const n=sql.prepare('SELECT count(*) AS n FROM object_states').get();sql.exec(readFileSync(new URL('../migrations/0003_cam_seed.sql',import.meta.url),'utf8'));expect((await snapshot(env.DB)).world).toEqual(before.world);expect(sql.prepare('SELECT count(*) AS n FROM object_states').get()).toEqual(n);
 });
});



it('hourly weather fetch uses injected Open-Meteo fixture and is not repeated',async()=>{
 const {env,sql}=database();let calls=0;
 const fetchFixture:typeof fetch=async()=>{calls++;return Response.json({hourly:{time:[new Date(NOW).toISOString()],temperature_2m:[10],cloud_cover:[100],precipitation:[2],weather_code:[63],wind_speed_10m:[12],is_day:[1]}});};
 await tick(env,NOW,{fetch:fetchFixture});await tick(env,NOW+300000,{fetch:fetchFixture});
 expect(calls).toBe(1);expect(sql.prepare('SELECT condition, source FROM weather WHERE hour_utc=?').get(NOW)).toMatchObject({condition:'rain',source:'open-meteo'});
});
it('API limits replay range to 200 segments and omits private completion values',async()=>{
 const {env,sql}=database();
 sql.prepare('UPDATE world SET timeline_until=?').run(NOW+3600000);
 const put=sql.prepare("INSERT INTO segments (start_at,end_at,action,primitive,pose,path,source,world_version,completion,debug,trigger) VALUES (?,?,'idle_sit','wait','sit','[[2,6]]','safe',0,?,?,'{}')");
 for(let i=0;i<210;i++)put.run(NOW+i*1000,NOW+(i+1)*1000,'{"private":"secret fixture"}','private debug');
 const res=await handle(new Request('http://local/api/cam?from='+NOW),env,{now:()=>NOW});const text=await res.text();const body=JSON.parse(text);
 expect(body.segments).toHaveLength(200);expect(text).not.toContain('secret fixture');expect(text).not.toContain('private debug');
});
