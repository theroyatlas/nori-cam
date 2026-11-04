// B6 room shell: warm diorama base, thick walls, plank floor, wall decor.
// Deterministic renderer-only layer: every pixel is a function of (grid, t).
// The static shell is cached on an offscreen canvas in screen space; the
// dynamic layer (night light, shaft, twinkle, clock) is drawn per frame.
import { project as defaultProject, lightAt } from './cam-shared.js';
import { OUTLINE, isGiftSpriteURL, giftSpriteImage } from './cam-props.js';
import { outlineFor, PALETTE_OVERRIDES, lightFor, poolScaleFor, extraDecorFor, EXTRA_DECOR } from './cam-look.js';

export { OUTLINE };

export const LOGICAL_W = 320;
export const LOGICAL_H = 240;

// Single palette block for the whole shell (spec B6.11).
export const PAL = {
  outline: OUTLINE,
  vignetteOuter: '#171009',
  vignetteInner: '#2a1f16',
  slabShadow: 'rgba(8,5,3,0.42)',
  slabSideWarm: '#7a5230',
  slabSideCool: '#5f3f27',
  slabEarth: '#4a3120',
  woodLight: '#c69c62',
  woodMid: '#bb9057',
  woodDark: '#ab7e4a',
  plankSeam: '#a98250',
  wainscot: '#6f9184',
  wainscotDark: '#56766a',
  wainscotTrim: '#e6d9bd',
  wallCream: '#ecdfc6',
  wallPaperDot: '#d9c8a9',
  wallCap: '#f6ecd6',
  wallEnd: '#e0d0b2',
  wallBase: '#43301f',
  rugBase: '#a34d3a',
  rugBorder: '#7e3828',
  rugInner: '#c47a52',
  rugMotif: '#e8c890',
  rugOval: '#7d9a8a',
  rugOvalRing: '#5f7d6c',
  aoSeam: 'rgba(38,26,16,0.38)',
  aoCorner: 'rgba(30,20,12,0.30)',
  nightAmbient: 'rgba(22,18,55,0.64)',
  lampGlowCore: 'rgba(255,202,111,0.72)',
  lampGlowMid: 'rgba(244,145,58,0.29)',
  sconceGlow: 'rgba(255,192,99,0.38)',
  windowGlow: 'rgba(150,180,230,0.20)',
  shaftFill: 'rgba(255,238,196,0.10)',
  dust: '#f2e4c0',
  fairyOff: '#7a6a4e',
  fairyOn: '#ffe9a8',
  clockFace: '#f6efdd',
  clockHand: '#3e2f26',
  curtainA: '#96505a',
  curtainB: '#743c45',
  curtainC: '#ad6470',
  plantLeaf: '#476b35',
  plantLeafDark: '#2e4a22',
  plantPot: '#96603a',
  bookA: '#5d74a8',
  bookB: '#a85d6d',
  bookC: '#6d9a6a',
  frameWood: '#6e4c2e',
  frameArtA: '#a9c6de',
  frameArtB: '#e3b7a0',
  shelfWood: '#8a623e',
  shadow: 'rgba(24,16,10,0.25)',
};

// --- B10 preview looks -------------------------------------------------------
// Preview-only renderer state. Default is byte-identical to B9: setSceneLook
// restores every base value before applying a look's overrides.
const BASE_PAL = { ...PAL };
let LOOK = 'default';
function scaleAlpha(rgba, f) {
  const m = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(rgba);
  if (!m) return rgba;
  const a = Math.max(0, Math.min(1, Number(m[4]) * f));
  return `rgba(${m[1]},${m[2]},${m[3]},${a.toFixed(3)})`;
}
/** Switch the preview look ('a' | 'b' | 'c'; anything else is default). */
export function setSceneLook(look) {
  const next = look === 'a' || look === 'b' || look === 'c' ? look : 'default';
  if (next === LOOK) return LOOK;
  LOOK = next;
  const light = lightFor(LOOK);
  const over = PALETTE_OVERRIDES[LOOK] || {};
  for (const k of Object.keys(BASE_PAL)) {
    if (k === 'lampGlowCore') PAL[k] = scaleAlpha(over[k] || BASE_PAL[k], light.night);
    else if (k === 'lampGlowMid' || k === 'sconceGlow') PAL[k] = scaleAlpha(over[k] || BASE_PAL[k], light.night);
    else if (k === 'shaftFill') PAL[k] = scaleAlpha(over[k] || BASE_PAL[k], light.day);
    else PAL[k] = over[k] || BASE_PAL[k];
  }
  return LOOK;
}
export function sceneLook() { return LOOK; }
/** Outline for a shape with a local fill: base OUTLINE under default. */
function inkFor(fill) { return outlineFor(LOOK, fill, OUTLINE); }
/**
 * 1 px line colours that bypass the poly() choke point: the base colour
 * under default (byte-identical), the look-mapped outline otherwise, so
 * look b/c get crisp selective outlines on every room edge and look a
 * softens them.
 */
function lineFor(fill) { return LOOK === 'default' ? fill : inkFor(fill); }
// B10 block ends here (PAL closes above).

// Window geometry shared with cam.js windowPane(): grid x 5.2..9.2 on the
// y=0 wall, from 12 px to 38 px above the floor line.
export const WINDOW = { x0: 5.2, x1: 9.2, hBot: 12, hTop: 38 };

