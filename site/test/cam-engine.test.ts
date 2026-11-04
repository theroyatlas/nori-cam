import {planNext} from '../src/worker/cam/plan.ts';
import {settle} from '../src/worker/cam/settle.ts';
import {simulate} from '../scripts/simulate.ts';
import {describe,it,expect} from 'vitest';
import {assess,initialState,utility,choose,circadian,preference} from '../src/worker/cam/engine.ts';
import {rng} from '../src/worker/cam/rng.ts';
import catalog from '../public/cam/catalog.json';
import type {CatalogEntry} from '../src/worker/cam/types.ts';
const entry=catalog.entries[0] as unknown as CatalogEntry;
describe('cam life engine',()=>{
 it('seeded RNG repeats',()=>{expect(Array.from({length:20},rng(1))).toEqual(Array.from({length:20},rng(1)));});
 it('covers positive, negative and mixed first impressions over 200 cases',()=>{let positive=0,negative=0,scaredGood=0,scaredBad=0,calmBad=0;for(let i=0;i<200;i++){const s=initialState();s.nori.security=(i%5)/4;s.nori.energy=((i*3)%7)/6;s.nori.curiosity=0.2+(i%4)*0.2;const a=assess(s,'piano',{sound:0.9,motion:0.1},'piano',i);if(a.appraisal>0)positive++;else negative++;if(a.startle>0.15&&a.appraisal>0)scaredGood++;if(a.startle>0.15&&a.appraisal<0)scaredBad++;if(a.startle<=0.15&&a.appraisal<0)calmBad++;}expect(positive).toBeGreaterThanOrEqual(30);expect(negative).toBeGreaterThanOrEqual(30);expect(Math.min(scaredGood,scaredBad,calmBad)).toBeGreaterThan(0);});
 it('familiarity reduces startle over five actual settlements',()=>{
   const object=structuredClone(entry.object);object.id='p';object.blocks=false;object.x=2;object.y=5;
   const ix={id:'noisy',object_id:'p',action:'play',spec:{verb:'touch',sensations:{sound:1,motion:.8},steps:[{p:'move_to',part:'inside'},{p:'touch',part:'inside',ms:500}],end_state:null,cooldown_min:0}};
   let state=initialState(),position:[number,number]=[2,6];const startles=[];
   for(let i=0;i<5;i++){
     const segments=planNext({state,objects:[object],interactions:[ix],position,start_at:state.settled_through,world_version:i+1,intent:{expires_at:86400000,action:'play',bonus:10}});
     expect(segments.filter(s=>s.completion)).toHaveLength(1);
     const experiences=[];
     for(const seg of segments){const r=settle(state,seg,[object],seg.end_at);state=r.state;experiences.push(...r.experiences);}
     expect(experiences).toHaveLength(1);startles.push(experiences[0].startle);
     position=segments.at(-1)!.path.at(-1)!;
     expect(state.familiarity.p).toBeCloseTo((i+1)*.1);
   }
   for(let i=1;i<5;i++)expect(startles[i]).toBeLessThan(startles[i-1]);
 });
 it('sensory preference transfers across objects without affecting other sensations',()=>{const s=initialState(),other={...entry.object,id:'other'},ix={...entry.interactions[0],spec:{...entry.interactions[0].spec,sensations:{sound:.9}}},unrelated={...ix,spec:{...ix.spec,sensations:{soft:.9}}};const base=utility(s,other,ix,0),neutral=utility(s,other,unrelated,0);s.prefs.sound+=.04*Math.tanh(1);expect(utility(s,other,ix,0)).toBeGreaterThan(base);expect(utility(s,other,unrelated,0)).toBe(neutral);s.prefs.sound=.45;expect(utility(s,other,ix,0)).toBeLessThan(base);});
 it('caps daily preference changes and resets on next London day',()=>{const s=initialState();for(let i=0;i<20;i++)preference(s,'soft',.03,0);expect(s.prefs.soft).toBeCloseTo(.6);preference(s,'soft',.03,86400000);expect(s.prefs.soft).toBeCloseTo(.63);});
 it('London DST circadian uses local time',()=>{expect(circadian(Date.UTC(2026,6,1,3))).toBe(.2);expect(circadian(Date.UTC(2026,10,2,3))).toBe(1.6);});
 it('assessment and selection are deterministic',()=>{const s=initialState();expect(assess(s,'p',{sound:1},'i',1)).toEqual(assess(s,'p',{sound:1},'i',1));expect(choose([.1,.2,.3],2,3)).toBe(choose([.1,.2,.3],2,3));});

 it('repeats the full 72-hour simulation and separates seven-day memory profiles',()=>{
 const first=simulate(72,1);expect(simulate(72,1).determinism_hash).toBe(first.determinism_hash);
 const a=simulate(168,1,{soft:.9,shelter:.1}),b=simulate(168,1,{soft:.1,shelter:.9});
 const share=(r:typeof a)=>r.interactions_per_object.o_bed/Object.values(r.interactions_per_object).reduce((x,y)=>x+y,0);
 // Adoption threshold: at least three percentage points in bed-interaction share.
 expect(share(a)-share(b)).toBeGreaterThanOrEqual(.03);
 },60000);
});
