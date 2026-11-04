import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {describe,it,expect} from 'vitest';
import {animState,frontPawTip,pushDraw} from '../public/cam-anim.js';
import {buildDepthItems,depthLayerOf,pruneFloatingFragments} from '../public/cam-props.js';
import {poseAt,project,ORIGIN_X,ORIGIN_Y} from '../public/cam-shared.js';
const f=JSON.parse(readFileSync(new URL('./fixtures/cam-live-heights.json',import.meta.url),'utf8'));
const manifest=JSON.parse(readFileSync(new URL('../public/cam/manifest.json',import.meta.url),'utf8'));
const O=f.server_now;
const tree=f.objects.find((o:any)=>o.kind==='cat_tree');
const shelf=f.objects.find((o:any)=>o.kind==='wall_shelf');
const push=f.segments.find((s:any)=>s.primitive==='touch'&&s.action==='play');
const kf=push.effects.find((e:any)=>e.keyframes).keyframes;
const contact=kf[0].at_ms;
function ids(items:any[]){return items.map(i=>i.id);}

describe('B8 shelf occlusion (fix 1)',()=>{
 it('the wall shelf front layer sorts by its back plane; other props keep their layers',()=>{
  expect(depthLayerOf(shelf,'front')).toBe('back');
  expect(depthLayerOf(shelf,'back')).toBe('back');
  expect(depthLayerOf(tree,'front')).toBe('front');
 });
 it('Nori at the tree top is drawn after every plank of the shelf',()=>{
  const items=buildDepthItems([tree,shelf],{x:5,y:0,z:2.5});
  const nori=ids(items).indexOf('nori');
  for(const [i,id] of ids(items).entries()) if(id===shelf.id) expect(i).toBeLessThan(nori);
 });
 it('Nori on the shelf is drawn after the shelf',()=>{
  const items=buildDepthItems([shelf],{x:5,y:0,z:3});
  const nori=ids(items).indexOf('nori');
  expect(nori).toBeGreaterThan(-1);
  for(const [i,id] of ids(items).entries()) if(id===shelf.id) expect(i).toBeLessThan(nori);
 });
});

describe('B8 floating fragments (fix 2)',()=>{
 const W=6,H=7;
 const px=(d:Uint8ClampedArray,x:number,y:number)=>d[(y*W+x)*4+3];
 function canvas(){
  const d=new Uint8ClampedArray(W*H*4);
  const put=(x:number,y:number)=>{d[(y*W+x)*4]=200;d[(y*W+x)*4+1]=190;d[(y*W+x)*4+2]=170;d[(y*W+x)*4+3]=255;};
  for(let y=2;y<=4;y++)for(let x=1;x<=4;x++)put(x,y);   // body
  put(0,0);                                             // stray pixel above the body: kept
  for(let x=1;x<=3;x++)put(x,6);                        // detached strip under the body: cleared
  return d;
 }
 it('clears a strip wholly below the body and keeps fragments above it',()=>{
  const d=canvas();
  expect(pruneFloatingFragments(d,W,H)).toBe(3);
  expect(px(d,2,6)).toBe(0);
  expect(px(d,1,3)).toBe(255);
  expect(px(d,0,0)).toBe(255);
 });
 it('leaves a body with no detached fragments untouched',()=>{
  const d=canvas();
  for(let x=1;x<=3;x++)d[(6*W+x)*4+3]=0;
  expect(pruneFloatingFragments(d,W,H)).toBe(0);
 });
});

// Decodes public/cam/sprites/stretch.png (8-bit RGBA, non-interlaced) with node:zlib.
function stretchRgba(){
 const buf=readFileSync(new URL('../public/cam/sprites/stretch.png',import.meta.url));
 let p=8,w=0,h=0;const idat:Buffer[]=[];
 while(p<buf.length){
  const len=buf.readUInt32BE(p);const type=buf.toString('latin1',p+4,p+8);const data=buf.subarray(p+8,p+8+len);
  if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);}
  if(type==='IDAT')idat.push(data);
  p+=12+len;
 }
 const raw=inflateSync(Buffer.concat(idat));const stride=w*4;
 const rgba=new Uint8Array(w*h*4);let prev=new Uint8Array(stride);
 for(let y=0;y<h;y++){
  const filter=raw[y*(stride+1)];const line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));const cur=new Uint8Array(stride);
  for(let i=0;i<stride;i++){
   const a=i>=4?cur[i-4]:0,b=prev[i],c=i>=4?prev[i-4]:0;
   let pr=0;
   if(filter===1)pr=a;else if(filter===2)pr=b;else if(filter===3)pr=(a+b)>>1;
   else if(filter===4){const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);pr=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
   cur[i]=(line[i]+pr)&255;
  }
  rgba.set(cur,y*stride);prev=cur;
 }
 return {w,h,rgba};
}
// Grid cell position of a projected point (inverse of project(), z = 0).
function gridOf(sx:number,sy:number){const u=(sx-ORIGIN_X)/16,v=(sy-ORIGIN_Y)/8;return {x:(u+v)/2,y:(v-u)/2};}
function distToSegment(p:{x:number,y:number},a:{x:number,y:number},b:{x:number,y:number}){
 const dx=b.x-a.x,dy=b.y-a.y;const len2=dx*dx+dy*dy;
 const u=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2));
 return Math.hypot(a.x+u*dx-p.x,a.y+u*dy-p.y);
}

