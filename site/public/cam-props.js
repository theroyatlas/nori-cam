// cam-props.js — B5 code-drawn room props (spec 3.10, 4.3, 4.5, 13.4).
// Pure drawing: no DOM creation, no wall clock, no RNG. All animation
// phase comes from the caller-supplied t (server/fixture time).
import { project, depthKey, applyEffects } from './cam-shared.js';
import { outlineFor } from './cam-look.js';
// B10b preview look for props. Looks b/c use selective outlines (a darker
// shade of each local colour); look a softens outlines toward the fill;
// default keeps props as today.
let LOOK = 'default';
export function setPropLook(look) {
  LOOK = look === 'a' || look === 'b' || look === 'c' ? look : 'default';
  return LOOK;
}
export function propLook() { return LOOK; }
function propInk(fill) { return outlineFor(LOOK, fill, INK); }
/** 1 px line colours bypassing the poly() choke point (default identical). */
function lineForProp(fill) { return LOOK === 'default' ? fill : propInk(fill); }

export const OUTLINE = '#3e2f26';
const INK = OUTLINE;

// Room palette (matches cam.js floor/walls/box).
const PAL = {
  bedTop: '#e8b4b8', bedFace: '#c97f8a', bedDark: '#a85f6d', blanket: '#7fb3d9', pillow: '#f3e9d2',
  woodTop: '#b38556', woodFace: '#8a623e', woodDark: '#6e4c2e',
  screen: '#2e4a5a', screenGlow: '#9fd8e8', chair: '#5a7a8c',
  paper: '#f5efdd', paper2: '#e8dfc8', doodle: '#5a7ab5',
  bowlFood: '#c96f4a', bowlWater: '#5a9ec4', ceramic: '#e8e0cc', ceramicDark: '#b8ab8c',
  slipper: '#e8913a', slipperDark: '#b96f24', parcel: '#cb9d70', parcelDark: '#a87f52',
  cushionTeal: '#3a8a82', cushionMustard: '#c9a227', yarnA: '#e8dcc8', yarnB: '#d4a574',
  mug: '#f5efe3', mugCoffee: '#5c3a22', lampShade: '#f2d48a', lampBase: '#6e4c2e',
};

function poly(ctx, pts, fill, stroke) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke === INK ? propInk(fill) : stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function rect(ctx, x, y, w, h, fill) {
  ctx.fillStyle = fill; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function px(ctx, x, y, color) { rect(ctx, x, y, 1, 1, color); }
function diamond(cx, cy, hw, hh) { return [[cx, cy - hh], [cx + hw, cy], [cx, cy + hh], [cx - hw, cy]]; }

export function kindOf(obj) {
  if (!obj || typeof obj !== 'object') return 'unknown';
  if (typeof obj.kind === 'string' && obj.kind) return obj.kind;
  if (typeof obj.sprite === 'string' && obj.sprite.startsWith('procedural:')) return obj.sprite.slice('procedural:'.length);
  return 'unknown';
}

// Only root-relative media URLs can be fetched. Cache failures as well as loads.
const giftImages = new Map();
export function isGiftSpriteURL(url) {
  return typeof url === 'string' && /^\/media\/[A-Za-z0-9_-]+\.png$/.test(url);
}
export function giftSpriteImage(url) {
  if (!isGiftSpriteURL(url)) return null;
  if (giftImages.has(url)) return giftImages.get(url);
  const entry = { image: null, state: 'loading' };
  giftImages.set(url, entry);
  try {
    const image = new Image();
    entry.image = image;
    image.onload = () => { entry.state = image.naturalWidth && image.naturalHeight ? 'ready' : 'error'; };
    image.onerror = () => { entry.state = 'error'; };
    image.src = url;
  } catch { entry.state = 'error'; }
  return entry;
}
export function giftPosition(obj) {
  const cells = Array.isArray(obj.footprint) ? obj.footprint.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) : [];
  const xs = cells.map(c => c[0]); const ys = cells.map(c => c[1]);
  const dx = cells.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const dy = cells.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
  return { x: obj.x + dx, y: obj.y + dy, z: obj.z || 0 };
}
export function giftAnchor(obj) {
  const p = giftPosition(obj); return project(p.x, p.y, p.z);
}
function drawGiftSprite(ctx, obj) {
  const entry = giftSpriteImage(obj.sprite);
  if (!entry || entry.state !== 'ready') return false;
  const p = giftAnchor(obj); const image = entry.image;
  try {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, Math.round(p.sx - image.naturalWidth / 2), Math.round(p.sy - image.naturalHeight));
    ctx.restore();
    return true;
  } catch { ctx.restore(); return false; }
}

