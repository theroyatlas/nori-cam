import { project, poseAt, depthKey, applyEffects } from './cam-shared.js';
import { animState, frontPawTip } from './cam-anim.js';
import { WEATHER_ATTRIBUTION } from './cam-weather.js';
import { parseWxParams, selectWeatherRow, windowView } from './cam-window.js';
import { rigMotion, mapPolygon, mapPoint, pointInPolygon, sortedParts, alphaOn } from './cam-rig.js';
import { LiveTimeline, parseMode, wallNowMs, firstLoadPose, createClockSource } from './cam-live.js';
import { drawPropLayer, drawCarriedProp, interpolateObjects, kindOf, isPropVisible, propLayers, depthLayerOf, pruneFloatingFragments, setPropLook, isGiftSpriteURL, giftPosition } from './cam-props.js';
import {
  createSceneStaticCache, drawWindowDressing, drawSceneDynamic,
  drawPropContactShadows, drawForegroundPlant, supportShadow,
  nightSpriteLight, applyNightSpriteLight,
} from './cam-scene.js';
import { parseLookParams, outlineFor, lightFor, catScaleFor, dayWashFor, patchColorFor } from './cam-look.js';
import { replayObjectsAt,replayPoseAt,replayEffectSegments } from './cam-replay.js';
import { carryPresentation } from './cam-carry.js';

const LOGICAL_W = 320;
const LOGICAL_H = 240;
const WALL_H = 64;
// Cardboard colours sampled from room/sprites/nori-box.png.
const CARDBOARD = '#cb9d70';
const CARDBOARD_DARK = '#a87f52';
const CARDBOARD_INNER = '#8a623e';
const OUTLINE = '#3e2f26';
// Pixel font drawn in code: 3x5 glyphs for overlays.
const GLYPH_BANG = ['010', '010', '010', '000', '010'];
// 4x4 sleep-z continuation (1 px/cell); colour from sleepy.png z strokes (245,180,147).
const GLYPH_Z_SLEEP = ['0110', '0010', '0100', '1000'];
const SLEEPY_Z_COLOR = '#f5b493';

const canvas = document.getElementById('cam');
let ctx = canvas.getContext('2d');
const litEnvironment = document.createElement('canvas');
const foregroundMask = document.createElement('canvas');
for (const layer of [litEnvironment, foregroundMask]) { layer.width = LOGICAL_W; layer.height = LOGICAL_H; }
ctx.imageSmoothingEnabled = false;

const params = new URLSearchParams(location.search);
const isReplay = params.has('replayFrom');
const debug = params.get('debug') === '1';
const benchClock = createClockSource();
const bench = params.get('bench') === '1';
const benchTimes = [];
let benchLogged = false;
let frozenT = params.has('t') ? Number(params.get('t')) : null;
// B10 preview-only: ?look=a|b|c and ?catScale=real. Production default unchanged.
const { look: LOOK, catReal, catMid } = parseLookParams(params);
const CAT_SCALE = catScaleFor(catReal, catMid);
const boxInk = (fill) => outlineFor(LOOK, fill, OUTLINE);
// Window frame/mullion lines: base OUTLINE under default (byte-identical),
// look-mapped selective/soft outline otherwise.
const winInk = (fill) => (LOOK === 'default' ? OUTLINE : outlineFor(LOOK, fill, OUTLINE));
setPropLook(LOOK);
const animEnabled = params.get('anim') !== '0';
const rigEnabled = params.get('rig') !== '0';
let rigData = null;
let frameT = 0;
let miniature = null;

// Renderer-side room offset: centre the projected room bbox in the canvas.
// cam-shared.js project() is lane A's; the offset lives only here.
function roomOffset(gridW, gridH) {
  const pts = [project(0, 0), project(gridW, 0), project(0, gridH), project(gridW, gridH)];
  const xs = pts.map((p) => p.sx); const ys = pts.map((p) => p.sy);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys) - WALL_H; const maxY = Math.max(...ys);
  return {
    x: Math.round(LOGICAL_W / 2 - (minX + maxX) / 2),
    y: Math.round(LOGICAL_H / 2 - (minY + maxY) / 2),
  };
}
let ROOM_OFF = roomOffset(10, 8);
const sceneStatic = createSceneStaticCache({
  logicalW: LOGICAL_W,
  logicalH: LOGICAL_H,
  wallH: WALL_H,
  project,
  createCanvas: (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  },
});
const NEUTRAL = {
  scaleX: 1, scaleY: 1, dx: 0, dy: 0, rot: 0,
  blink: 0, shadowScale: 1, overlays: [], objectFx: {}, push: null,
};

function fit() {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const rawW = vw / LOGICAL_W;
  const rawH = vh / LOGICAL_H;
  let scale;
  if (rawW < 1 || rawH < 1) {
    scale = Math.min(rawW, rawH);
  } else {
    scale = Math.min(Math.floor(rawW), Math.floor(rawH));
  }
  canvas.style.width = `${Math.floor(LOGICAL_W * scale)}px`;
  canvas.style.height = `${Math.floor(LOGICAL_H * scale)}px`;
}
window.addEventListener('resize', fit);
fit();

