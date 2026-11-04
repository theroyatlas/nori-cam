// Local persistent owner runner entry. Production default entry does not expose this hook.
import {handle} from '../../site/src/worker/index.ts';
import {bearer} from '../../site/src/worker/cam/auth.ts';
import {reserve} from '../../site/src/worker/cam/budget.ts';
import {advance} from '../../site/src/worker/cam/timeline.ts';
import {json} from '../../site/src/worker/headers.ts';
import type {GiftEnv} from '../../site/src/worker/cam/gifts.ts';
type OwnerEnv=GiftEnv & {CAM_OWNER_LIVE?:string;CAM_LOCAL_WALL_CLOCK?:string};
export async function ownerHandle(req:Request,env:OwnerEnv,ctx?:ExecutionContext){
 const path=new URL(req.url).pathname;
 if(path==='/api/owner/advance'){
  if(env.CAM_OWNER_LIVE!=='1'||env.CAM_LOCAL_PIPELINE!=='1'||env.CAM_LOCAL_WALL_CLOCK!=='1')return json({error:'not_found'},404);
  if(req.method!=='POST'||!bearer(req,env))return json({error:'unauthorized'},401);
  const result=await advance(env,Date.now(),'read');
  return json({won:result.won,server_now:Date.now()});
 }
 if(path==='/api/owner/experience-reflect'){
  if(env.CAM_OWNER_LIVE!=='1'||env.CAM_LOCAL_PIPELINE!=='1'||env.CAM_LOCAL_WALL_CLOCK!=='1')return json({error:'not_found'},404);
  if(req.method!=='POST'||!bearer(req,env))return json({error:'unauthorized'},401);
  const body=await req.json() as {experience_id?:unknown};
  if(typeof body.experience_id!=='string'||body.experience_id.length>240)return json({error:'invalid experience'},400);
  // A real completed photo-gift experience is mandatory. Never create a physical segment,
  // experience, sleep or intent here: only annotate its already-settled completion for dispatch.
  const row=await env.DB.prepare(`SELECT x.id,x.object_id,json_extract(x.segment_ids,'$[#-1]') AS segment_id
   FROM experiences x JOIN gifts g ON g.object_id=x.object_id JOIN segments s ON s.id=json_extract(x.segment_ids,'$[#-1]')
   WHERE x.id=? AND g.kind='photo' AND g.status='ready' AND s.settled_at IS NOT NULL
   AND s.cut_at IS NULL AND s.superseded_at IS NULL AND json_extract(s.completion,'$.last')=1
   AND EXISTS(SELECT 1 FROM events e WHERE e.type='experience_settled' AND json_extract(e.payload,'$.experience')=x.id)
   AND NOT EXISTS(SELECT 1 FROM segments old JOIN experiences other ON old.id=json_extract(other.segment_ids,'$[#-1]')
     WHERE other.object_id=x.object_id AND json_extract(old.debug,'$.owner_live_reflect') IS NOT NULL)
   LIMIT 1`).bind(body.experience_id).first<{id:string;object_id:string;segment_id:number}>();
  if(!row)return json({error:'new completed photo experience required'},409);
  const now=Date.now(),ref=`seg:${row.segment_id}`;
  if(!await reserve(env,'wonder',ref,0.75,20,now))return json({error:'local reflection budget exhausted'},429);
  const result=await env.DB.prepare(`UPDATE segments SET trigger=?,trigger_claimed_at=?,trigger_status='dispatched',
    debug=json_set(COALESCE(debug,'{}'),'$.owner_live_reflect',?) WHERE id=? AND settled_at IS NOT NULL
    AND trigger_claimed_at IS NULL`).bind(JSON.stringify({kind:'reflect'}),now,row.id,row.segment_id).run();
  if(!result.meta.changes)return json({error:'already claimed'},409);
  return json({intent_id:ref,experience_id:row.id,dispatch:'local actual-experience reflection; no synthetic sleep'});
 }
 return handle(req,env,{},ctx);
}
export default {fetch:ownerHandle};