export const PROP_KINDS = ['bed', 'cardboard_box', 'computer_desk', 'drawing_wall', 'food_bowl', 'water_bowl', 'slipper', 'env:sun', 'toy', 'cat_tree', 'wall_shelf'];
const KNOWN = new Set([...PROP_KINDS, 'cushion']);
export function hasDrawPath(kind) { return KNOWN.has(kind) || kind === 'unknown'; }
export function isInvisibleProp(obj) { return kindOf(obj) === 'env:sun'; }
export function isPropVisible(obj) {
  if (!obj) return false;
  if (isInvisibleProp(obj)) return false;
  if (obj.status === 'carried') return false;
  if (obj.status && obj.status !== 'placed') return false;
  return true;
}
export function propLayers(obj) {
  const k = kindOf(obj);
  if (k === 'env:sun') return [];
  if (!isPropVisible(obj)) return [];
  if (isGiftSpriteURL(obj.sprite)) return ['single'];
  if (k === 'bed' || k === 'computer_desk' || k === 'cardboard_box' || k === 'cat_tree' || k === 'wall_shelf') return ['back', 'front'];
  return ['single'];
}

// B8: a wall-flush shelf is sorted by its back plane for both of its draw
// layers. Its planks then never land in front of a cat standing on the cat
// tree (or anything else at the same wall cell); only a cat that stands on
// the shelf draws after it, because her depth is greater by height.
export function depthLayerOf(obj, layer) {
  if (layer === 'front' && kindOf(obj) === 'wall_shelf') return 'back';
  return layer;
}

// B8: drop sprite fragments that float below the body. The jump sprite has a
// detached pale strip 4 rows under its paws; it reads as a bar in the room.
// Components are 8-connected opaque pixels; the largest is the body, and any
// other component lying wholly below it is cleared. Fragments above or beside
// the body (sleepy, alert_loaf) are kept. Returns the number of pixels cleared.
export function pruneFloatingFragments(data, w, h) {
  const total = w * h;
  const label = new Int32Array(total).fill(-1);
  const comps = [];
  for (let s = 0; s < total; s += 1) {
    if (data[s * 4 + 3] === 0 || label[s] !== -1) continue;
    const id = comps.length;
    const pix = [];
    const stack = [s];
    label[s] = id;
    let minY = Infinity; let maxY = -Infinity;
    while (stack.length) {
      const p = stack.pop();
      pix.push(p);
      const x = p % w; const y = (p - x) / w;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (data[q * 4 + 3] !== 0 && label[q] === -1) { label[q] = id; stack.push(q); }
        }
      }
    }
    comps.push({ pix, minY, maxY });
  }
  if (comps.length < 2) return 0;
  let body = comps[0];
  for (const c of comps) if (c.pix.length > body.pix.length) body = c;
  let cleared = 0;
  for (const c of comps) {
    if (c === body || !(c.minY > body.maxY)) continue;
    for (const p of c.pix) data[p * 4 + 3] = 0;
    cleared += c.pix.length;
  }
  return cleared;
}