const liveMode = parseMode(params);
const isFixture = liveMode.mode === 'fixture' || isReplay;
const liveSource = isFixture ? null : new LiveTimeline({
  onUpdate: () => updateLiveStatus(),
});
if(liveSource) window.addEventListener('nori-world-changed',()=>{
  // The reaction to a new gift is scheduled a moment after the gift lands; refetch again so it plays live
  // instead of waiting for the next 60 s poll (by then those segments are already in the past).
  for (const ms of [0, 3000, 8000]) setTimeout(()=>{ void refreshAfterWorldChange(); }, ms);
});
async function refreshAfterWorldChange(){
  try {
    const r = await liveSource.fetchOnce();
    const inc = r && r.body && Array.isArray(r.body.segments) ? r.body.segments : null;
    if (inc && inc.length) {
      // The server supersedes the old idle segment when it schedules the reaction and stops sending it;
      // drop cached segments it no longer reports from this point on, or the stale idle keeps winning.
      const ids = new Set(inc.map((s) => s.id)), first = Math.min(...inc.map((s) => s.start_at));
      liveSource.segments = liveSource.segments.filter((s) =>
        ids.has(s.id) || (s.cut_at != null ? Math.min(s.end_at, s.cut_at) : s.end_at) <= first);
    }
  } catch (e) { updateLiveStatus(); }
}
function updateLiveStatus() {
  const el = document.getElementById('live-status');
  if (!el || !liveSource) return;
  el.hidden = !liveSource.shouldShowReconnect();
}
// The one place that knows where the timeline comes from.
async function getTimeline() {
  if(isReplay){
    const from=Number(params.get('replayFrom')),to=Number(params.get('replayTo'));
    const [past,current]=await Promise.all([fetch(`/api/replay?from=${from}&to=${to}`),fetch('/api/cam')]);
    if(!past.ok||!current.ok)throw new Error('Replay unavailable');
    const data=await past.json(),now=await current.json();
    if(data.truncated)throw new Error('Replay range truncated');
    return {...data,room:now.room,replayMetadata:now.objects,loop_ms:to-from,weather:data.weather?.[0]||now.weather};
  }
  if (!isFixture) {
    try { await liveSource.fetchOnce(); } catch (e) { /* keep empty; poll retries */ }
    liveSource.start();
    return {
      server_now: liveSource.serverNowValue,
      timeline_until: liveSource.timelineUntil,
      objects: liveSource.objects,
      segments: liveSource.segments,
      weather: liveSource.weather,
      room: liveSource.room || { grid: { w: 10, h: 8 } },
    };
  }
  const fixtureURL=liveMode.fixture==='heights'?'/cam/fixture/heights.json':liveMode.fixture?.startsWith('/cam/fixture/')?liveMode.fixture:'/cam/fixture/now.json';
  const res = await fetch(fixtureURL);
  if (!res.ok) throw new Error(`timeline ${res.status}`);
  return res.json();
}

const wxParams = parseWxParams(params);
const hasWxOverride = !!(wxParams.wx || wxParams.night);
let weatherCache = null;
let weatherRowsCache = null;
async function loadWeatherRows() {
  if (weatherRowsCache) return weatherRowsCache;
  const res = await fetch('/cam/fixture/weather-rows.json');
  if (!res.ok) throw new Error(`weather ${res.status}`);
  weatherRowsCache = await res.json();
  return weatherRowsCache;
}
// Weather source: live mode uses the /api/cam row; ?wx= / ?night=1 override
// from the fixture rows for demos. Fixture mode keeps the fixture rows.
async function getWeather(t) {
  if (!isFixture && !hasWxOverride) {
    return liveSource ? liveSource.weather : null;
  }
  if (weatherCache) return weatherCache;
  try {
    const rows = await loadWeatherRows();
    weatherCache = selectWeatherRow(rows, wxParams.wx, wxParams.night);
  } catch (e) {
    weatherCache = null;
  }
  return weatherCache;
}
async function currentWeather(t) {
  if (!isFixture && !hasWxOverride) return liveSource ? liveSource.weather : null;
  return getWeather(t);
}

function poly(points, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function diamond(cx, cy, hw, hh) {
  return [[cx, cy - hh], [cx + hw, cy], [cx, cy + hh], [cx - hw, cy]];
}

function windowPane() {
  const wpt = (x, h) => { const p = project(x, 0); return [p.sx, p.sy - h]; };
  const quad = [wpt(5.2, 12), wpt(9.2, 12), wpt(9.2, 38), wpt(5.2, 38)];
  const xs = quad.map((q) => q[0]); const ys = quad.map((q) => q[1]);
  const rect = {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
  };
  return { quad, rect, wpt };
}

function drawWindowView(view, pane) {
  const { quad } = pane;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(quad[0][0], quad[0][1]);
  for (let i = 1; i < quad.length; i += 1) ctx.lineTo(quad[i][0], quad[i][1]);
  ctx.closePath();
  ctx.clip();
  // Sky.
  ctx.fillStyle = view.skyColor;
  ctx.fillRect(pane.rect.x - 2, pane.rect.y - 2, pane.rect.w + 4, pane.rect.h + 4);
  // Stars (night, low cloud).
  ctx.fillStyle = '#e8ecff';
  for (const s of view.stars) {
    ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, s.alpha));
    ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1); ctx.restore();
  }
  // Drifting pixel clouds.
  const cloudShade = view.sky === 'night' ? '#2a3352' : view.sky === 'dusk' ? '#c97a44' : '#eef3f8';
  for (const c of view.clouds) {
    ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, c.alpha));
    ctx.fillStyle = cloudShade;
    ctx.fillRect(Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h));
    ctx.fillRect(Math.round(c.x + 2), Math.round(c.y - 1), Math.round(c.w * 0.6), 1);
    ctx.restore();
  }
  // Fog veil.
  if (view.fogAlpha > 0) {
    ctx.fillStyle = `rgba(210,218,228,${view.fogAlpha})`;
    ctx.fillRect(pane.rect.x - 2, pane.rect.y - 2, pane.rect.w + 4, pane.rect.h + 4);
  }
  // Rain streaks outside the glass (2–3 px diagonals, readable at 1x scale).
  if (view.rainDrops.length) {
    const drizzle = view.rain > 0 && view.rain < 0.42;
    ctx.lineWidth = 1;
    ctx.strokeStyle = drizzle ? '#dce8f5' : '#f2f8ff';
    for (const d of view.rainDrops) {
      const alphaMul = drizzle ? 0.75 : 1;
      ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, d.alpha * alphaMul));
      const dx = drizzle ? 1 : 2;
      const streak = drizzle ? Math.max(1, d.len) : Math.max(2, d.len + 1);
      const x0 = Math.round(d.x); const y0 = Math.round(d.y);
      ctx.beginPath(); ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + dx, y0 + streak); ctx.stroke(); ctx.restore();
    }
  }
  // Snow flakes.
  for (const f of view.snowFlakes) {
    ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, f.alpha));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(f.x), Math.round(f.y), Math.max(1, f.r), Math.max(1, f.r));
    ctx.restore();
  }
  // Drops sliding down the glass (inside surface).
  for (const d of view.glassDrops) {
    ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, d.alpha));
    ctx.fillStyle = '#dceefc';
    ctx.fillRect(Math.round(d.x), Math.round(d.y), 1, d.len);
    ctx.fillRect(Math.round(d.x), Math.round(d.y - 2), 1, 1);
    ctx.restore();
  }
  // Thunder flash brightens the pane itself (capped so the room stays readable).
  if (view.flash > 0) {
    const paneFlash = roomFlashWash(view.flash);
    ctx.fillStyle = `rgba(240,246,255,${paneFlash.toFixed(3)})`;
    ctx.fillRect(pane.rect.x - 2, pane.rect.y - 2, pane.rect.w + 4, pane.rect.h + 4);
  }
  ctx.restore();
  // Frame and mullions stay on top of the view.
  poly(quad, null, winInk('#8a97a8'));
  const { wpt } = pane;
  const mid1 = wpt(7.2, 12); const mid2 = wpt(7.2, 34);
  ctx.beginPath(); ctx.moveTo(mid1[0], mid1[1]); ctx.lineTo(mid2[0], mid2[1]);
  ctx.strokeStyle = winInk('#8a97a8'); ctx.lineWidth = 1; ctx.stroke();
  const hm1 = wpt(5.2, 25); const hm2 = wpt(9.2, 25);
  ctx.beginPath(); ctx.moveTo(hm1[0], hm1[1]); ctx.lineTo(hm2[0], hm2[1]); ctx.stroke();
}

