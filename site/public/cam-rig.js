// cam-rig.js — B3 cutout rig helpers (spec 19, item E2).
// Pure: no DOM, no clock, no RNG. Motion depends only on (pose, t, segId).

export const RIG_GOOD_POSES = [
  'sit', 'stretch', 'walk', 'look_up', 'jump', 'sneak', 'dash', 'wave',
  'startled', 'question', 'unimpressed', 'grumpy', 'giggle', 'meh', 'ponder',
];
export const GOOD_POSES = RIG_GOOD_POSES;
const GOOD = new Set(RIG_GOOD_POSES);

export function isRigPose(pose) { return GOOD.has(pose); }

export function hashSegId(id) {
  let h = (Number(id) || 0) * 2654435761;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function finite(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

export function mapPoint(point, source, target) {
  const sw = source && source.w ? source.w : 1;
  const sh = source && source.h ? source.h : 1;
  const tw = target && target.w ? target.w : sw;
  const th = target && target.h ? target.h : sh;
  return [Math.round((point[0] * tw) / sw), Math.round((point[1] * th) / sh)];
}

export function mapPolygon(polygon, source, target) {
  if (!Array.isArray(polygon)) return [];
  return polygon.map((p) => mapPoint(p, source, target));
}

export function pointInPolygon(x, y, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0]; const yi = polygon[i][1];
    const xj = polygon[j][0]; const yj = polygon[j][1];
    // Boundary counts as inside so adjacent parts leave no seam.
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-9
      && x >= Math.min(xi, xj) && x <= Math.max(xi, xj)
      && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y)) {
      const xInt = xi + ((y - yi) * (xj - xi)) / (yj - yi);
      if (x < xInt) inside = !inside;
    }
  }
  return inside;
}

export function sortedParts(rigEntry) {
  const parts = (rigEntry && rigEntry.parts) || {};
  return Object.entries(parts)
    .map(([name, part]) => ({ name, ...(part || {}), z: finite(part && part.z, 0) }))
    .sort((a, b) => a.z - b.z);
}

export function alphaOn(v) { return v >= 128 ? 255 : 0; }

// Motion for one frame. rigEntry is optional; limits come from its tail part.
export function rigMotion(pose, t, segId, rigEntry, opts) {
  const options = typeof opts === 'string' ? { action: opts } : (opts || {});
  const zeroEar = { dx: 0, dy: 0, flatten: 0, rotDeg: 0, active: false };
  const out = {
    enabled: false,
    tailAngleDeg: 0, tailRotDeg: 0, tailMaxDeg: 0, tailPeriodMs: 3000,
    earL: { ...zeroEar }, earR: { ...zeroEar },
    ear: null, headBobPx: 0, headDy: 0, headRotDeg: 0,
  };
  if (!isRigPose(pose)) return out;
  const time = finite(Number(t), 0);
  const hash = hashSegId(segId);
  const phase = (hash % 6283) / 1000;
  const tailLimits = rigEntry && rigEntry.parts && rigEntry.parts.tail
    ? rigEntry.parts.tail.limits : null;
  const maxDeg = Math.max(0, Math.min(10,
    finite(tailLimits && tailLimits.rot_deg_max, 10)));
  const alert = options.alert === true || pose === 'startled'
    || options.action === 'startled' || options.action === 'alert';
  const period = alert ? 700 + (hash % 401) : 2500 + (hash % 1501);
  const angle = maxDeg * Math.sin((2 * Math.PI * time) / period + phase);
  out.enabled = true;
  out.tailMaxDeg = maxDeg;
  out.tailPeriodMs = period;
  out.tailAngleDeg = angle;
  out.tailRotDeg = angle;

  // Ear twitch: one ear, 1 px shift + flatten, every 4-8 s, never rotation.
  const earPeriod = 4000 + (hash % 4001);
  const earOffset = hashSegId((Number(segId) || 0) ^ 0x9e3779b9) % earPeriod;
  const local = (((time - earOffset) % earPeriod) + earPeriod) % earPeriod;
  if (local < 160) {
    const left = hash % 2 === 0;
    const ear = { dx: left ? -1 : 1, dy: 0, flatten: 1, rotDeg: 0, active: true };
    if (left) out.earL = ear; else out.earR = ear;
    out.ear = left ? 'ear_l' : 'ear_r';
  } else {
    out.ear = null;
  }
  out.earPeriodMs = earPeriod;

  // Head: at most a 1 px bob synced to the 2 s breathing cycle, no rotation.
  out.headBobPx = Math.round((Math.sin((2 * Math.PI * time) / 2000 + phase) + 1) / 2);
  out.headDy = out.headBobPx;
  return out;
}

export default rigMotion;
