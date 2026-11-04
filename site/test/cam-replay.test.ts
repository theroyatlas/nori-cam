import {describe,it,expect} from 'vitest';
import {replayObjectsAt,replayPoseAt,replayEffectSegments} from '../public/cam-replay.js';
import {interpolateObjects} from '../public/cam-props.js';
describe('historical miniature replay',()=>{
 const replay={from:100,to:400,objects:[{id:'old',x:1,y:1,z:0,kind:'toy'}],object_states:[
  {id:1,object_id:'old',valid_from:150,x:2,y:1,z:0},
  {id:2,object_id:'new',valid_from:250,x:4,y:3,z:1.5,footprint:'[[0,0],[1,0]]',sprite:'procedural:cushion',status:'placed'},
  {id:3,object_id:'old',valid_from:300,status:'removed',x:2,y:1,z:0},
 ]};
 const current=[{id:'old',x:99,y:99,z:9},{id:'new',x:99,y:99,z:9,kind:'cushion'}];
 it('does not leak future gifts or current positions into the past',()=>{
  const before=JSON.stringify({replay,current});
  expect(replayObjectsAt(replay,current,200)).toEqual([{id:'old',x:2,y:1,z:0,kind:'toy'}]);
  const after=replayObjectsAt(replay,current,280).find(o=>o.id==='new');
  expect(after).toMatchObject({x:4,y:3,z:1.5,footprint:[[0,0],[1,0]],kind:'cushion'});
  expect(JSON.stringify({replay,current})).toBe(before);
 });
 it('honours historical removals',()=>expect(replayObjectsAt(replay,current,350).find(o=>o.id==='old').status).toBe('removed'));
 it('rejects incomplete ranges and invalid timestamps',()=>{
  expect(()=>replayObjectsAt({...replay,truncated:true},current,200)).toThrow(/truncated/);
  expect(()=>replayObjectsAt(replay,current,99)).toThrow(RangeError);
 });
 it('does not apply already settled effects a second time',()=>{
  const objects=replayObjectsAt(replay,current,200);
  const segment={id:1,start_at:100,end_at:150,action:'play',target:'old',effects:[{type:'move_object',object_id:'old',x:2,y:1}]};
  expect(interpolateObjects(objects,[segment],200,200).find(o=>o.id==='old')?.x).toBe(2);
 });
 it('preserves original movement speed before a cut and the cut position after it',()=>{
  const segments=[{id:1,start_at:0,end_at:1000,cut_at:400,action:'walk',pose:'walk',path:[[0,0],[10,0]],z:0}];
  expect(replayPoseAt(segments,200).x).toBe(2);
  expect(replayPoseAt(segments,600)).toMatchObject({pose:'sit',held:true,hop:0});
  expect(replayPoseAt(segments,600).x).toBeCloseTo(4,3);
 });
 it('selects the replacement segment after a cut',()=>{
  const segments=[{id:1,start_at:0,end_at:1000,cut_at:400,action:'walk',pose:'walk',path:[[0,0],[10,0]],z:0},
   {id:2,start_at:400,end_at:1000,action:'rest',pose:'sit',path:[[4,0]],z:0}];
  expect(replayPoseAt(segments,600)).toMatchObject({x:4,y:0,pose:'sit',segmentId:2});
 });
 it('keeps a future-cut segment available for historical effects only before its cut',()=>{
  const segments=[{id:1,start_at:0,end_at:1000,cut_at:400}];const raw=JSON.stringify(segments);
  expect(replayEffectSegments(segments,200)[0].cut_at).toBeNull();
  expect(replayEffectSegments(segments,600)).toEqual([]);
  expect(JSON.stringify(segments)).toBe(raw);
 });
});
