// Read-only full settlement/CAS provenance. No Worker or database mutation.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeObject,decodeSegment} from '../../site/src/worker/cam/store.ts';
import {settle,settleEnded} from '../../site/src/worker/cam/settle.ts';
import {planNext,type PlanInput} from '../../site/src/worker/cam/plan.ts';
import {gateSegments} from '../../site/src/worker/cam/segment-gate.ts';
import {weatherAt,HOUR_MS} from '../../site/src/worker/cam/weather.ts';
import {canonical,digest} from './experience_causal_v2.ts';
import type {Segment,WorldState,CamObject,Experience,CamEvent} from '../../site/src/worker/cam/types.ts';
export type Row=Record<string,any>;
export interface BatchSample {before:Record<string,Row[]>;after:Record<string,Row[]>;target_id:string}
const eq=(a:unknown,b:unknown,label:string)=>{if(canonical(a)!==canonical(b))throw Error(label);};
const order=(rows:Row[],keys:string[])=>[...rows].sort((a,b)=>{for(const k of keys){const d=a[k]-b[k];if(d)return d;}return 0;});
const segmentColumns=['id','start_at','end_at','action','primitive','pose','facing','path','z','target','part','carrying','interaction',
 'effects','source','world_version','cut_at','settled_at','superseded_at','trigger','completion'];
const jsonFields=new Set(['path','effects','trigger','completion']);
function rowSegment(s:Segment):Row {return Object.fromEntries([...segmentColumns.map(k=>[k,(s as any)[k]==null?null:
 jsonFields.has(k)?JSON.stringify((s as any)[k]):(s as any)[k]]),...['trigger_claimed_at','trigger_status','debug'].map(k=>[k,(s as any)[k]??null])]);}
