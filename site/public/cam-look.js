// cam-look.js — B10b preview-only look variants for the Cam room.
// Pure: no DOM, no wall clock, no randomness. NOT a world object source:
// production rendering is look 'default' and must be byte-identical with or
// without this module loaded.
// ?look=a  "warm diorama" (Kind Words): one rose/amber hue family for walls,
//         floor and rug; soft outlines mixed toward the fill; strong warm
//         window shaft by day, strong amber lamp pools at night, plum-to-dark
//         backdrop with soft specks, thicker room slab and base.
// ?look=b  "lived-in" (Unpacking): cool neutral daylight (grey-lavender
//         walls, natural wood floor, slate-blue backdrop); crisp selective
//         outlines (one art pixel, darker shade of the local colour) on room
//         edges and every prop; readable decor extras painted into the static
//         shell. Decor is not a world object: no catalog entry, not
//         interactable, never on Nori's floor paths.
// ?look=c  "mixed": b's outlines, materials and decor with a's warm palette
//         at about half strength, plus a's window shaft by day and lamp pools
//         by night (at ~2/3 strength so c still differs from a).
// ?catScale=real (independent of look): draw Nori at the rule-2 scale.
// ?catScale=mid: halfway between today's size and real. Only the drawn
// sprite size changes; anchor and world positions are untouched.

// Single source of truth for the base outline. Must stay equal to
// cam-props.js OUTLINE (asserted in cam-look.test.ts).
export const BASE_OUTLINE = '#3e2f26';

export const LOOKS = ['a', 'b', 'c'];
export const DEFAULT_LOOK = 'default';

// Owner pick 2026-11-03: look c with the mid cat scale is the product default.
// ?look=default&catScale=current still shows the pre-B10 rendering.
export const PRODUCT_LOOK = 'c';

/** 'a' | 'b' | 'c' | 'default'. Unknown or missing values fall back to the product look (c). */
export function parseLook(value) {
  return value === 'a' || value === 'b' || value === 'c' || value === DEFAULT_LOOK ? value : PRODUCT_LOOK;
}

/**
 * Read preview params from a URLSearchParams (or anything with .get()).
 * Returns { look, catReal, catMid }. catScale is independent of look.
 */
export function parseLookParams(search) {
  let get = null;
  if (search && typeof search.get === 'function') get = (k) => search.get(k);
  else if (typeof search === 'string') {
    const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    get = (k) => p.get(k);
  }
  const look = parseLook(get ? get('look') : null);
  const scale = get ? get('catScale') : null;
  // Missing or unknown -> mid (product default); 'current' -> the pre-B10 size.
  if (scale === 'real') return { look, catReal: true, catMid: false };
  if (scale === 'current') return { look, catReal: false, catMid: false };
  return { look, catReal: false, catMid: true };
}

// --- Colour helpers (hex #rrggbb only) --------------------------------------

function toRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fromRgb([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix two hex colours; t=0 keeps a, t=1 keeps b. */
export function mix(hexA, hexB, t) {
  const a = toRgb(hexA); const b = toRgb(hexB);
  if (!a || !b) return hexA;
  const k = Math.max(0, Math.min(1, t));
  return fromRgb([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
}

/** Darken a hex colour toward black by f (0 keeps, 1 is black). */
export function shade(hex, f) {
  return mix(hex, '#000000', f);
}

/**
 * Outline colour for a shape with the given local fill colour.
 * - default (or unknown): the base outline, unchanged.
 * - a: soft, mixed toward the local fill (room and props alike).
 * - b/c: selective, a darker shade of the local colour, 1 art pixel wide
 *   (callers always stroke 1 px).
 * Non-hex fills fall back to the base outline.
 */
export function outlineFor(look, localFill, base = BASE_OUTLINE) {
  if (look === 'a') {
    if (!toRgb(localFill)) return base;
    return mix(base, localFill, 0.55);
  }
  if (look === 'b' || look === 'c') {
    if (!toRgb(localFill)) return base;
    return shade(localFill, 0.5);
  }
  return base;
}

// --- Palette -----------------------------------------------------------------
// Overrides only; default applies none, so every renderer constant is
// unchanged under the default look (asserted in cam-look.test.ts).

/** Warm diorama (a): one rose/amber hue family across walls, floor and rug. */
const WARM_OVERRIDES = {
  wallCream: '#f0c496',
  wallPaperDot: '#c98f5f',
  wallCap: '#f7ddba',
  wallEnd: '#d9a06a',
  wainscot: '#a86a48',
  wainscotDark: '#7e4a30',
  wainscotTrim: '#e8b988',
  woodLight: '#d8954a',
  woodMid: '#bd7f42',
  woodDark: '#96602e',
  plankSeam: '#8a5a30',
  shelfWood: '#8a5a30',
  rugBase: '#c0482e',
  rugInner: '#e08a4a',
  rugBorder: '#7e2f1e',
  rugMotif: '#f2c078',
  rugOval: '#a86a4a',
  rugOvalRing: '#7e4a30',
  slabSideWarm: '#8a5630',
  slabSideCool: '#6e4026',
  slabEarth: '#3e2818',
  curtainA: '#b45a5a',
  curtainB: '#8a4048',
  curtainC: '#d07a72',
  vignetteInner: '#4b2440',
  vignetteOuter: '#1d101f',
  nightAmbient: 'rgba(52,24,70,0.60)',
  shaftFill: 'rgba(255,214,140,0.22)',
  dust: '#ffe9c0',
};

/** Lived-in neutrals (b): grey-lavender walls, natural wood, slate backdrop. */
const NEUTRAL_OVERRIDES = {
  wallCream: '#d9d9e4',
  wallPaperDot: '#b4b4c4',
  wainscot: '#7d8aa0',
  wainscotDark: '#5a6578',
  wainscotTrim: '#e8e8f0',
  wallCap: '#ececf2',
  wallEnd: '#c0c0cf',
  woodLight: '#cdb488',
  woodMid: '#b69a6e',
  woodDark: '#8f7452',
  plankSeam: '#93805f',
  shelfWood: '#7d6240',
  rugBase: '#9a6a4a',
  rugInner: '#bd9267',
  rugBorder: '#6e4a30',
  rugMotif: '#e0cda8',
  rugOval: '#7d8aa0',
  rugOvalRing: '#5a6578',
  slabSideWarm: '#6e5a44',
  slabSideCool: '#54432f',
  curtainA: '#5a6e8c',
  curtainB: '#42506a',
  curtainC: '#7488a6',
  vignetteInner: '#2e3a4c',
  vignetteOuter: '#12161f',
  nightAmbient: 'rgba(18,30,58,0.62)',
  shaftFill: 'rgba(220,232,255,0.10)',
  dust: '#d8e0f0',
  bookA: '#4a6ec0',
  bookB: '#c04a5e',
  bookC: '#3fa04a',
  frameArtA: '#9ec2e8',
  frameArtB: '#e8a88a',
  plantLeaf: '#4f8a3f',
  plantLeafDark: '#2e5a24',
  frameWood: '#5a4a34',
};

/** Mixed (c): b's neutrals warmed halfway toward a's rose/amber family. */
function halfWarm() {
  const out = {};
  const keys = new Set([...Object.keys(WARM_OVERRIDES), ...Object.keys(NEUTRAL_OVERRIDES)]);
  for (const k of keys) {
    const a = WARM_OVERRIDES[k]; const b = NEUTRAL_OVERRIDES[k];
    if (a && b && toRgb(a) && toRgb(b)) out[k] = mix(b, a, 0.5);
    else out[k] = a || b;
  }
  // rgba() entries cannot go through mix(); hand-averaged midpoints.
  out.nightAmbient = 'rgba(35,27,64,0.61)';
  out.shaftFill = 'rgba(255,220,160,0.17)';
  return out;
}

export const PALETTE_OVERRIDES = {
  default: {},
  a: WARM_OVERRIDES,
  b: NEUTRAL_OVERRIDES,
  c: halfWarm(),
};

/** Base palette with the look's overrides applied. Default returns it untouched. */
export function paletteFor(look, basePAL) {
  const o = PALETTE_OVERRIDES[look];
  if (!o || look === DEFAULT_LOOK) return basePAL;
  return { ...basePAL, ...o };
}

// --- Light --------------------------------------------------------------------

export const LIGHT = {
  default: { day: 1, night: 1, dust: 1, block: 1 },
  a: { day: 2.6, night: 2.2, dust: 2, block: 1.5 },
  b: { day: 1, night: 0.9, dust: 1, block: 1 },
  c: { day: 1.8, night: 1.6, dust: 2, block: 1 },
};

/** Light multipliers for a look; unknown looks get the default (all 1). */
export function lightFor(look) {
  return LIGHT[look] || LIGHT.default;
}

/** Pool-radius scale for the night lamp glows (1 under default). */
export function poolScaleFor(look) {
  if (look === 'a') return 1.4;
  if (look === 'c') return 1.25;
  if (look === 'b') return 0.95;
  return 1;
}

// --- Day wash ------------------------------------------------------------------
// A full-room tint applied after the weather tint so each look reads as a
// different direction even where palettes overlap. Null under default.
const DAY_WASH = {
  default: null,
  a: 'rgba(255,166,88,0.20)',
  b: 'rgba(150,170,215,0.15)',
  c: 'rgba(255,176,100,0.11)',
};

/** Full-room day tint for a look; null unless a/b/c. */
export function dayWashFor(look) {
  return DAY_WASH[look] || null;
}

/** Floor sun-patch colour per look; b gets a cool patch, a/c warm. */
export function patchColorFor(look) {
  if (look === 'b') return [235, 242, 255];
  return [255, 240, 190];
}

// --- Extra decor (looks b and c only) ------------------------------------------
// Wall-only anchors in wall space { wall, along0, along1, hBot, hTop },
// like cam-scene.js DECOR. Nothing here touches a floor cell, the window
// span (back wall grid x 5.2..9.2, 12..38 px up), or the drawing-wall spot.
// Decor is painted into the static shell: no catalog entry, not
// interactable, and it can never block Nori.
export const EXTRA_DECOR = [
  { id: 'print', wall: 'back', along0: 2.9, along1: 4.3, hBot: 18, hTop: 32 },
  { id: 'bunting', wall: 'back', along0: 0.2, along1: 2.0, hBot: 44, hTop: 48 },
  { id: 'miniframe', wall: 'left', along0: 6.5, along1: 7.1, hBot: 33, hTop: 41 },
  { id: 'hook', wall: 'left', along0: 2.3, along1: 2.9, hBot: 34, hTop: 42 },
  { id: 'minishelf', wall: 'left', along0: 7.35, along1: 8.0, hBot: 22, hTop: 28 },
];

/** Extra decor descriptors for a look ([] unless b or c). */
export function extraDecorFor(look) {
  return look === 'b' || look === 'c' ? EXTRA_DECOR : [];
}

// --- Cat scale ------------------------------------------------------------------
// Assumption (documented for the owner): one floor grid cell is 40 cm, so the
// 40x40 cm cardboard box fills exactly one cell. The tile is 32x16 px, i.e.
// 0.8 px/cm horizontally. A 25 cm shoulder height is then ~20 px on screen,
// while the sit sprite is 40 px tall: CAT_REAL_SCALE = 0.5. At that scale
// Nori (37x40 native) draws ~19x20 px and fits inside the box opening.
// CAT_MID_SCALE = 0.75 is halfway between today's size and real.
export const CAT_REAL_SCALE = 0.5;
export const CAT_MID_SCALE = 0.75;
export const CAT_DEFAULT_SCALE = 1;

/**
 * Drawn-sprite scale multiplier. 'real' shrinks to the rule-2 size, 'mid'
 * lands halfway there, anything else draws at 1. The second argument is the
 * parsed catMid flag; catScaleFor(true) keeps its B10 meaning (real).
 */
export function catScaleFor(catReal, catMid) {
  if (catReal === true) return CAT_REAL_SCALE;
  if (catReal === 'mid' || catMid === true) return CAT_MID_SCALE;
  return CAT_DEFAULT_SCALE;
}