function drawSunPatch(view) {
  if (!view || !view.sunPatch.allowed) return;
  const polygon = view.sunPatch.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  const quad = polygon.map(([gx, gy]) => {
    const p = project(gx, gy);
    return [p.sx, p.sy];
  });
  ctx.save();
  const patch = patchColorFor(LOOK);
  ctx.fillStyle = 'rgba(' + patch[0] + ',' + patch[1] + ',' + patch[2] + ',' + Math.min(1, view.sunPatch.alpha * lightFor(LOOK).day).toFixed(4) + ')';
  ctx.beginPath(); ctx.moveTo(quad[0][0], quad[0][1]);
  for (let i = 1; i < quad.length; i += 1) ctx.lineTo(quad[i][0], quad[i][1]);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawRoom(gridW, gridH, view, t) {
  const pane = windowPane();
  sceneStatic.blit(ctx, gridW, gridH, ROOM_OFF, debug, pane, LOOK);
  if (view) drawWindowView(view, pane);
  else poly(pane.quad, '#a9c6de', winInk('#a9c6de'));
  drawWindowDressing(ctx, pane, project);
  if (view) drawSunPatch(view);
  if (!view || view.sky !== 'night') drawSceneDynamic(ctx, {
    project, gridW, gridH, view, pane, t: typeof t === 'number' ? t : frameT, wallH: WALL_H,
    roomOff: ROOM_OFF,
    look: LOOK,
  });
}

function roomFlashWash(f) {
  if (!(f > 0)) return 0;
  return Math.min(0.55, f * f * 0.55);
}

function drawRoomLight(view, gridW, gridH, t) {
  if (!view) return;
  if (view.sky === 'night') {
    // Environment light is composited before the crisp character sprite.
    drawSceneDynamic(ctx, { project, gridW, gridH,
      view, pane: windowPane(), t, wallH: WALL_H, roomOff: ROOM_OFF, look: LOOK });
  } else {
    ctx.fillStyle = view.tintCss;
    ctx.fillRect(-ROOM_OFF.x, -ROOM_OFF.y, LOGICAL_W, LOGICAL_H);
    // B10b preview-only day wash so each look reads as its own direction.
    const wash = dayWashFor(LOOK);
    if (wash) { ctx.fillStyle = wash; ctx.fillRect(-ROOM_OFF.x, -ROOM_OFF.y, LOGICAL_W, LOGICAL_H); }
  }
  if (view.flash > 0) {
    const wash = roomFlashWash(view.flash);
    ctx.fillStyle = `rgba(240,246,255,${wash.toFixed(3)})`;
    ctx.fillRect(-ROOM_OFF.x, -ROOM_OFF.y, LOGICAL_W, LOGICAL_H);
  }
}

// B8: the region above the box front rim (the V of its two front top edges).
function clipAboveBoxRim(box, fx) {
  const p = project(box.x, box.y);
  const f = fx || { shearX: 0, dy: 0 };
  const cx = p.sx + Math.round(f.shearX || 0);
  const cy = p.sy - 14 + Math.round(f.dy || 0); // top-face centre, as drawBoxFront
  ctx.beginPath();
  ctx.moveTo(cx - 60, cy - 60); ctx.lineTo(cx + 60, cy - 60); ctx.lineTo(cx + 60, cy);
  ctx.lineTo(cx + 16, cy); ctx.lineTo(cx, cy + 8); ctx.lineTo(cx - 16, cy); ctx.lineTo(cx - 60, cy);
  ctx.closePath();
  ctx.clip();
}

function boxLayers(box, fx) {
  const p = project(box.x, box.y);
  const f = fx || { shearX: 0, dy: 0, flap: 0 };
  return {
    back: () => drawBoxBack(p.sx, p.sy, f),
    front: () => drawBoxFront(p.sx, p.sy, f),
  };
}

function drawBoxBack(cx, cy, fx) {
  // Inner floor and inner back walls at top opening (14 px tall).
  poly(diamond(cx, cy - 5, 13, 6), CARDBOARD_INNER, boxInk(CARDBOARD_INNER));
  const top = diamond(cx + Math.round(fx.shearX), cy - 14 + Math.round(fx.dy), 16, 8);
  const inner = diamond(cx, cy - 5, 13, 6);
  poly([inner[0], top[0], top[3], inner[3]], CARDBOARD_DARK, boxInk(CARDBOARD_DARK));
  poly([inner[0], top[0], top[1], inner[1]], '#96703f', boxInk('#96703f'));
}

function drawBoxFront(cx, cy, fx) {
  const sh = Math.round(fx.shearX);
  const dy = Math.round(fx.dy);
  const flap = Math.round(fx.flap || 0);
  const top = diamond(cx + sh, cy - 14 + dy, 16, 8);
  const bot = diamond(cx, cy, 16, 8);
  // Two outer faces.
  poly([top[3], top[2], bot[2], bot[3]], CARDBOARD, boxInk(CARDBOARD));
  poly([top[2], top[1], bot[1], bot[2]], CARDBOARD_DARK, boxInk(CARDBOARD_DARK));
  // Open flaps hinged on the front top edges; they bounce with fx.flap.
  poly([top[3], top[2], [top[2][0] - 4, top[2][1] + 7 - flap], [top[3][0] - 7, top[3][1] + 3 - flap]], '#dbb489', boxInk('#dbb489'));
  poly([top[2], top[1], [top[1][0] + 7, top[1][1] + 3 - flap], [top[2][0] + 4, top[2][1] + 7 - flap]], '#dbb489', boxInk('#dbb489'));
}

function pickSprite(pose, manifest, images) {
  const seen = new Set();
  const chain = [pose];
  if (manifest[pose] && manifest[pose].fallback) chain.push(manifest[pose].fallback);
  chain.push('sit');
  for (const key of chain) {
    if (seen.has(key)) continue;
    seen.add(key);
    const img = images[key];
    const entry = manifest[key];
    if (img && entry && img.complete && img.naturalWidth > 0) return { img, entry, key };
  }
  return null;
}

// Offscreen native sprite (flip baked in), cached per pose+flip.
const spriteCanvasCache = new Map();
function spriteCanvas(picked, flip) {
  const cacheKey = `${picked.key}|${flip ? 1 : 0}`;
  let hit = spriteCanvasCache.get(cacheKey);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = picked.entry.w; c.height = picked.entry.h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (flip) { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(picked.img, 0, 0);
  // B8: a sprite fragment floating under the body (jump) is not part of the pose.
  try {
    const img = g.getImageData(0, 0, c.width, c.height);
    if (pruneFloatingFragments(img.data, c.width, c.height)) g.putImageData(img, 0, 0);
  } catch (e) { /* keep the sprite as drawn */ }
  hit = { canvas: c, entry: picked.entry };
  spriteCanvasCache.set(cacheKey, hit);
  return hit;
}

// --- B3 cutout rig: parts built once per pose on 1x canvases. ---
const rigCutoutCache = new Map();
const rigComposedCache = new Map();
function buildRigCutout(picked) {
  if (rigCutoutCache.has(picked.key)) return rigCutoutCache.get(picked.key);
  let cut = null;
  try {
    const entryRig = rigData && rigData[picked.key];
    if (entryRig && entryRig.parts && entryRig.source) {
      const src = spriteCanvas(picked, false).canvas;
      const w = picked.entry.w; const h = picked.entry.h;
      const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
      const tg = tmp.getContext('2d'); tg.imageSmoothingEnabled = false;
      tg.drawImage(src, 0, 0);
      const data = tg.getImageData(0, 0, w, h).data;
      const target = { w, h };
      const parts = sortedParts(entryRig).map((p) => ({
        name: p.name, z: p.z,
        polygon: mapPolygon(p.polygon, entryRig.source, target),
        pivot: mapPoint(p.pivot, entryRig.source, target),
        canvas: null,
      })).filter((p) => p.polygon.length >= 3);
      if (parts.length && parts.some((p) => p.name === 'tail')) {
        const mkData = (keep) => {
          const img = new ImageData(w, h);
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const i = (y * w + x) * 4;
              if (data[i + 3] < 128 || !keep(x + 0.5, y + 0.5)) continue;
              img.data[i] = data[i]; img.data[i + 1] = data[i + 1];
              img.data[i + 2] = data[i + 2]; img.data[i + 3] = 255;
            }
          }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').putImageData(img, 0, 0);
          return c;
        };
        // Base erases every rig part; each part keeps its full polygon copy,
        // so a moved part reveals the part below it, never its own old copy.
        // Polygons are dilated by 1 px so sprite rows just outside a mapped
        // polygon (e.g. the head's top outline row) move with their part.
        const inPart = (x, y, poly) => {
          if (pointInPolygon(x, y, poly)) return true;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
            const ax = poly[j][0]; const ay = poly[j][1];
            const bx = poly[i][0]; const by = poly[i][1];
            const dx = bx - ax; const dy = by - ay;
            const len2 = dx * dx + dy * dy || 1;
            const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
            const px = ax + u * dx - x; const py = ay + u * dy - y;
            if (px * px + py * py <= 1) return true;
          }
          return false;
        };
        const base = mkData((x, y) => !parts.some((p) => inPart(x, y, p.polygon)));
        for (const p of parts) p.canvas = mkData((x, y) => inPart(x, y, p.polygon));
        cut = { base, parts, w, h };
      }
    }
  } catch (e) { cut = null; }
  rigCutoutCache.set(picked.key, cut);
  return cut;
}

