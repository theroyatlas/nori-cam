import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {poseAt,project} from '../public/cam-shared.js';
import {buildDepthItems,drawProp,hasDrawPath,interpolateObjects} from '../public/cam-props.js';
import {supportShadow} from '../public/cam-scene.js';
const f=JSON.parse(readFileSync(new URL('./fixtures/cam-live-heights.json',import.meta.url),'utf8'));
const push=f.segments.find((s:any)=>s.effects.some((e:any)=>e.keyframes));
const frames=push.effects.find((e:any)=>e.keyframes).keyframes;
const slip=()=>interpolateObjects(f.objects,f.segments,0).find(o=>o.id==='o_slipper')!;
function recordingContext() {
 const ops:any[]=[];
 const ctx:any=new Proxy({}, {get:(_,key)=> key==='ops'?ops:(...args:any[])=>ops.push([key,...args]),set:(_,key,v)=>{ops.push([key,v]);return true;}});
 return ctx;
}
describe('B7 renderer contract',()=>{
 it('all height fixture kinds paint (sun deliberately invisible)',()=>{
  for(const o of f.objects){ expect(hasDrawPath(o.kind)).toBe(true);const c=recordingContext();expect(drawProp(c,o,{t:6536})).toBe(o.kind!=='env:sun'); }
 });
 it('top is exactly 40 logical pixels above floor',()=>{expect(project(5,0,0).sy-project(5,0,2.5).sy).toBe(40);});
 it('all climbs interpolate monotonic elevation and have a bounded jump arc',()=>{
  for(const s of f.segments.filter((s:any)=>s.primitive==='climb')){
   let prev=s.z_from;
   for(let i=0;i<=10;i++){
    const p=poseAt([s],s.start_at+(s.end_at-s.start_at)*i/10)!;
    expect(p.z).toBeCloseTo(s.z_from+(s.z_to-s.z_from)*i/10);
    expect((p.z-prev)*Math.sign(s.z_to-s.z_from)).toBeGreaterThanOrEqual(-1e-8);
    expect(p.hop).toBeGreaterThanOrEqual(0);expect(p.hop).toBeLessThanOrEqual(10);prev=p.z;
   }
  }
 });
 it('shadow sits on tree/desk/shelf planes and below the jump',()=>{
  for(const z of [0,1,2.5,3])expect(supportShadow({x:5,y:0,z},f.objects).sy).toBe(project(5,0,z).sy);
  expect(supportShadow({x:8,y:1,z:1.5},f.objects).sy).toBe(project(8,1,1.5).sy);
  const p=poseAt(f.segments,f.server_now+6236)!;
  expect(supportShadow(p,f.objects).z).toBe(1);
 });
 it.each([[-1,'behind'],[1,'front']])('tree post ordering %s (%s)',(offset)=>{
  const tree=f.objects.find((o:any)=>o.kind==='cat_tree');
  const entries=buildDepthItems([tree],{x:5,y:Number(offset),z:0});
  const n=entries.findIndex(i=>i.id==='nori');
  const post=entries.findIndex(i=>i.id===tree.id&&i.layer==='back');
  expect(n<post).toBe(offset===-1);
 });
 it('height breaks a floor depth tie',()=>{
  const tree=f.objects.find((o:any)=>o.kind==='cat_tree');
  const e=buildDepthItems([tree],{x:5,y:0,z:2.5});expect(e.find(i=>i.id==='nori')!.depth).toBeCloseTo(5.025);
 });
 it.each([0,1,2])('absolute keyframes interpolate interval %s',(i)=>{
  const a=frames[i],b=frames[i+1],t=(a.at_ms+b.at_ms)/2;
  const o=interpolateObjects(f.objects,f.segments,t).find(o=>o.id==='o_slipper')!;
  expect(o.x).toBeCloseTo((a.x+b.x)/2);expect(o.y).toBeCloseTo((a.y+b.y)/2);
 });
 it('snaps after segment without adding final delta twice',()=>{
  const o=interpolateObjects(f.objects,f.segments,push.end_at+500).find(o=>o.id==='o_slipper')!;
  expect(o.x).toBe(frames.at(-1).x);
  const settled=f.objects.map((o:any)=>o.id==='o_slipper'?{...o,x:frames.at(-1).x}:o);
  expect(interpolateObjects(settled,f.segments,push.end_at+500,push.end_at).find(o=>o.id==='o_slipper')!.x).toBe(o.x);
 });
 it('later non-keyframed movement wins over an earlier completed trajectory',()=>{
  const later={id:9999999999,start_at:push.end_at+1,end_at:push.end_at+500,target:'o_slipper',effects:[{e:'move_object',dx:1,dy:0}]};
  expect(interpolateObjects(f.objects,[push,later],later.end_at).find(o=>o.id==='o_slipper')!.x).toBe(frames.at(-1).x+1);
 });
 it('cut and superseded trajectories restore authoritative geometry',()=>{
  for(const flag of [{cut_at:push.start_at+50},{superseded_at:push.start_at+50}])
   expect(interpolateObjects(f.objects,[{...push,...flag}],push.start_at+100).find(o=>o.id==='o_slipper')!.x).toBe(slip().x);
 });
 it('draw calls are deterministic for the same t',()=>{
  const a=recordingContext(),b=recordingContext();
  for(const o of f.objects){drawProp(a,o,{t:9000});drawProp(b,o,{t:9000});}expect(a.ops).toEqual(b.ops);
 });
 it('drawing modules contain no wall clock or random calls',()=>{
  for(const name of ['cam.js','cam-props.js','cam-scene.js','cam-anim.js']){
   const source=readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
   expect(source).not.toMatch(/\bDate\b|Math\.random|performance\.now/);
  }
 });
});