// Sorted depth entries (no draw functions) shared by cam.js ordering tests.
export function buildDepthItems(objects, noriPose) {
  const items = [];
  for (const obj of objects || []) {
    for (const rawLayer of propLayers(obj)) {
      const layer = depthLayerOf(obj, rawLayer);
      const item = { id: obj.id, kind: kindOf(obj), layer, x: obj.x, y: obj.y, z: obj.z || 0 };
      item.depth = depthKey(layer === 'single' ? { x: obj.x, y: obj.y, z: obj.z || 0 } : { x: obj.x, y: obj.y, z: obj.z || 0, layer });
      items.push(item);
    }
  }
  if (noriPose) {
    const item = { id: 'nori', kind: 'nori', layer: 'single', x: noriPose.x, y: noriPose.y, z: noriPose.z || 0 };
    item.depth = depthKey({ x: noriPose.x, y: noriPose.y, z: noriPose.z || 0, part: noriPose.part || null, targetX: noriPose.targetX, targetY: noriPose.targetY });
    items.push(item);
  }
  items.sort((a, b) => a.depth - b.depth);
  return items;
}

function phase(t, period) { const p = ((Number(t) || 0) % period + period) % period; return p / period; }

// ---- individual props: each draw(ctx, obj, env); env={t,activeAction,activeTargetId} ----

function drawBedBack(ctx, obj, env) {
  const p = project(obj.x, obj.y, obj.z || 0);
  // Headboard follows and touches the back-left mattress edge.
  poly(ctx, [[p.sx - 15, p.sy - 6], [p.sx, p.sy - 14],
    [p.sx, p.sy - 27], [p.sx - 15, p.sy - 19]], PAL.woodDark, INK);
  poly(ctx, [[p.sx - 13, p.sy - 9], [p.sx - 2, p.sy - 15],
    [p.sx - 2, p.sy - 24], [p.sx - 13, p.sy - 18]], PAL.woodFace, null);
  poly(ctx, diamond(p.sx, p.sy - 6, 15, 8), PAL.bedTop, INK);
  poly(ctx, [[p.sx - 10, p.sy - 7], [p.sx - 2, p.sy - 11],
    [p.sx + 4, p.sy - 8], [p.sx - 4, p.sy - 4]], PAL.pillow, INK);
  poly(ctx, [[p.sx - 5, p.sy - 1], [p.sx + 7, p.sy - 7],
    [p.sx + 13, p.sy - 4], [p.sx + 1, p.sy + 2]], PAL.blanket, null);
  poly(ctx, [[p.sx - 3, p.sy], [p.sx + 9, p.sy - 6],
    [p.sx + 11, p.sy - 5], [p.sx - 1, p.sy + 1]], '#a8cdea', null);
}
function drawBedFront(ctx, obj, env) {
  const p = project(obj.x, obj.y, obj.z || 0);
  const top = diamond(p.sx, p.sy - 6, 15, 8); const bot = diamond(p.sx, p.sy - 2, 15, 8);
  poly(ctx, [top[3], top[2], bot[2], bot[3]], PAL.bedFace, INK);
  poly(ctx, [top[2], top[1], bot[1], bot[2]], PAL.bedDark, INK);
  // Wooden rails meet the mattress; three legs reach the footprint.
  poly(ctx, [bot[3], bot[2], [p.sx, p.sy + 8], [p.sx - 15, p.sy]], PAL.woodFace, INK);
  poly(ctx, [bot[2], bot[1], [p.sx + 15, p.sy], [p.sx, p.sy + 8]], PAL.woodDark, INK);
  poly(ctx, [[p.sx + 1, p.sy + 2], [p.sx + 13, p.sy - 4],
    [p.sx + 13, p.sy], [p.sx + 1, p.sy + 6]], PAL.blanket, null);
  rect(ctx, p.sx - 14, p.sy, 3, 5, PAL.woodDark);
  rect(ctx, p.sx - 1, p.sy + 6, 3, 4, PAL.woodDark);
  rect(ctx, p.sx + 11, p.sy, 3, 5, PAL.woodDark);
}