function composeRigCanvas(picked, motion) {
  const cut = buildRigCutout(picked);
  if (!cut || !motion || !motion.enabled) return null;
  const angleQ = Math.round(motion.tailAngleDeg);
  const key = `${picked.key}|${angleQ}|${motion.earL.dx},${motion.earL.flatten}|${motion.earR.dx},${motion.earR.flatten}|${motion.headBobPx}`;
  let hit = rigComposedCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas'); c.width = cut.w; c.height = cut.h;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  g.drawImage(cut.base, 0, 0);
  for (const p of cut.parts) {
    if (p.name === 'tail' && angleQ !== 0) {
      g.save();
      g.translate(p.pivot[0], p.pivot[1]);
      g.rotate((angleQ * Math.PI) / 180);
      g.translate(-p.pivot[0], -p.pivot[1]);
      g.drawImage(p.canvas, 0, 0);
      g.restore();
    } else if (p.name === 'ear_l' || p.name === 'ear_r') {
      const ear = p.name === 'ear_l' ? motion.earL : motion.earR;
      if (ear.flatten) {
        g.save();
        g.translate(0, p.pivot[1]); g.scale(1, 0.82); g.translate(0, -p.pivot[1]);
        g.drawImage(p.canvas, ear.dx, motion.headBobPx);
        g.restore();
      } else {
        g.drawImage(p.canvas, ear.dx, motion.headBobPx);
      }
    } else if (p.name === 'head') {
      g.drawImage(p.canvas, 0, motion.headBobPx);
    } else {
      g.drawImage(p.canvas, 0, 0);
    }
  }
  // Binary alpha: no semi-transparent fringe from the tail rotation.
  try {
    const img = g.getImageData(0, 0, cut.w, cut.h);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = alphaOn(img.data[i]);
    g.putImageData(img, 0, 0);
  } catch (e) { /* keep canvas as drawn */ }
  if (rigComposedCache.size > 256) rigComposedCache.clear();
  rigComposedCache.set(key, c);
  return c;
}

