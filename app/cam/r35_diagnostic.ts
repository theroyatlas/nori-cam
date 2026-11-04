import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {decodeObject,decodeSegment} from '../../site/src/worker/cam/store.ts';
import {weatherAt} from '../../site/src/worker/cam/weather.ts';
import {experienceCausalV2, type CausalEvidence} from './experience_causal_v2.ts';
import type {Experience} from '../../site/src/worker/cam/types.ts';

type Row=Record<string,any>;
export function decodeEvidence(raw: {before:Row;after:Row;target_id:string}): CausalEvidence {
    const {before,after,target_id}=raw;
    const x={...after.experiences.find((x:Row)=>x.object_id===target_id)} as Row;
    for(const key of ['segment_ids','sensations','pref_deltas','wariness_deltas']) x[key]=JSON.parse(x[key]);
    const segment=decodeSegment(after.segments.find((s:Row)=>s.id===x.segment_ids.at(-1)));
    const at=x.at+Math.max(0,...after.interactions.filter((i:Row)=>i.object_id===target_id)
        .map((i:Row)=>JSON.parse(i.spec).cooldown_min*60000));
    const plan=(snap:Row)=>({state:JSON.parse(snap.world[0].state_json),
        objects:snap.objects.map(decodeObject),interactions:snap.interactions.map((i:Row)=>{
            const {action,...spec}=JSON.parse(i.spec);return {id:i.id,object_id:i.object_id,action,spec};}),
        start_at:at,world_version:after.world[0].version,position:segment.path.at(-1)!,
        weather:weatherAt(after.weather,segment.start_at),intents:after.intents
            .filter((i:Row)=>i.status==='active' && i.expires_at>at)
            .map((i:Row)=>({...JSON.parse(i.accepted),id:i.id,expires_at:i.expires_at}))});
    const event=after.events.find((ev:Row)=>ev.type==='experience_settled' && JSON.parse(ev.payload).experience===x.id);
    return {target_id,experience:x as Experience,segment,before:plan(before),observed:plan(after),
        new_experience_ids:after.experiences.filter((x:Row)=>!before.experiences.some((b:Row)=>b.id===x.id)).map((x:Row)=>x.id),
        completion_event_experience:event ? JSON.parse(event.payload).experience:''};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    const result=experienceCausalV2(decodeEvidence(JSON.parse(readFileSync(process.argv[2],'utf8'))));
    writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({diagnostic:result.diagnostic,status:result.status,...('reason' in result?{reason:result.reason}:{})}));
}
