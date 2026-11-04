/**
 * simulatePush({object, world, velocity, dropHeight256?}): keyframes, effect.
 * velocity is an integer [x,y] in cells/second, clamped per axis to 15.
 * dropHeight256 is an integer height in 1/256 cells above the floor (0..2048).
 * The object must be placed, floor-based, pushable, and initially legal.
 * Returns relative milliseconds; the planner supplies segment start time.
 */
import {cellsOf, placementOk} from '../../../public/cam-shared.js';
import type {CamObject, Cell, Effect, GeometryWorld} from './types.ts';

export interface PhysicsInput { object:CamObject; world:GeometryWorld; velocity:Cell; dropHeight256?:number }
export interface PhysicsFrame { at_ms:number; x:number; y:number; z:number }
export interface PhysicsResult { keyframes:PhysicsFrame[]; effect:Effect }
const UNIT=256, QUANTUM=16;
const trunc=(n:number)=>Math.trunc(n);
const quant=(n:number)=>Math.round(n/QUANTUM)*QUANTUM;
const time=(step:number)=>Math.round(step*1000/60);

export function simulatePush({object,world,velocity,dropHeight256=0}:PhysicsInput):PhysicsResult {
  if (!object.card?.space?.movable?.push && !object.tags?.includes('pushable')) throw new Error('object is not pushable');
  if (object.status!=='placed' || object.placement!=='floor' || !Number.isInteger(object.x) || !Number.isInteger(object.y) || !cellsOf(object).length) throw new Error('object must be placed on the floor at a cell');
  if (!Array.isArray(velocity) || velocity.length!==2 || velocity.some(v=>!Number.isSafeInteger(v)) || !Number.isInteger(dropHeight256) || dropHeight256<0 || dropHeight256>2048) throw new Error('invalid velocity or height');
  if (!placementOk(world,object).ok) throw new Error('initial placement is illegal');
  const own=cellsOf(object).map(([x,y])=>[x-object.x,y-object.y] as Cell);
  const obstacles=world.objects.filter(o=>o.id!==object.id && o.blocks).flatMap(cellsOf);
  // Swept bounding boxes, including rounded display endpoints. Touching is allowed.
  const clear=(ax:number,ay:number,bx:number,by:number):boolean=>{
    const minX=Math.min(ax,bx,quant(ax),quant(bx)), maxX=Math.max(ax,bx,quant(ax),quant(bx));
    const minY=Math.min(ay,by,quant(ay),quant(by)), maxY=Math.max(ay,by,quant(ay),quant(by));
    for (const [ox,oy] of own) {
      if (minX+ox*UNIT<0 || maxX+ox*UNIT>9*UNIT || minY+oy*UNIT<0 || maxY+oy*UNIT>7*UNIT) return false;
      for (const [cx,cy] of obstacles) if (minX+ox*UNIT<(cx+1)*UNIT && maxX+ox*UNIT>(cx-1)*UNIT && minY+oy*UNIT<(cy+1)*UNIT && maxY+oy*UNIT>(cy-1)*UNIT) return false;
    }
    return true;
  };
  let x=object.x*UNIT,y=object.y*UNIT,z=dropHeight256, vz=0, step=0;
  let vx=trunc(Math.max(-15,Math.min(15,velocity[0]))*UNIT/60), vy=trunc(Math.max(-15,Math.min(15,velocity[1]))*UNIT/60);
  const frames:PhysicsFrame[]=[];
  const emit=()=>{const f={at_ms:time(step),x:quant(x)/UNIT,y:quant(y)/UNIT,z:quant(z)/UNIT}; if (frames.length && frames[frames.length-1].at_ms===f.at_ms) frames[frames.length-1]=f; else frames.push(f);};
  emit();
  while ((vx!==0 || vy!==0 || z!==0 || vz!==0) && step<600) {
    step++;
    const nx=x+vx, ny=y+vy;
    // At most one cell in total: the existing executor's move_object contract.
    const limited=Math.abs(nx-object.x*UNIT)+Math.abs(ny-object.y*UNIT)>UNIT;
    let contact=false;
    if ((vx || vy) && (limited || !clear(x,y,nx,ny))) {vx=0;vy=0;contact=true;} else {x=nx;y=ny;}
    if (vx) vx-=Math.sign(vx)*Math.min(2,Math.abs(vx));
    if (vy) vy-=Math.sign(vy)*Math.min(2,Math.abs(vy));
    if (z || vz) {
      vz-=2; z+=vz;
      if (z<=0) {z=0;vz=trunc(-vz*3/5);if(vz<4)vz=0;contact=true;}
    }
    if (step%3===0 || contact || (!vx&&!vy&&!z&&!vz)) emit();
  }
  // Find a legal cell reached from the recorded path. Reverse the path if needed,
  // preserving collision-free interpolation rather than teleporting through furniture.
  let chosen=-1, tx=0, ty=0;
  for (let i=frames.length-1;i>=0;i--) {
    const f=frames[i], cx=Math.round(f.x), cy=Math.round(f.y);
    if (Math.abs(cx-object.x)+Math.abs(cy-object.y)>1) continue;
    const candidate={...object,x:cx,y:cy};
    if (clear(f.x*UNIT,f.y*UNIT,cx*UNIT,cy*UNIT) && placementOk(world,candidate).ok) {chosen=i;tx=cx;ty=cy;break;}
  }
  if (chosen<0) throw new Error('no legal rest position');
  for (let i=frames.length-2;i>=chosen;i--) {step+=3;frames.push({...frames[i],at_ms:time(step),z:0});}
  x=tx*UNIT;y=ty*UNIT;z=0;step+=3;emit();
  return {keyframes:frames,effect:{e:'move_object',object_id:object.id,dx:tx-object.x,dy:ty-object.y,at_ms:time(step)}};
}