function currentRigMotion(poseName, segId) {
  if (!rigEnabled || !animEnabled) {
    return { enabled: false, tailAngleDeg: 0, earL: { dx: 0, flatten: 0 }, earR: { dx: 0, flatten: 0 }, headBobPx: 0 };
  }
  return rigMotion(poseName, frameT, segId, rigData && rigData[poseName]);
}

// Canvas for a pose in native orientation, rig-composed when available.
function poseCanvas(picked, flip, segId) {
  const motion = currentRigMotion(picked.key, segId);
  const composed = motion.enabled ? composeRigCanvas(picked, motion) : null;
  if (!composed) return spriteCanvas(picked, flip);
  if (!flip) return { canvas: composed, entry: picked.entry };
  const fkey = `flip|${picked.key}|${Math.round(motion.tailAngleDeg)}|${motion.headBobPx}`;
  let fc = rigComposedCache.get(fkey);
  if (!fc) {
    fc = document.createElement('canvas'); fc.width = composed.width; fc.height = composed.height;
    const g = fc.getContext('2d'); g.imageSmoothingEnabled = false;
    g.translate(fc.width, 0); g.scale(-1, 1); g.drawImage(composed, 0, 0);
    rigComposedCache.set(fkey, fc);
  }
  return { canvas: fc, entry: picked.entry };
}

// Fur colour sampled from the pixel just beside the first eye.
const furCache = new Map();
function furColor(picked) {
  if (furCache.has(picked.key)) return furCache.get(picked.key);
  let color = '#d9bd9c';
  try {
    const eyes = picked.entry.eyes || [];
    if (eyes.length) {
      const c = document.createElement('canvas');
      c.width = picked.entry.w; c.height = picked.entry.h;
      const g = c.getContext('2d');
      g.drawImage(picked.img, 0, 0);
      const [ex, ey] = eyes[0];
      for (let d = 1; d < 8; d += 1) {
        const x = ex - d;
        if (x < 0) break;
        const px = g.getImageData(x, Math.min(ey + 1, picked.entry.h - 1), 1, 1).data;
        if (px[3] > 128 && px[0] + px[1] + px[2] > 180) {
          color = `rgb(${px[0]},${px[1]},${px[2]})`;
          break;
        }
      }
    }
  } catch (e) { color = '#d9bd9c'; }
  furCache.set(picked.key, color);
  return color;
}

// B8b: front paw tip of a sprite, read once from its pixels (null until the image has loaded).
const pawTipCache = new Map();
function pawTipOf(key, manifest, images) {
  if (pawTipCache.has(key)) return pawTipCache.get(key);
  const img = images[key]; const entry = manifest[key];
  if (!img || !entry || !img.complete || img.naturalWidth === 0) return null;
  let tip = null;
  try {
    const c = document.createElement('canvas');
    c.width = entry.w; c.height = entry.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, entry.w, entry.h).data;
    tip = frontPawTip(data, entry.w, entry.h, entry.native_facing);
  } catch (e) { tip = null; }
  pawTipCache.set(key, tip);
  return tip;
}

function footPoint(pose, box) {
  const p = project(pose.x, pose.y, pose.z);
  const inside = pose.part === 'inside' && box && pose.x === box.x && pose.y === box.y;
  const lift = inside ? 6 : 0;
  const bob = pose.pose === 'walk' ? Math.round(Math.abs(Math.sin((pose.distance || 0) * Math.PI)) * 2) : 0;
  return { p, inside, footY: p.sy - pose.hop - bob - lift };
}

// Night-lit copy of Nori's native sprite. Blink lids are painted into the copy
// first, so they are lit with her fur. One reused scratch canvas, sprite-sized.
const noriNight = document.createElement('canvas');
function noriNightSprite(src, light, lids) {
  const w = src.width; const h = src.height;
  if (noriNight.width !== w || noriNight.height !== h) { noriNight.width = w; noriNight.height = h; }
  const g = noriNight.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  g.drawImage(src, 0, 0);
  if (lids) {
    g.fillStyle = lids.color;
    for (const [x, y, lw, lh] of lids.rects) g.fillRect(x, y, lw, lh);
  }
  const img = g.getImageData(0, 0, w, h);
  applyNightSpriteLight(img.data, light);
  g.putImageData(img, 0, 0);
  return noriNight;
}

