import type {BatchSample} from './r37_batch.ts';
export const mutations:Record<string,(s:BatchSample)=>void>={
 'corrupt entire post state':s=>{const state=JSON.parse(s.after.world[0].state_json);state.nori.energy+=0.01;s.after.world[0].state_json=JSON.stringify(state);},
 'drop prior segment':s=>{s.before.segments.splice(s.before.segments.findIndex(r=>r.id===6000000013),1);},
 'reorder input':s=>{[s.before.segments[0],s.before.segments[1]]=[s.before.segments[1],s.before.segments[0]];},
 'foreign segment':s=>{s.before.segments.find(r=>r.id===6000000013)!.target='o_water_bowl';},
 'changed weather':s=>{s.after.weather.push({hour_utc:1793800800000,condition:'thunder'});},
 'wrong CAS':s=>{s.after.world[0].version++;},
 'wrong settled time':s=>{s.after.segments.find(r=>r.id===6000000013)!.settled_at++;},
 'non-target object':s=>{s.after.objects.find(r=>r.id==='o_water_bowl')!.x++;},
 'extra experience':s=>{s.after.experiences.push({...s.after.experiences[0],id:'foreign-exp'});},
 'extra event':s=>{s.after.events.push({...s.after.events[0],id:'foreign-event'});},
 'changed prior event':s=>{s.after.events[0].actor='foreign';},
 'corrupt planned row':s=>{s.after.segments.find(r=>r.id===8000000000)!.pose='foreign';},
 'missing weather source':s=>{delete (s.before as any).weather;},
};
