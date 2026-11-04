// cam-anim.js — B1 procedural life layer (spec section 19, item E1).
// Pure: no DOM, no clock, no RNG. Every output depends only on
// (segments, t, manifest), so two browsers draw the same frame.
//
// Eye rectangles in cam/manifest.json ("eyes": [[x,y,w,h], ...] in native
// sprite pixels, origin top-left) were found by scanning each sprite for
// near-black clusters (max RGB < 70, which isolates the dark eye blobs
// from the mid-brown outline) and confirming each cluster against an 8x
// nearest-neighbour enlargement of the sprite. Poses whose eyes are
// already closed in the art (jump, sleepy, stretch) get "eyes": [] and
// never blink. The lid colour is sampled at render time from the fur
// pixel immediately beside the first eye rectangle (see cam.js).

const CROUCH_MS = 150;
const CROUCH_SCALE_Y = 0.9;
const LAND_MS = 250;
const WOBBLE_MS = 350;
const BLINK_MS = 120;
// B8b push contact: the stretch pose starts this long before the first slipper keyframe.
const PUSH_LEAD_MS = 120;
// Projected width of one cell along the facing axis (TILE_W in cam-shared.js).
const PUSH_TILE_PX = 32;
const PUSH_MAX_SHIFT_CELLS = 0.4;
const PUSH_STRETCH_KEY = 'stretch';
const OPEN_EYED_FALLBACK = { sit: 1, walk: 1, look_up: 1, alert_loaf: 1 };

function hashId(id) {
  let h = (Number(id) || 0) * 2654435761;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function finite(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

function findSegment(segments, t) {
  for (let i = 0; i < segments.length; i += 1) {
    if (t >= segments[i].start_at && t < segments[i].end_at) return i;
  }
  return t < segments[0].start_at ? 0 : segments.length - 1;
}

function isClimb(seg) {
  return !!seg && (seg.primitive === 'climb' || seg.pose === 'jump');
}

function neutral() {
  return {
    scaleX: 1, scaleY: 1, dx: 0, dy: 0, rot: 0,
    blink: 0, shadowScale: 1, overlays: [], objectFx: {}, push: null,
  };
}

// Grid offset (cells, z = 0) of a projected offset. Inverse of project() in cam-shared.js.
function gridDelta(dsx, dsy) {
  const u = dsx / 16; const v = dsy / 8;
  return { x: (u + v) / 2, y: (v - u) / 2 };
}

// Front-most paw tip of a sprite, in native pixels (origin top-left).
// Looks at the lower third of the rows, takes the opaque column furthest
// toward the sprite's native facing, and returns its front edge plus the
// mean centre row of that column. rgba is RGBA bytes, row-major.
export function frontPawTip(rgba, w, h, nativeFacing) {
  if (!rgba || !(w > 0) || !(h > 0)) return null;
  const front = nativeFacing === -1 ? -1 : 1;
  const lowFrom = Math.floor((2 * h) / 3);
  let best = null; let sumY = 0; let count = 0;
  for (let y = lowFrom; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rgba[(y * w + x) * 4 + 3] < 128) continue;
      const beyond = best === null || (front === -1 ? x < best : x > best);
      if (beyond) { best = x; sumY = 0; count = 0; }
      if (x === best) { sumY += y + 0.5; count += 1; }
    }
  }
  if (best === null) return null;
  return { x: front === -1 ? best : best + 1, y: sumY / count };
}

// Push contact window: from PUSH_LEAD_MS before the first keyframe of the
// slipper's move until its last keyframe (hard cut in and out).
function pushWindow(segments, time) {
  for (const seg of segments || []) {
    if (!seg || seg.primitive !== 'touch' || seg.action !== 'play' || !seg.target) continue;
    const fx = (seg.effects || []).find((e) => e && Array.isArray(e.keyframes) && e.keyframes.length >= 2
      && (e.object_id || seg.target) === seg.target);
    if (!fx) continue;
    const frames = fx.keyframes;
    const first = finite(frames[0].at_ms, NaN);
    const last = finite(frames[frames.length - 1].at_ms, NaN);
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    if (time < first - PUSH_LEAD_MS || time >= last) continue;
    return { seg, frames };
  }
  return null;
}

// Distance in cells from point p to the segment a-b.
function segmentDistance(p, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const u = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2);
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y);
}

