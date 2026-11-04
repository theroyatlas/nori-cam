import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEATHER_ATTRIBUTION as CLIENT_ATTRIBUTION,
  rainDrops,
  snowFlakes,
  thunderStartleEvents as clientThunderEvents,
  weatherVisual,
} from '../public/cam-weather.js';
import {
  FALLBACK_SOURCE,
  FETCH_TIMEOUT_MS,
  HOUR_MS,
  LONDON_LAT,
  LONDON_LON,
  MAX_LOOKBACK_MS,
  OPEN_METEO_HOURLY_FIELDS,
  WEATHER_ATTRIBUTION,
  WEATHER_CONDITIONS,
  WEATHER_SOURCE,
  WEATHER_TABLE_SQL,
  WMO_CODE_MAP,
  buildOpenMeteoUrl,
  fetchWeather,
  mapWmoCode,
  parseOpenMeteo,
  thunderStartleEvents,
  weatherAt,
  weatherEffects,
  weatherRowsToUpsert,
  type WeatherCondition,
  type WeatherHour,
} from '../src/worker/cam/weather.ts';

const openMeteoFixtureUrl = new URL('../sample/cam/weather-openmeteo-london.json', import.meta.url);
const rowsFixtureUrl = new URL('../sample/cam/weather-rows.json', import.meta.url);
const camWeatherJsUrl = new URL('../public/cam-weather.js', import.meta.url);

const openMeteoFixture = JSON.parse(readFileSync(openMeteoFixtureUrl, 'utf8'));
const expectedRows: WeatherHour[] = JSON.parse(readFileSync(rowsFixtureUrl, 'utf8'));

afterEach(() => {
  vi.useRealTimers();
});

describe('Open-Meteo URL and attribution', () => {
  it('builds the London UTC hourly forecast URL with all required parameters', () => {
    const raw = buildOpenMeteoUrl();
    const url = new URL(raw);
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(Number(url.searchParams.get('latitude'))).toBeCloseTo(LONDON_LAT, 4);
    expect(Number(url.searchParams.get('longitude'))).toBeCloseTo(LONDON_LON, 4);
    expect(url.searchParams.get('timezone')).toBe('UTC');
    expect(url.searchParams.get('past_days')).toBe('1');
    expect(url.searchParams.get('forecast_days')).toBe('2');
    expect(url.searchParams.get('hourly')?.split(',')).toEqual([...OPEN_METEO_HOURLY_FIELDS]);
  });

  it('exports the CC BY 4.0 Open-Meteo attribution string on both worker and client modules', () => {
    expect(WEATHER_ATTRIBUTION).toBe('Weather data by Open-Meteo.com (CC BY 4.0)');
    expect(CLIENT_ATTRIBUTION).toBe(WEATHER_ATTRIBUTION);
  });
});

describe('WMO weather code mapping table', () => {
  const expectedTable: Array<[number, WeatherCondition]> = [
    [0, 'clear'],
    [1, 'clear'],
    [2, 'cloudy'],
    [3, 'overcast'],
    [45, 'fog'],
    [48, 'fog'],
    [51, 'drizzle'],
    [53, 'drizzle'],
    [55, 'drizzle'],
    [56, 'drizzle'],
    [57, 'drizzle'],
    [61, 'rain'],
    [63, 'rain'],
    [65, 'rain'],
    [66, 'rain'],
    [67, 'rain'],
    [71, 'snow'],
    [73, 'snow'],
    [75, 'snow'],
    [77, 'snow'],
    [80, 'rain'],
    [81, 'rain'],
    [82, 'rain'],
    [85, 'snow'],
    [86, 'snow'],
    [95, 'thunder'],
    [96, 'thunder'],
    [99, 'thunder'],
  ];

  it('maps every standard Open-Meteo WMO 4677 code explicitly', () => {
    expect(Object.keys(WMO_CODE_MAP).map(Number).sort((a, b) => a - b)).toEqual(
      expectedTable.map(([c]) => c).sort((a, b) => a - b),
    );
    for (const [code, condition] of expectedTable) {
      expect(WMO_CODE_MAP[code]).toBe(condition);
      expect(mapWmoCode(code)).toBe(condition);
    }
    const mappedSet = new Set(Object.values(WMO_CODE_MAP));
    expect([...mappedSet].sort()).toEqual([...WEATHER_CONDITIONS].sort());
  });

  it('falls back to clear on unknown or non-finite WMO codes without throwing', () => {
    expect(mapWmoCode(999)).toBe('clear');
    expect(mapWmoCode(-5)).toBe('clear');
    expect(mapWmoCode(Number.NaN)).toBe('clear');
  });
});

