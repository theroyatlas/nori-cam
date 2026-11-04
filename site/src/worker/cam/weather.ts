// London hourly weather data layer (Open-Meteo, CC BY 4.0) for Nori Cam (spec section 19, E6).

export const WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';
export const WEATHER_SOURCE = 'open-meteo' as const;
export const FALLBACK_SOURCE = 'fallback' as const;

export const LONDON_LAT = 51.5072;
export const LONDON_LON = -0.1276;
export const HOUR_MS = 3_600_000;
export const MAX_LOOKBACK_MS = 3 * HOUR_MS;
export const FETCH_TIMEOUT_MS = 5_000;

export const OPEN_METEO_HOURLY_FIELDS = [
  'temperature_2m',
  'cloud_cover',
  'precipitation',
  'rain',
  'snowfall',
  'weather_code',
  'wind_speed_10m',
  'is_day',
] as const;

export const WEATHER_CONDITIONS = [
  'clear',
  'cloudy',
  'overcast',
  'fog',
  'drizzle',
  'rain',
  'snow',
  'thunder',
] as const;

export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

/**
 * Explicit WMO 4677 weather interpretation codes used by Open-Meteo:
 * - 0: Clear sky -> clear
 * - 1: Mainly clear -> clear
 * - 2: Partly cloudy -> cloudy
 * - 3: Overcast -> overcast
 * - 45, 48: Fog and depositing rime fog -> fog
 * - 51, 53, 55: Drizzle (light, moderate, dense) -> drizzle
 * - 56, 57: Freezing drizzle (light, dense) -> drizzle
 * - 61, 63, 65: Rain (slight, moderate, heavy) -> rain
 * - 66, 67: Freezing rain (light, heavy) -> rain
 * - 71, 73, 75: Snow fall (slight, moderate, heavy) -> snow
 * - 77: Snow grains -> snow
 * - 80, 81, 82: Rain showers (slight, moderate, violent) -> rain
 * - 85, 86: Snow showers (slight, heavy) -> snow
 * - 95: Thunderstorm (slight or moderate) -> thunder
 * - 96, 99: Thunderstorm with slight or heavy hail -> thunder
 */
export const WMO_CODE_MAP: Readonly<Record<number, WeatherCondition>> = Object.freeze({
  0: 'clear',
  1: 'clear',
  2: 'cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'fog',
  51: 'drizzle',
  53: 'drizzle',
  55: 'drizzle',
  56: 'drizzle',
  57: 'drizzle',
  61: 'rain',
  63: 'rain',
  65: 'rain',
  66: 'rain',
  67: 'rain',
  71: 'snow',
  73: 'snow',
  75: 'snow',
  77: 'snow',
  80: 'rain',
  81: 'rain',
  82: 'rain',
  85: 'snow',
  86: 'snow',
  95: 'thunder',
  96: 'thunder',
  99: 'thunder',
});

export function mapWmoCode(code: number): WeatherCondition {
  if (typeof code !== 'number' || !Number.isFinite(code)) return 'clear';
  return WMO_CODE_MAP[Math.trunc(code)] ?? 'clear';
}

export interface WeatherHour {
  hour_utc: number;
  condition: WeatherCondition;
  temp_c: number;
  cloud_pct: number;
  precip_mm: number;
  wind_kph: number;
  is_day: 0 | 1;
}

export interface WeatherRow extends WeatherHour {
  fetched_at: number;
  source: string;
}

export interface StartleEvent {
  at_ms: number;
  kind: 'thunder';
}

export interface WeatherEffects {
  cozyBoost: number;
  sunPatchAllowed: boolean;
  startleEvents: StartleEvent[];
}

export interface WeatherSnapshot {
  hour_utc: number;
  condition: WeatherCondition;
  temp_c: number | null;
  cloud_pct: number;
  precip_mm: number;
  wind_kph: number;
  is_day: 0 | 1;
  source: string;
  effects: WeatherEffects;
}

