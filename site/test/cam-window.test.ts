import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cloudClusters,
  glassDrops,
  parseWxParams,
  selectWeatherRow,
  skyPhase,
  sunPatchPlaceholder,
  windowView,
} from '../public/cam-window.js';
import { thunderStartleEvents } from '../public/cam-weather.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rows: any[] = JSON.parse(
  readFileSync(new URL('../sample/cam/weather-rows.json', import.meta.url), 'utf8'),
);
const rect = { x: 243.2, y: 51.6, w: 64, h: 58 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = (cond: string, night = false): any => selectWeatherRow(rows, cond, night)!;

describe('fixture copy', () => {
  it('public fixture is byte-identical to the sample', () => {
    const sample = readFileSync(new URL('../sample/cam/weather-rows.json', import.meta.url));
    const copy = readFileSync(new URL('../public/cam/fixture/weather-rows.json', import.meta.url));
    expect(copy.equals(sample)).toBe(true);
    expect(rows).toHaveLength(72);
  });
});

describe('?wx parsing', () => {
  it('parses valid conditions and night flag', () => {
    expect(parseWxParams('?wx=rain')).toEqual({ wx: 'rain', night: false });
    expect(parseWxParams('?wx=snow&night=1')).toEqual({ wx: 'snow', night: true });
    expect(parseWxParams('wx=thunder&night=1')).toEqual({ wx: 'thunder', night: true });
    expect(parseWxParams(new URLSearchParams('wx=fog'))).toEqual({ wx: 'fog', night: false });
  });
  it('rejects unknown conditions and defaults night off', () => {
    expect(parseWxParams('?wx=hail')).toEqual({ wx: null, night: false });
    expect(parseWxParams('')).toEqual({ wx: null, night: false });
    expect(parseWxParams('?night=yes')).toEqual({ wx: null, night: false });
    expect(parseWxParams(null)).toEqual({ wx: null, night: false });
  });
});

describe('selectWeatherRow', () => {
  it('defaults to the first clear day row', () => {
    const r = selectWeatherRow(rows, null, false)!;
    expect(r.condition).toBe('clear');
    expect(r.is_day).toBe(1);
    expect(r).toBe(rows.find((x: { condition: string; is_day: number }) => x.condition === 'clear' && x.is_day === 1));
  });
  it('picks the first row with the condition and is_day=1', () => {
    for (const cond of ['clear', 'cloudy', 'overcast', 'rain', 'thunder']) {
      const r = selectWeatherRow(rows, cond, false)!;
      expect(r.condition).toBe(cond);
      expect(r.is_day).toBe(1);
    }
  });
  it('with night=1 picks the first matching night row', () => {
    const r = selectWeatherRow(rows, 'clear', true)!;
    expect(r.condition).toBe('clear');
    expect(r.is_day).toBe(0);
    expect(r).toBe(rows[0]);
  });
  it('overrides is_day when no row matches the requested flag', () => {
    // Fog, drizzle and snow have no day rows in the fixture.
    for (const cond of ['fog', 'drizzle', 'snow']) {
      const r = selectWeatherRow(rows, cond, false)!;
      expect(r.condition).toBe(cond);
      expect(r.is_day).toBe(1);
      expect(rows).not.toContain(r);
    }
    const nightThunder = selectWeatherRow(rows, 'thunder', true)!;
    expect(nightThunder.is_day).toBe(0);
  });
  it('handles empty input', () => {
    expect(selectWeatherRow([], 'rain', false)).toBeNull();
    expect(selectWeatherRow(null, 'rain', false)).toBeNull();
  });
});

describe('windowView determinism', () => {
  it('same (t, wx) gives identical draw parameters', () => {
    for (const cond of ['clear', 'cloudy', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'thunder']) {
      const w = row(cond);
      const t = w.hour_utc + 30000;
      expect(windowView(w, t, rect)).toEqual(windowView(w, t, rect));
    }
  });
  it('changes with t (motion) and stays inside the pane', () => {
    const w = row('rain');
    const a = windowView(w, w.hour_utc + 30000, rect);
    const b = windowView(w, w.hour_utc + 30400, rect);
    expect(b.rainDrops).not.toEqual(a.rainDrops);
    expect(b.clouds).not.toEqual(a.clouds);
    for (const v of [a, b]) {
      for (const d of [...v.rainDrops, ...v.glassDrops]) {
        expect(d.x).toBeGreaterThanOrEqual(rect.x);
        expect(d.x).toBeLessThanOrEqual(rect.x + rect.w);
        expect(d.y).toBeGreaterThanOrEqual(rect.y);
        expect(d.y).toBeLessThanOrEqual(rect.y + rect.h);
      }
      for (const f of v.snowFlakes) {
        expect(f.x).toBeGreaterThanOrEqual(rect.x);
        expect(f.x).toBeLessThanOrEqual(rect.x + rect.w);
      }
      for (const c of v.clouds) {
        expect(c.x).toBeGreaterThanOrEqual(rect.x - c.w);
        expect(c.x).toBeLessThanOrEqual(rect.x + rect.w);
      }
    }
  });
  it('per-weather signatures', () => {
    const at = (cond: string, night = false) => {
      const w = row(cond, night);
      return windowView(w, w.hour_utc + 30000, rect);
    };
    expect(at('clear').rainDrops).toHaveLength(0);
    expect(at('clear').snowFlakes).toHaveLength(0);
    expect(at('clear').sky).not.toBe('night');
    expect(at('clear', true).sky).toBe('night');
    expect(at('clear', true).stars.length).toBeGreaterThan(0);
    expect(at('rain').rainDrops.length).toBeGreaterThan(0);
    expect(at('rain').glassDrops.length).toBeGreaterThan(0);
    expect(at('drizzle').rainDrops.length).toBeGreaterThan(0);
    expect(at('drizzle').rainDrops.length).toBeLessThan(at('rain').rainDrops.length);
    expect(at('snow').snowFlakes.length).toBeGreaterThan(0);
    expect(at('snow').rainDrops).toHaveLength(0);
    expect(at('fog').fogAlpha).toBeGreaterThan(0.3);
    expect(at('clear').fogAlpha).toBe(0);
    expect(at('overcast').cloud).toBeGreaterThanOrEqual(0.7);
    expect(at('overcast').clouds.length).toBeGreaterThan(at('clear').clouds.length);
  });
  it('thunder flash is synced to thunderStartleEvents', () => {
    const w = row('thunder');
    const events = thunderStartleEvents(w.hour_utc);
    expect(events.length).toBeGreaterThan(0);
    const atFlash = windowView(w, events[0].at_ms, rect);
    expect(atFlash.flash).toBe(1);
    expect(windowView(w, events[0].at_ms - 5000, rect).flash).toBe(0);
    expect(windowView(row('rain'), events[0].at_ms, rect).flash).toBe(0);
  });
  it('tint and sky stay in range for every fixture row', () => {
    for (const w of rows) {
      const v = windowView(w, w.hour_utc + 30000, rect);
      expect(['day', 'dusk', 'night']).toContain(v.sky);
      expect(v.tint[3]).toBeGreaterThanOrEqual(0);
      expect(v.tint[3]).toBeLessThanOrEqual(1);
      expect(v.flash).toBeGreaterThanOrEqual(0);
      expect(v.flash).toBeLessThanOrEqual(1);
    }
  });
});

describe('helpers', () => {
  it('skyPhase distinguishes day, dusk and night', () => {
    expect(skyPhase(row('clear'))).toBeDefined();
    expect(skyPhase(row('clear', true))).toBe('night');
    const midday = rows.find((r: { condition: string; is_day: number; hour_utc: number }) => {
      const h = Math.floor((r.hour_utc % 86400000) / 3600000);
      return r.is_day === 1 && h >= 9 && h <= 14;
    });
    if (midday) expect(skyPhase(midday)).toBe('day');
  });
  it('sunPatchPlaceholder only allows clear/cloudy dry days', () => {
    expect(sunPatchPlaceholder(0, row('clear')).allowed).toBe(true);
    expect(sunPatchPlaceholder(0, row('clear', true)).allowed).toBe(false);
    expect(sunPatchPlaceholder(0, row('rain')).allowed).toBe(false);
    expect(sunPatchPlaceholder(0, row('overcast')).allowed).toBe(false);
    expect(sunPatchPlaceholder(0, null).allowed).toBe(false);
    expect(sunPatchPlaceholder(0, row('clear'))).toEqual(sunPatchPlaceholder(0, row('clear')));
  });
  it('cloudClusters and glassDrops are deterministic and bounded', () => {
    expect(cloudClusters(0.9, 1000, rect)).toEqual(cloudClusters(0.9, 1000, rect));
    expect(cloudClusters(0, 1000, rect)).toHaveLength(0);
    const w = row('rain');
    expect(glassDrops(w, w.hour_utc + 5000, rect)).toEqual(glassDrops(w, w.hour_utc + 5000, rect));
    expect(glassDrops(row('clear'), 5000, rect)).toHaveLength(0);
  });
});

describe('purity', () => {
  it('cam-window.js has no Date, Math.random or DOM globals', () => {
    const src = readFileSync(new URL('../public/cam-window.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bDate\b/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\b(?:document|navigator|location|fetch)\s*[.(]/);
    expect(src).not.toMatch(/\bwindow\./);
  });
});
