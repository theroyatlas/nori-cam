// Pure window-view helpers for Nori Cam (B2). No DOM, no wall clock, no PRNG state.
// Every output depends only on (weather row, t, rect), so two browsers draw
// the same frame. Sun patch and room tint come from lane A lightAt /
// sunPatchAt in cam-shared.js (B4); sunPatchPlaceholder is kept exported
// for existing callers and tests.

import { rainDrops, snowFlakes, weatherVisual } from './cam-weather.js';
import { lightAt, sunPatchAt } from './cam-shared.js';

export const WX_CONDITIONS = [
  'clear', 'cloudy', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'thunder',
];

const SKY_COLORS = {
  day: '#7fb0dc',
  dusk: '#e08a4e',
  night: '#141c36',
};

function clamp01(v) {
  if (!(v > 0)) return 0;
  return v >= 1 ? 1 : v;
}
function round4(v) { return Math.round(v * 10000) / 10000; }
function posMod(a, m) {
  if (!(m > 0) || !Number.isFinite(a)) return 0;
  const r = a % m;
  return r < 0 ? r + m : r;
}
function hash32(seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
function unitHash(seed) { return hash32(seed) / 4294967296; }
function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x ?? 0);
  const y = Number(rect.y ?? 0);
  const w = Number(rect.w ?? rect.width ?? 0);
  const h = Number(rect.h ?? rect.height ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}
function isDayRow(w) {
  return !!w && (w.is_day === 1 || w.is_day === true);
}

// --- URL / fixture selection -------------------------------------------------

export function parseWxParams(search) {
  let params;
  if (typeof search === 'string') {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } else if (search && typeof search.get === 'function') {
    params = search;
  } else {
    params = new URLSearchParams();
  }
  const rawWx = params.get('wx');
  const wx = rawWx && WX_CONDITIONS.includes(rawWx) ? rawWx : null;
  const night = params.get('night') === '1';
  return { wx, night };
}

export function selectWeatherRow(rows, wx, night) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cond = wx && WX_CONDITIONS.includes(wx) ? wx : 'clear';
  const wantDay = !night;
  const withCond = rows.filter((r) => r && r.condition === cond);
  const pool = withCond.length ? withCond : rows;
  const exact = pool.find((r) => isDayRow(r) === wantDay);
  if (exact) return exact;
  const any = pool[0];
  if (!any) return null;
  // No row with the requested day/night flag: keep the condition and
  // override is_day so the sky matches the request.
  return { ...any, is_day: wantDay ? 1 : 0 };
}

// --- Sky phase ---------------------------------------------------------------

export function skyPhase(w) {
  if (!isDayRow(w)) return 'night';
  const hourUtc = w && typeof w.hour_utc === 'number' && Number.isFinite(w.hour_utc)
    ? w.hour_utc : null;
  if (hourUtc !== null) {
    const hour = Math.floor(posMod(hourUtc, 86_400_000) / 3_600_000);
    if (hour >= 16 && hour <= 18) return 'dusk';
  }
  return 'day';
}

// --- Sun patch (renderer-only placeholder for lane A sunPatchAt) -------------

export function sunPatchPlaceholder(t, w) {
  const safeT = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  if (!w || !isDayRow(w)) return { allowed: false, alpha: 0, dx: 0, dy: 0 };
  const cloudPct = typeof w.cloud_pct === 'number' && Number.isFinite(w.cloud_pct) ? w.cloud_pct : 100;
  const precip = typeof w.precip_mm === 'number' && Number.isFinite(w.precip_mm) ? Math.max(0, w.precip_mm) : 0;
  const condOk = w.condition === 'clear' || w.condition === 'cloudy';
  const allowed = condOk && cloudPct < 70 && precip <= 0;
  if (!allowed) return { allowed: false, alpha: 0, dx: 0, dy: 0 };
  // Soft patch drifts a pixel or two across an hour; alpha breathes slowly.
  const drift = posMod(safeT, 3_600_000) / 3_600_000;
  return {
    allowed: true,
    alpha: round4(0.16 + 0.04 * Math.sin((safeT / 9000) * Math.PI * 2)),
    dx: round4(drift * 2 - 1),
    dy: round4(drift),
  };
}

// --- Clouds, stars, glass drops ----------------------------------------------

export function cloudClusters(cloud, t, rect) {
  const box = normalizeRect(rect);
  if (!box) return [];
  const c = clamp01(typeof cloud === 'number' && Number.isFinite(cloud) ? cloud : 0);
  const count = Math.round(c * 7);
  const safeT = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const speedPxPerSec = 1.2 + unitHash(i * 7919 + 13) * 1.6;
    const w = 8 + (hash32(i * 104729 + 29) % 14);
    const h = 3 + (hash32(i * 13007 + 43) % 3);
    const span = box.w + w;
    const baseX = unitHash(i * 31337 + 59) * span;
    const x = box.x - w + posMod(baseX + (safeT / 1000) * speedPxPerSec, span);
    const y = box.y + 2 + unitHash(i * 15485863 + 71) * Math.max(1, box.h * 0.45);
    out.push({
      x: round4(x), y: round4(Math.round(y)), w, h,
      alpha: round4(0.55 + unitHash(i * 32452843 + 83) * 0.35),
    });
  }
  return out;
}