function drawDeskBack(ctx, obj, env) {
  const p = project(obj.x, obj.y, (obj.z || 0) + 0.875);
  const active = env && env.activeAction === 'use_computer' && env.activeTargetId === obj.id;
  const glow = active || obj.glow;
  // Desktop top.
  poly(ctx, diamond(p.sx, p.sy - 10, 16, 8), PAL.woodTop, INK);
  // Monitor: post + screen, faint glow; scrolling lines while use_computer.
  rect(ctx, p.sx - 1, p.sy - 16, 2, 6, PAL.woodDark);
  rect(ctx, p.sx - 7, p.sy - 24, 14, 9, LOOK === 'default' ? INK : propInk(PAL.screen));
  rect(ctx, p.sx - 6, p.sy - 23, 12, 7, glow ? PAL.screenGlow : PAL.screen);
  if (glow) {
    const off = Math.floor(phase(env ? env.t : 0, 800) * 4);
    ctx.fillStyle = '#2e4a5a';
    for (let r = 0; r < 3; r += 1) {
      const y = p.sy - 22 + ((r * 2 + off) % 6);
      ctx.fillRect(Math.round(p.sx - 5), Math.round(y), 7 - r, 1);
    }
    rect(ctx, p.sx - 8, p.sy - 25, 16, 1, 'rgba(159,216,232,0.5)');
  } else {
    rect(ctx, p.sx - 5, p.sy - 21, 6, 1, '#7fb3d9'); rect(ctx, p.sx - 5, p.sy - 19, 4, 1, '#7fb3d9');
  }
  // Small keyboard slab.
  rect(ctx, p.sx + 1, p.sy - 12, 7, 2, PAL.ceramicDark);
  // Desk lamp (back) + mug.
  rect(ctx, p.sx - 12, p.sy - 14, 2, 8, PAL.lampBase);
  poly(ctx, [[p.sx - 14, p.sy - 16], [p.sx - 8, p.sy - 16], [p.sx - 9, p.sy - 20], [p.sx - 13, p.sy - 20]], PAL.lampShade, INK);
  rect(ctx, p.sx + 4, p.sy - 13, 4, 3, PAL.mug);
  px(ctx, p.sx + 5, p.sy - 12, PAL.mugCoffee);
  if (LOOK === 'b' || LOOK === 'c') {
    px(ctx, p.sx + 4, p.sy - 13, '#ffffff');
    rect(ctx, p.sx + 4, p.sy - 11, 4, 1, PAL.paper2);
  }
}
function drawDeskFront(ctx, obj, env) {
  const p = project(obj.x, obj.y, (obj.z || 0) + 0.875);
  const top = diamond(p.sx, p.sy - 10, 16, 8); const bot = diamond(p.sx, p.sy + 2, 16, 8);
  // Front faces are mostly open legs so Nori behind shows between them.
  poly(ctx, [top[3], top[2], bot[2], bot[3]], 'rgba(138,98,62,0.35)', null);
  poly(ctx, [top[2], top[1], bot[1], bot[2]], 'rgba(110,76,46,0.35)', null);
  // Legs (1px outline posts at corners).
  for (const [lx, ly] of [[-13, -4], [13, -4], [-10, 3], [10, 3]]) {
    rect(ctx, p.sx + lx, p.sy + ly - 8, 2, 23, PAL.woodDark);
    px(ctx, p.sx + lx, p.sy + ly - 8, propInk(PAL.woodDark));
  }
  // Front edge of desktop.
  ctx.beginPath(); ctx.moveTo(top[3][0], top[3][1]); ctx.lineTo(top[2][0], top[2][1]); ctx.lineTo(top[1][0], top[1][1]);
  ctx.strokeStyle = propInk(PAL.woodTop); ctx.lineWidth = 1; ctx.stroke();
}