function decodedRow(row:Row, fields:string[]) {const r=structuredClone(row);for(const k of fields)if(typeof r[k]==='string')r[k]=JSON.parse(r[k]);return r;}
function interactions(rows:Row[]){return rows.map(i=>{const{action,...spec}=JSON.parse(i.spec);return{id:i.id,object_id:i.object_id,action,spec};});}
export function verifyBatch(sample:BatchSample) {
 const evidence={method:'full_batch_replay_v1',input_sha256:digest(sample),reconstructed:true,directly_persisted:false};
 try {
  const {before:b,after:a}=sample;
  for(const k of ['world','objects','segments','interactions','experiences','events','weather','intents'])
   if(!Array.isArray(b?.[k])||!Array.isArray(a?.[k]))throw Error('missing table '+k);
  if(b.world.length!==1||a.world.length!==1)throw Error('ambiguous world');
  const bw=b.world[0],aw=a.world[0],now=aw.updated_at;
  if(aw.version!==bw.version+1 || !Number.isSafeInteger(now)||now<=bw.updated_at||!aw.writer||aw.writer===bw.writer)
   throw Error('CAS version/time/writer mismatch');
  for(const k of ['id','engine_version'])eq(bw[k],aw[k],'world identity '+k);
  for(const k of ['interactions','weather','intents'])eq(b[k],a[k],'changed input '+k);
  if(b.intents.length)throw Error('unsupported active intent provenance');
  for(const snap of [b,a]) {
   eq(snap.segments,order(snap.segments,['start_at','id']),'reordered segment input');
   for(const table of ['objects','segments','experiences','events'])
    if(new Set(snap[table].map(r=>r.id)).size!==snap[table].length)throw Error('duplicate '+table);
  }
  const prior=JSON.parse(bw.state_json) as WorldState;
  const unsettled=order(b.segments.filter(s=>s.settled_at==null&&s.superseded_at==null),['end_at','id']);
  const ended=unsettled.filter(s=>s.end_at<=now).slice(0,30);
  if(!ended.length)throw Error('empty settlement batch');
  const existing=new Map(b.segments.map(s=>[s.id,s]));
  const changed=a.segments.filter(s=>existing.has(s.id)&&canonical(s)!==canonical(existing.get(s.id)));
  eq(changed.map(s=>s.id).sort((x,y)=>x-y),ended.map(s=>s.id).sort((x,y)=>x-y),'dropped/foreign settled segment');
  for(const s of b.segments){const found=a.segments.find(r=>r.id===s.id);if(!found)throw Error('missing prior segment');
   eq(found,{...s,settled_at:ended.some(e=>e.id===s.id)?now:s.settled_at},'settled row mutation '+s.id);}
  let state=structuredClone(prior),objects=b.objects.map(decodeObject);
  const experiences:Experience[]=[],events:CamEvent[]=[],derived:Record<string,any>[]=[];
  for(const raw of ended){const s=decodeSegment(raw),pre=structuredClone(state),preObjects=structuredClone(objects);
   const r=settleEnded(state,[s],objects,now,weatherAt(b.weather as any,s.start_at));
   if(r.error||r.segments.length!==1)throw Error('settlement replay gap');
   eq(decodedRow(rowSegment(r.segments[0]),[...jsonFields]),decodedRow(a.segments.find(x=>x.id===s.id)!,[...jsonFields]),'entire settled row '+s.id);
   state=r.state;objects=r.objects;experiences.push(...r.experiences);events.push(...r.events);
   for(const x of r.experiences)derived.push({experience:x,segment:s,before:pre,after:structuredClone(state),
    objects_before:preObjects,objects_after:structuredClone(objects)});
  }
  eq(state,JSON.parse(aw.state_json),'full post state_json');
  eq(objects,a.objects.map(decodeObject),'full post objects');
  const oldExps=new Map(b.experiences.map(x=>[x.id,x]));
  for(const x of b.experiences)eq(x,a.experiences.find(y=>x.id===y.id),'prior experience mutation');
  const newExps=a.experiences.filter(x=>!oldExps.has(x.id)).map(x=>decodedRow(x,['segment_ids','sensations','pref_deltas','wariness_deltas']));
  eq(experiences,newExps,'full new experiences');
  // Also replay the normal read-mode forecast/extension, so its CAS metadata and
  // appended segments/event cannot hide a second writer. Unsupported fallback rejects.
  let until=bw.timeline_until,planned:Segment[]=[];
  if(until<now+120000){
   let projection=structuredClone(state),geometry=structuredClone(objects);
   for(const raw of unsettled.filter(s=>s.end_at>state.settled_through)){
    const s=decodeSegment(raw),r=settle(projection,s,geometry,until,weatherAt(b.weather as any,s.start_at));
    if(r.error)throw Error('forecast source gap');projection=r.state;geometry=r.objects;
   }
   const last=order(b.segments.filter(s=>s.superseded_at==null),['end_at','id']).at(-1);
   if(!last||now-until>45*60000)throw Error('unsupported catchup');
   let position=JSON.parse(last.path).at(-1),horizon=now+10*60000;
   while(until<horizon){
    if(planned.length>=29)throw Error('unsupported planning cap fallback');
    const weather=weatherAt(b.weather as any,until);
    const storm=weather.effects.startleEvents.find(e=>e.at_ms===until);
    const input:PlanInput={state:projection,objects:geometry,interactions:interactions(b.interactions),start_at:until,
     world_version:aw.version,position,weather,intents:[],reaction:storm?{event_id:`thunder:${storm.at_ms}`,pose:'startled'}:undefined};
    let next=gateSegments(planNext(input),geometry,position).segments.slice(0,29-planned.length);
    const boundary=Math.min((Math.floor(until/HOUR_MS)+1)*HOUR_MS,...weather.effects.startleEvents.filter(e=>e.at_ms>until).map(e=>e.at_ms));
    next=next.filter(s=>s.start_at<boundary).map(s=>s.end_at>boundary&&s.primitive!=='climb'?{...s,end_at:boundary,cut_at:boundary,
     completion:undefined,trigger:s.primitive==='sleep'&&s.trigger?.kind==='reflect'?{...s.trigger,planned_end_at:s.end_at}:s.trigger}:s);
    if(!next.length)throw Error('empty forecast');
    for(const s of next){const r=settle(projection,s,geometry,s.end_at,weather);if(r.error)throw Error('forecast mismatch');projection=r.state;geometry=r.objects;}
    planned.push(...next);until=next.at(-1)!.end_at;position=next.at(-1)!.path.at(-1)!;
   }
  }
  const appended=a.segments.filter(s=>!existing.has(s.id));
  eq(planned.map(rowSegment),appended,'full appended planner rows');
  eq(aw,{...bw,version:bw.version+1,writer:aw.writer,state_json:JSON.stringify(state),timeline_until:until,updated_at:now},'complete CAS world row');
  const expectedEvents:Row[]=events.map(e=>({...e,payload:e.payload,insert_token:aw.writer,public:e.type==='weather_startle'?0:1,
   world_version:aw.version,handled_version:aw.version}));
  if(planned.some(s=>s.effects.some(e=>e.e==='hazard_refused')||s.source.startsWith('template:')))throw Error('unsupported extra planning evidence');
  if(planned.length)expectedEvents.push({id:`extend:${bw.timeline_until}`,at:now,type:'timeline_extended',actor:'system',payload:{until},
   insert_token:aw.writer,public:0,world_version:aw.version,handled_version:aw.version});
  const eventIds=new Set(b.events.map(e=>e.id));for(const ev of b.events)eq(ev,a.events.find(x=>x.id===ev.id),'prior event mutation');
  eq(expectedEvents,a.events.filter(e=>!eventIds.has(e.id)).map(e=>decodedRow(e,['payload'])),'full new events/CAS metadata');
  return {...evidence,status:'PASS',full_batch_post_verified:true,world_versions:[bw.version,aw.version],cas_at:now,
   settled_ids:ended.map(s=>s.id),settled_count:ended.length,appended_count:planned.length,new_experience_ids:experiences.map(x=>x.id),
   hashes:{state:digest(state),objects:digest(objects),experiences:digest(experiences),events:digest(expectedEvents),settled:digest(ended.map(s=>({...s,settled_at:now})))},
   metadata_normalization:'JSON database columns parsed for row comparisons; insert_token must equal exact after.writer, version/handled_version exact CAS version; SQL nullable columns explicit null. Full state_json and world row compared verbatim JSON serialization.',
   derived,interactions:interactions(b.interactions),weather:b.weather,intents:b.intents};
 }catch(error){return {...evidence,status:'NOT_EVALUABLE',full_batch_post_verified:false,reason:String((error as Error).message)};}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const out=verifyBatch(JSON.parse(readFileSync(process.argv[2],'utf8')));writeFileSync(process.argv[3],JSON.stringify(out,null,2)+'\n');
 console.log(JSON.stringify({status:out.status,...('reason' in out?{reason:out.reason}:{settled:out.settled_count,appended:out.appended_count})}));
}