describe('parseOpenMeteo and weatherRowsToUpsert', () => {
  it('parses the recorded-style London fixture into weather-rows.json covering clear, rain, snow, and thunder', () => {
    expect(openMeteoFixture._fixture).toBe(true);
    const parsed = parseOpenMeteo(openMeteoFixture);
    expect(parsed).toEqual(expectedRows);
    expect(parsed).toHaveLength(72);

    // First entry is 2026-11-01T00:00Z in exact UTC ms regardless of host timezone.
    expect(parsed[0].hour_utc).toBe(Date.UTC(2026, 10, 1, 0, 0, 0, 0));
    for (let i = 0; i < parsed.length; i += 1) {
      expect(parsed[i].hour_utc % HOUR_MS).toBe(0);
      if (i > 0) expect(parsed[i].hour_utc - parsed[i - 1].hour_utc).toBe(HOUR_MS);
    }

    const conditions = new Set(parsed.map((r) => r.condition));
    expect(conditions.has('clear')).toBe(true);
    expect(conditions.has('rain')).toBe(true);
    expect(conditions.has('snow')).toBe(true);
    expect(conditions.has('thunder')).toBe(true);
  });

  it('returns [] or skips malformed entries safely without throwing', () => {
    expect(parseOpenMeteo(null)).toEqual([]);
    expect(parseOpenMeteo('bad')).toEqual([]);
    expect(parseOpenMeteo({})).toEqual([]);
    expect(parseOpenMeteo({ hourly: { time: 'not-an-array' } })).toEqual([]);
    const partial = parseOpenMeteo({
      hourly: {
        time: ['invalid-time', '2026-11-02T12:34'],
        weather_code: [0, 61],
        temperature_2m: [10, 9.5],
        cloud_cover: [20, 92],
        precipitation: [0, 2.4],
        wind_speed_10m: [5, 18],
        is_day: [1, 1],
      },
    });
    expect(partial).toEqual([
      {
        hour_utc: Date.UTC(2026, 10, 2, 12, 0, 0, 0),
        condition: 'rain',
        temp_c: 9.5,
        cloud_pct: 92,
        precip_mm: 2.4,
        wind_kph: 18,
        is_day: 1,
      },
    ]);
  });

  it('produces valid D1/SQLite upsert statements and params for the weather table', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(WEATHER_TABLE_SQL);

    const fetchedAt = Date.UTC(2026, 10, 2, 12, 5, 0, 0);
    const statements = weatherRowsToUpsert(expectedRows, fetchedAt);
    expect(statements).toHaveLength(expectedRows.length);

    for (const stmt of statements) {
      expect(stmt.params).toHaveLength(9);
      expect(stmt.params[7]).toBe(fetchedAt);
      expect(stmt.params[8]).toBe(WEATHER_SOURCE);
      db.prepare(stmt.sql).run(...stmt.params);
    }

    const countRow = db.prepare('SELECT COUNT(*) AS n FROM weather').get() as { n: number };
    expect(countRow.n).toBe(72);

    // Upserting an updated forecast for an existing hour overwrites cleanly on conflict.
    const updatedHour: WeatherHour = {
      ...expectedRows[0],
      condition: 'rain',
      precip_mm: 3.2,
    };
    const [reUpsert] = weatherRowsToUpsert([updatedHour], fetchedAt + 60_000);
    db.prepare(reUpsert.sql).run(...reUpsert.params);

    const row = db
      .prepare('SELECT condition, precip_mm, fetched_at, source FROM weather WHERE hour_utc = ?')
      .get(expectedRows[0].hour_utc) as {
      condition: string;
      precip_mm: number;
      fetched_at: number;
      source: string;
    };
    expect(row).toEqual({
      condition: 'rain',
      precip_mm: 3.2,
      fetched_at: fetchedAt + 60_000,
      source: 'open-meteo',
    });
  });
});