export function starPoints(t, rect, cloud) {
  const box = normalizeRect(rect);
  if (!box) return [];
  if (clamp01(cloud || 0) > 0.5) return [];
  const out = [];
  for (let i = 0; i < 14; i += 1) {
    out.push({
      x: round4(box.x + unitHash(i * 2225531 + 97) * box.w),
      y: round4(box.y + unitHash(i * 3341219 + 113) * box.h * 0.8),
      // Twinkle is a pure function of (i, t).
      alpha: round4(0.35 + 0.6 * (0.5 + 0.5 * Math.sin(t / 700 + i * 1.7))),
    });
  }
  return out;
}

export function glassDrops(w, t, rect, n) {
  const box = normalizeRect(rect);
  if (!box) return [];
  const safeT = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  const vis = weatherVisual(w, safeT);
  if (!(vis.rain > 0)) return [];
  const count = typeof n === 'number' && Number.isFinite(n)
    ? Math.max(0, Math.floor(n))
    : Math.max(1, Math.round(9 * vis.rain));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const periodMs = 2600 + (hash32(i * 2654435761 + 131) % 2200);
    const lane = unitHash(i * 1103515245 + 149);
    const v = posMod(unitHash(i * 1234567891 + 167) + posMod(safeT, periodMs) / periodMs, 1);
    // Drops cling, then slide: ease the second half of the cycle.
    const slide = v < 0.6 ? v * 0.25 : 0.15 + (v - 0.6) / 0.4 * 0.85;
    out.push({
      x: round4(box.x + lane * box.w),
      y: round4(box.y + slide * box.h),
      len: 2 + (hash32(i * 1597334677 + 181) % 2),
      alpha: round4(0.4 + unitHash(i * 668265263 + 199) * 0.4),
    });
  }
  return out;
}

// --- Combined deterministic view ---------------------------------------------

export function windowView(w, t, rect) {
  const box = normalizeRect(rect) || { x: 0, y: 0, w: 1, h: 1 };
  const safeT = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  const vis = weatherVisual(w, safeT);
  const phase = skyPhase(w);
  const sky = phase;
  let skyColor = SKY_COLORS[phase];
  if (phase === 'day') {
    if (vis.fog > 0) skyColor = '#c3ccd4';
    else if (vis.cloud >= 0.85) skyColor = '#93a7ba';
    else if (vis.cloud >= 0.5) skyColor = '#a8bfd6';
  } else if (phase === 'dusk' && vis.cloud >= 0.7) {
    skyColor = '#b98a6a';
  }
  const drizzleCond = w && w.condition === 'drizzle';
  const rainCount = drizzleCond
    ? Math.round(36 * vis.rain)
    : Math.round(96 * vis.rain);
  const snowCount = Math.round(48 * vis.snow);
  // Room tint is based on lightAt (B4): night darkens, day clears, low sun
  // warms. Weather flash still wins; weather tint is kept for precip/fog.
  const light = lightAt(safeT, w || undefined);
  const sun = w ? sunPatchAt(safeT, w) : null;
  let tint = vis.tint;
  if (vis.flash <= 0) {
    if (light.phase === 'morning' || light.phase === 'evening' || phase === 'dusk') {
      tint = [232, 145, 74, 0.16];
    } else if (light.phase === 'night') {
      tint = [22, 34, 68, Math.max(tint[3], 0.34)];
    } else {
      // Day: scale weather tint alpha down by daylight intensity.
      tint = [tint[0], tint[1], tint[2], round4(clamp01(tint[3] * (1 - light.intensity * 0.6)))];
    }
  }
  const sunPatch = sun
    ? {
      allowed: true,
      alpha: round4(0.1 + 0.22 * sun.brightness),
      dx: 0, dy: 0,
      x: sun.x, y: sun.y, polygon: sun.polygon, brightness: sun.brightness,
    }
    : { allowed: false, alpha: 0, dx: 0, dy: 0, x: 0, y: 0, polygon: null, brightness: 0 };
  return {
    sky,
    skyColor,
    cloud: vis.cloud,
    rain: vis.rain,
    snow: vis.snow,
    fog: vis.fog,
    fogAlpha: round4(vis.fog * 0.55),
    flash: vis.flash,
    tint,
    tintCss: `rgba(${tint[0]},${tint[1]},${tint[2]},${tint[3]})`,
    clouds: cloudClusters(vis.cloud, safeT, box),
    stars: phase === 'night' ? starPoints(safeT, box, vis.cloud) : [],
    rainDrops: rainDrops(w, safeT, box, rainCount),
    glassDrops: glassDrops(w, safeT, box),
    snowFlakes: snowFlakes(w, safeT, box, snowCount),
    sunPatch,
    light,
    sunPatchAt: sun,
  };
}