export type WeatherUpsertParams = [
  hour_utc: number,
  condition: WeatherCondition,
  temp_c: number,
  cloud_pct: number,
  precip_mm: number,
  wind_kph: number,
  is_day: 0 | 1,
  fetched_at: number,
  source: string,
];

export interface WeatherUpsertStatement {
  sql: string;
  params: WeatherUpsertParams;
  row: WeatherRow;
}

export const WEATHER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS weather (
  hour_utc INTEGER PRIMARY KEY,
  condition TEXT NOT NULL,
  temp_c REAL,
  cloud_pct INTEGER,
  precip_mm REAL,
  wind_kph REAL,
  is_day INTEGER,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL
)`;

export const WEATHER_UPSERT_SQL = `INSERT INTO weather (
  hour_utc, condition, temp_c, cloud_pct, precip_mm, wind_kph, is_day, fetched_at, source
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (hour_utc) DO UPDATE SET
  condition = excluded.condition,
  temp_c = excluded.temp_c,
  cloud_pct = excluded.cloud_pct,
  precip_mm = excluded.precip_mm,
  wind_kph = excluded.wind_kph,
  is_day = excluded.is_day,
  fetched_at = excluded.fetched_at,
  source = excluded.source`;

export function buildOpenMeteoUrl(): string {
  const fields = OPEN_METEO_HOURLY_FIELDS.join(',');
  return `https://api.open-meteo.com/v1/forecast?latitude=${LONDON_LAT}&longitude=${LONDON_LON}&hourly=${fields}&timezone=UTC&past_days=1&forecast_days=2`;
}

function parseUtcHourMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.floor(raw / HOUR_MS) * HOUR_MS;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const iso = hasZone ? trimmed : `${trimmed}Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / HOUR_MS) * HOUR_MS;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export function parseOpenMeteo(json: unknown): WeatherHour[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [];
  const hourly = (json as Record<string, unknown>).hourly;
  if (typeof hourly !== 'object' || hourly === null || Array.isArray(hourly)) return [];
  const h = hourly as Record<string, unknown>;
  if (!Array.isArray(h.time)) return [];

  const times = h.time;
  const temps = Array.isArray(h.temperature_2m) ? h.temperature_2m : [];
  const clouds = Array.isArray(h.cloud_cover) ? h.cloud_cover : [];
  const precips = Array.isArray(h.precipitation) ? h.precipitation : [];
  const rains = Array.isArray(h.rain) ? h.rain : [];
  const snows = Array.isArray(h.snowfall) ? h.snowfall : [];
  const codes = Array.isArray(h.weather_code) ? h.weather_code : [];
  const winds = Array.isArray(h.wind_speed_10m) ? h.wind_speed_10m : [];
  const days = Array.isArray(h.is_day) ? h.is_day : [];

  const byHour = new Map<number, WeatherHour>();
  for (let i = 0; i < times.length; i += 1) {
    const hourUtc = parseUtcHourMs(times[i]);
    if (hourUtc === null) continue;
    const code = finiteOr(codes[i], NaN);
    if (!Number.isFinite(code)) continue;

    const condition = mapWmoCode(code);
    const tempC = round3(finiteOr(temps[i], 12));
    const cloudPct = Math.max(0, Math.min(100, Math.round(finiteOr(clouds[i], 0))));
    const rawPrecip = precips[i];
    const fallbackPrecip = Math.max(0, finiteOr(rains[i], 0)) + Math.max(0, finiteOr(snows[i], 0));
    const precipMm = round3(Math.max(0, typeof rawPrecip === 'number' && Number.isFinite(rawPrecip) ? rawPrecip : fallbackPrecip));
    const windKph = round3(Math.max(0, finiteOr(winds[i], 0)));
    const rawDay = days[i];
    const isDay: 0 | 1 = rawDay === 1 || rawDay === true ? 1 : rawDay === 0 || rawDay === false ? 0 : londonIsDay(hourUtc);

    byHour.set(hourUtc, {
      hour_utc: hourUtc,
      condition,
      temp_c: tempC,
      cloud_pct: cloudPct,
      precip_mm: precipMm,
      wind_kph: windKph,
      is_day: isDay,
    });
  }

  return [...byHour.values()].sort((a, b) => a.hour_utc - b.hour_utc);
}

export async function fetchWeather(
  fetchFn: typeof fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<WeatherHour[]> {
  if (typeof fetchFn !== 'function') return [];
  const ms = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<WeatherHour[]>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve([]);
      }, ms);
    });
    const requestPromise = (async (): Promise<WeatherHour[]> => {
      const res = await fetchFn(buildOpenMeteoUrl(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res || !res.ok) return [];
      const data: unknown = await res.json();
      return parseOpenMeteo(data);
    })();
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function weatherRowsToUpsert(
  hours: readonly WeatherHour[],
  fetchedAt: number = Date.now(),
): WeatherUpsertStatement[] {
  if (!Array.isArray(hours) || hours.length === 0) return [];
  const stampedAt = Number.isFinite(fetchedAt) ? Math.trunc(fetchedAt) : 0;
  return hours.map((h) => {
    const hourUtc = Math.floor(h.hour_utc / HOUR_MS) * HOUR_MS;
    const cloudPct = Math.max(0, Math.min(100, Math.round(h.cloud_pct)));
    const isDay: 0 | 1 = h.is_day ? 1 : 0;
    const row: WeatherRow = {
      hour_utc: hourUtc,
      condition: h.condition,
      temp_c: h.temp_c,
      cloud_pct: cloudPct,
      precip_mm: h.precip_mm,
      wind_kph: h.wind_kph,
      is_day: isDay,
      fetched_at: stampedAt,
      source: WEATHER_SOURCE,
    };
    const params: WeatherUpsertParams = [
      row.hour_utc,
      row.condition,
      row.temp_c,
      row.cloud_pct,
      row.precip_mm,
      row.wind_kph,
      row.is_day,
      row.fetched_at,
      row.source,
    ];
    return { sql: WEATHER_UPSERT_SQL, params, row };
  });
}

// Shared 32-bit mixer (identical to cam-weather.js so Worker and Canvas agree on thunder timestamps).
function hash32(seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function thunderStartleEvents(hourUtc: number): StartleEvent[] {
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
  const firstHalfSpan = 1_680_000; // [60s, 1740s)
  const secondHalfStart = 1_860_000; // [1860s, 3540s) -> >= 2 min separation
  const off1 = 60_000 + (hash32(hourIndex ^ 0x27d4eb2f) % firstHalfSpan);
  const off2 = secondHalfStart + (hash32(hourIndex ^ 0x165667b1) % firstHalfSpan);
  return [
    { at_ms: base + off1, kind: 'thunder' },
    { at_ms: base + off2, kind: 'thunder' },
  ];
}

const PRECIP_CONDITIONS = new Set<WeatherCondition>(['drizzle', 'rain', 'snow', 'thunder']);

export function weatherEffects(
  w: Pick<WeatherHour, 'condition'> & Partial<Pick<WeatherHour, 'hour_utc' | 'cloud_pct' | 'precip_mm'>>,
): WeatherEffects {
  const condition = w?.condition ?? 'clear';
  const cloudPct = finiteOr(w?.cloud_pct, 0);
  const precipMm = Math.max(0, finiteOr(w?.precip_mm, 0));

  let cozyBoost = 0;
  if (condition === 'drizzle') {
    cozyBoost = clamp01(0.25 + Math.min(0.15, precipMm * 0.05));
  } else if (condition === 'rain') {
    cozyBoost = clamp01(0.55 + Math.min(0.25, precipMm * 0.03));
  } else if (condition === 'snow') {
    cozyBoost = clamp01(0.65 + Math.min(0.25, precipMm * 0.05));
  } else if (condition === 'thunder') {
    cozyBoost = clamp01(0.85 + Math.min(0.15, precipMm * 0.02));
  }
  cozyBoost = round3(cozyBoost);

  const hasPrecipitation = precipMm > 0 || PRECIP_CONDITIONS.has(condition);
  const sunPatchAllowed = !(cloudPct >= 70 || hasPrecipitation);

  const startleEvents =
    condition === 'thunder' && typeof w?.hour_utc === 'number' && Number.isFinite(w.hour_utc)
      ? thunderStartleEvents(w.hour_utc)
      : [];

  return { cozyBoost, sunPatchAllowed, startleEvents };
}

/** Pure arithmetic London daylight approximation (NOAA simplified solar elevation > -0.833 deg). */
export function londonIsDay(tMs: number): 0 | 1 {
  if (!Number.isFinite(tMs)) return 1;
  const DEG = Math.PI / 180;
  const dayMs = ((tMs % 86_400_000) + 86_400_000) % 86_400_000;
  const n = (tMs - 946_728_000_000) / 86_400_000;
  const meanLon = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const meanAnom = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * DEG;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG;
  const eps = 23.439 * DEG;
  const sinDec = Math.sin(eps) * Math.sin(eclLon);
  const cosDec = Math.sqrt(Math.max(0, 1 - sinDec * sinDec));
  const utcHours = dayMs / HOUR_MS;
  const hourAngle = (utcHours + LONDON_LON / 15 - 12) * 15 * DEG;
  const latRad = LONDON_LAT * DEG;
  const sinAlt = Math.sin(latRad) * sinDec + Math.cos(latRad) * cosDec * Math.cos(hourAngle);
  return sinAlt > -0.01454 ? 1 : 0;
}

export function weatherAt(
  rows: readonly (WeatherHour & Partial<Pick<WeatherRow, 'fetched_at' | 'source'>>)[],
  t: number,
): WeatherSnapshot {
  const safeT = Number.isFinite(t) ? t : 0;
  if (Array.isArray(rows) && rows.length > 0) {
    let exact: (WeatherHour & Partial<Pick<WeatherRow, 'fetched_at' | 'source'>>) | null = null;
    let nearestEarlier: (WeatherHour & Partial<Pick<WeatherRow, 'fetched_at' | 'source'>>) | null = null;

    for (const r of rows) {
      if (!r || typeof r.hour_utc !== 'number' || !Number.isFinite(r.hour_utc)) continue;
      if (r.hour_utc <= safeT && safeT < r.hour_utc + HOUR_MS) {
        exact = r;
        break;
      }
      if (r.hour_utc <= safeT && safeT - r.hour_utc <= MAX_LOOKBACK_MS) {
        if (!nearestEarlier || r.hour_utc > nearestEarlier.hour_utc) {
          nearestEarlier = r;
        }
      }
    }

    const picked = exact ?? nearestEarlier;
    if (picked) {
      return {
        hour_utc: picked.hour_utc,
        condition: picked.condition,
        temp_c: picked.temp_c,
        cloud_pct: picked.cloud_pct,
        precip_mm: picked.precip_mm,
        wind_kph: picked.wind_kph,
        is_day: picked.is_day ? 1 : 0,
        source: picked.source ?? WEATHER_SOURCE,
        effects: weatherEffects(picked),
      };
    }
  }

  const fallbackHour = Math.floor(safeT / HOUR_MS) * HOUR_MS;
  return {
    hour_utc: fallbackHour,
    condition: 'clear',
    temp_c: null,
    cloud_pct: 0,
    precip_mm: 0,
    wind_kph: 0,
    is_day: londonIsDay(safeT),
    source: FALLBACK_SOURCE,
    effects: {
      cozyBoost: 0,
      sunPatchAllowed: true,
      startleEvents: [],
    },
  };
}