function drawDrawingWall(ctx, obj, env) {
  const p = project(obj.x, obj.y, obj.z || 0);
  // Left wall (x=0): papers pinned up the wall from the floor point.
  const bx = p.sx; const by = p.sy - 26;
  const paper = (dx, dy, w, h, fill, doodle) => {
    // slight iso skew along wall: down-right 0.5 slope
    poly(ctx, [[bx + dx, by + dy + Math.round(dx * 0.5)], [bx + dx + w, by + dy + Math.round((dx + w) * 0.5)], [bx + dx + w, by + dy + h + Math.round((dx + w) * 0.5)], [bx + dx, by + dy + h + Math.round(dx * 0.5)]], fill, INK);
    px(ctx, bx + dx + Math.round(w / 2), by + dy + Math.round(dx * 0.5), '#c0392b');
    if (doodle) {
      // simple cat-ish doodle: circle + ears
      const cx = bx + dx + Math.round(w / 2); const cy = by + dy + 4 + Math.round(dx * 0.5);
      px(ctx, cx - 1, cy, PAL.doodle); px(ctx, cx, cy - 1, PAL.doodle); px(ctx, cx + 1, cy, PAL.doodle);
      px(ctx, cx - 1, cy - 2, PAL.doodle); px(ctx, cx + 1, cy - 2, PAL.doodle); px(ctx, cx, cy + 1, PAL.doodle);
    }
  };
  paper(0, 0, 9, 11, PAL.paper, true);
  paper(11, 3, 8, 10, PAL.paper2, false);
  paper(4, 13, 7, 9, PAL.paper, false);
}

function bowl(ctx, obj, env, isWater) {
  const p = project(obj.x, obj.y, obj.z || 0);
  poly(ctx, diamond(p.sx, p.sy - 2, 9, 4), isWater ? PAL.bowlWater : PAL.bowlFood, INK);
  poly(ctx, diamond(p.sx, p.sy - 3, 7, 3), isWater ? '#bfe3f2' : '#e8a06a', INK);
  if (isWater) {
    const active = env && env.activeAction === 'drink' && env.activeTargetId === obj.id;
    if (active) {
      const q = phase(env.t, 900);
      const r = 1 + Math.round(q * 4);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(p.sx, p.sy - 3, r + 2, Math.max(1, Math.round(r / 2)), 0, 0, Math.PI * 2); ctx.stroke();
      px(ctx, p.sx - 2, p.sy - 4, '#ffffff');
    } else { px(ctx, p.sx - 2, p.sy - 4, '#ffffff'); px(ctx, p.sx + 2, p.sy - 3, '#dff2fb'); }
  } else {
    px(ctx, p.sx - 2, p.sy - 4, '#8a4a24'); px(ctx, p.sx + 1, p.sy - 3, '#8a4a24'); px(ctx, p.sx, p.sy - 5, '#e8c39a');
  }
  const top = diamond(p.sx, p.sy - 2, 9, 4); const bot = diamond(p.sx, p.sy + 1, 9, 4);
  poly(ctx, [top[3], top[2], bot[2], bot[3]], PAL.ceramic, INK);
  poly(ctx, [top[2], top[1], bot[1], bot[2]], PAL.ceramicDark, INK);
}

function drawSlipperShape(ctx, cx, cy, rotation, nudge) {
  ctx.save();
  ctx.translate(Math.round(cx + (nudge || 0)), Math.round(cy));
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  // sole + toe, top-left light
  poly(ctx, [[-6, 0], [-2, -3], [5, -2], [7, 0], [5, 2], [-3, 2]], PAL.slipper, INK);
  rect(ctx, -3, -2, 6, 1, '#f5b26b');
  rect(ctx, 2, -3, 4, 2, PAL.slipperDark);
  px(ctx, -4, -1, '#ffffff');
  ctx.restore();
}

