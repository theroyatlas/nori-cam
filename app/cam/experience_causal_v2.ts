// Additive, read-only diagnostic. Never imported by the Worker or legacy judge.
import {createHash} from 'node:crypto';
import {continuous, RULES} from '../../site/src/worker/cam/engine.ts';
import {settle} from '../../site/src/worker/cam/settle.ts';
import {candidateScores, choiceProbabilities, type PlanInput} from '../../site/src/worker/cam/plan.ts';
import {validate} from '../../site/src/worker/cam/validate.ts';
import type {Experience, Segment, WorldState, Sensation} from '../../site/src/worker/cam/types.ts';

export function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined)
        .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
    return JSON.stringify(value);
}
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export function differences(a: unknown, b: unknown, path = ''): string[] {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a-b) < 1e-10 ? [] : [path];
    if (canonical(a) === canonical(b)) return [];
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const aa=a as Record<string,unknown>, bb=b as Record<string,unknown>;
        return [...new Set([...Object.keys(aa), ...Object.keys(bb)])].sort()
            .flatMap(k => differences(aa[k],bb[k],path ? path+'.'+k : k));
    }
    return [path];
}
const projection = (input: PlanInput, exp: Experience) => {
    const out=structuredClone(input);
    for (const k of Object.keys(exp.sensations) as Sensation[]) {
        delete (out.state.prefs as Partial<WorldState['prefs']>)[k];
        delete (out.state.wariness as Partial<WorldState['wariness']>)[k];
    }
    delete out.state.familiarity[exp.object_id];
    const habit=out.state.habits[exp.interaction_id];
    if (habit) { habit.n=0; habit.good=0; } // last_at and habit presence are fixed.
    return out;
};
const candidateIdentity = (input: PlanInput, legal = false) => candidateScores(input)
    .filter(c => !legal || validate({objects:input.objects},c.object,c.ix.spec,input.position).spec)
    .map(c => ({id:c.ix.id,object_id:c.object.id,steps:c.ix.spec.steps}));

export function fixedPair(observed: PlanInput, counterfactual: PlanInput, exp: Experience) {
    const fixedDifferences=differences(projection(observed,exp),projection(counterfactual,exp));
    const observedIds=candidateIdentity(observed), counterfactualIds=candidateIdentity(counterfactual);
    const legalObserved=candidateIdentity(observed,true), legalCounterfactual=candidateIdentity(counterfactual,true);
    return {ok:fixedDifferences.length===0 && digest(observedIds)===digest(counterfactualIds)
            && digest(legalObserved)===digest(legalCounterfactual),
        fixed_differences:fixedDifferences, state_differences:differences(observed,counterfactual),
        fixed_hashes:[digest(projection(observed,exp)),digest(projection(counterfactual,exp))],
        candidate_hashes:[digest(observedIds),digest(counterfactualIds)],
        legal_candidate_hashes:[digest(legalObserved),digest(legalCounterfactual)],
        candidates:observedIds, legal_candidates:legalObserved};
}