function drawCat(pose, box, manifest, images, anim, objects, view) {
  const { p, inside, footY } = footPoint(pose, box);
  if (pose.part !== 'inside') {
    const shadow = supportShadow(pose, objects);
    ctx.beginPath();
    ctx.ellipse(shadow.sx, shadow.sy + 2, 12 * anim.shadowScale * CAT_SCALE, 4 * anim.shadowScale * CAT_SCALE, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(40,26,16,0.25)';
    ctx.fill();
  }
  const picked = pickSprite(pose.pose, manifest, images);
  if (!picked) {
    // Final fallback: a coloured rectangle, never a blank frame.
    ctx.fillStyle = '#e8913a';
    ctx.fillRect(Math.round(p.sx - 11), Math.round(footY - 16), 22, 16);
    ctx.strokeStyle = winInk('#e8913a'); ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(p.sx - 11) + 0.5, Math.round(footY - 16) + 0.5, 22, 16);
    return;
  }
  const { entry } = picked;
  const flip = pose.facing !== entry.native_facing;
  const foot = entry.foot || [entry.w / 2, entry.h - 1];
  const anchorX = Math.round(p.sx) + Math.round(anim.dx || 0);
  const anchorY = Math.round(footY) + Math.round(anim.dy || 0);
  // Night: Nori takes the room's ambient on her own pixels, plus a capped lamp lift.
  const night = view && view.sky === 'night'
    ? nightSpriteLight(view, project, windowPane(), p.sx, footY, roomFlashWash(view.flash)) : null;

  const rigNative = poseCanvas(picked, false, pose.segmentId);
  const rigBob = currentRigMotion(picked.key, pose.segmentId).headBobPx || 0;
  ctx.save();
  ctx.translate(anchorX, anchorY);
  if (anim.rot) ctx.rotate(anim.rot);
  ctx.scale((flip ? -1 : 1) * anim.scaleX * CAT_SCALE, anim.scaleY * CAT_SCALE);
  const blinkOn = anim.blink > 0.02 && Array.isArray(entry.eyes) && entry.eyes.length > 0;
  if (night) {
    // Night: the lit copy carries its own blink lids, so they match her fur.
    const lids = blinkOn ? {
      color: furColor(picked),
      rects: entry.eyes.map(([ex, ey, ew, eh]) => [ex, ey + rigBob, ew, Math.max(1, Math.round(eh * anim.blink))]),
    } : null;
    ctx.drawImage(noriNightSprite(rigNative.canvas, night, lids), Math.round(-foot[0]), Math.round(-foot[1]));
  } else {
    ctx.drawImage(rigNative.canvas, Math.round(-foot[0]), Math.round(-foot[1]));
    // Blink lid: fur-coloured rect growing over each eye rectangle.
    if (blinkOn) {
      ctx.fillStyle = furColor(picked);
      for (const [ex, ey, ew, eh] of entry.eyes) {
        const lh = Math.max(1, Math.round(eh * anim.blink));
        ctx.fillRect(Math.round(-foot[0] + ex), Math.round(-foot[1] + ey + rigBob), ew, lh);
      }
    }
  }
  ctx.restore();
}

function drawGlyph(glyph, cx, cy, pix, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const w = glyph[0].length * pix; const h = glyph.length * pix;
  for (let r = 0; r < glyph.length; r += 1) {
    for (let c = 0; c < glyph[r].length; c += 1) {
      if (glyph[r][c] === '1') ctx.fillRect(Math.round(cx - w / 2 + c * pix), Math.round(cy - h / 2 + r * pix), pix, pix);
    }
  }
  ctx.restore();
}

function drawOverlays(pose, box, anim) {
  const { p, footY } = footPoint(pose, box);
  const boxP = box ? project(box.x, box.y) : p;
  for (const o of anim.overlays) {
    if (o.type === 'z') {
      drawGlyph(GLYPH_Z_SLEEP, p.sx + o.dx, footY + o.dy, 1, SLEEPY_Z_COLOR, o.alpha);
    } else if (o.type === '!') {
      const pix = Math.max(1, Math.round((o.scale || 1) * 2));
      drawGlyph(GLYPH_BANG, p.sx + o.dx, footY + o.dy, pix, '#ffd94d', o.alpha);
    } else if (o.type === 'dust') {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, o.alpha));
      ctx.fillStyle = '#d8c3a5';
      const s = o.size || 1;
      ctx.fillRect(Math.round(boxP.sx + o.dx - s / 2), Math.round(boxP.sy + o.dy), s, s);
      ctx.restore();
    }
  }
}