function drawYarnBall(ctx, obj, env) {
  const p = project(obj.x, obj.y, obj.z || 0);
  // Round yarn ball: wound arcs plus a loose string tail on the floor.
  ctx.fillStyle = PAL.yarnA;
  ctx.beginPath();
  ctx.arc(Math.round(p.sx), Math.round(p.sy - 5), 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = propInk(PAL.yarnA); ctx.lineWidth = 1; ctx.stroke();
  ctx.strokeStyle = lineForProp(PAL.yarnB);
  ctx.beginPath(); ctx.arc(Math.round(p.sx), Math.round(p.sy - 5), 5, 0.4, 2.4); ctx.stroke();
  ctx.beginPath(); ctx.arc(Math.round(p.sx), Math.round(p.sy - 5), 3, 2.8, 5.2); ctx.stroke();
  px(ctx, p.sx - 3, p.sy - 9, '#ffffff');
  ctx.beginPath();
  ctx.moveTo(Math.round(p.sx + 6), Math.round(p.sy - 2));
  ctx.lineTo(Math.round(p.sx + 10), Math.round(p.sy + 1));
  ctx.lineTo(Math.round(p.sx + 13), Math.round(p.sy));
  ctx.strokeStyle = lineForProp(PAL.yarnB); ctx.stroke();
}

function drawCushion(ctx, obj, env) {
  const p = project(obj.x, obj.y, obj.z || 0);
  const teal = (obj.x + obj.y) % 2 === 0;
  const fill = teal ? PAL.cushionTeal : PAL.cushionMustard;
  const dark = teal ? '#2a6a64' : '#9a7a18';
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(p.sx, p.sy - 1, 11, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = propInk(fill);
  ctx.lineWidth = 1;
  ctx.stroke();
  px(ctx, p.sx - 4, p.sy - 3, dark);
  px(ctx, p.sx + 3, p.sy - 2, '#ffffff');
}

function drawParcel(ctx, obj, env) {
  const p = project(obj.x, obj.y, obj.z || 0);
  const top = diamond(p.sx, p.sy - 7, 11, 5); const bot = diamond(p.sx, p.sy, 11, 5);
  poly(ctx, diamond(p.sx, p.sy - 7, 11, 5), '#dbb489', INK);
  poly(ctx, [top[3], top[2], bot[2], bot[3]], PAL.parcel, INK);
  poly(ctx, [top[2], top[1], bot[1], bot[2]], PAL.parcelDark, INK);
  ctx.beginPath(); ctx.moveTo(top[3][0], top[3][1]); ctx.lineTo(top[1][0], top[1][1]); ctx.strokeStyle = propInk(PAL.parcel); ctx.lineWidth = 1; ctx.stroke();
}

// Support surfaces share Nori's projection, at 16 pixels per height unit.
function platform(ctx, p, hw, hh, front) {
  if (!front) poly(ctx, diamond(p.sx, p.sy, hw, hh), PAL.woodTop, INK);
  else poly(ctx, [[p.sx-hw,p.sy],[p.sx,p.sy+hh],[p.sx+hw,p.sy],
    [p.sx+hw,p.sy+3],[p.sx,p.sy+hh+3],[p.sx-hw,p.sy+3]], PAL.woodFace, INK);
}
function drawTreeBack(ctx, obj) {
  const p = project(obj.x,obj.y,obj.z || 0);
  platform(ctx,p,14,6,false);
  rect(ctx,p.sx-3,p.sy-40,6,40,PAL.yarnB);
  rect(ctx,p.sx-3,p.sy-40,1,40,propInk(PAL.yarnB));
  for(let y=3;y<40;y+=3) {
    rect(ctx,p.sx-2,p.sy-y,4,1,PAL.yarnA);
    px(ctx,p.sx+2,p.sy-y+1,PAL.woodFace);
  }
  platform(ctx,project(obj.x,obj.y,1),12,5,false);
  const top=project(obj.x,obj.y,2.5);
  platform(ctx,top,14,6,false);
  ctx.fillStyle='#d9a09a'; ctx.beginPath(); ctx.ellipse(top.sx,top.sy,12,4,0,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle=propInk('#d9a09a');ctx.stroke();
  rect(ctx,top.sx-9,top.sy-3,18,1,'#f0c5b8');
}
function drawTreeFront(ctx,obj) {
  platform(ctx,project(obj.x,obj.y,obj.z || 0),14,6,true);
  platform(ctx,project(obj.x,obj.y,1),12,5,true);
  platform(ctx,project(obj.x,obj.y,2.5),14,6,true);
}
function drawShelfBack(ctx,obj) {
  const p=project(obj.x,obj.y,obj.z ?? 3);
  poly(ctx,[[p.sx-24,p.sy-12],[p.sx+20,p.sy+10],[p.sx+16,p.sy+13],[p.sx-28,p.sy-9]],PAL.woodTop,INK);
  for(const dx of [-18,12]) {
    poly(ctx,[[p.sx+dx,p.sy+dx/2+2],[p.sx+dx,p.sy+dx/2+9],
      [p.sx+dx+5,p.sy+dx/2+4]],PAL.woodDark,INK);
  }
}
function drawShelfFront(ctx,obj) {
  const p=project(obj.x,obj.y,obj.z ?? 3);
  poly(ctx,[[p.sx-28,p.sy-9],[p.sx+16,p.sy+13],[p.sx+20,p.sy+10],
    [p.sx+20,p.sy+12],[p.sx+16,p.sy+15],[p.sx-28,p.sy-7]],PAL.woodFace,INK);
}

// Single-kind dispatch table.
const SINGLE = {
  bed: null, computer_desk: null,
  drawing_wall: drawDrawingWall,
  food_bowl: (c, o, e) => bowl(c, o, e, false),
  water_bowl: (c, o, e) => bowl(c, o, e, true),
  slipper: (c, o, e) => {
    const p = project(o.x, o.y, o.z || 0);
    const active = e && e.activeTargetId === o.id && (e.activeAction === 'play' || e.activeAction === 'interact' || e.activePrimitive === 'push');
    const nudge = active ? Math.round(Math.sin(phase(e.t, 600) * Math.PI * 2) * 1) : 0;
    drawSlipperShape(c, p.sx, p.sy, o.rotation || 0, nudge);
  },
  cushion: drawCushion,
  toy: drawYarnBall,
};
const BACK = { cat_tree: drawTreeBack, wall_shelf: drawShelfBack, bed: drawBedBack, computer_desk: drawDeskBack };
const FRONT = { cat_tree: drawTreeFront, wall_shelf: drawShelfFront, bed: drawBedFront, cushion: drawCushion, computer_desk: drawDeskFront };

export function drawPropBack(ctx, obj, env = {}) {
  const k = kindOf(obj); const fn = BACK[k]; if (fn) { fn(ctx, obj, env); return true; } return false;
}
export function drawPropFront(ctx, obj, env = {}) {
  const k = kindOf(obj); const fn = FRONT[k]; if (fn) { fn(ctx, obj, env); return true; } return false;
}
export function drawProp(ctx, obj, env = {}) {
  if (!isPropVisible(obj)) return false;
  const k = kindOf(obj);
  if (k === 'env:sun') return false;
  if (isGiftSpriteURL(obj.sprite)) { if (!drawGiftSprite(ctx, obj)) drawParcel(ctx, obj, env); return true; }
  if (BACK[k]) { drawPropBack(ctx, obj, env); drawPropFront(ctx, obj, env); return true; }
  const fn = SINGLE[k];
  if (fn) { fn(ctx, obj, env); return true; }
  drawParcel(ctx, obj, env); return true;
}
export function drawPropLayer(ctx, obj, layer, env = {}) {
  if (!isPropVisible(obj)) return false;
  const k = kindOf(obj);
  if (k === 'env:sun') return false;
  if (layer === 'back') return drawPropBack(ctx, obj, env);
  if (layer === 'front') return drawPropFront(ctx, obj, env);
  // single
  if (isGiftSpriteURL(obj.sprite)) return drawProp(ctx, obj, env);
  if (BACK[k]) { drawPropBack(ctx, obj, env); drawPropFront(ctx, obj, env); return true; }
  return drawProp(ctx, obj, env);
}
// Carried slipper (or any small prop) at mouth anchor screen pos.
export function drawCarriedProp(ctx, obj, sx, sy, env = {}) {
  const k = kindOf(obj);
  if (k === 'slipper') { drawSlipperShape(ctx, sx, sy, obj.rotation || 0, 0); return true; }
  if (obj && isGiftSpriteURL(obj.sprite)) {
    try {
      const entry = giftSpriteImage(obj.sprite);
      const image = entry && entry.state === 'ready' ? entry.image : null;
      const nw = image ? image.naturalWidth || 0 : 0;
      const nh = image ? image.naturalHeight || 0 : 0;
      if (image && nw > 0 && nh > 0) {
        // Pixel-art downscale: halve until at most 16 px wide (16->1, 28->2, 44->4).
        let factor = 1;
        while (nw / factor > 16) factor *= 2;
        const dw = Math.max(1, Math.floor(nw / factor));
        const dh = Math.max(1, Math.floor(nh / factor));
        const dx = Math.round(sx - dw / 2);
        const dy = Math.round(sy - 2); // mouth hang: top edge 2 px above the anchor
        ctx.save();
        try {
          ctx.imageSmoothingEnabled = false;
          if (factor === 1) ctx.drawImage(image, dx, dy);
          else ctx.drawImage(image, dx, dy, dw, dh);
        } finally {
          ctx.restore();
        }
        return true;
      }
    } catch { /* fall through to the parcel below */ }
  }
  // generic: tiny parcel at anchor
  rect(ctx, sx - 4, sy - 3, 8, 6, PAL.parcel); ctx.strokeStyle = propInk(PAL.parcel); ctx.lineWidth = 1; ctx.strokeRect(Math.round(sx - 4) + 0.5, Math.round(sy - 3) + 0.5, 8, 6);
  return true;
}

// Interpolate physics keyframes using absolute timestamps; snap via applyEffects otherwise.
export function interpolateObjects(objects, segments, t, snapshotAt = -Infinity) {
  // Live snapshots already contain settled effects. Cuts restore authoritative geometry.
  segments = (segments || []).filter(s => s.end_at > snapshotAt && s.cut_at == null && s.superseded_at == null)
    .sort((a,b) => a.start_at-b.start_at || a.id-b.id);
  let base = (objects || []).map(o => ({...o}));
  if (!Array.isArray(segments)) return base;
  for (const seg of segments) {
    base = applyEffects(base, [seg], t);
    const effects = Array.isArray(seg.effects) ? seg.effects : [];
    for (const e of effects) {
      const frames = e && (e.keyframes || e.frames);
      if (!Array.isArray(frames) || frames.length < 2) continue;
      const targetId = e.object_id || seg.target;
      const o = base.find((x) => x.id === targetId);
      if (!o) continue;
      const rel = t;
      if (rel < (frames[0].at_ms || 0)) continue;
      // Before segment start / after end, applyEffects / future state governs.
      if (t < seg.start_at) continue;
      let a = frames[0]; let b = frames[frames.length - 1];
      if (rel >= (frames[frames.length - 1].at_ms || 0)) { a = b; }
      else {
        for (let i = 0; i + 1 < frames.length; i += 1) {
          if (rel >= frames[i].at_ms && rel <= frames[i + 1].at_ms) { a = frames[i]; b = frames[i + 1]; break; }
        }
      }
      const span = (b.at_ms || 0) - (a.at_ms || 0);
      const f = span > 0 ? Math.max(0, Math.min(1, (rel - (a.at_ms || 0)) / span)) : 0;
      o.x = a.x + (b.x - a.x) * f;
      o.y = a.y + (b.y - a.y) * f;
      if (typeof a.z === 'number' && typeof b.z === 'number') o.z = a.z + (b.z - a.z) * f;
    }
  }
  return base;
}
