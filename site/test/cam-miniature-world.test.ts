import {describe,it,expect} from 'vitest';
import {objectBounds,objectVisualKind,contactPlane,canonicalPose,walkFootTargets} from '../public/cam-miniature-world.js';
import {poseAt} from '../public/cam-shared.js';

describe('read-only miniature world adapter',()=>{
 it('uses actual multi-cell bounds, height and media rules without mutating the snapshot',()=>{
  const object={id:'gift',x:4,y:3,z:1.5,footprint:[[0,0],[1,0],[1,1]],sprite:'/media/gift.png',kind:'unknown'};
  const before=JSON.stringify(object);
  expect(objectBounds(object)).toEqual({minX:3.5,maxX:5.5,minY:2.5,maxY:4.5,x:4.5,y:3.5,width:2,depth:2,z:1.5});
  expect(objectVisualKind(object)).toBe('image');
  expect(objectVisualKind({...object,sprite:'https://other.example/gift.png'})).toBe('unknown');
  expect(JSON.stringify(object)).toBe(before);
 });
 it('uses absolute support levels and never raises shadows onto a future platform',()=>{
  const objects=[{x:5,y:0,z:0,levels:[{z:1},{z:2.5}]},{x:5,y:0,z:3,levels:[{z:3}]}];
  expect(contactPlane({x:5,y:0,z:3},objects)).toBe(3);
  expect(contactPlane({x:5,y:0,z:1.8},objects)).toBe(1);
  expect(contactPlane({x:4,y:3,z:3},objects)).toBe(0);
  expect(contactPlane({x:5,y:0,z:3},objects.map(o=>({...o,status:'carried'})))).toBe(0);
 });
 it('keeps existing canonical fallback names',()=>{
  const manifest={sit:{},sleepy:{},look_up:{},alert_loaf:{}};
  expect(canonicalPose('alert-loaf',manifest)).toBe('alert_loaf');
  expect(canonicalPose('back',manifest)).toBe('look_up');
  expect(canonicalPose('unrecognized',manifest)).toBe('sit');
 });
 it('plants stance targets in the shared path frame while the root moves',()=>{
  const segments=[{id:1,start_at:0,end_at:5000,action:'walk',pose:'walk',path:[[0,2],[5,2]],facing:1,z:0}];
  const a=walkFootTargets(segments,poseAt(segments,920)!,920);
  const b=walkFootTargets(segments,poseAt(segments,970)!,970);
  expect(a.front_far.stance).toBe(true);expect(b.front_far.stance).toBe(true);
  expect(a.front_far).toEqual(b.front_far);
  expect(Object.values(a).some(p=>!p.stance&&p.z>0)).toBe(true);
 });
 it('does not sample a superseded walk past its cut',()=>{
  const segments=[{id:1,start_at:0,end_at:5000,cut_at:900,pose:'walk',path:[[0,0],[100,0]],facing:1,z:0}];
  const pose={x:2,y:2,z:0,facing:1,pose:'walk'};
  const feet=walkFootTargets(segments,pose,2200);
  expect(Object.values(feet).every(p=>p.x<3&&p.y<3)).toBe(true);
 });
});
