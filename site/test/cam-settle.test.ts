import {describe,it,expect} from 'vitest';
import catalog from '../public/cam/catalog.json';
import {initialState,assess,RULES} from '../src/worker/cam/engine.ts';
import {planNext} from '../src/worker/cam/plan.ts';
import {applyEffects} from '../public/cam-shared.js';
import {settle} from '../src/worker/cam/settle.ts';
import type {CatalogEntry,Segment} from '../src/worker/cam/types.ts';
const entries=catalog.entries as unknown as CatalogEntry[],objects=entries.map(e=>e.object);
const sleep=():Segment=>({id:1,start_at:0,end_at:1200000,action:'sleep',primitive:'sleep',pose:'sleepy',facing:1,path:[[2,6]],z:0,target:'o_bed',part:null,carrying:null,interaction:null,effects:[],source:'routine',world_version:1,cut_at:null,settled_at:null,superseded_at:null,trigger:null});
describe('cam settlement',()=>{
 it('does nothing until the segment ends',()=>{const s=initialState();expect(settle(s,sleep(),objects,600000).state).toEqual(s);});
 it('cut sleep applies elapsed energy but no discrete result',()=>{const s=initialState(),r=settle(s,{...sleep(),end_at:600000,cut_at:600000},objects,600000);expect(r.state.prefs).toEqual(s.prefs);expect(r.state.familiarity).toEqual({});expect(r.state.nori.energy).toBeCloseTo(s.nori.energy+RULES.energySleep/6);expect(r.events).toEqual([]);});
 it('full sleep changes memory once even with stale segment replay',()=>{const s=initialState(),r=settle(s,sleep(),objects,1200000);expect(r.state.prefs.soft).toBeCloseTo(.5+RULES.prefRate,8);expect(r.state.familiarity.o_bed).toBe(.05);expect(settle(r.state,sleep(),r.objects,1200000).state).toEqual(r.state);expect(settle(r.state,sleep(),r.objects,1200000).events).toEqual([]);});
 it('effects are applied only on normal completion, with shared replay parity',()=>{const s=initialState(),seg={...sleep(),action:'play',target:'o_slipper',effects:[{e:'move_object',dx:1,dy:0}]};const r=settle(s,seg,objects,seg.end_at);expect(r.objects).toEqual(applyEffects(objects,[seg],seg.end_at));expect(r.objects).not.toEqual(objects);expect(settle(s,{...seg,cut_at:seg.end_at},objects,seg.end_at).objects).toEqual(objects);});
 it('planner assessment is exactly the settlement assessment',()=>{
   let state=initialState(),currentObjects=objects;
   const segments=planNext({state,objects,interactions:[entries[0].interactions[0]],position:[2,6],start_at:0,world_version:2,intent:{expires_at:86400000,action:'hide_in',bonus:10}});
   const completions=segments.filter(s=>s.completion);
   expect(completions).toHaveLength(1);
   const experiences=[];
   for(const seg of segments){const r=settle(state,seg,currentObjects,seg.end_at);state=r.state;currentObjects=r.objects;experiences.push(...r.experiences);}
   expect(experiences).toHaveLength(1);
   expect(experiences[0].appraisal).toBe(completions[0].completion!.assessment.appraisal);
   expect(experiences[0].startle).toBe(completions[0].completion!.assessment.startle);
 });
 it('an interrupted earlier step prevents later completion memory',()=>{
   const i={state:initialState(),objects,interactions:[entries[0].interactions[0]],position:[2,6] as [number,number],start_at:0,world_version:2,intent:{expires_at:86400000,action:'hide_in',bonus:10}};
   const segments=planNext(i);expect(segments.filter(s=>s.completion)).toHaveLength(1);
   const run=(cut:boolean)=>{let state=i.state;const experiences=[];for(let j=0;j<segments.length;j++){
     const seg=cut&&j===0?{...segments[j],cut_at:segments[j].end_at}:segments[j];
     const r=settle(state,seg,objects,seg.end_at);state=r.state;experiences.push(...r.experiences);
   }return {state,experiences};};
   expect(run(false).experiences).toHaveLength(1);
   expect(run(true).experiences).toEqual([]);expect(run(true).state.habits).toEqual({});
 });
 it('returns a typed settlement gap without changing state',()=>{
   const s=initialState(),r=settle(s,{...sleep(),start_at:1000},objects,1200000);
   expect(r.error).toEqual({code:'settlement_gap',expected_at:0,actual_at:1000});expect(r.state).toEqual(s);expect(r.events).toEqual([]);
 });
 it('keeps instantaneous sound time when a segment is cut after contact',()=>{const s={...sleep(),action:'interact',cut_at:1000,end_at:1000,effects:[{e:'emit_sound',pattern:'single',at_ms:200}]};expect(settle(initialState(),s,objects,1000).events[0].at).toBe(200);});
});