function drawDebug(pose, t, gridW, gridH) {
  ctx.fillStyle = '#ffffff';
  ctx.font = '7px monospace';
  for (let x = 0; x < gridW; x += 1) {
    for (let y = 0; y < gridH; y += 1) {
      const p = project(x, y);
      ctx.fillText(`${x},${y}`, p.sx - 6, p.sy + 2);
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(2, 2, 196, 12);
  ctx.fillStyle = '#ffffff';
  ctx.font = '8px monospace';
  ctx.fillText(`seg ${pose.segmentId} ${pose.action} ${pose.pose} t=${Math.round(t)}`, 4, 11);
}

async function main() {
  let timeline;
  let manifest = {};
  try {
    timeline = await getTimeline();
  } catch (e) {
    ROOM_OFF = roomOffset(10, 8);
    ctx.save(); ctx.translate(ROOM_OFF.x, ROOM_OFF.y);
    drawRoom(10, 8);
    ctx.fillStyle = '#e8913a';
    ctx.fillRect(149, 100, 22, 16);
    ctx.restore();
    return;
  }
  try {
    const res = await fetch('/cam/manifest.json');
    if (res.ok) manifest = await res.json();
  } catch (e) { manifest = {}; }
  if (rigEnabled) {
    try {
      const res = await fetch('/cam/rig.json');
      if (res.ok) rigData = await res.json();
    } catch (e) { rigData = null; }
  }
  const images = {};
  for (const [pose, entry] of Object.entries(manifest)) {
    const img = new Image();
    img.src = entry.file.startsWith('/') ? entry.file : `/cam/${entry.file}`;
    images[pose] = img;
  }
  const gridW = (timeline.room && timeline.room.grid && timeline.room.grid.w) || 10;
  const gridH = (timeline.room && timeline.room.grid && timeline.room.grid.h) || 8;
  const loopMs = timeline.loop_ms || 61000;
  const fixtureSegments = timeline.segments || [];
  const fixtureObjects = timeline.objects || [];
  const fixtureWeather = await getWeather(0);
  const replayStart=benchClock.perfNow();
  if(isReplay){const label=document.getElementById('live-status');if(label){label.hidden=false;label.textContent='回看這段時光';}}
  // R40 observatory room is the default scene (?scene=miniature is the same renderer). ?scene=pixel keeps the 2D room;
  // no WebGL or any load failure also leaves the 2D room, which is drawn until the R40 renderer is ready.
  const sceneParam = params.get('scene');
  const webgl = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } })();
  if (sceneParam !== 'pixel' && webgl) {
    void import('./cam-observatory.js').then(({createMiniatureRenderer}) =>
      createMiniatureRenderer({oldCanvas:canvas,manifest,images,debug,onFailure:()=>{ miniature=null; }})
    ).then(renderer=>{
      miniature=renderer;
      if(debug) window.NORI_MINIATURE_DEBUG={probe:renderer.probe,finishFrame:renderer.finishFrame,
        seekReplay:isReplay?time=>{if(!Number.isFinite(time))return;frozenT=Math.max(timeline.from,Math.min(timeline.to,time));}:undefined};
    }).catch(error=>{ console.warn('Miniature renderer unavailable; using the original room.',error); });
  }
  const attributionEl = document.getElementById('wx-attribution');
  if (attributionEl) attributionEl.textContent = WEATHER_ATTRIBUTION;
  fit();
  const pane = windowPane();
  // Live weather may arrive after the first frame; refresh the cached row.
  let liveWeather = fixtureWeather;

  function frame() {
    const benchT0 = bench ? benchClock.perfNow() : 0;
    let t;
    let segments;
    let objects;
    let weather;
    if (isFixture) {
      t = frozenT !== null && Number.isFinite(frozenT) ? frozenT : isReplay?Math.min(timeline.to,timeline.from+benchClock.perfNow()-replayStart):wallNowMs() % loopMs;
      if(isReplay)t=Math.max(timeline.from,Math.min(timeline.to,t));
      segments = fixtureSegments;
      objects = isReplay?interpolateObjects(replayObjectsAt(timeline,timeline.replayMetadata,t),replayEffectSegments(segments,t),t,t):interpolateObjects(fixtureObjects,segments,t,timeline.objects_at??-Infinity);
      weather = fixtureWeather;
    } else {
      // Server time from the synced clock in cam-live; never a local wall
      // clock here. Frozen ?t= still pins the fixture-style offset for demos:
      // in live mode it is treated as ms since the first server sample.
      const serverNow = liveSource.nowServer();
      t = frozenT !== null && Number.isFinite(frozenT) && liveSource.serverNowValue != null
        ? liveSource.serverNowValue + frozenT : serverNow;
      segments = liveSource.segments;
      objects = interpolateObjects(liveSource.objects, segments, t, liveSource.objectsAt);
      weather = hasWxOverride ? fixtureWeather : liveSource.weather;
      liveWeather = weather;
      updateLiveStatus();
      // Spec 3.8: confirm the ending segment before its effects show.
      for (const s of segments) {
        if (s.end_at > t && s.end_at - t < 2000 && Array.isArray(s.effects) && s.effects.length) {
          void liveSource.confirmSegmentEnd(s);
        }
      }
    }
    frameT = isFixture ? t : t % 3_600_000;
    const curGridW = (!isFixture && liveSource.room && liveSource.room.grid && liveSource.room.grid.w) || gridW;
    const curGridH = (!isFixture && liveSource.room && liveSource.room.grid && liveSource.room.grid.h) || gridH;
    ROOM_OFF = roomOffset(curGridW, curGridH);
    ctx.save();
    ctx.translate(ROOM_OFF.x, ROOM_OFF.y);
    const box = (objects || []).find((o) => o.kind === 'cardboard_box') || null;
    const pose = isReplay?replayPoseAt(segments,t):isFixture ? poseAt(segments, t) : liveSource.poseAtLive(t, poseAt);
    const paws = { stretch: pawTipOf('stretch', manifest, images) };
    const anim = animEnabled ? animState(segments, t, manifest, paws) : NEUTRAL;
    // Weather clock: fixture rows carry hour_utc; live rows are current, so
    // live weather is evaluated at server time directly.
    const wxT = !isFixture && !hasWxOverride
      ? t
      : (weather && typeof weather.hour_utc === 'number' ? (isFixture ? weather.hour_utc + t : weather.hour_utc + (t % loopMs)) : t);
    const view = windowView(weather, wxT, pane.rect);
    drawRoom(curGridW, curGridH, view, t);
    // First-load failure (live, no data yet): sleepy Nori on bed/centre.
    let effPose = pose; let effObjects = objects || []; let effAnim = anim; let effSegments = segments;
    if (!effPose && !isFixture) {
      const defObjs = effObjects.length ? effObjects : [{ id: 'default_bed', kind: 'bed', x: Math.floor(curGridW/2), y: Math.floor(curGridH/2), z: 0, footprint: [[0,0]], rotation: 0, status: 'placed', placement: 'floor', state: 'default' }];
      effObjects = defObjs;
      const fp = firstLoadPose(defObjs, { w: curGridW, h: curGridH });
      effPose = { x: fp.x, y: fp.y, z: fp.z, pose: 'sleepy', facing: 1, segmentId: 0, action: 'sleep', primitive: 'sleep', target: null, part: null, hop: 0, distance: 0 };
      effSegments = [{ id: 0, start_at: t, end_at: t + 1000, action: 'sleep', primitive: 'sleep', pose: 'sleepy', facing: 1, path: [[fp.x, fp.y]] }];
      effAnim = animEnabled ? animState(effSegments, t, manifest) : NEUTRAL;
    }
    // B8b: during the push contact Nori is drawn in the stretch pose, facing the slipper.
    if (effPose && effAnim.push) effPose = { ...effPose, pose: effAnim.push.pose, facing: effAnim.push.facing };
    if (miniature && effPose) {
      const active=(effSegments||[]).find(s=>t>=s.start_at&&t<s.end_at);
      miniature.render({pose:effPose,objects:effObjects,time:t,grid:{w:curGridW,h:curGridH},view,anim:effAnim,
        motion:currentRigMotion(effPose.pose,effPose.segmentId),segments:effSegments,
        carryingId:active?.carrying||(active?.primitive==='carry'?active.target:null)});
      ctx.restore();requestAnimationFrame(frame);return;
    }
    if (effPose) {
      const activeSeg = (effSegments || []).find((sg) => t >= sg.start_at && t < sg.end_at) || null;
      const env = { t, activeAction: activeSeg ? activeSeg.action : null, activeTargetId: activeSeg ? activeSeg.target : null, activePrimitive: activeSeg ? activeSeg.primitive : null };
      const { carried: carriedObj, floorObjects } = carryPresentation(effObjects, effSegments || [], t);
      const effBox = (effObjects || []).find((o) => kindOf(o) === 'cardboard_box') || null;
      const fx = effBox ? effAnim.objectFx[effBox.id] : undefined;
      const layers = effBox ? boxLayers(effBox, fx) : null;
      const items = [];
      for (const obj of floorObjects) {
        if (!isPropVisible(obj)) continue;
        const k = kindOf(obj);
        if (k === 'cardboard_box' && layers && !isGiftSpriteURL(obj.sprite)) {
          items.push({ x: obj.x, y: obj.y, z: obj.z || 0, layer: 'back', draw: layers.back });
          items.push({ x: obj.x, y: obj.y, z: obj.z || 0, layer: 'front', draw: layers.front });
        } else if (k === 'drawing_wall' && !isGiftSpriteURL(obj.sprite)) {
          items.push({ x: obj.x, y: obj.y, z: obj.z || 0, layer: 'back', draw: () => drawPropLayer(ctx, obj, 'single', env) });
        } else if (propLayers(obj).includes('back')) {
          items.push({ x: obj.x, y: obj.y, z: obj.z || 0, layer: 'back', draw: () => drawPropLayer(ctx, obj, 'back', env) });
          items.push({ x: obj.x, y: obj.y, z: obj.z || 0, layer: depthLayerOf(obj, 'front'), draw: () => drawPropLayer(ctx, obj, 'front', env) });
        } else {
          items.push({ ...(isGiftSpriteURL(obj.sprite) ? giftPosition(obj) : { x: obj.x, y: obj.y, z: obj.z || 0 }), draw: () => drawPropLayer(ctx, obj, 'single', env) });
        }
      }
      // B8: inside the box, Nori shows only above the front rim; the front faces are drawn over the rest.
      const catDraw = () => drawCat(effPose, effBox, manifest, images, effAnim, effObjects, view);
      items.push({ x: effPose.x, y: effPose.y, z: effPose.z || 0, part: effPose.part, draw: effPose.part === 'inside' && effBox
        ? () => { ctx.save(); clipAboveBoxRim(effBox, fx); catDraw(); ctx.restore(); } : catDraw });
      // Carried prop at mouth anchor (manifest mouth if present, else above front).
      if (carriedObj) {
        items.push({ x: effPose.x, y: effPose.y, z: effPose.z || 0, layer: 'front', draw: () => {
          const fp2 = footPoint(effPose, effBox);
          const entry = (manifest[effPose.pose] || {});
          let mx; let my;
          if (Array.isArray(entry.mouth)) { const foot = entry.foot || [entry.w/2, entry.h-1]; const flip = effPose.facing !== entry.native_facing; mx = fp2.p.sx + (flip ? -(entry.mouth[0]-foot[0]) : (entry.mouth[0]-foot[0])); my = fp2.footY - (foot[1]-entry.mouth[1]); }
          else { mx = fp2.p.sx + (effPose.facing || 1) * 10; my = fp2.footY - 14; }
          drawCarriedProp(ctx, carriedObj, mx, my, env);
        } });
      }
      drawPropContactShadows(ctx, floorObjects.map(o => isGiftSpriteURL(o.sprite) ? { ...o, ...giftPosition(o) } : o), project, isPropVisible, kindOf);
      items.sort((m, n) => depthKey(m) - depthKey(n));
      const catIndex = items.findIndex(it => it.part !== undefined);
      for (let i=0;i<items.length;i+=1) if (i !== catIndex) items[i].draw();
      drawRoomLight(view, curGridW, curGridH, t);
      if (catIndex >= 0) {
        // Keep the lit environment, then restore its foreground through an alpha
        // mask. Nori is lit on her own pixels (drawCat), not by the room pools,
        // and no prop is painted twice.
        litEnvironment.getContext('2d').drawImage(canvas, 0, 0);
        items[catIndex].draw();
        const mainCtx = ctx;
        ctx = foregroundMask.getContext('2d');
        ctx.setTransform(1,0,0,1,0,0);
        ctx.clearRect(0,0,LOGICAL_W,LOGICAL_H);
        ctx.globalCompositeOperation = 'source-over';
        ctx.translate(ROOM_OFF.x, ROOM_OFF.y);
        for(let i=catIndex+1;i<items.length;i+=1) items[i].draw();
        ctx.setTransform(1,0,0,1,0,0);
        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(litEnvironment,0,0);
        ctx.globalCompositeOperation = 'source-over';
        ctx = mainCtx;
        ctx.drawImage(foregroundMask,-ROOM_OFF.x,-ROOM_OFF.y);
      }
      drawForegroundPlant(ctx, project, curGridH);
      drawOverlays(effPose, effBox, effAnim);
      if (debug) drawDebug(effPose, t, curGridW, curGridH);
    } else {
      drawRoomLight(view, curGridW, curGridH, t);
    }
    ctx.restore();
    if (bench && !benchLogged) {
      benchTimes.push(benchClock.perfNow() - benchT0);
      if (benchTimes.length >= 300) {
        benchLogged = true;
        const sorted = [...benchTimes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
        console.log(`CAM_BENCH median_ms=${median.toFixed(3)} p95_ms=${p95.toFixed(3)} frames=${sorted.length}`);
        document.title = `CAM_BENCH median_ms=${median.toFixed(3)} p95_ms=${p95.toFixed(3)}`;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
