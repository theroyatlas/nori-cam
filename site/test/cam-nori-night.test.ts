import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyNightSpriteLight, nightSpriteLight, windowRect } from '../public/cam-scene.js';
import { project } from '../public/cam-shared.js';
import { selectWeatherRow, windowView } from '../public/cam-window.js';

// Nori's lighting at night (B7 follow-up). The day path draws her sprite
// untouched; the night path lights only her own pixels.
const NIGHT = { sky: 'night', flash: 0 };
const pane = { rect: windowRect(project) };
// Floor point more than 48 px from every lamp (the sconce is nearest, 62 px).
const FAR = project(2.5, 6.5);
// Foot point 29 px from the desk lamp centre.
const DESK = project(7.7, 2.3);

describe('night light: gate and shape (pure)', () => {
  it('applies only to night views', () => {
    for (const view of [null, { sky: 'day', flash: 0 }, { sky: 'dusk', flash: 0 }]) {
      expect(nightSpriteLight(view, project, pane, DESK.sx, DESK.sy)).toBeNull();
    }
    expect(nightSpriteLight(NIGHT, project, pane, DESK.sx, DESK.sy)).not.toBeNull();
  });

  it('day and rain rows get no night light; night rain does', () => {
    const rows = JSON.parse(readFileSync(new URL('../public/cam/fixture/weather-rows.json', import.meta.url), 'utf8'));
    const rect = windowRect(project);
    const dayRow = selectWeatherRow(rows, null, false);
    const dayRain = selectWeatherRow(rows, 'rain', false);
    const nightRain = selectWeatherRow(rows, 'rain', true);
    expect(nightSpriteLight(windowView(dayRow, 30_000, rect) as any, project, pane, DESK.sx, DESK.sy)).toBeNull();
    expect(nightSpriteLight(windowView(dayRain, 30_000, rect) as any, project, pane, DESK.sx, DESK.sy)).toBeNull();
    expect(nightSpriteLight(windowView(nightRain, 30_000, rect) as any, project, pane, DESK.sx, DESK.sy)).not.toBeNull();
  });

  it('far from every lamp the gain is exactly 1 and there is no flash', () => {
    const light = nightSpriteLight(NIGHT, project, pane, FAR.sx, FAR.sy)!;
    expect(light.gain).toEqual([1, 1, 1]);
    expect(light.flash).toBeNull();
  });

  it('lift is warm and never exceeds the cap anywhere in the room', () => {
    const near = nightSpriteLight(NIGHT, project, pane, DESK.sx, DESK.sy)!;
    expect(near.gain[0]).toBeGreaterThan(1);
    expect(near.gain[0]).toBeGreaterThan(near.gain[1]);
    expect(near.gain[1]).toBeGreaterThan(near.gain[2]);
    for (let x = 0; x <= 10; x += 0.5) {
      for (let y = 0; y <= 8; y += 0.5) {
        const p = project(x, y);
        const { gain } = nightSpriteLight(NIGHT, project, pane, p.sx, p.sy)!;
        for (const g of gain) {
          expect(g).toBeGreaterThanOrEqual(1);
          expect(g).toBeLessThanOrEqual(1.24 + 1e-9);
        }
        expect(gain[0]).toBeGreaterThanOrEqual(gain[1] - 1e-9);
        expect(gain[1]).toBeGreaterThanOrEqual(gain[2] - 1e-9);
      }
    }
  });

  it('applies the room ambient exactly, keeps alpha, and skips transparent pixels', () => {
    const light = nightSpriteLight(NIGHT, project, pane, FAR.sx, FAR.sy)!;
    const data = new Uint8ClampedArray([200, 100, 50, 255, 9, 9, 9, 0]);
    applyNightSpriteLight(data, light);
    // Room fill: out = src * (1 - 0.64) + rgb(22,18,55) * 0.64.
    expect(Array.from(data.slice(0, 4))).toEqual([
      Math.round(200 * 0.36 + 22 * 0.64), Math.round(100 * 0.36 + 18 * 0.64), Math.round(50 * 0.36 + 55 * 0.64), 255,
    ]);
    expect(Array.from(data.slice(4))).toEqual([9, 9, 9, 0]);
  });

  it('a flash wash brightens toward its colour and still never writes alpha', () => {
    const plain = nightSpriteLight(NIGHT, project, pane, DESK.sx, DESK.sy)!;
    const flashed = nightSpriteLight({ sky: 'night', flash: 0.3 }, project, pane, DESK.sx, DESK.sy, 0.3)!;
    expect(flashed.flash).toEqual({ rgb: [240, 246, 255], a: 0.3 });
    const a = applyNightSpriteLight(new Uint8ClampedArray([120, 90, 80, 255]), plain);
    const b = applyNightSpriteLight(new Uint8ClampedArray([120, 90, 80, 255]), flashed);
    expect(b[0] + b[1] + b[2]).toBeGreaterThan(a[0] + a[1] + a[2]);
    expect(b[3]).toBe(255);
  });

  it('is deterministic for the same inputs', () => {
    const run = () => Array.from(applyNightSpriteLight(
      new Uint8ClampedArray([200, 160, 140, 255, 30, 20, 25, 255]),
      nightSpriteLight(NIGHT, project, pane, DESK.sx, DESK.sy)!,
    ));
    expect(run()).toEqual(run());
  });
});

