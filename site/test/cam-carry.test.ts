import {describe,it,expect} from 'vitest';
import {carryPresentation} from '../public/cam-carry.js';

const objects=Object.freeze([Object.freeze({id:'gift',x:0,y:6,status:'placed'}),Object.freeze({id:'other',x:4,y:4,status:'placed'})]);
const carry={id:1,start_at:100,end_at:300,primitive:'carry',carrying:'gift',target:'gift'};
describe('default Canvas carry identity (floor and shadow exclusion)',()=>{
 it('keeps the floor before pickup, draws only the carried identity in flight, restores floor after drop',()=>{
  expect(carryPresentation(objects,[carry],99).floorObjects).toBe(objects);
  const inFlight=carryPresentation(objects,[carry],200);
  expect(inFlight.carried).toBe(objects[0]);expect(inFlight.floorObjects.map(o=>o.id)).toEqual(['other']);
  expect(carryPresentation(objects,[carry],300).carried).toBeNull();
  expect(objects[0].status).toBe('placed');
 });
 it('expires a cut at its exact boundary and ignores a superseded carry',()=>{
  expect(carryPresentation(objects,[{...carry,cut_at:150}],149).carried?.id).toBe('gift');
  expect(carryPresentation(objects,[{...carry,cut_at:150}],150).carried).toBeNull();
  expect(carryPresentation(objects,[{...carry,superseded_at:120}],200).carried).toBeNull();
 });
 it('uses the replacement segment and the explicit carrying identity before a stale status',()=>{
  const statusObjects=[{...objects[0],status:'carried'},objects[1]];
  const replacement={id:2,start_at:150,end_at:250,primitive:'carry',carrying:'other',target:'other'};
  expect(carryPresentation(statusObjects,[carry,replacement],200).carried?.id).toBe('other');
 });
 it('retains authoritative carried status between carry/drop, without mutation',()=>{
  const snapshot=[Object.freeze({...objects[0],status:'carried'})];
  expect(carryPresentation(snapshot,[],310).carried).toBe(snapshot[0]);
  expect(carryPresentation(snapshot,[],310).floorObjects).toEqual([]);
 });
 it('does not resurrect a removed or unknown carried identity',()=>{
  expect(carryPresentation([{...objects[0],status:'removed'}],[carry],200).carried).toBeNull();
  expect(carryPresentation(objects,[{...carry,target:'missing',carrying:'missing'}],200).carried).toBeNull();
 });
});
