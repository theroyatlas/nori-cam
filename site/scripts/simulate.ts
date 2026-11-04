import {
  createHash
} from 'node:crypto';
import {
  pathToFileURL
} from 'node:url';
import catalog from '../public/cam/catalog.json' with {
  type:'json'
};
import {
  initialState,londonHour
} from '../src/worker/cam/engine.ts';
import {
  planNext
} from '../src/worker/cam/plan.ts';
import {
  settle
} from '../src/worker/cam/settle.ts';
import type {
  CatalogEntry,Cell,Segment
} from '../src/worker/cam/types.ts';
export function simulate(hours=72,seed=1,prefs?:{
  soft:number;
  shelter:number
}) {
  const entries=catalog.entries as unknown as CatalogEntry[];
  let objects=structuredClone(entries.map(e=>e.object)),state=initialState(Date.UTC(2026,10,2)),position:Cell=[2,6];
  if(prefs)Object.assign(state.prefs,prefs);
  const initial={
    ...state.prefs
  },asleep=Array(24).fill(0) as number[],counts:Record<string,number>={
  },habits:Record<string,number>={
  },sunMinutes={
    value:0
  };
  const hash=createHash('sha256'),end=state.settled_through+hours*3600000;
  let at=state.settled_through,segments=0;
  const poses=new Set<string>();
  let restChoices=0;
  while(at<end){
    const next=planNext({
      state,objects,interactions:entries.flatMap(e=>e.interactions),position,start_at:at,world_version:seed
    });
    for(let s of next){
      if(s.start_at>=end)break;
      if(s.end_at>end)s={
        ...s,end_at:end,cut_at:end
      };
      poses.add(s.pose);
      if(s.action==='idle_sit')restChoices++;
      if(s.action==='sleep')for(let t=s.start_at;t<s.end_at;){
        const stop=Math.min(s.end_at,(Math.floor(t/3600000)+1)*3600000);
        asleep[londonHour(t)]+=(stop-t)/60000;
        t=stop;
      }
      if(s.target==='env:sun')sunMinutes.value+=(s.end_at-s.start_at)/60000;
      const result=settle(state,s,objects,s.end_at);
      state=result.state;
      objects=result.objects;
      for(const e of result.experiences)counts[e.object_id]=(counts[e.object_id]||0)+1;
      hash.update(JSON.stringify(s));
      segments++;
      position=s.path.at(-1)!;
      at=s.end_at;
    }
  }
  for(const [k,v] of Object.entries(state.habits))habits[k]=v.n;
  const drift=Object.fromEntries(Object.entries(state.prefs).map(([k,v])=>[k,Number((v-initial[k as keyof typeof initial]).toFixed(6))]));
  const asleepMinutes=asleep.reduce((a,b)=>a+b,0), awakeHours=hours-asleepMinutes/60;
  const interactionCount=Object.values(counts).reduce((a,b)=>a+b,0);
  return {
    asleep_hours_per_day:asleepMinutes/60/(hours/24),
    night_asleep_share:asleep.slice(0,4).reduce((a,b)=>a+b,0)/(hours/24*4*60),
    midday_asleep_share:asleep.slice(11,15).reduce((a,b)=>a+b,0)/(hours/24*4*60),
    interactions_per_awake_hour:(interactionCount-Object.entries(habits).filter(([id])=>entries.some(e=>e.interactions.some(ix=>ix.id===id&&ix.spec.steps.some(s=>s.p==='sleep')))).reduce((n,[,v])=>n+v,0))/awakeHours,
    rest_choices:restChoices,pose_names:[...poses].sort(),
    hours,seed,segments,asleep_minutes_by_london_hour:asleep.map(v=>Number(v.toFixed(3))),interactions_per_object:counts,preference_drift:drift,habit_counts:habits,sun_minutes:Number(sunMinutes.value.toFixed(3)),determinism_hash:hash.digest('hex')
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const arg=(name:string,defaultValue:number)=>{
    const i=process.argv.indexOf(name);
    return i<0?defaultValue:Number(process.argv[i+1]);
  };
  const hours=arg('--hours',72),seed=arg('--seed',1);
  if(!Number.isFinite(hours)||hours<=0||hours>8760||!Number.isFinite(seed))throw new Error('Invalid hours or seed');
  for(const [key,value] of Object.entries(simulate(hours,seed)))console.log(key+': '+JSON.stringify(value));
}