export interface CausalEvidence {
    target_id: string;
    experience: Experience;
    segment: Segment;
    before: PlanInput;
    observed: PlanInput;
    new_experience_ids: string[];
    completion_event_experience: string;
}
export function experienceCausalV2(e: CausalEvidence) {
    const base={diagnostic:'experience_causal_v2',
        probability:'nominal production choiceProbabilities(candidateScores + rest=1.3), before seeded noise/rest selection/validation retry; not realized behavior',
        experience_id:e.experience.id};
    const unavailable=(reason:string, details:Record<string,unknown>={}) =>
        ({...base,status:'NOT_EVALUABLE',reason,...details});
    const x=e.experience, s=e.segment, before=e.before.state;
    if (e.target_id!==x.object_id || s.target!==x.object_id || s.interaction!==x.interaction_id
        || !s.completion?.last || x.segment_ids.at(-1)!==s.id || s.cut_at!=null || s.superseded_at!=null
        || canonical(s.completion.segment_ids)!==canonical(x.segment_ids)
        || x.segment_ids.some(id=>id!==s.id && !before.settled_ids?.includes(id))
        || e.completion_event_experience!==x.id || canonical(e.new_experience_ids)!==canonical([x.id]))
        return unavailable('missing exact target/completion or overlapping experiences');
    if (before.settled_through!==s.start_at || e.observed.state.settled_through!==x.at || x.at!==s.end_at
        || x.world_version!==s.world_version || !e.observed.state.habits[x.interaction_id])
        return unavailable('not an exact adjacent persisted pre/post settlement sample');
    // This narrow control has no other memory-producing final action/weather event.
    if (s.action==='sleep' || s.action==='hide_in' || x.object_id==='env:sun'
        || e.before.weather?.condition==='thunder') return unavailable('unsupported overlapping memory source');
    const replay=settle(structuredClone(before),{...structuredClone(s),settled_at:null},
        structuredClone(e.before.objects),s.end_at,e.before.weather);
    const formulaDiff=differences(replay.experiences[0],x);
    const storedDiff=differences(replay.state,e.observed.state);
    const objectDiff=differences(replay.objects,e.observed.objects);
    if(replay.error || replay.experiences.length!==1 || formulaDiff.length || storedDiff.length || objectDiff.length)
        return unavailable('persisted experience/formula/post-state mismatch',{formula_differences:formulaDiff,
            stored_differences:storedDiff,object_differences:objectDiff});
    const pre=continuous(before,s.start_at,s.end_at,s.action);
    const expected=Object.fromEntries(Object.entries(x.sensations).map(([k,w])=>[k,RULES.prefRate*w!*Math.tanh(2*x.appraisal)]));
    const clipped=Object.keys(x.sensations).some(k=>Math.abs((x.pref_deltas[k as Sensation]??NaN)-expected[k])>1e-10
        || Math.abs((x.wariness_deltas[k as Sensation]??NaN)-0.15*x.startle)>1e-10)
        || Math.abs(x.familiarity_delta-0.1)>1e-10;
    if(clipped) return unavailable('saturation/daily-cap/truncation prevents unambiguous attribution');
    const counterfactual=structuredClone(e.observed), state=counterfactual.state;
    for(const k of Object.keys(x.sensations) as Sensation[]) {
        state.prefs[k]-=x.pref_deltas[k]!;
        state.wariness[k]-=x.wariness_deltas[k]!;
    }
    state.familiarity[x.object_id]-=x.familiarity_delta;
    state.habits[x.interaction_id].n-=1;
    state.habits[x.interaction_id].good-=x.appraisal>0?1:0;
    const oldHabit=pre.habits[x.interaction_id]??{n:0,good:0,last_at:0};
    if(state.habits[x.interaction_id].n!==oldHabit.n || state.habits[x.interaction_id].good!==oldHabit.good)
        return unavailable('target habit delta mismatch');
    const amount=Object.values(x.pref_deltas).reduce((a,b)=>a+Math.abs(b!),0)
        +Object.values(x.wariness_deltas).reduce((a,b)=>a+Math.abs(b!),0)+Math.abs(x.familiarity_delta);
    if(!Number.isFinite(amount) || amount===0) return unavailable('no attributable target delta');
    const pair=fixedPair(e.observed,counterfactual,x);
    if(!pair.ok) return unavailable('changed fixed state or candidate identities', {pair});
    const targetIds=pair.legal_candidates.filter(c=>c.object_id===x.object_id).map(c=>c.id);
    const probability=(input:PlanInput) => {
        const c=candidateScores(input), p=choiceProbabilities([...c.map(c=>c.score),1.3]);
        return c.reduce((v,c,i)=>v+(targetIds.includes(c.ix.id)?p[i]:0),0);
    };
    const pObserved=probability(e.observed), pCounterfactual=probability(counterfactual), delta=pObserved-pCounterfactual;
    if(!targetIds.length || pCounterfactual<=0) return unavailable('no legal target candidate or zero counterfactual probability',{pair});
    const status=Math.abs(x.appraisal)<=0.1 ? 'NOT_JUDGED'
        : Math.sign(x.appraisal)*delta>0 && Math.abs(delta)/pCounterfactual>=0.1 ? 'PASS':'FAIL';
    return {...base,status,appraisal:x.appraisal,eval_at:e.observed.start_at,
        p_observed:pObserved,p_counterfactual:pCounterfactual,delta,relative_delta:delta/pCounterfactual,
        target_candidate_ids:targetIds,pair,formula_verified:true,persisted_post_verified:true,
        observed:e.observed,counterfactual,expected_preference_deltas:expected};
}
