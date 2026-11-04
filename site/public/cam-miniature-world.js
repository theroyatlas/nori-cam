// Read-only adapter. Inputs are already settled/interpolated by the existing live renderer.
import { poseAt } from './cam-shared.js';
import { kindOf, isGiftSpriteURL } from './cam-props.js';

export function objectBounds(object) {
  const cells = (Array.isArray(object.footprint) ? object.footprint : [])
    .filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const xs = cells.length ? cells.map(c => c[0]) : [0];
  const ys = cells.length ? cells.map(c => c[1]) : [0];
  const minX = object.x + Math.min(...xs) - .5, maxX = object.x + Math.max(...xs) + .5;
  const minY = object.y + Math.min(...ys) - .5, maxY = object.y + Math.max(...ys) + .5;
  return { minX, maxX, minY, maxY, x:(minX+maxX)/2, y:(minY+maxY)/2,
    width:maxX-minX, depth:maxY-minY, z:Number.isFinite(object.z)?object.z:0 };
}

export function objectVisualKind(object) {
  return isGiftSpriteURL(object.sprite) ? 'image' : kindOf(object);
}

export function contactPlane(pose, objects) {
  let z = 0;
  for (const object of objects) {
    if (object.status && object.status !== 'placed') continue;
    const b = objectBounds(object);
    if (pose.x < b.minX-.05 || pose.x > b.maxX+.05 || pose.y < b.minY-.05 || pose.y > b.maxY+.05) continue;
    // Public level z is absolute, including shelves already placed above the floor.
    for (const level of object.levels || []) {
      if (Number.isFinite(level.z) && level.z <= pose.z+.03) z = Math.max(z, level.z);
    }
  }
  return z;
}

export function canonicalPose(name, manifest) {
  const key = String(name || 'sit').replaceAll('-', '_');
  if (manifest[key]) return key;
  return key === 'sleep' ? 'sleepy' : key === 'back' ? 'look_up' : 'sit';
}

const FEET = {front_far:[8,32,0],front_near:[21,35,.5],rear_far:[28,33,.5],rear_near:[37,33,0]};
const CYCLE=720, DUTY=.64;
const smooth=u=>u*u*(3-2*u);
export function walkFootTargets(segments, pose, time) {
  const sample=t=>{
    const valid=segments.filter(s=>t>=s.start_at&&t<Math.min(s.end_at,s.cut_at??Infinity));
    const p=poseAt(valid,t);
    return p && p.pose==='walk' ? p : pose;
  };
  const target={};
  for(const [name,[px,py,offset]] of Object.entries(FEET)) {
    const cycle=time/CYCLE+offset,phase=cycle-Math.floor(cycle);
    const start=(Math.floor(cycle)-offset)*CYCLE;
    const a=sample(start+DUTY*CYCLE/2),b=sample(start+CYCLE+DUTY*CYCLE/2);
    const sourceOffset=(p)=>{const flip=p.facing===-1?1:-1;return {x:flip*(px-20)/32,y:-flip*(px-20)/32,z:p.z||0};};
    const da=sourceOffset(a),db=sourceOffset(b),u=phase<DUTY?0:(phase-DUTY)/(1-DUTY),f=smooth(u);
    target[name]={x:(a.x+da.x)*(1-f)+(b.x+db.x)*f,y:(a.y+da.y)*(1-f)+(b.y+db.y)*f,
      z:da.z*(1-f)+db.z*f+Math.sin(Math.PI*u)*.14,stance:phase<DUTY};
  }
  return target;
}