export function windowRect(project) {
  const a = project(WINDOW.x0, 0); const b = project(WINDOW.x1, 0);
  const xs = [a.sx, b.sx]; const ys = [a.sy - WINDOW.hTop, b.sy - WINDOW.hTop, a.sy - WINDOW.hBot, b.sy - WINDOW.hBot];
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function hash32(seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
function unitHash(x, y, salt) {
  return hash32((x | 0) * 374761393 + (y | 0) * 668265263 + (salt | 0) * 974711) / 4294967296;
}

function poly(ctx, pts, fill, stroke) {
  if (!pts || pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke === OUTLINE ? inkFor(fill) : stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function px(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}
function cellPoly(P, x, y) {
  const a = P(x, y); const b = P(x + 1, y); const c = P(x + 1, y + 1); const d = P(x, y + 1);
  return [[a.sx, a.sy], [b.sx, b.sy], [c.sx, c.sy], [d.sx, d.sy]];
}
// Point on a wall: grid position along the wall, height above the floor line.
function wallPt(P, axis, along, h) {
  const p = axis === 'back' ? P(along, 0) : P(0, along);
  return [p.sx, p.sy - h];
}

/** Renderer-only decor never occupies a floor cell. */
export const DECOR_FLOOR_CELLS = [];
export function decorTouchesFloorCell(gx, gy) {
  return DECOR_FLOOR_CELLS.some(([x, y]) => x === gx && y === gy);
}

// Decor anchors: { id, wall, along0, along1, hBot, hTop } in wall space.
// Left wall avoids the drawing-wall spot (grid 0,2); the back wall decor
// stays clear of the window span (grid x 5.2..9.2, 12..38 px up).
export const DECOR = [
  { id: 'shelf', wall: 'left', along0: 4.6, along1: 6.0, hBot: 26, hTop: 34 },
  { id: 'frame_a', wall: 'left', along0: 3.4, along1: 4.2, hBot: 18, hTop: 30 },
  { id: 'frame_b', wall: 'left', along0: 6.3, along1: 7.0, hBot: 20, hTop: 30 },
  { id: 'fairy', wall: 'back', along0: 0.4, along1: 9.6, hBot: 54, hTop: 57 },
  { id: 'clock', wall: 'back', along0: 1.6, along1: 2.6, hBot: 24, hTop: 36 },
  { id: 'sconce', wall: 'left', along0: 5.1, along1: 5.5, hBot: 24, hTop: 32 },
];

/** Axis-aligned screen rects (project space) for every decor item. */
export function decorRects(project, wallH, look = 'default') {
  void wallH;
  const out = [];
  const list = look === 'b' || look === 'c' ? [...DECOR, ...EXTRA_DECOR] : DECOR;
  for (const d of list) {
    if (d.id === 'fairy') {
      // One small rect per bulb so slant-aware checks stay honest.
      for (let i = 0; i < 12; i += 1) {
        if (i >= 4 && i <= 8) continue;
        const p = wallPt(project, 'back', 0.4 + (9.2 * i) / 11, 56);
        out.push({ id: `fairy_${i}`, wall: d.wall, x: p[0], y: p[1], w: 2, h: 3 });
      }
      continue;
    }
    const pts = [
      wallPt(project, d.wall, d.along0, d.hBot), wallPt(project, d.wall, d.along1, d.hBot),
      wallPt(project, d.wall, d.along0, d.hTop), wallPt(project, d.wall, d.along1, d.hTop),
    ];
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs); const y = Math.min(...ys);
    out.push({ id: d.id, wall: d.wall, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
  }
  return out;
}

function drawLookDecor(ctx, P) {
  if (!extraDecorFor(LOOK).length) return;
  const ink = inkFor;
  // Framed print on the back wall, left of the window span.
  { const a = wallPt(P, 'back', 2.9, 18); const b = wallPt(P, 'back', 4.3, 18);
    const at = wallPt(P, 'back', 2.9, 32); const bt = wallPt(P, 'back', 4.3, 32);
    poly(ctx, [a, b, bt, at], PAL.frameWood, ink(PAL.frameWood));
    const cx = Math.round((a[0] + b[0] + at[0] + bt[0]) / 4);
    const cy = Math.round((a[1] + b[1] + at[1] + bt[1]) / 4);
    ctx.fillStyle = PAL.frameArtA;
    ctx.fillRect(cx - 5, cy - 4, 10, 8);
    ctx.strokeStyle = ink(PAL.frameArtA); ctx.lineWidth = 1;
    ctx.strokeRect(cx - 5 + 0.5, cy - 4 + 0.5, 10, 8);
    px(ctx, cx + 2, cy - 2, PAL.rugMotif);
    px(ctx, cx - 3, cy + 2, PAL.plantLeaf);
    if (LOOK === 'b' || LOOK === 'c') {
      ctx.strokeStyle = ink(PAL.rugMotif); ctx.lineWidth = 1;
      ctx.strokeRect(cx - 4 + 0.5, cy - 3 + 0.5, 8, 6);
      px(ctx, cx - 1, cy + 1, PAL.bookB);
      px(ctx, cx + 1, cy, PAL.plantLeafDark);
    } }
  // Bunting string above the clock, with five small flags.
  { const pts = [];
    for (let i = 0; i <= 8; i += 1) {
      const sag = Math.round(Math.sin((i / 8) * Math.PI) * 2);
      pts.push(wallPt(P, 'back', 0.2 + (1.8 * i) / 8, 47 - sag)); }
    ctx.strokeStyle = ink(PAL.shelfWood); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    const flagCols = [PAL.bookA, PAL.rugBase, PAL.bookC, PAL.rugMotif, PAL.bookB];
    for (let i = 0; i < 5; i += 1) { const q = pts[1 + i * 1];
      poly(ctx, [[q[0] - 2, q[1]], [q[0] + 2, q[1]], [q[0], q[1] + 3]], flagCols[i], ink(flagCols[i])); } }
  // Mini frame on the left wall, above frame_b.
  { const a = wallPt(P, 'left', 6.5, 33); const b = wallPt(P, 'left', 7.1, 33);
    const at = wallPt(P, 'left', 6.5, 41); const bt = wallPt(P, 'left', 7.1, 41);
    poly(ctx, [a, b, bt, at], PAL.frameWood, ink(PAL.frameWood));
    const cx = Math.round((a[0] + b[0] + at[0] + bt[0]) / 4);
    const cy = Math.round((a[1] + b[1] + at[1] + bt[1]) / 4);
    ctx.fillStyle = PAL.frameArtB;
    ctx.fillRect(cx - 3, cy - 2, 6, 5);
    ctx.strokeStyle = ink(PAL.frameArtB);
    ctx.strokeRect(cx - 3 + 0.5, cy - 2 + 0.5, 6, 5); }
  // Wall hook with a hanging cap on the left wall.
  { const h = wallPt(P, 'left', 2.6, 38);
    ctx.fillStyle = PAL.woodDark;
    ctx.fillRect(Math.round(h[0]), Math.round(h[1]), 3, 2);
    const cx = Math.round(h[0]) + 1; const cy = Math.round(h[1]) + 5;
    ctx.fillStyle = PAL.curtainB;
    ctx.fillRect(cx - 2, cy - 2, 5, 3);
    ctx.fillRect(cx - 3, cy + 1, 7, 1);
    ctx.strokeStyle = ink(PAL.curtainB); ctx.lineWidth = 1;
    ctx.strokeRect(cx - 2 + 0.5, cy - 2 + 0.5, 5, 3);
    if (LOOK === 'b' || LOOK === 'c') {
      ctx.fillStyle = PAL.curtainC;
      ctx.fillRect(cx - 2, cy + 1, 7, 1);
    } }
  // Mini shelf with two books and a sprout on the left wall.
  { const s0 = wallPt(P, 'left', 7.35, 24); const s1 = wallPt(P, 'left', 8.0, 24);
    poly(ctx, [s0, s1, [s1[0], s1[1] + 2], [s0[0], s0[1] + 2]], PAL.shelfWood, ink(PAL.shelfWood));
    const cols = [PAL.bookC, PAL.bookA];
    for (let i = 0; i < 2; i += 1) {
      const bx = s0[0] + (s1[0] - s0[0]) * (0.15 + i * 0.25);
      const by = s0[1] + (s1[1] - s0[1]) * (0.15 + i * 0.25);
      ctx.fillStyle = cols[i];
      ctx.fillRect(Math.round(bx), Math.round(by - 5), 3, 5);
      ctx.strokeStyle = ink(cols[i]); ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by - 5) + 0.5, 3, 5);
      if (LOOK === 'b' || LOOK === 'c') {
        ctx.fillStyle = PAL.paper;
        ctx.fillRect(Math.round(bx) + 1, Math.round(by - 4), 1, 3);
      } }
    const pp = [s0[0] + (s1[0] - s0[0]) * 0.78, s0[1] + (s1[1] - s0[1]) * 0.78];
    ctx.fillStyle = PAL.plantPot;
    ctx.fillRect(Math.round(pp[0]), Math.round(pp[1] - 3), 4, 3);
    px(ctx, pp[0] + 1, pp[1] - 5, PAL.plantLeaf); }
}

function drawVignette(ctx) {
  ctx.fillStyle = PAL.vignetteInner;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  const g = ctx.createRadialGradient(160, 118, 30, 160, 118, 190);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, PAL.vignetteOuter);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  if (LOOK === 'a') {
    // Soft rose dust specks floating in the void behind the room block
    // (the room shell paints over the middle, so only the edges show).
    for (let i = 0; i < 44; i += 1) {
      const x = Math.floor(unitHash(i, 7, 101) * LOGICAL_W);
      const y = Math.floor(unitHash(i, 13, 103) * LOGICAL_H);
      ctx.fillStyle = i % 5 === 0 ? '#ffe0c0' : '#c98878';
      ctx.globalAlpha = 0.22 + 0.3 * unitHash(i, 29, 107);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
  }
}

function drawSlabShadow(ctx, P, gridW, gridH) {
  const a = P(0, gridH); const b = P(gridW, gridH); const c = P(gridW, 0); const d = P(0, 0);
  void d; void c;
  ctx.fillStyle = PAL.slabShadow;
  ctx.beginPath();
  ctx.ellipse((a.sx + b.sx) / 2 + 6, b.sy + 8, Math.abs(b.sx - a.sx) / 2 + 12, 16, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawWall(ctx, P, gridW, gridH, wallH, axis) {
  const len = axis === 'back' ? gridW : gridH;
  const base0 = wallPt(P, axis, 0, 0); const base1 = wallPt(P, axis, len, 0);
  const top0 = wallPt(P, axis, 0, wallH); const top1 = wallPt(P, axis, len, wallH);
  const wainsH = Math.round(wallH * 0.4);
  const w0 = wallPt(P, axis, 0, wainsH); const w1 = wallPt(P, axis, len, wainsH);
  // Cream wallpaper above, sage wainscot below.
  poly(ctx, [base0, base1, top1, top0], PAL.wallCream, null);
  poly(ctx, [base0, base1, w1, w0], PAL.wainscot, null);
  // Subtle low-contrast wallpaper dots on the upper band only.
  ctx.save();
  poly(ctx, [w0, w1, top1, top0], null, null);
  ctx.clip();
  for (let i = 0; i < 90; i += 1) {
    const u = unitHash(i, axis === 'back' ? 1 : 2, 31);
    const v = unitHash(i, axis === 'back' ? 3 : 4, 37);
    const bx = w0[0] + (w1[0] - w0[0]) * u + (top0[0] - w0[0]) * v;
    const by = w0[1] + (w1[1] - w0[1]) * u + (top0[1] - w0[1]) * v;
    px(ctx, bx, by, PAL.wallPaperDot);
  }
  ctx.restore();
  // Trim line between the two tones.
  poly(ctx, [w0, w1, [w1[0], w1[1] - 1], [w0[0], w0[1] - 1]], PAL.wainscotTrim, null);
  ctx.strokeStyle = lineFor(PAL.wainscotDark); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(w0[0], w0[1]); ctx.lineTo(w1[0], w1[1]); ctx.stroke();
  // Lighter 3 px top cap following the wall slope.
  poly(ctx, [top0, top1, [top1[0], top1[1] - 3], [top0[0], top0[1] - 3]], PAL.wallCap, OUTLINE);
  // Darker 3 px baseboard along the floor line.
  poly(ctx, [base0, base1, [base1[0], base1[1] - 3], [base0[0], base0[1] - 3]], PAL.wallBase, null);
  // Solid wall outline.
  poly(ctx, [base0, base1, top1, top0], null, OUTLINE);
  // Cut end (about 4 px) at the front end of the wall.
  const f = base1; const ft = top1;
  const dirx = axis === 'back' ? 4 : -3; const diry = axis === 'back' ? 2 : 2;
  poly(ctx, [f, [f[0] + dirx, f[1] + diry], [ft[0] + dirx, ft[1] + diry - 3], [ft[0], ft[1] - 3]], PAL.wallEnd, OUTLINE);
}

function drawLeftDecor(ctx, P) {
  // Floating shelf with books and a small plant (grid y 4.6..6.0).
  const s0 = wallPt(P, 'left', 4.6, 27); const s1 = wallPt(P, 'left', 6.0, 27);
  poly(ctx, [s0, s1, [s1[0], s1[1] + 2], [s0[0], s0[1] + 2]], PAL.shelfWood, OUTLINE);
  const bookCols = [PAL.bookA, PAL.bookB, PAL.bookC, PAL.bookA];
  for (let i = 0; i < 4; i += 1) {
    const bx = s0[0] + (s1[0] - s0[0]) * (0.08 + i * 0.16);
    const by = s0[1] + (s1[1] - s0[1]) * (0.08 + i * 0.16);
    ctx.fillStyle = bookCols[i];
    ctx.fillRect(Math.round(bx), Math.round(by - 6), 3, 6);
    ctx.strokeStyle = inkFor(bookCols[i]); ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by - 6) + 0.5, 3, 6);
    if (LOOK === 'b' || LOOK === 'c') {
      ctx.fillStyle = PAL.paper;
      ctx.fillRect(Math.round(bx) + 1, Math.round(by - 5), 1, 4);
    }
  }
  const pp = [s0[0] + (s1[0] - s0[0]) * 0.82, s0[1] + (s1[1] - s0[1]) * 0.82];
  ctx.fillStyle = PAL.plantPot;
  ctx.fillRect(Math.round(pp[0]), Math.round(pp[1] - 3), 4, 3);
  px(ctx, pp[0] + 1, pp[1] - 5, PAL.plantLeaf);
  px(ctx, pp[0] + 2, pp[1] - 4, PAL.plantLeafDark);
  if (LOOK === 'b' || LOOK === 'c') {
    px(ctx, pp[0], pp[1] - 4, PAL.plantLeafDark);
    px(ctx, pp[0] + 3, pp[1] - 6, PAL.plantLeaf);
  }
  // Two framed pictures.
  for (const d of DECOR.filter((x) => x.id.startsWith('frame'))) {
    const a = wallPt(P, 'left', d.along0, d.hBot); const b = wallPt(P, 'left', d.along1, d.hBot);
    const at = wallPt(P, 'left', d.along0, d.hTop); const bt = wallPt(P, 'left', d.along1, d.hTop);
    poly(ctx, [a, b, bt, at], PAL.frameWood, OUTLINE);
    const inset = (p, q, r, s, k) => [p[0] + (q[0] - p[0]) * 0 + (r[0] - p[0]) * k, p[1] + (s[1] - p[1]) * k];
    void inset;
    const cx = (a[0] + b[0] + at[0] + bt[0]) / 4; const cy = (a[1] + b[1] + at[1] + bt[1]) / 4;
    ctx.fillStyle = d.id === 'frame_a' ? PAL.frameArtA : PAL.frameArtB;
    ctx.fillRect(Math.round(cx - 4), Math.round(cy - 3), 8, 6);
    ctx.strokeStyle = inkFor(d.id === 'frame_a' ? PAL.frameArtA : PAL.frameArtB); ctx.strokeRect(Math.round(cx - 4) + 0.5, Math.round(cy - 3) + 0.5, 8, 6);
    px(ctx, cx - 2, cy + 1, PAL.plantLeaf);
    px(ctx, cx + 2, cy - 1, PAL.wallCap);
  }
  // Wall sconce (glow is dynamic; fixture is static).
  const sc = wallPt(P, 'left', 5.3, 28);
  ctx.fillStyle = PAL.frameWood;
  ctx.fillRect(Math.round(sc[0] - 1), Math.round(sc[1]), 3, 4);
  ctx.fillStyle = '#f2d48a';
  ctx.fillRect(Math.round(sc[0] - 2), Math.round(sc[1] - 3), 5, 3);
  ctx.strokeStyle = inkFor('#f2d48a'); ctx.strokeRect(Math.round(sc[0] - 2) + 0.5, Math.round(sc[1] - 3) + 0.5, 5, 3);
}

function drawBackDecor(ctx, P, gridW) {
  // Fairy-light bulbs along the top of the back wall (off state; the
  // dynamic layer repaints lit bulbs at night).
  for (let i = 0; i < 12; i += 1) {
    if (i >= 4 && i <= 8) continue;
    const along = 0.4 + (9.2 * i) / 11;
    const p = wallPt(P, 'back', along, 56);
    ctx.fillStyle = PAL.fairyOff;
    ctx.fillRect(Math.round(p[0]), Math.round(p[1]), 2, 2);
  }
  void gridW;
  // Clock face (hands are dynamic).
  const c = wallPt(P, 'back', 2.1, 30);
  ctx.fillStyle = PAL.clockFace;
  ctx.beginPath(); ctx.arc(Math.round(c[0]), Math.round(c[1]), 6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = inkFor(PAL.clockFace); ctx.lineWidth = 1; ctx.stroke();
}

function plankTone(seg, row) {
  const u = unitHash(seg, row, 11);
  if (u < 0.36) return PAL.woodLight;
  if (u < 0.7) return PAL.woodMid;
  return PAL.woodDark;
}

export function drawPlankFloor(ctx, P, gridW, gridH, debug) {
  // A continuous undercoat prevents antialiased polygon edges exposing void.
  const point = (x, y) => { const p = P(x, y); return [p.sx, p.sy]; };
  poly(ctx, [point(0, 0), point(gridW, 0), point(gridW, gridH), point(0, gridH)], PAL.woodMid, null);
  // Narrow boards, offset from integer cell boundaries; butt joints stagger
  // independently per row and never snap to the gameplay grid.
  for (let row = 0; row < Math.ceil(gridH * 3) + 1; row += 1) {
    const y0 = Math.max(0, (row - 0.61) / 3);
    const y1 = Math.min(gridH, (row + 0.39) / 3);
    if (y1 <= y0) continue;
    let x = -2.7 + unitHash(row, 0, 73) * 2.1;
    let seg = 0;
    while (x < gridW) {
      const end = x + 2.3 + unitHash(row, seg, 79) * 1.4;
      const left = Math.max(0, x); const right = Math.min(gridW, end);
      if (right > left) {
        poly(ctx, [point(left, y0), point(right, y0), point(right, y1), point(left, y1)], plankTone(seg, row), null);
        ctx.strokeStyle = lineFor(PAL.plankSeam); ctx.lineWidth = 1;
        if (y0 > 0) {
          const a = point(left, y0); const b = point(right, y0);
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
        }
        if (x > 0) {
          const a = point(x, y0); const b = point(x, y1);
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
        }
        // Sparse one-pixel grain, away from board edges.
        if (unitHash(row, seg, 83) > 0.45) {
          const g = P(left + (right - left) * 0.46, (y0 + y1) / 2);
          px(ctx, g.sx, g.sy, PAL.plankSeam);
          px(ctx, g.sx + 2, g.sy + 1, PAL.plankSeam);
        }
      }
      x = end; seg += 1;
    }
  }
  if (debug) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    for (let x = 0; x < gridW; x += 1) {
      for (let y = 0; y < gridH; y += 1) {
        const q = cellPoly(P, x, y);
        ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < 4; i += 1) ctx.lineTo(q[i][0], q[i][1]);
        ctx.closePath(); ctx.stroke();
      }
    }
  }
}

function drawRugs(ctx, P) {
  // Large patterned rug: one 3x2 block in the open front-centre.
  const a = P(4, 5); const b = P(7, 5); const c = P(7, 7); const d = P(4, 7);
  const outer = [[a.sx, a.sy], [b.sx, b.sy], [c.sx, c.sy], [d.sx, d.sy]];
  poly(ctx, outer, PAL.rugBase, OUTLINE);
  const cx = (a.sx + c.sx) / 2; const cy = (a.sy + c.sy) / 2;
  const inner = outer.map(([x, y]) => [cx + (x - cx) * 0.78, cy + (y - cy) * 0.78]);
  poly(ctx, inner, PAL.rugInner, PAL.rugBorder);
  const motif = [[cx, cy - 7], [cx + 12, cy], [cx, cy + 7], [cx - 12, cy]];
  poly(ctx, motif, PAL.rugMotif, PAL.rugBorder);
  px(ctx, cx - 1, cy - 1, PAL.rugBorder); px(ctx, cx + 20, cy - 4, PAL.rugMotif);
  px(ctx, cx - 22, cy + 3, PAL.rugMotif); px(ctx, cx + 4, cy + 5, PAL.rugBorder);
  if (LOOK === 'b' || LOOK === 'c') {
    // Woven fringe sticking out of the rug's two short ends.
    const fringe = (p, q) => {
      const mx = (p[0] + q[0]) / 2 - cx; const my = (p[1] + q[1]) / 2 - cy;
      const len = Math.hypot(mx, my) || 1;
      for (let i = 1; i < 7; i += 1) {
        const t = i / 7;
        const fx = p[0] + (q[0] - p[0]) * t + (mx / len) * 2;
        const fy = p[1] + (q[1] - p[1]) * t + (my / len) * 2;
        ctx.fillStyle = i % 2 ? PAL.rugMotif : PAL.rugBorder;
        ctx.fillRect(Math.round(fx), Math.round(fy), 1, 2);
      }
    };
    fringe(a, d); fringe(b, c);
  }
  // Small oval rug near the bed corner (bed sits at grid 8,6).
  const bp = P(7.6, 6.4);
  ctx.fillStyle = PAL.rugOval;
  ctx.beginPath(); ctx.ellipse(bp.sx, bp.sy, 13, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = inkFor(PAL.rugOval); ctx.lineWidth = 1; ctx.stroke();
  ctx.strokeStyle = lineFor(PAL.rugOvalRing);
  ctx.beginPath(); ctx.ellipse(bp.sx, bp.sy, 9, 4, 0, 0, Math.PI * 2); ctx.stroke();
}

function drawFloorAO(ctx, P, gridW, gridH) {
  // 4-6 px darkening along both wall seams plus a darker back corner.
  for (let i = 0; i < 5; i += 1) {
    ctx.strokeStyle = PAL.aoSeam; ctx.globalAlpha = 0.55 - i * 0.1; ctx.lineWidth = 1;
    const a1 = P(0, 0); const b1 = P(gridW, 0);
    ctx.beginPath(); ctx.moveTo(a1.sx, a1.sy + 1 + i); ctx.lineTo(b1.sx, b1.sy + 1 + i); ctx.stroke();
    const a2 = P(0, 0); const b2 = P(0, gridH);
    ctx.beginPath(); ctx.moveTo(a2.sx - 1 - i, a2.sy + i); ctx.lineTo(b2.sx - 1 - i, b2.sy + i); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const corner = P(1, 1);
  ctx.fillStyle = PAL.aoCorner;
  ctx.beginPath(); ctx.ellipse(corner.sx - 14, corner.sy - 4, 16, 8, 0, 0, Math.PI * 2); ctx.fill();
}

function drawSlabThickness(ctx, P, gridW, gridH) {
  const slabD = Math.max(7, Math.round(7 * lightFor(LOOK).block));
  // 6-8 px cross-section under the two front floor edges.
  const a = P(0, gridH); const b = P(gridW, gridH); const c = P(gridW, 0);
  poly(ctx, [[a.sx, a.sy], [b.sx, b.sy], [b.sx, b.sy + slabD], [a.sx, a.sy + slabD]], PAL.slabSideWarm, OUTLINE);
  poly(ctx, [[b.sx, b.sy], [c.sx, c.sy], [c.sx, c.sy + slabD], [b.sx, b.sy + slabD]], PAL.slabSideCool, OUTLINE);
  ctx.strokeStyle = lineFor(PAL.slabEarth); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(a.sx, a.sy + 4); ctx.lineTo(b.sx, b.sy + 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(b.sx, b.sy + 4); ctx.lineTo(c.sx, c.sy + 4); ctx.stroke();
}

function buildStaticScene(ctx, opts) {
  setSceneLook(opts.look);
  const { P, gridW, gridH, wallH, debug, pane } = opts;
  drawVignette(ctx);
  drawSlabShadow(ctx, P, gridW, gridH);
  drawWall(ctx, P, gridW, gridH, wallH, 'back');
  drawWall(ctx, P, gridW, gridH, wallH, 'left');
  drawLeftDecor(ctx, P);
  drawBackDecor(ctx, P, gridW);
  drawLookDecor(ctx, P);
  if (pane && pane.quad) {
    const quad = pane.quad.map(([x, y]) => [x + opts.roomOff.x, y + opts.roomOff.y]);
    poly(ctx, quad, '#241c14', OUTLINE);
  }
  drawPlankFloor(ctx, P, gridW, gridH, debug);
  drawRugs(ctx, P);
  drawFloorAO(ctx, P, gridW, gridH);
  drawSlabThickness(ctx, P, gridW, gridH);
}

export function createSceneStaticCache(options) {
  const {
    logicalW = LOGICAL_W, logicalH = LOGICAL_H, wallH = 44,
    project = defaultProject, createCanvas,
  } = options;
  let key = ''; let canvas = null; let buildCount = 0;
  function ensure(gridW, gridH, roomOff, debug, pane, look = 'default') {
    const nextKey = `${gridW}x${gridH}|${debug ? 1 : 0}|${roomOff.x},${roomOff.y}|${wallH}|${look}`;
    if (nextKey === key && canvas) return canvas;
    key = nextKey; buildCount += 1;
    canvas = createCanvas(logicalW, logicalH);
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, logicalW, logicalH);
    // Draw in screen space so the cached image lines up with the centred
    // room; blit() then lands it at the canvas origin.
    const P = (x, y, z = 0) => {
      const p = project(x, y, z);
      return { sx: p.sx + roomOff.x, sy: p.sy + roomOff.y, x: p.sx + roomOff.x, y: p.sy + roomOff.y };
    };
    buildStaticScene(g, { P, project, gridW, gridH, wallH, roomOff, debug, pane, look });
    return canvas;
  }
  function blit(ctx, gridW, gridH, roomOff, debug, pane, look = 'default') {
    ensure(gridW, gridH, roomOff, debug, pane, look);
    ctx.drawImage(canvas, -roomOff.x, -roomOff.y);
    return canvas;
  }
  return { ensure, blit, get buildCount() { return buildCount; }, get key() { return key; } };
}

export function drawWindowDressing(ctx, pane, project) {
  if (!pane || !pane.quad || !pane.wpt) return;
  const { wpt } = pane;
  // Curtains on both sides: three fold shades each.
  const folds = [PAL.curtainB, PAL.curtainA, PAL.curtainC];
  for (let side = 0; side < 2; side += 1) {
    const gx = side === 0 ? WINDOW.x0 - 0.15 : WINDOW.x1 - 0.55;
    for (let f = 0; f < 3; f += 1) {
      const top = wpt(gx + f * 0.22, WINDOW.hTop + 1);
      const bot = wpt(gx + f * 0.22, WINDOW.hBot + 2);
      ctx.fillStyle = folds[f];
      ctx.fillRect(Math.round(top[0]), Math.round(top[1]), 4, Math.round(bot[1] - top[1]));
      ctx.strokeStyle = inkFor(folds[f]); ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(top[0]) + 0.5, Math.round(top[1]) + 0.5, 4, Math.round(bot[1] - top[1]));
    }
  }
  // Sill with a tiny potted plant.
  const s0 = wpt(WINDOW.x0 - 0.2, WINDOW.hBot - 1);
  const s1 = wpt(WINDOW.x1 + 0.2, WINDOW.hBot - 1);
  const b1 = wpt(WINDOW.x1 + 0.2, WINDOW.hBot - 4);
  const b0 = wpt(WINDOW.x0 - 0.2, WINDOW.hBot - 4);
  poly(ctx, [s0, s1, b1, b0], PAL.shelfWood, OUTLINE);
  const pot = wpt(6.9, WINDOW.hBot + 1);
  ctx.fillStyle = PAL.plantPot;
  ctx.fillRect(Math.round(pot[0]), Math.round(pot[1]), 4, 3);
  px(ctx, pot[0] + 1, pot[1] - 2, PAL.plantLeaf);
  px(ctx, pot[0] + 2, pot[1] - 3, PAL.plantLeafDark);
  if (LOOK === 'b' || LOOK === 'c') {
    // Fuller readable plant on the sill: bigger pot, more leaves.
    ctx.fillRect(Math.round(pot[0]) - 1, Math.round(pot[1]) + 1, 6, 2);
    px(ctx, pot[0], pot[1] - 3, PAL.plantLeafDark);
    px(ctx, pot[0] + 3, pot[1] - 4, PAL.plantLeaf);
    px(ctx, pot[0] + 1, pot[1] - 4, PAL.plantLeafDark);
  }
}

export function drawClockHands(ctx, cx, cy, t) {
  const ms = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  const totalMin = Math.floor(ms / 60000);
  const min = ((totalMin % 60) + 60) % 60;
  const hr = ((Math.floor(totalMin / 60) % 12) + 12) % 12;
  const minAng = (min / 60) * Math.PI * 2 - Math.PI / 2;
  const hrAng = ((hr + min / 60) / 12) * Math.PI * 2 - Math.PI / 2;
  ctx.strokeStyle = lineFor(PAL.clockHand); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.lineTo(Math.round(cx + Math.cos(hrAng) * 3), Math.round(cy + Math.sin(hrAng) * 3)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.lineTo(Math.round(cx + Math.cos(minAng) * 5), Math.round(cy + Math.sin(minAng) * 5)); ctx.stroke();
}

/** Screen-space rect that the night ambient must cover (all 4 corners). */
export function nightAmbientRect(roomOff) {
  const off = roomOff || { x: 0, y: 0 };
  return { x: -off.x, y: -off.y, w: LOGICAL_W, h: LOGICAL_H };
}

/** Warm glow centres (project space) used at night. */
export function lampGlowCentres(project, pane) {
  const desk = project(8, 1);
  const sconce = project(0, 5.3);
  const out = [
    { id: 'desk_lamp', x: desk.sx - 11, y: desk.sy - 17, r: 46 },
    { id: 'sconce', x: sconce.sx, y: sconce.sy - 29, r: 24 },
  ];
  if (pane && pane.rect) {
    out.push({ id: 'window', x: pane.rect.x + pane.rect.w / 2, y: pane.rect.y + pane.rect.h / 2, r: 30 });
  }
  return out;
}

// --- Nori at night ----------------------------------------------------------
// Her sprite takes the same night ambient as the room, plus a capped warm
// lift that falls off with the distance from her foot point to each nearby
// lamp. The math is per pixel on her own sprite and never writes alpha, so
// nothing outside her silhouette changes and the outline and eyes stay crisp.
const NIGHT_SPRITE_LIFT = Object.freeze({
  cap: 0.24,
  lamps: Object.freeze({
    desk_lamp: { peak: 0.26, reach: 72, rgb: [255, 196, 112] },
    sconce: { peak: 0.2, reach: 48, rgb: [255, 190, 100] },
    // Window and moon give a small lift, kept warm like the lamps.
    window: { peak: 0.08, reach: 56, rgb: [255, 226, 180] },
  }),
});
const FLASH_RGB = [240, 246, 255];

function parseRgba(css) {
  const m = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(css);
  if (!m) throw new Error(`not an rgba() colour: ${css}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4]) };
}
const NIGHT_AMBIENT = parseRgba(PAL.nightAmbient);

/**
 * Night light for Nori's sprite, or null unless the view is night.
 * footX/footY: her foot point in room space (the space lampGlowCentres uses).
 * flashWash: the room's thunder-flash alpha, 0 when there is none.
 */
export function nightSpriteLight(view, project, pane, footX, footY, flashWash = 0) {
  if (!view || view.sky !== 'night') return null;
  let weight = 0; let kr = 0; let kg = 0; let kb = 0;
  for (const lamp of lampGlowCentres(project, pane)) {
    const spec = NIGHT_SPRITE_LIFT.lamps[lamp.id];
    if (!spec) continue;
    const d = Math.hypot(footX - lamp.x, footY - lamp.y);
    const w = spec.peak * Math.max(0, 1 - d / spec.reach);
    if (w <= 0) continue;
    const top = Math.max(...spec.rgb);
    weight += w;
    kr += (w * spec.rgb[0]) / top;
    kg += (w * spec.rgb[1]) / top;
    kb += (w * spec.rgb[2]) / top;
  }
  const strength = Math.min(NIGHT_SPRITE_LIFT.cap, weight);
  const gain = weight > 0
    ? [1 + (strength * kr) / weight, 1 + (strength * kg) / weight, 1 + (strength * kb) / weight]
    : [1, 1, 1];
  const flash = flashWash > 0 ? { rgb: FLASH_RGB, a: Math.min(1, flashWash) } : null;
  return { ambient: NIGHT_AMBIENT, gain, flash };
}

/**
 * Applies a night light to RGBA bytes in place, in the room's order: ambient
 * fill, warm lift, then flash wash. Alpha is never written and fully
 * transparent pixels are skipped, so the silhouette is untouched.
 */
export function applyNightSpriteLight(data, light) {
  const { ambient, gain, flash } = light;
  const aa = ambient.a; const [ar, ag, ab] = ambient.rgb;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let r = (data[i] * (1 - aa) + ar * aa) * gain[0];
    let g = (data[i + 1] * (1 - aa) + ag * aa) * gain[1];
    let b = (data[i + 2] * (1 - aa) + ab * aa) * gain[2];
    if (flash) {
      r = r * (1 - flash.a) + flash.rgb[0] * flash.a;
      g = g * (1 - flash.a) + flash.rgb[1] * flash.a;
      b = b * (1 - flash.a) + flash.rgb[2] * flash.a;
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return data;
}

function radialGlow(ctx, cx, cy, r, core, mid) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, core);
  g.addColorStop(0.55, mid);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
}

function drawLightShaft(ctx, project, view, pane, t) {
  const polygon = view.sunPatch && view.sunPatch.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3 || !pane || !pane.wpt) return;
  const quad = polygon.map(([gx, gy]) => { const p = project(gx, gy); return [p.sx, p.sy]; });
  const w0 = pane.wpt(WINDOW.x0 + 0.4, WINDOW.hTop - 4);
  const w1 = pane.wpt(WINDOW.x1 - 0.4, WINDOW.hTop - 4);
  ctx.save();
  ctx.fillStyle = PAL.shaftFill;
  ctx.beginPath();
  ctx.moveTo(w0[0], w0[1]); ctx.lineTo(w1[0], w1[1]);
  ctx.lineTo(quad[1][0], quad[1][1]); ctx.lineTo(quad[0][0], quad[0][1]);
  ctx.closePath(); ctx.fill();
  if (LOOK === 'a' || LOOK === 'b' || LOOK === 'c') {
    // Visible volumetric beam from the sill to the floor patch, plus a
    // brightened patch: warm for a/c, cool and faint for b.
    const spread = LOOK === 'a' ? 14 : LOOK === 'c' ? 10 : 8;
    const col = LOOK === 'b' ? '200,215,240' : '255,196,128';
    const beamA = LOOK === 'a' ? '0.10' : LOOK === 'c' ? '0.07' : '0.05';
    const patchA = LOOK === 'a' ? '0.22' : LOOK === 'c' ? '0.14' : '0.08';
    ctx.fillStyle = 'rgba(' + col + ',' + beamA + ')';
    ctx.beginPath();
    ctx.moveTo(w0[0] - spread, w0[1]); ctx.lineTo(w1[0] + spread, w1[1]);
    ctx.lineTo(quad[1][0] + spread, quad[1][1]); ctx.lineTo(quad[0][0] - spread, quad[0][1]);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(' + col + ',' + patchA + ')';
    ctx.beginPath(); ctx.moveTo(quad[0][0], quad[0][1]);
    for (let i = 1; i < quad.length; i += 1) ctx.lineTo(quad[i][0], quad[i][1]);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // Slow dust motes drifting inside the shaft.
  for (let i = 0, moteCount = 6 * lightFor(LOOK).dust; i < moteCount; i += 1) {
    const u = unitHash(i, 3, 51);
    const v = unitHash(i, 9, 53);
    const drift = 0.5 + 0.5 * Math.sin(t / 2600 + i * 1.9);
    const mx = w0[0] + (quad[1][0] - w0[0]) * u + drift * 2;
    const my = w0[1] + (quad[2][1] - w0[1]) * v + drift;
    ctx.fillStyle = PAL.dust;
    ctx.globalAlpha = 0.35 + 0.3 * unitHash(i, Math.floor(t / 1800), 57);
    ctx.fillRect(Math.round(mx), Math.round(my), 1, 1);
    ctx.globalAlpha = 1;
  }
}

function drawFairyTwinkle(ctx, project, t) {
  for (let i = 0; i < 12; i += 1) {
    if (i >= 4 && i <= 8) continue;
    const along = 0.4 + (9.2 * i) / 11;
    const p = wallPt(project, 'back', along, 56);
    const on = unitHash(i, Math.floor(t / 480), 61) > 0.45;
    ctx.fillStyle = on ? PAL.fairyOn : PAL.fairyOff;
    ctx.fillRect(Math.round(p[0]), Math.round(p[1]), 2, 2);
    radialGlow(ctx, p[0] + 1, p[1] + 1, 3, on ? 'rgba(255,213,126,0.8)' : 'rgba(255,183,96,0.35)', 'rgba(255,170,80,0.12)');
    if (on) px(ctx, p[0], p[1] - 1, PAL.fairyOn);
  }
}

export function drawSceneDynamic(ctx, opts) {
  const { project, view, pane, wallH = 44 } = opts;
  setSceneLook(opts.look);
  const t = typeof opts.t === 'number' && Number.isFinite(opts.t) ? opts.t : 0;
  const roomOff = opts.roomOff || { x: 0, y: 0 };
  const light = view && view.light ? view.light : lightAt(t);
  const isDark = light.phase === 'night' || (view && view.sky === 'night');

  if (view && view.sunPatch && view.sunPatch.allowed) {
    drawLightShaft(ctx, project, view, pane, t);
  }

  if (isDark) {
    // Ambient covers the whole logical canvas: no rectangle edges.
    const r = nightAmbientRect(roomOff);
    ctx.fillStyle = PAL.nightAmbient;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    // Clip light to the room volume so the diorama's void stays dark.
    const pt = (x, y, h = 0) => { const p = project(x, y); return [p.sx, p.sy - h]; };
    poly(ctx, [pt(0, 0, wallH + 3), pt(opts.gridW, 0, wallH + 3), pt(opts.gridW, 0),
      pt(opts.gridW, opts.gridH), pt(0, opts.gridH), pt(0, opts.gridH, wallH + 3)], null, null);
    ctx.clip();
    const pool = poolScaleFor(LOOK);
    for (const glow of lampGlowCentres(project, pane)) {
      if (glow.id === 'desk_lamp') {
        radialGlow(ctx, glow.x, glow.y, glow.r * pool, PAL.lampGlowCore, PAL.lampGlowMid);
        const f = project(7.7, 2.3);
        radialGlow(ctx, f.sx, f.sy, 33 * pool, 'rgba(255,181,83,0.62)', 'rgba(246,151,66,0.22)');
        radialGlow(ctx, glow.x, glow.y, 6 * pool, 'rgba(255,238,175,0.95)', 'rgba(255,201,95,0.5)');
      } else if (glow.id === 'sconce') {
        radialGlow(ctx, glow.x, glow.y + 10, glow.r * pool, PAL.sconceGlow, 'rgba(244,145,58,0.14)');
        const f = project(0.7, 5.3);
        radialGlow(ctx, f.sx, f.sy, 24 * pool, 'rgba(255,180,85,0.28)', 'rgba(244,145,58,0.09)');
        // Downward cone on the wall, tapering from the visible fixture.
        poly(ctx, [[glow.x - 2, glow.y], [glow.x + 2, glow.y],
          [glow.x + 12, glow.y + 24], [glow.x - 12, glow.y + 16]], 'rgba(255,180,89,0.16)', null);
        radialGlow(ctx, glow.x, glow.y, 4 * pool, 'rgba(255,232,161,0.95)', PAL.lampGlowMid);
      } else if (view && view.sky === 'night' && view.stars && view.stars.length > 0) {
        // cam-window exposes stars for clear, low-cloud nights (no moon API).
        const patch = [[5.6, 1.1], [7.8, 1.1], [8.6, 3.0], [6.4, 3.0]].map(([x, y]) => pt(x, y));
        poly(ctx, patch, 'rgba(142,174,255,0.12)', null);
      }
    }
    drawFairyTwinkle(ctx, project, t);
    ctx.restore();
  }

  // Clock hands always track t (UTC).
  const c = wallPt(project, 'back', 2.1, 30);
  drawClockHands(ctx, Math.round(c[0]), Math.round(c[1]), t);
  void wallH;
}

export function nightGlowWarmth(view) {
  if (!view || !view.light) return 0;
  return view.light.phase === 'night' ? 0.5 : 0;
}

export function drawPropContactShadows(ctx, objects, project, isPropVisible, kindOf) {
  for (const obj of objects || []) {
    if (!isPropVisible(obj)) continue;
    const k = kindOf(obj);
    if (k === 'env:sun' || k === 'drawing_wall') continue;
    const p = project(obj.x, obj.y, obj.z || 0);
    let w = k === 'bed' ? 15 : k === 'computer_desk' ? 13 : 10;
    let h = 4;
    let cy = p.sy + 2;
    // A ready gift sprite is wider than the default blob, so the shadow
    // spreads around its base. Anything else keeps today's shadow.
    try {
      if (obj && isGiftSpriteURL(obj.sprite)) {
        const entry = giftSpriteImage(obj.sprite);
        const nw = entry && entry.state === 'ready' && entry.image ? entry.image.naturalWidth || 0 : 0;
        if (nw > 0) { w = Math.max(8, Math.round(nw * 0.62)); h = 4; cy = p.sy + 3; }
      }
    } catch { /* keep the default shadow */ }
    ctx.fillStyle = PAL.shadow;
    ctx.beginPath();
    ctx.ellipse(p.sx, cy, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawForegroundPlant(ctx, project, gridH) {
  // Omitted: there is no non-walkable ledge wide enough for this planter.
  void ctx; void project; void gridH;
}

/** Contact remains on a real support plane; cosmetic jump height never moves it. */
export function supportShadow(pose, objects) {
  let z = pose.z || 0;
  if (pose.primitive === 'climb') {
    const levels = [0];
    for (const obj of objects || []) {
      if (obj.status && obj.status !== 'placed') continue;
      if (Math.abs(obj.x-pose.x)>0.6 || Math.abs(obj.y-pose.y)>0.6) continue;
      for (const level of obj.levels || []) if (level.z <= z + 1e-8) levels.push(level.z);
    }
    z = Math.max(...levels);
  }
  return { ...defaultProject(pose.x, pose.y, z), z };
}