describe('B8b push reads as a paw reach (fix 3)',()=>{
 const sprite=stretchRgba();
 const stretch=manifest.stretch;
 const tip=frontPawTip(sprite.rgba,sprite.w,sprite.h,stretch.native_facing)!;
 const paws={stretch:tip};
 it('the decoded sprite matches its manifest size and the paw tip is the front-most lower-third column',()=>{
  expect([sprite.w,sprite.h]).toEqual([stretch.w,stretch.h]);
  expect(tip.x).toBe(0);            // native facing -1: front edge is the left edge
  expect(tip.y).toBeGreaterThan(stretch.h*2/3);
  expect(tip.y).toBeLessThan(stretch.h);
 });
 it('the stretch pose is drawn only from 120 ms before the first slipper keyframe until the last keyframe',()=>{
  expect(animState(f.segments,contact-121,manifest,paws).push).toBeNull();
  expect(animState(f.segments,contact-120,manifest,paws).push?.pose).toBe('stretch');
  expect(animState(f.segments,kf.at(-1).at_ms-1,manifest,paws).push?.pose).toBe('stretch');
  expect(animState(f.segments,kf.at(-1).at_ms,manifest,paws).push).toBeNull();
  // Outside the window the pose is the segment's own pose: the touch segment is sit, the walk before it is walk.
  expect(poseAt(f.segments,kf.at(-1).at_ms+10)?.pose).toBe('sit');
  expect(poseAt(f.segments,contact-200)?.pose).toBe('walk');
 });
 it('inside the window Nori faces the slipper (mirrored) and the shift is whole pixels within 0.4 cell',()=>{
  const d=pushDraw(f.segments,contact+60,manifest,paws)!;
  expect(d.facing).toBe(1);
  expect(d.facing!==stretch.native_facing).toBe(true);   // mirrored
  expect(Number.isInteger(d.dx)).toBe(true);
  expect(Math.abs(d.dx)).toBeLessThanOrEqual(0.4*32);
 });
 it('at the first keyframe the paw tip is within 0.25 cell of the slipper near edge, in projected coordinates',()=>{
  const pos=poseAt(f.segments,contact)!;
  const d=animState(f.segments,contact,manifest,paws).push!;
  const anchor=project(pos.x,pos.y);
  const anchorX=Math.round(anchor.sx)+Math.round(animState(f.segments,contact,manifest,paws).dx);
  const anchorY=Math.round(anchor.sy-(pos.hop||0));
  const flip=d.facing!==stretch.native_facing;
  const sx=anchorX+(flip?-1:1)*(tip.x-stretch.foot[0]);
  const sy=anchorY+(tip.y-stretch.foot[1]);
  // Slipper at its first keyframe: near edge is the side facing Nori at (3,3).
  const obj={x:kf[0].x,y:kf[0].y};
  const edge={a:{x:obj.x-0.5,y:obj.y+0.5},b:{x:obj.x+0.5,y:obj.y+0.5}};
  const dist=distToSegment(gridOf(sx,sy),edge.a,edge.b);
  expect(dist).toBeLessThan(0.25);
 });
 it('the same t gives identical state and identical draw input',()=>{
  for(const t of [contact-120,contact+60,kf.at(-1).at_ms-1,O+6536,O+9000]){
   expect(animState(f.segments,t,manifest,paws)).toEqual(animState(f.segments,t,manifest,paws));
   expect(pushDraw(f.segments,t,manifest,paws)).toEqual(pushDraw(f.segments,t,manifest,paws));
  }
 });
 it('no transition or lean state remains, and no dither code path exists',()=>{
  const a=animState(f.segments,contact+60,manifest,paws);
  expect(a).not.toHaveProperty('transition');
  expect(a).not.toHaveProperty('reach');
  for(let t=O+600000;t<O+616000;t+=37)expect(animState(f.segments,t,manifest,paws)).not.toHaveProperty('transition');
  const cam=readFileSync(new URL('../public/cam.js',import.meta.url),'utf8');
  const anim=readFileSync(new URL('../public/cam-anim.js',import.meta.url),'utf8');
  expect(cam).not.toMatch(/BAYER|dither/i);
  expect(anim).not.toMatch(/BAYER|dither/i);
  expect(anim).not.toMatch(/lean|REACH_/);
  expect(cam).toMatch(/effAnim\.push/);
 });
});

describe('B8 asleep inside the box (fix 4)',()=>{
 const box=(()=>{const n=JSON.parse(readFileSync(new URL('../public/cam/fixture/now.json',import.meta.url),'utf8'));return n.objects.find((o:any)=>o.id==='o_box1');})();
 it.each([['sleepy'],['alert_loaf']])('%s inside the box is drawn before the box front faces',()=>{
  const items=buildDepthItems([box],{x:box.x,y:box.y,z:0,part:'inside'});
  const nori=items.findIndex(i=>i.id==='nori');
  const front=items.findIndex(i=>i.id===box.id&&i.layer==='front');
  const back=items.findIndex(i=>i.id===box.id&&i.layer==='back');
  expect(back).toBeLessThan(nori);
  expect(nori).toBeLessThan(front);
 });
 it('the renderer clips an inside pose to the region above the rim',()=>{
  const cam=readFileSync(new URL('../public/cam.js',import.meta.url),'utf8');
  expect(cam).toMatch(/clipAboveBoxRim\(effBox, fx\)/);
  expect(cam).toMatch(/effPose\.part === 'inside' && effBox/);
 });
});