// B8b push draw. During the push window Nori is drawn in the stretch pose,
// mirrored to face the slipper, and shifted along the facing axis by a whole
// number of pixels (at most PUSH_MAX_SHIFT_CELLS of a cell) so that her front
// paw tip lands as close as possible to the slipper's near edge at its first
// keyframe. Returns { pose, facing, dx } or null. Pure: same inputs, same output.
export function pushDraw(segments, time, manifest, paws) {
  const hit = pushWindow(segments, time);
  if (!hit) return null;
  const entry = manifest && manifest[PUSH_STRETCH_KEY];
  const tip = paws && paws[PUSH_STRETCH_KEY];
  if (!entry || !tip || !Array.isArray(entry.foot)) return null;
  const { seg, frames } = hit;
  const nori = { x: seg.path[0][0], y: seg.path[0][1] };
  const obj0 = { x: frames[0].x, y: frames[0].y };
  // Facing: sign of the slipper's projected offset from Nori.
  const screenDir = (obj0.x - obj0.y) - (nori.x - nori.y);
  const facing = screenDir > 0 ? 1 : screenDir < 0 ? -1 : (seg.facing === -1 ? -1 : 1);
  // Slipper's near edge: the side of its cell that faces Nori (dominant axis).
  const ddx = nori.x - obj0.x; const ddy = nori.y - obj0.y;
  if (ddx === 0 && ddy === 0) return null;
  let a; let b;
  if (Math.abs(ddx) >= Math.abs(ddy)) {
    const ex = obj0.x + Math.sign(ddx) * 0.5;
    a = { x: ex, y: obj0.y - 0.5 }; b = { x: ex, y: obj0.y + 0.5 };
  } else {
    const ey = obj0.y + Math.sign(ddy) * 0.5;
    a = { x: obj0.x - 0.5, y: ey }; b = { x: obj0.x + 0.5, y: ey };
  }
  // Paw tip relative to the foot, in projected px (mirrored when facing away from native).
  const flip = facing !== entry.native_facing;
  const lx = tip.x - entry.foot[0];
  const ly = tip.y - entry.foot[1];
  const pawOff = gridDelta(flip ? -lx : lx, ly);
  // Whole-pixel shifts along the facing axis: a shift of d px moves the grid by (d/32, -d/32).
  const maxPx = Math.floor(PUSH_MAX_SHIFT_CELLS * PUSH_TILE_PX);
  let bestPx = 0; let bestDist = Infinity;
  for (let d = -maxPx; d <= maxPx; d += 1) {
    const p = { x: nori.x + pawOff.x + (facing * d) / PUSH_TILE_PX, y: nori.y + pawOff.y - (facing * d) / PUSH_TILE_PX };
    const dist = segmentDistance(p, a, b);
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && Math.abs(d) < Math.abs(bestPx))) {
      bestDist = dist; bestPx = d;
    }
  }
  return { pose: PUSH_STRETCH_KEY, facing, dx: facing * bestPx };
}

