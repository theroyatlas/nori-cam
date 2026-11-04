import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {verifyBatch,type BatchSample} from './r37_batch.ts';
import {fixedPair} from './experience_causal_v2.ts';
import {RULES} from '../../site/src/worker/cam/engine.ts';
import {candidateScores,choiceProbabilities,type PlanInput} from '../../site/src/worker/cam/plan.ts';
import {weatherAt} from '../../site/src/worker/cam/weather.ts';
import type {Sensation} from '../../site/src/worker/cam/types.ts';
export function causalBatch(sample:BatchSample){
 const proof=verifyBatch(sample);
 const base={diagnostic:'experience_causal_batch_v1',reconstructed:true,directly_persisted:false,
  full_batch_post_verified:proof.full_batch_post_verified,probability:'nominal production candidateScores softmax + rest 1.3; legal target mass; before RNG noise/rest draw/validation retry; target moment only, not batch endpoint or 24h',proof};
 const unavailable=(reason:string)=>({...base,status:'NOT_EVALUABLE',reason});
 if(proof.status!=='PASS'||!('derived' in proof))return unavailable('full batch provenance rejected');
 const rows=proof.derived.filter(d=>d.experience.object_id===sample.target_id);
 if(rows.length!==1)return unavailable('ambiguous target experience');
 const d=rows[0],x=d.experience,s=d.segment;
 if(s.action==='sleep'||s.action==='hide_in'||x.object_id==='env:sun')return unavailable('overlapping target memory source');
 const at=x.at+Math.max(0,...proof.interactions.filter(i=>i.object_id===x.object_id).map(i=>i.spec.cooldown_min*60000));
 const observed:PlanInput={state:structuredClone(d.after),objects:structuredClone(d.objects_after),
  interactions:structuredClone(proof.interactions),world_version:proof.world_versions[1],start_at:at,
  position:s.path.at(-1)!,weather:weatherAt(proof.weather as any,s.start_at),intents:[]};
 if(observed.weather?.condition==='thunder')return unavailable('unsupported target weather overlap');
 for(const k of Object.keys(x.sensations) as Sensation[]){
  const requested=RULES.prefRate*x.sensations[k]*Math.tanh(2*x.appraisal);
  if(!Number.isFinite(requested)||Math.abs(x.pref_deltas[k]-requested)>1e-10
   ||Math.abs(x.wariness_deltas[k]-0.15*x.startle)>1e-10)return unavailable('clipped/saturated target delta');
 }
 if(Math.abs(x.familiarity_delta-0.1)>1e-10)return unavailable('familiarity saturation');
 const h=observed.state.habits[x.interaction_id],old=d.before.habits[x.interaction_id]??{n:0,good:0};
 if(!h||h.n!==old.n+1||h.good!==old.good+(x.appraisal>0?1:0)||h.last_at!==x.at)return unavailable('habit attribution mismatch');
 const counterfactual=structuredClone(observed),c=counterfactual.state;
 for(const k of Object.keys(x.sensations) as Sensation[]){c.prefs[k]-=x.pref_deltas[k];c.wariness[k]-=x.wariness_deltas[k];}
 c.familiarity[x.object_id]-=x.familiarity_delta;c.habits[x.interaction_id].n--;c.habits[x.interaction_id].good-=x.appraisal>0?1:0;
 const pair=fixedPair(observed,counterfactual,x);
 if(!pair.ok)return unavailable('fixed state/candidates changed');
 const ids=pair.legal_candidates.filter(c=>c.object_id===sample.target_id).map(c=>c.id);
 const probability=(input:PlanInput)=>{const cs=candidateScores(input),ps=choiceProbabilities([...cs.map(c=>c.score),1.3]);return cs.reduce((n,c,i)=>n+(ids.includes(c.ix.id)?ps[i]:0),0);};
 const p=probability(observed),q=probability(counterfactual),delta=p-q;
 if(!ids.length||q<=0)return unavailable('no legal target baseline');
 const status=Math.abs(x.appraisal)<=0.1?'NOT_JUDGED':Math.sign(x.appraisal)*delta>0&&Math.abs(delta)/q>=0.1?'PASS':'FAIL';
 return {...base,status,target_experience_id:x.id,appraisal:x.appraisal,eval_at:at,p_observed:p,p_counterfactual:q,
  delta,relative_delta:delta/q,pair,observed,counterfactual};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=causalBatch(JSON.parse(readFileSync(process.argv[2],'utf8')));writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({status:result.status,proof:result.proof.status,...('reason' in result?{reason:result.reason}:{relative:result.relative_delta})}));
}