describe('fetchWeather error and timeout resilience', () => {
  it('parses hours from an injected fetch returning the fixture', async () => {
    let calledUrl = '';
    const okFetch: typeof fetch = async (input) => {
      calledUrl = String(input);
      return new Response(JSON.stringify(openMeteoFixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const hours = await fetchWeather(okFetch);
    expect(calledUrl).toBe(buildOpenMeteoUrl());
    expect(hours).toEqual(expectedRows);
  });

  it('returns [] and never throws on network rejection, sync throw, HTTP 5xx, or bad JSON', async () => {
    const rejectFetch: typeof fetch = async () => {
      throw new Error('ECONNRESET');
    };
    const syncThrowFetch = (() => {
      throw new Error('sync failure');
    }) as unknown as typeof fetch;
    const http503Fetch: typeof fetch = async () => new Response('Service Unavailable', { status: 503 });
    const badJsonFetch: typeof fetch = async () => new Response('<<<not-json>>>', { status: 200 });

    await expect(fetchWeather(rejectFetch)).resolves.toEqual([]);
    await expect(fetchWeather(syncThrowFetch)).resolves.toEqual([]);
    await expect(fetchWeather(http503Fetch)).resolves.toEqual([]);
    await expect(fetchWeather(badJsonFetch)).resolves.toEqual([]);

    // Empty rows fall back cleanly to clear with no effects.
    const fb = weatherAt([], Date.UTC(2026, 10, 2, 12, 30, 0));
    expect(fb.condition).toBe('clear');
    expect(fb.source).toBe(FALLBACK_SOURCE);
    expect(fb.effects).toEqual({ cozyBoost: 0, sunPatchAllowed: true, startleEvents: [] });
  });

  it('aborts and returns [] after the 5 s timeout', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const pending = fetchWeather(hangingFetch);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    const result = await pending;
    expect(aborted).toBe(true);
    expect(result).toEqual([]);
  });
});

describe('weatherAt boundaries', () => {
  const h12 = Date.UTC(2026, 10, 2, 12, 0, 0, 0);
  const h13 = h12 + HOUR_MS;
  const sampleRows: WeatherHour[] = [
    {
      hour_utc: h12,
      condition: 'rain',
      temp_c: 10.5,
      cloud_pct: 95,
      precip_mm: 3.5,
      wind_kph: 24,
      is_day: 1,
    },
    {
      hour_utc: h13,
      condition: 'cloudy',
      temp_c: 11.0,
      cloud_pct: 50,
      precip_mm: 0,
      wind_kph: 16,
      is_day: 1,
    },
  ];

  it('selects the row whose hour contains t across exact start/end boundaries', () => {
    expect(weatherAt(sampleRows, h12).condition).toBe('rain');
    expect(weatherAt(sampleRows, h12 + 1_800_000).condition).toBe('rain');
    expect(weatherAt(sampleRows, h13 - 1).condition).toBe('rain');
    expect(weatherAt(sampleRows, h13).condition).toBe('cloudy');
    expect(weatherAt(sampleRows, h13 + HOUR_MS - 1).condition).toBe('cloudy');
  });

  it('uses the nearest earlier row within 3 h when the containing hour is missing, and falls back past 3 h', () => {
    const reversed = [sampleRows[1], sampleRows[0]];
    // At h13 + 3h (exact 3 h from h13.hour_utc), h13 is still within 3 h.
    const within = weatherAt(reversed, h13 + MAX_LOOKBACK_MS);
    expect(within.condition).toBe('cloudy');
    expect(within.hour_utc).toBe(h13);
    expect(within.source).toBe(WEATHER_SOURCE);

    // 1 ms past the 3 h window -> fallback.
    const expired = weatherAt(reversed, h13 + MAX_LOOKBACK_MS + 1);
    expect(expired.condition).toBe('clear');
    expect(expired.source).toBe(FALLBACK_SOURCE);
    expect(expired.effects).toEqual({ cozyBoost: 0, sunPatchAllowed: true, startleEvents: [] });

    // Future rows only (t before h12) -> never look forward, return fallback.
    const beforeAll = weatherAt(sampleRows, h12 - 1);
    expect(beforeAll.condition).toBe('clear');
    expect(beforeAll.source).toBe(FALLBACK_SOURCE);
  });
});

describe('weatherEffects and sunPatchAllowed rules', () => {
  it('disallows sunPatch when cloud_pct >= 70 or on any precipitation', () => {
    expect(weatherEffects({ condition: 'clear', cloud_pct: 0, precip_mm: 0 }).sunPatchAllowed).toBe(true);
    expect(weatherEffects({ condition: 'cloudy', cloud_pct: 69, precip_mm: 0 }).sunPatchAllowed).toBe(true);
    expect(weatherEffects({ condition: 'cloudy', cloud_pct: 70, precip_mm: 0 }).sunPatchAllowed).toBe(false);
    expect(weatherEffects({ condition: 'overcast', cloud_pct: 95, precip_mm: 0 }).sunPatchAllowed).toBe(false);
    expect(weatherEffects({ condition: 'clear', cloud_pct: 15, precip_mm: 0.1 }).sunPatchAllowed).toBe(false);
    expect(weatherEffects({ condition: 'drizzle', cloud_pct: 40, precip_mm: 0 }).sunPatchAllowed).toBe(false);
    expect(weatherEffects({ condition: 'rain', cloud_pct: 50, precip_mm: 0 }).sunPatchAllowed).toBe(false);
    expect(weatherEffects({ condition: 'snow', cloud_pct: 50, precip_mm: 0 }).sunPatchAllowed).toBe(false);
    expect(weatherEffects({ condition: 'thunder', cloud_pct: 50, precip_mm: 0 }).sunPatchAllowed).toBe(false);
  });

  it('raises cozyBoost in [0, 1] for rain, snow, and thunder while keeping clear dry weather at 0', () => {
    const clear = weatherEffects({ condition: 'clear', cloud_pct: 10, precip_mm: 0 });
    const rain = weatherEffects({ condition: 'rain', cloud_pct: 90, precip_mm: 3 });
    const snow = weatherEffects({ condition: 'snow', cloud_pct: 90, precip_mm: 2 });
    const thunder = weatherEffects({ condition: 'thunder', cloud_pct: 98, precip_mm: 6 });

    expect(clear.cozyBoost).toBe(0);
    expect(rain.cozyBoost).toBeGreaterThan(0.5);
    expect(snow.cozyBoost).toBeGreaterThan(0.6);
    expect(thunder.cozyBoost).toBeGreaterThan(0.8);
    expect(thunder.cozyBoost).toBeLessThanOrEqual(1);
  });
});

describe('determinism of thunder times, weatherVisual, rainDrops, and snowFlakes', () => {
  it('produces 0..2 deterministic thunder startleEvents per thunder hour, matching client visual flashes', () => {
    const baseHour = Date.UTC(2026, 10, 2, 0, 0, 0, 0);
    const countsSeen = new Set<number>();

    for (let k = 0; k < 64; k += 1) {
      const hourUtc = baseHour + k * HOUR_MS;
      const evA = thunderStartleEvents(hourUtc);
      const evB = thunderStartleEvents(hourUtc);
      const evClient = clientThunderEvents(hourUtc);

      expect(evA).toEqual(evB);
      expect(evA).toEqual(evClient);
      expect(evA.length).toBeGreaterThanOrEqual(0);
      expect(evA.length).toBeLessThanOrEqual(2);
      countsSeen.add(evA.length);

      for (let i = 0; i < evA.length; i += 1) {
        expect(evA[i].kind).toBe('thunder');
        expect(evA[i].at_ms).toBeGreaterThanOrEqual(hourUtc);
        expect(evA[i].at_ms).toBeLessThan(hourUtc + HOUR_MS);
        if (i > 0) expect(evA[i].at_ms).toBeGreaterThan(evA[i - 1].at_ms);

        const thunderRow: WeatherHour = {
          hour_utc: hourUtc,
          condition: 'thunder',
          temp_c: 10,
          cloud_pct: 99,
          precip_mm: 7,
          wind_kph: 34,
          is_day: 0,
        };
        const atFlash = weatherVisual(thunderRow, evA[i].at_ms);
        const beforeFlash = weatherVisual(thunderRow, evA[i].at_ms - 5_000);
        expect(atFlash.flash).toBe(1);
        expect(beforeFlash.flash).toBe(0);
        expect(atFlash.sky).toBe('night');
        expect(atFlash.rain).toBeGreaterThan(0);
      }
    }

    // All of 0, 1, and 2 events per hour occur deterministically.
    expect([...countsSeen].sort()).toEqual([0, 1, 2]);
  });

  it('computes deterministic rainDrops and snowFlakes strictly inside the window rectangle', () => {
    const rect = { x: 210, y: 18, w: 32, h: 22 };
    const rainRow = expectedRows.find((r) => r.condition === 'rain')!;
    const snowRow = expectedRows.find((r) => r.condition === 'snow')!;
    const clearRow = expectedRows.find((r) => r.condition === 'clear')!;

    const t = rainRow.hour_utc + 12_345;
    const dropsBrowserA = rainDrops(rainRow, t, rect, 18);
    const dropsBrowserB = rainDrops(rainRow, t, rect, 18);
    expect(dropsBrowserA).toEqual(dropsBrowserB);
    expect(dropsBrowserA).toHaveLength(18);
    // Prefix invariance: particle position depends on (t, index) only, independent of total n.
    expect(rainDrops(rainRow, t, rect, 24).slice(0, 18)).toEqual(dropsBrowserA);
    expect(rainDrops(rainRow, t + 100, rect, 18)).not.toEqual(dropsBrowserA);

    const tSnow = snowRow.hour_utc + 54_321;
    const flakesBrowserA = snowFlakes(snowRow, tSnow, { x: 210, y: 18, width: 32, height: 22 }, 14);
    const flakesBrowserB = snowFlakes(snowRow, tSnow, rect, 14);
    expect(flakesBrowserA).toEqual(flakesBrowserB);
    expect(flakesBrowserA).toHaveLength(14);
    expect(snowFlakes(snowRow, tSnow + 250, rect, 14)).not.toEqual(flakesBrowserA);

    // Clear weather produces no drops or snowflakes; snow produces no rainDrops; rain produces no snowFlakes.
    expect(rainDrops(clearRow, t, rect, 12)).toEqual([]);
    expect(snowFlakes(clearRow, t, rect, 12)).toEqual([]);
    expect(rainDrops(snowRow, tSnow, rect, 12)).toEqual([]);
    expect(snowFlakes(rainRow, t, rect, 12)).toEqual([]);

    for (let step = 0; step < 50; step += 1) {
      const ts = t + step * 37;
      for (const d of rainDrops(rainRow, ts, rect, 25)) {
        expect(d.x).toBeGreaterThanOrEqual(rect.x);
        expect(d.x).toBeLessThanOrEqual(rect.x + rect.w);
        expect(d.y).toBeGreaterThanOrEqual(rect.y);
        expect(d.y).toBeLessThanOrEqual(rect.y + rect.h);
      }
      for (const f of snowFlakes(snowRow, ts, rect, 25)) {
        expect(f.x).toBeGreaterThanOrEqual(rect.x);
        expect(f.x).toBeLessThanOrEqual(rect.x + rect.w);
        expect(f.y).toBeGreaterThanOrEqual(rect.y);
        expect(f.y).toBeLessThanOrEqual(rect.y + rect.h);
      }
    }
  });

  it('keeps all weatherVisual outputs in valid ranges across every fixture row', () => {
    for (const row of expectedRows) {
      const v = weatherVisual(row, row.hour_utc + 900_000);
      expect(['day', 'night']).toContain(v.sky);
      expect(v.cloud).toBeGreaterThanOrEqual(0);
      expect(v.cloud).toBeLessThanOrEqual(1);
      expect(v.rain).toBeGreaterThanOrEqual(0);
      expect(v.rain).toBeLessThanOrEqual(1);
      expect(v.snow).toBeGreaterThanOrEqual(0);
      expect(v.snow).toBeLessThanOrEqual(1);
      expect(v.fog).toBeGreaterThanOrEqual(0);
      expect(v.fog).toBeLessThanOrEqual(1);
      expect(v.flash).toBeGreaterThanOrEqual(0);
      expect(v.flash).toBeLessThanOrEqual(1);
      expect(v.tint).toHaveLength(4);
      for (let c = 0; c < 3; c += 1) {
        expect(v.tint[c]).toBeGreaterThanOrEqual(0);
        expect(v.tint[c]).toBeLessThanOrEqual(255);
      }
      expect(v.tint[3]).toBeGreaterThanOrEqual(0);
      expect(v.tint[3]).toBeLessThanOrEqual(1);
    }
  });

  it('keeps cam-weather.js pure with no Date, Math.random, or DOM globals', () => {
    const src = readFileSync(camWeatherJsUrl, 'utf8');
    expect(src).not.toMatch(/\bDate\b/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\b(?:document|window|navigator)\b/);
  });
});