// paws: optional { stretch: {x, y} } from frontPawTip(), one per sprite key used by pushDraw.
export function animState(segments, t, manifest, paws) {
  const out = neutral();
  if (!Array.isArray(segments) || segments.length === 0) return out;
  const time = finite(Number(t), 0);
  const mf = manifest && typeof manifest === 'object' ? manifest : {};
  const idx = findSegment(segments, time);
  const seg = segments[idx];
  if (!seg) return out;
  const prev = idx > 0 ? segments[idx - 1] : null;
  const next = idx + 1 < segments.length ? segments[idx + 1] : null;
  const elapsed = time - seg.start_at;
  const entry = mf[seg.pose] || {};
  const bodyH = finite(entry.body_h, finite(entry.h, 40)) || 40;
  const phase = (hashId(seg.id) % 6283) / 1000; // 0..2*pi-ish, stable per segment

  // B8b: push contact draws the stretch pose (see pushDraw); no breathing or blink while it shows.
  const push = pushDraw(segments, time, mf, paws);

  let scaleX = 1;
  let scaleY = 1;

  // Breathing: idle + sleeping poses only, 1 px at the top of the sprite.
  const breathingPose = seg.pose === 'sit' || seg.pose === 'sleepy' || seg.pose === 'alert_loaf';
  const stillPrimitive = seg.primitive !== 'climb' && seg.primitive !== 'move_to';
  if (breathingPose && stillPrimitive && !push) {
    const sleeping = seg.pose === 'sleepy' || seg.primitive === 'sleep' || seg.action === 'sleep';
    const period = sleeping ? 3200 : 2000;
    const amp = 1 / Math.max(10, bodyH);
    scaleY *= 1 + amp * Math.sin((time / period) * Math.PI * 2 + phase);
  }

  // Anticipation crouch at the end of the segment before a climb/jump.
  if (next && isClimb(next) && next.start_at === seg.end_at && !isClimb(seg)) {
    const remain = seg.end_at - time;
    if (remain >= 0 && remain < CROUCH_MS) {
      const q = 1 - remain / CROUCH_MS;
      const e = q * q * (3 - 2 * q);
      scaleY *= 1 - (1 - CROUCH_SCALE_Y) * e;
      scaleX *= 1 + 0.05 * e;
    }
  }

  // Landing squash-and-stretch after a climb ends (contiguous next segment).
  if (prev && isClimb(prev) && prev.end_at === seg.start_at && elapsed >= 0 && elapsed < LAND_MS) {
    const s = 1 - 0.15 * Math.exp(-elapsed / 90) * Math.cos((elapsed / LAND_MS) * Math.PI * 2);
    scaleY *= s;
    scaleX *= 1 + (1 - s) * 0.6;
  }

  // Shadow shrinks with hop height.
  let shadowScale = 1;
  if (isClimb(seg)) {
    const dur = seg.end_at - seg.start_at;
    const p = dur > 0 ? clamp01(elapsed / dur) : 0;
    const hopPx = 40 * p * (1 - p) * 4; // poseAt hop peaks at 10 px
    shadowScale = 1 - clamp01(hopPx / 40) * 0.45;
  }

  // Blink: deterministic 3.5-5 s schedule, never during a climb/jump.
  let blink = 0;
  const eyes = Array.isArray(entry.eyes) ? entry.eyes : null;
  const openEyed = eyes ? eyes.length > 0 : !!OPEN_EYED_FALLBACK[seg.pose];
  if (openEyed && !isClimb(seg) && seg.pose !== 'sleepy' && !push) {
    const period = 3500 + (hashId(seg.id) % 1500);
    const offset = hashId(seg.id ^ 0x9e3779b9) % 1000;
    const cyc = ((elapsed - offset) % period + period) % period;
    if (cyc < BLINK_MS) blink = Math.sin(Math.PI * (cyc / BLINK_MS));
  }

  // Object reaction + overlays.
  const overlays = [];
  const objectFx = {};
  const addWobble = (objectId, eventT, eventSegId) => {
    if (!objectId) return;
    const age = time - eventT;
    if (age < 0 || age >= WOBBLE_MS) return;
    const decay = 1 - age / WOBBLE_MS;
    const wob = Math.sin((age / WOBBLE_MS) * Math.PI * 3) * decay;
    objectFx[objectId] = {
      shearX: wob,
      dy: -Math.abs(Math.sin((age / WOBBLE_MS) * Math.PI * 2)) * decay * 1,
      flap: Math.abs(wob) * 3 * decay + decay * 1,
    };
    const n = 5;
    for (let k = 0; k < n; k += 1) {
      const h1 = hashId((eventSegId * 131 + k * 17 + 7) >>> 0) % 1000 / 1000;
      const h2 = hashId((eventSegId * 57 + k * 29 + 3) >>> 0) % 1000 / 1000;
      const dir = k % 2 === 0 ? 1 : -1;
      const spread = (4 + h1 * 12) * dir;
      const rise = age / WOBBLE_MS;
      overlays.push({
        type: 'dust', objectId,
        dx: spread * (0.4 + rise * 0.8),
        dy: -2 - h2 * 3 - rise * 4 + rise * rise * 3,
        size: h2 > 0.5 ? 2 : 1,
        alpha: decay,
      });
    }
  };
  // Landing in / arriving after a climb, and jumping out of the box.
  if (prev && isClimb(prev) && prev.end_at === seg.start_at) addWobble(prev.target || seg.target, seg.start_at, prev.id);
  if (isClimb(seg) && prev && prev.part === 'inside') addWobble(seg.target, seg.start_at, seg.id);

  // "!" pop at the start of a hide_in run.
  if (seg.action === 'hide_in' && (!prev || prev.action !== 'hide_in') && elapsed >= 0 && elapsed < 450) {
    const q = elapsed / 450;
    const pop = q < 0.25 ? (q / 0.25) : 1;
    overlays.push({
      type: '!', dx: 10, dy: -bodyH - 8 - Math.sin(pop * Math.PI) * 2,
      scale: 0.6 + 0.4 * pop, alpha: q > 0.8 ? 1 - (q - 0.8) / 0.2 : 1,
    });
  }

  // Drifting z glyphs while sleeping (above baked sprite z marks, max 2).
  if (seg.pose === 'sleepy' || seg.primitive === 'sleep' || seg.action === 'sleep') {
    for (let k = 0; k < 2; k += 1) {
      const cycleMs = 2400;
      const cyc = (((elapsed + k * 1200) % cycleMs) + cycleMs) % cycleMs;
      const q = cyc / cycleMs;
      overlays.push({
        type: 'z', index: k,
        dx: 16 + q * 10 + k * 5,
        dy: -bodyH - 10 - q * 12,
        size: 1,
        alpha: q < 0.15 ? q / 0.15 : q > 0.75 ? (1 - q) / 0.25 : 1,
      });
    }
  }

  out.scaleX = finite(scaleX, 1);
  out.scaleY = finite(scaleY, 1);
  out.shadowScale = finite(shadowScale, 1);
  out.blink = finite(blink, 0);
  out.overlays = overlays;
  out.objectFx = objectFx;
  out.push = push;
  if (push) out.dx = push.dx;
  return out;
}

export default animState;
