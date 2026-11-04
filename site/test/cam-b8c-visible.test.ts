// B8c: every object with keyframes is drawn at its rest position, at the first
// keyframe, in the middle, and after the last keyframe. Draw calls are recorded
// (no screenshot); the same t must give the same draw input and the same paint.
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {drawPropLayer,buildDepthItems,interpolateObjects} from '../public/cam-props.js';
import {poseAt,project} from '../public/cam-shared.js';

const FIXTURES:Record<string,any>={
 heights:JSON.parse(readFileSync(new URL('./fixtures/cam-live-heights.json',import.meta.url),'utf8')),
 now:JSON.parse(readFileSync(new URL('../public/cam/fixture/now.json',import.meta.url),'utf8')),
};

// Recording ctx: tracks translate() and records every point the prop paints.
function recorder(){
 const pts:[number,number][]=[];
 const stack:[number,number][]=[];
 let ox=0,oy=0,ops=0;
 const ctx:any={
  fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,
  save(){stack.push([ox,oy]);},
  restore(){const p=stack.pop();if(p){ox=p[0];oy=p[1];}},
  translate(x:number,y:number){ox+=x;oy+=y;},
  rotate(){},
  beginPath(){ops+=1;},closePath(){},
  moveTo(x:number,y:number){pts.push([x+ox,y+oy]);},
  lineTo(x:number,y:number){pts.push([x+ox,y+oy]);},
  fill(){ops+=1;},stroke(){ops+=1;},
  fillRect(x:number,y:number,w:number,h:number){ops+=1;pts.push([x+ox,y+oy],[x+w+ox,y+h+oy]);},
  strokeRect(x:number,y:number,w:number,h:number){ops+=1;pts.push([x+ox,y+oy],[x+w+ox,y+h+oy]);},
  ellipse(){ops+=1;},
 };
 return {ctx,pts,ops:()=>ops};
}
function bbox(pts:[number,number][]){
 const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
 return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};
}
// Draws one object alone and returns its paint bounds (null when nothing is painted).
function paint(obj:any,t:number){
 const r=recorder();
 const drew=drawPropLayer(r.ctx,obj,'single',{t,activeAction:null,activeTargetId:null,activePrimitive:null});
 return {drew,ops:r.ops(),box:r.pts.length?bbox(r.pts):null};
}
function keyedEffects(fixture:any){
 const out:{objId:string;frames:any[];}[]=[];
 for(const seg of fixture.segments||[])for(const e of seg.effects||[]){
  if(!Array.isArray(e.keyframes)||e.keyframes.length<2) continue;
  out.push({objId:e.object_id||seg.target,frames:e.keyframes});
 }
 return out;
}

const keyed={heights:keyedEffects(FIXTURES.heights),now:keyedEffects(FIXTURES.now)};

describe('B8c keyframed objects in the fixtures',()=>{
 it('heights has exactly one keyframed object (o_slipper); now.json has none',()=>{
  expect(keyed.heights.map(k=>k.objId)).toEqual(['o_slipper']);
  expect(keyed.now).toEqual([]);
 });
});

for(const name of ['heights','now'] as const){
 const fixture=FIXTURES[name];
 for(const k of keyed[name]){
  describe(`${name} ${k.objId} is drawn outside and inside its keyframes`,()=>{
   const base=fixture.objects.find((o:any)=>o.id===k.objId);
   const first=k.frames[0];
   const last=k.frames[k.frames.length-1];
   const mid=Math.round((first.at_ms+last.at_ms)/2);
   const times={before:first.at_ms-1000,first:first.at_ms,mid,after:last.at_ms+1000};

   it('the object is in the object model and placed',()=>{
    expect(base).toBeDefined();
    expect(base.status).toBe('placed');
   });

   for(const [label,t] of Object.entries(times)){
    it(`${label} (t=${t}): drawn, at the position the object model gives`,()=>{
     const objs=interpolateObjects(fixture.objects,fixture.segments,t);
     const o=objs.find((x:any)=>x.id===k.objId)!;
     expect(o.status).toBe('placed');
     const p=paint(o,t);
     expect(p.drew).toBe(true);
     expect(p.ops).toBeGreaterThan(0);
     const c=project(o.x,o.y,o.z||0);
     expect(p.box!.minX).toBeLessThanOrEqual(c.sx+1);
     expect(p.box!.maxX).toBeGreaterThanOrEqual(c.sx-1);
     expect(p.box!.minY).toBeLessThanOrEqual(c.sy+1);
     expect(p.box!.maxY).toBeGreaterThanOrEqual(c.sy-1);
    });
   }

   it('rest, first keyframe, last keyframe and after-last positions match the object model',()=>{
    const at=(t:number)=>{const o=interpolateObjects(fixture.objects,fixture.segments,t).find((x:any)=>x.id===k.objId)!;return {x:o.x,y:o.y};};
    expect(at(times.before)).toEqual({x:base.x,y:base.y});
    expect(at(times.first)).toEqual({x:first.x,y:first.y});
    expect(at(times.after)).toEqual({x:last.x,y:last.y});
    const m=at(times.mid);
    expect(m.x).toBeGreaterThanOrEqual(Math.min(first.x,last.x));
    expect(m.x).toBeLessThanOrEqual(Math.max(first.x,last.x));
   });

   it('the same t gives identical object state and identical draw input',()=>{
    const once=()=>{const objs=interpolateObjects(fixture.objects,fixture.segments,times.mid);return {objs:JSON.stringify(objs),paint:paint(objs.find((x:any)=>x.id===k.objId),times.mid)};};
    const a=once(),b=once();
    expect(b).toEqual(a);
   });
  });
 }
}

describe('B8c slipper before its play segment (heights, t=612950)',()=>{
 const f=FIXTURES.heights;
 const O=f.server_now;
 const t=O+612950;
 it('the slipper is drawn, not dropped: its paint is issued before Nori is drawn',()=>{
  const objs=interpolateObjects(f.objects,f.segments,t);
  const slip=objs.find((o:any)=>o.id==='o_slipper')!;
  expect(paint(slip,t).ops).toBeGreaterThan(0);
  const items=buildDepthItems(objs,poseAt(f.segments,t));
  const ids=items.map(i=>i.id);
  expect(ids.indexOf('o_slipper')).toBeGreaterThan(-1);
  // Nori walks in front of the slipper (larger depth), so she is painted over it.
  expect(items[ids.indexOf('nori')].depth).toBeGreaterThan(items[ids.indexOf('o_slipper')].depth);
  expect(ids.indexOf('o_slipper')).toBeLessThan(ids.indexOf('nori'));
 });
});
