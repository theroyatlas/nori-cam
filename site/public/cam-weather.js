// Pure weather visual helpers for Nori Cam. No DOM, no wall-clock globals, no PRNG state.

export const WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LONDON_LAT = 51.5072;
const LONDON_LON = -0.1276;
const TWO_PI = Math.PI * 2;

const DEFAULT_CLOUD = {
  clear: 0,
  cloudy: 0.45,
  overcast: 0.9,
  fog: 0.75,
  drizzle: 0.78,
  rain: 0.88,
  snow: 0.85,
  thunder: 0.96,
};

function clamp01(v) {
  if (!(v > 0)) return 0;
  return v >= 1 ? 1 : v;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function posMod(a, m) {
  if (!(m > 0) || !Number.isFinite(a)) return 0;
  const r = a % m;
  const p = r < 0 ? r + m : r;
  return p >= m || p < 0 ? 0 : p;
}

function hash32(seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function unitHash(seed) {
  return hash32(seed) / 4294967296;
}

function londonDaylightAt(tMs) {
  if (!Number.isFinite(tMs)) return true;
  const deg = Math.PI / 180;
  const dayMs = posMod(tMs, DAY_MS);
  const n = (tMs - 946_728_000_000) / DAY_MS;
  const meanLon = posMod(280.46 + 0.9856474 * n, 360);
  const meanAnom = posMod(357.528 + 0.9856003 * n, 360) * deg;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * deg;
  const eps = 23.439 * deg;
  const sinDec = Math.sin(eps) * Math.sin(eclLon);
  const cosDec = Math.sqrt(Math.max(0, 1 - sinDec * sinDec));
  const utcHours = dayMs / HOUR_MS;
  const hourAngle = (utcHours + LONDON_LON / 15 - 12) * 15 * deg;
  const latRad = LONDON_LAT * deg;
  const sinAlt = Math.sin(latRad) * sinDec + Math.cos(latRad) * cosDec * Math.cos(hourAngle);
  return sinAlt > -0.01454;
}

export function thunderStartleEvents(hourUtc) {
  if (!Number.isFinite(hourUtc)) return [];
  const base = Math.floor(hourUtc / HOUR_MS) * HOUR_MS;
  const hourIndex = Math.floor(base / HOUR_MS);
  const h0 = hash32(hourIndex);
  const bucket = h0 % 4;
  const count = bucket === 0 ? 0 : bucket === 3 ? 2 : 1;
  if (count === 0) return [];
  if (count === 1) {
    const offset = 60_000 + (hash32(hourIndex ^ 0x51ed270b) % (HOUR_MS - 120_000));
    return [{ at_ms: base + offset, kind: 'thunder' }];
  }
  const firstHalfSpan = 1_680_000;
  const secondHalfStart = 1_860_000;
  const off1 = 60_000 + (hash32(hourIndex ^ 0x27d4eb2f) % firstHalfSpan);
  const off2 = secondHalfStart + (hash32(hourIndex ^ 0x165667b1) % firstHalfSpan);
  return [
    { at_ms: base + off1, kind: 'thunder' },
    { at_ms: base + off2, kind: 'thunder' },
  ];
}

function flashCurve(dtMs) {
  if (dtMs < -40 || dtMs >= 600) return 0;
  if (dtMs <= 0) return (dtMs + 40) / 40;
  if (dtMs <= 220) return 1 - (dtMs / 220) * 0.85;
  if (dtMs <= 280) return 0.15 + ((dtMs - 220) / 60) * 0.4;
  return 0.55 * (1 - (dtMs - 280) / 320);
}

function resolveStartleEvents(w, safeT) {
  if (w && w.effects && Array.isArray(w.effects.startleEvents)) {
    return w.effects.startleEvents;
  }
  if (w && Array.isArray(w.startleEvents)) {
    return w.startleEvents;
  }
  const hourBase =
    w && typeof w.hour_utc === 'number' && Number.isFinite(w.hour_utc)
      ? w.hour_utc
      : Math.floor(safeT / HOUR_MS) * HOUR_MS;
  return thunderStartleEvents(hourBase);
}

export function weatherVisual(w, t) {
  const safeT = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  const cond = w && typeof w.condition === 'string' ? w.condition : 'clear';
  const precip = w && typeof w.precip_mm === 'number' && Number.isFinite(w.precip_mm) ? Math.max(0, w.precip_mm) : 0;

  let isDay;
  if (w && (w.is_day === 1 || w.is_day === true)) {
    isDay = true;
  } else if (w && (w.is_day === 0 || w.is_day === false)) {
    isDay = false;
  } else {
    isDay = londonDaylightAt(safeT);
  }
  const sky = isDay ? 'day' : 'night';

  const rawCloud =
    w && typeof w.cloud_pct === 'number' && Number.isFinite(w.cloud_pct)
      ? clamp01(w.cloud_pct / 100)
      : DEFAULT_CLOUD[cond] ?? 0;
  const cloud = round4(rawCloud);

  let rain = 0;
  if (cond === 'drizzle') {
    rain = clamp01(0.25 + Math.min(0.2, precip * 0.15));
  } else if (cond === 'rain') {
    rain = clamp01(0.5 + Math.min(0.5, precip * 0.08));
  } else if (cond === 'thunder') {
    rain = clamp01(0.7 + Math.min(0.3, precip * 0.05));
  }
  rain = round4(rain);

  const snow = cond === 'snow' ? round4(clamp01(0.45 + Math.min(0.55, precip * 0.15))) : 0;
  const fog = cond === 'fog' ? 0.8 : 0;

  let flash = 0;
  if (cond === 'thunder') {
    const events = resolveStartleEvents(w, safeT);
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (!ev || typeof ev.at_ms !== 'number') continue;
      const f = flashCurve(safeT - ev.at_ms);
      if (f > flash) flash = f;
    }
  }
  flash = round4(clamp01(flash));

  let r = isDay ? 255 : 22;
  let g = isDay ? 248 : 34;
  let b = isDay ? 228 : 68;
  let a = isDay ? 0 : 0.34;

  if (snow > 0) {
    r = isDay ? 222 : 44;
    g = isDay ? 234 : 58;
    b = isDay ? 248 : 92;
    a = isDay ? round4(0.1 + snow * 0.08) : 0.36;
  } else if (rain > 0) {
    r = isDay ? 92 : 20;
    g = isDay ? 110 : 30;
    b = isDay ? 136 : 58;
    a = isDay ? round4(0.1 + rain * 0.14) : round4(0.36 + rain * 0.08);
  } else if (fog > 0) {
    r = isDay ? 204 : 58;
    g = isDay ? 212 : 66;
    b = isDay ? 220 : 82;
    a = isDay ? 0.22 : 0.36;
  } else if (cloud >= 0.7) {
    r = isDay ? 128 : 24;
    g = isDay ? 138 : 36;
    b = isDay ? 154 : 68;
    a = isDay ? round4(0.06 + (cloud - 0.7) * 0.2) : 0.35;
  }

  if (flash > 0) {
    r = Math.round(r + (240 - r) * flash);
    g = Math.round(g + (246 - g) * flash);
    b = Math.round(b + (255 - b) * flash);
    a = round4(clamp01(a * (1 - flash * 0.5) + flash * 0.45));
  }

  return {
    sky,
    cloud,
    rain,
    snow,
    fog,
    flash,
    tint: [r, g, b, a],
  };
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x ?? 0);
  const y = Number(rect.y ?? 0);
  const w = Number(rect.w ?? rect.width ?? 0);
  const h = Number(rect.h ?? rect.height ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

export function rainDrops(w, t, rect, n) {
  const box = normalizeRect(rect);
  if (!box) return [];
  const safeT = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  const vis = weatherVisual(w, safeT);
  if (!(vis.rain > 0)) return [];

  const count =
    typeof n === 'number' && Number.isFinite(n)
      ? Math.max(0, Math.floor(n))
      : Math.max(1, Math.round(24 * vis.rain));
  if (count === 0) return [];

  const drops = [];
  for (let i = 0; i < count; i += 1) {
    const phaseX = unitHash(i * 374761393 + 17);
    const phaseY = unitHash(i * 668265263 + 53);
    const periodYMs = 320 + (hash32(i * 2246822519 + 97) % 240);
    const periodXMs = 2400 + (hash32(i * 3266489917 + 131) % 1800);
    const len = 2 + (hash32(i * 1597334677 + 193) % 3);
    const alpha = round4(0.35 + unitHash(i * 2654435761 + 257) * 0.45);

    const uNorm = posMod(phaseX - posMod(safeT, periodXMs) / periodXMs, 1);
    const vNorm = posMod(phaseY + posMod(safeT, periodYMs) / periodYMs, 1);
    const px = Math.min(box.x + box.w, Math.max(box.x, box.x + uNorm * box.w));
    const py = Math.min(box.y + box.h, Math.max(box.y, box.y + vNorm * box.h));

    drops.push({
      x: round4(px),
      y: round4(py),
      len,
      alpha,
    });
  }
  return drops;
}

export function snowFlakes(w, t, rect, n) {
  const box = normalizeRect(rect);
  if (!box) return [];
  const safeT = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  const vis = weatherVisual(w, safeT);
  if (!(vis.snow > 0)) return [];

  const count =
    typeof n === 'number' && Number.isFinite(n)
      ? Math.max(0, Math.floor(n))
      : Math.max(1, Math.round(20 * vis.snow));
  if (count === 0) return [];

  const flakes = [];
  for (let i = 0; i < count; i += 1) {
    const phaseX = unitHash(i * 1103515245 + 101);
    const phaseY = unitHash(i * 1234567891 + 211);
    const periodYMs = 1500 + (hash32(i * 2147483629 + 307) % 1300);
    const swayPeriodMs = 2200 + (hash32(i * 2971215073 + 401) % 1800);
    const swayPhase = unitHash(i * 1664525 + 503) * TWO_PI;
    const swayAmpNorm = 0.04 + unitHash(i * 1013904223 + 601) * 0.06;
    const r = 1 + (hash32(i * 374761393 + 701) % 2);
    const alpha = round4(0.55 + unitHash(i * 668265263 + 809) * 0.4);

    const swayAngle = (posMod(safeT, swayPeriodMs) / swayPeriodMs) * TWO_PI + swayPhase;
    const uNorm = posMod(phaseX + Math.sin(swayAngle) * swayAmpNorm, 1);
    const vNorm = posMod(phaseY + posMod(safeT, periodYMs) / periodYMs, 1);
    const px = Math.min(box.x + box.w, Math.max(box.x, box.x + uNorm * box.w));
    const py = Math.min(box.y + box.h, Math.max(box.y, box.y + vNorm * box.h));

    flakes.push({
      x: round4(px),
      y: round4(py),
      r,
      alpha,
    });
  }
  return flakes;
}