// Real Canvas2D pixels on Nori's own sprite, through the same functions cam.js
// calls. Headless Chrome, same harness pattern as cam-scene.test.ts (B6b).
describe('night light on Nori\'s sprite pixels (headless Chrome)', () => {
  let result: any;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nori-night-sprite-'));
    const sprite = (name: string) => `data:image/png;base64,${readFileSync(new URL(`../public/cam/sprites/${name}.png`, import.meta.url)).toString('base64')}`;
    const scene = new URL('../public/cam-scene.js', import.meta.url).href;
    const shared = new URL('../public/cam-shared.js', import.meta.url).href;
    const html = `<!doctype html><pre id="result">pending</pre><script type="module">
      import {applyNightSpriteLight, nightSpriteLight, windowRect} from '${scene}';
      import {project} from '${shared}';
      const sprites = {sit: '${sprite('sit')}', walk: '${sprite('walk')}'};
      const NIGHT = {sky:'night', flash:0};
      const pane = {rect: windowRect(project)};
      const FAR = project(2.5, 6.5), DESK = project(7.7, 2.3);
      const lum = (d, i) => .2126*d[i] + .7152*d[i+1] + .0722*d[i+2];
      const mean = (d) => { let s = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 0) { s += lum(d, i); n++; } return s / n; };
      const load = (src) => new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('sprite load')); im.src = src; });
      try {
        const out = {};
        for (const [name, src] of Object.entries(sprites)) {
          const im = await load(src);
          const w = im.naturalWidth, h = im.naturalHeight;
          const c = Object.assign(document.createElement('canvas'), {width: w, height: h});
          const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(im, 0, 0);
          const raw = g.getImageData(0, 0, w, h).data;
          const litAt = (p) => { const copy = new Uint8ClampedArray(raw); applyNightSpriteLight(copy, nightSpriteLight(NIGHT, project, pane, p.sx, p.sy)); return copy; };
          const far = litAt(FAR), near = litAt(DESK);
          // Round-trip the lit copy through a real canvas before measuring.
          const rt = Object.assign(document.createElement('canvas'), {width: w, height: h});
          const rg = rt.getContext('2d'); rg.putImageData(new ImageData(far, w, h), 0, 0);
          const back = rg.getImageData(0, 0, w, h).data;
          let alphaChanged = 0, outsideChanged = 0, insideChanged = 0, inside = 0;
          for (let i = 0; i < raw.length; i += 4) {
            if (back[i+3] !== raw[i+3]) alphaChanged++;
            const rgbSame = far[i] === raw[i] && far[i+1] === raw[i+1] && far[i+2] === raw[i+2];
            if (raw[i+3] === 0) { if (!rgbSame) outsideChanged++; }
            else { inside++; if (!rgbSame) insideChanged++; }
          }
          const day = mean(raw);
          out[name] = {
            dayMean: day,
            farRatio: mean(far) / day,
            nearRatio: mean(near) / day,
            alphaChanged, outsideChanged, insideChanged, inside,
          };
        }
        document.querySelector('#result').textContent = JSON.stringify(out);
      } catch (e) { document.querySelector('#result').textContent = JSON.stringify({error: String(e && e.stack || e)}); }
    </script>`;
    const file = join(dir, 'night-sprite.html');
    writeFileSync(file, html);
    const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const run = spawnSync(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'),
      '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    expect(run.error, 'headless Chrome must run the sprite harness').toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const match = run.stdout.match(/<pre id="result">(.*?)<\/pre>/s);
    expect(match, run.stdout).toBeTruthy();
    result = JSON.parse(match![1]);
    expect(result.error).toBeUndefined();
    console.log('CAM_NORI_NIGHT_SPRITE=' + JSON.stringify(result));
  }, 40000);

  it.each(['sit', 'walk'])('%s: far from the lamps, night mean is 35%-75% of the day mean', (name) => {
    expect(result[name].farRatio).toBeGreaterThanOrEqual(0.35);
    expect(result[name].farRatio).toBeLessThanOrEqual(0.75);
  });

  it.each(['sit', 'walk'])('%s: near the desk lamp she is brighter than far from the lamps', (name) => {
    expect(result[name].nearRatio).toBeGreaterThan(result[name].farRatio);
  });

  it.each(['sit', 'walk'])('%s: nothing outside her silhouette changes, alpha is untouched', (name) => {
    expect(result[name].alphaChanged).toBe(0);
    expect(result[name].outsideChanged).toBe(0);
    expect(result[name].insideChanged).toBeGreaterThan(result[name].inside * 0.9);
  });
});
