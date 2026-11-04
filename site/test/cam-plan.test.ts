import {describe,it,expect} from 'vitest';
import catalog from '../public/cam/catalog.json';
import {plan,planNext} from '../src/worker/cam/plan.ts';
import {settle} from '../src/worker/cam/settle.ts';
import {initialState} from '../src/worker/cam/engine.ts';
import {validate,validateCard} from '../src/worker/cam/validate.ts';
import {walkable,applyEffects,cellsOf} from '../public/cam-shared.js';
import type {CatalogEntry} from '../src/worker/cam/types.ts';
const entries=catalog.entries as unknown as CatalogEntry[];
const input=()=>({state:initialState(),objects:entries.map(e=>e.object),interactions:entries.flatMap(e=>e.interactions),position:[2,6] as [number,number],start_at:0,world_version:1});
describe('cam planner and validation',()=>{
 it('catalog cards and interactions validate',()=>{const world={objects:entries.map(e=>e.object)};for(const e of entries){expect(validateCard(e.object.card,true),e.object.id).toEqual([]);for(const ix of e.interactions)expect(validate(world,e.object,ix.spec,[2,6]).status,ix.id).toBe('accepted');}});
 it('plans day and night contiguously and checks every primitive against changing geometry',()=>{
   for(const start of [0,12*3600000,18*3600000]){
     const i=input();i.start_at=start;i.state.settled_through=start;
     const before=structuredClone(i),a=plan(i,start+3600000);
     expect(i).toEqual(before);expect(a).toEqual(plan(i,start+3600000));
     if(!Array.isArray(a))throw new Error(JSON.stringify(a.error));
     expect(a.at(-1)!.end_at).toBeGreaterThanOrEqual(start+3600000);
     let objects=structuredClone(i.objects);
     for(let j=0;j<a.length;j++){
       const seg=a[j],free=walkable({objects});
       expect(seg.end_at).toBeGreaterThan(seg.start_at);
       if(j){expect(seg.start_at).toBe(a[j-1].end_at);expect(seg.path[0]).toEqual(a[j-1].path.at(-1));}
       for(const cell of seg.path){
         if(free.some(c=>c[0]===cell[0]&&c[1]===cell[1]))continue;
         const containing=objects.find(o=>o.blocks&&cellsOf(o).some(c=>c[0]===cell[0]&&c[1]===cell[1]));
         expect(containing,JSON.stringify(seg)).toBeDefined();
         expect(containing!.tags.some(t=>t==='enclosed'||t==='high_place')).toBe(true);
         expect(['climb','hold_pose','sleep']).toContain(seg.primitive);
       }
       objects=applyEffects(objects,[seg],seg.end_at);
     }
   }
 });
 it('reaction takes priority',()=>{const a=planNext({...input(),reaction:{event_id:'e1',pose:'startled'}});expect(a[0].source).toBe('reaction:e1');});
 it('rejects schema injection, invalid parts and inappropriate prop poses',()=>{const i=input(),o=i.objects[0],spec=i.interactions[0].spec;expect(validate(i,o,{...spec,preference_delta:1},i.position).status).toBe('rejected');expect(validate(i,o,{...spec,steps:[{p:'touch',part:'viewport',ms:500}]},i.position).status).toBe('rejected');expect(validate(i,{...o,id:'gift'}, {...spec,steps:[{p:'hold_pose',pose:'laptop',ms:1000}]},i.position).status).toBe('rejected');});
 it('degrades unsupported look-through deterministically',()=>{const i=input(),o=i.objects[0],spec={...i.interactions[0].spec,steps:[{p:'move_to',part:'inside'},{p:'look_through',part:'inside'}]};const v=validate(i,o,spec,i.position);expect(v.status).toBe('degraded');expect(v.gaps).toHaveLength(1);expect(v).toEqual(validate(i,o,spec,i.position));});
 it('rejects tall touch and sound without sound sensation',()=>{const i=input(),o=i.objects[0];const spec={...i.interactions[0].spec,steps:[{p:'move_to',part:'inside'},{p:'touch',part:'inside',ms:500,effects:[{e:'emit_sound',pattern:'single'}]}]};expect(validate(i,o,spec,i.position).status).toBe('rejected');});

 it('carries a prefab along legal legs and drops it at the validated point',()=>{const i=input(),ix=entries[1].interactions.find(i=>i.action==='carry')!;const segments=planNext({...i,interactions:[ix]});for(const seg of segments)for(const c of seg.path)expect(walkable(i)).toContainEqual(c);let state=i.state,objects=i.objects;for(const segment of segments){const r=settle(state,segment,objects,segment.end_at);state=r.state;objects=r.objects;}expect(objects.find(o=>o.id===ix.object_id)).toMatchObject({x:4,y:2,status:'placed'});expect(segments.some(s=>s.primitive==='carry')).toBe(true);});
 it('enters and exits the enclosed prefab without walking through blocked cells',()=>{const i=input(),segments=planNext({...i,interactions:[entries[0].interactions[1]]});expect(segments.some(s=>s.primitive==='climb'&&s.part==='inside')).toBe(true);const last=segments.at(-1)!,next=planNext({...i,start_at:last.end_at,position:last.path.at(-1)!,interactions:entries[1].interactions});expect(next[0].primitive).toBe('climb');expect(next[0].path[0]).toEqual(last.path.at(-1));});
});
