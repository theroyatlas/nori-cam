import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createSceneStaticCache,
  decorRects,
  decorTouchesFloorCell,
  drawSceneDynamic,
  drawClockHands,
  lampGlowCentres,
  nightAmbientRect,
  nightGlowWarmth,
  windowRect,
  LOGICAL_W,
  LOGICAL_H,
  drawWindowDressing,
  PAL,
  WINDOW,
} from '../public/cam-scene.js';
import { project } from '../public/cam-shared.js';
import { drawProp } from '../public/cam-props.js';
import { windowView } from '../public/cam-window.js';

// Recording ctx: captures paint ops with their geometry so tests can
// assert coverage and determinism without a DOM canvas.
function mockCtx() {
  const ops: string[] = [];
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  const gradients: { x: number; y: number; r: number; stops: [number, string][] }[] = [];
  const ctx: any = {
    ops, fills, gradients,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, imageSmoothingEnabled: true,
    createRadialGradient(x: number, y: number, _r0: number, _x1: number, _y1: number, r: number) {
      const g = { x, y, r, stops: [] as [number, string][] };
      gradients.push(g);
      return { addColorStop(n: number, c: string) { g.stops.push([n, c]); } };
    },
    createLinearGradient() { return { addColorStop() {} }; },
    beginPath() { ops.push('path'); },
    moveTo(x: number, y: number) { ops.push(`moveTo:${x},${y}`); },
    lineTo(x: number, y: number) { ops.push(`lineTo:${x},${y}`); },
    closePath() { ops.push('close'); },
    arc(x: number, y: number, r: number) { ops.push(`arc:${x},${y},${r}`); },
    fill() { ops.push(`fill:${ctx.fillStyle}`); },
    stroke() { ops.push('stroke'); },
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push(`fillRect:${ctx.fillStyle}:${x},${y},${w},${h}`);
      fills.push({ style: String(ctx.fillStyle), x, y, w, h });
    },
    strokeRect() { ops.push('strokeRect'); },
    drawImage() { ops.push('drawImage'); },
    save() { ops.push('save'); }, restore() { ops.push('restore'); },
    clearRect() { ops.push('clear'); },
    clip() { ops.push('clip'); },
    ellipse(x: number, y: number, rx: number, ry: number) { ops.push(`ellipse:${x},${y},${rx},${ry}`); },
  };
  return ctx;
}
function mockCanvas(w: number, h: number) {
  const g = mockCtx();
  return { width: w, height: h, getContext: () => g, _ctx: g };
}
const paneFor = () => {
  const wpt = (x: number, h: number) => { const p = project(x, 0); return [p.sx, p.sy - h] as [number, number]; };
  const quad = [wpt(5.2, 12), wpt(9.2, 12), wpt(9.2, 38), wpt(5.2, 38)];
  return { quad, rect: windowRect(project), wpt };
};
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('purity: deterministic drawing sources', () => {
  it('no wall-clock, RNG or perf timers in cam-scene.js and cam-props.js', () => {
    for (const f of ['cam-scene.js', 'cam-props.js']) {
      const src = readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/\bDate\b/);
      expect(src, f).not.toMatch(/Math\.random/);
      expect(src, f).not.toMatch(/performance\.now/);
    }
  });
});

describe('same t gives identical pixels', () => {
  it('dynamic layer op stream is identical for the same t', () => {
    const rect = windowRect(project);
    const row = { condition: 'clear', is_day: 0 as const, hour_utc: 0, cloud_pct: 5, precip_mm: 0 };
    const view = windowView(row, 90_000, rect) as any;
    const run = () => {
      const ctx = mockCtx();
      drawSceneDynamic(ctx, { project, gridW: 10, gridH: 8, view, pane: paneFor() as any, t: 90_000, wallH: 44, roomOff: { x: -16, y: 22 } });
      return ctx.ops.join('|');
    };
    expect(run()).toBe(run());
  });
  it('static shell op stream is identical across rebuilds', () => {
    const build = () => {
      const cache = createSceneStaticCache({ logicalW: 320, logicalH: 240, wallH: 44, project, createCanvas: (w, h) => mockCanvas(w, h) as any });
      const c: any = cache.ensure(10, 8, { x: -16, y: 22 }, false, paneFor());
      return c._ctx.ops.join('|');
    };
    const a = build(); const b = build();
    expect(a.length).toBeGreaterThan(100);
    expect(a).toBe(b);
  });
  it('clock hands are a pure function of t (UTC)', () => {
    const a = mockCtx(); const b = mockCtx();
    drawClockHands(a, 100, 50, 3_600_000 + 45 * 60_000);
    drawClockHands(b, 100, 50, 3_600_000 + 45 * 60_000);
    expect(a.ops).toEqual(b.ops);
    const c = mockCtx();
    drawClockHands(c, 100, 50, 3_600_000 + 46 * 60_000);
    expect(c.ops).not.toEqual(a.ops);
  });
});

describe('decor placement', () => {
  it('decor never overlaps floor cells, the drawing-wall spot or the window', () => {
    for (let x = 0; x < 10; x += 1) for (let y = 0; y < 8; y += 1) {
      expect(decorTouchesFloorCell(x, y)).toBe(false);
    }
    const rects = decorRects(project);
    const win = windowRect(project);
    const winQuad = paneFor().quad;
    const pointInQuad = (x: number, y: number) => {
      // Same-side test for the convex window quad.
      let sign = 0;
      for (let i = 0; i < 4; i += 1) {
        const [ax, ay] = winQuad[i]; const [bx, by] = winQuad[(i + 1) % 4];
        const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (cross !== 0) { if (sign === 0) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false; }
      }
      return true;
    };
    const hitsWindow = (r: { x: number; y: number; w: number; h: number }) => {
      const corners: [number, number][] = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
      if (corners.some(([x, y]) => pointInQuad(x, y))) return true;
      return winQuad.some(([x, y]) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    };
    void win;
    // Drawing-wall papers hang around grid (0,2) on the left wall.
    const dw = project(0, 2);
    const drawingSpot = { x: dw.sx - 2, y: dw.sy - 30, w: 24, h: 30 };
    for (const r of rects) {
      expect(hitsWindow(r), `${r.id} vs window`).toBe(false);
      expect(overlaps(r, drawingSpot), `${r.id} vs drawing wall`).toBe(false);
      // Bottom edge stays on the wall, above the floor line at its centre.
      const cx = r.x + r.w / 2;
      const floorY = r.wall === 'back'
        ? project(0, 0).sy + (cx - project(0, 0).sx) * 0.5
        : project(0, 0).sy + (project(0, 0).sx - cx) * 0.5;
      expect(r.y + r.h, `${r.id} above floor`).toBeLessThanOrEqual(floorY + 1);
    }
  });
});

describe('window sill follows wall slope (B9)', () => {
  it('sill corners follow wpt() and form a 3 px thick parallelogram along wall slope', () => {
    const ctx = mockCtx();
    const pane = paneFor();
    drawWindowDressing(ctx, pane as any, project);
    const s0 = pane.wpt(WINDOW.x0 - 0.2, WINDOW.hBot - 1);
    const s1 = pane.wpt(WINDOW.x1 + 0.2, WINDOW.hBot - 1);
    const b1 = pane.wpt(WINDOW.x1 + 0.2, WINDOW.hBot - 4);
    const b0 = pane.wpt(WINDOW.x0 - 0.2, WINDOW.hBot - 4);
    expect(ctx.ops).toContain(`moveTo:${s0[0]},${s0[1]}`);
    expect(ctx.ops).toContain(`lineTo:${s1[0]},${s1[1]}`);
    expect(ctx.ops).toContain(`lineTo:${b1[0]},${b1[1]}`);
    expect(ctx.ops).toContain(`lineTo:${b0[0]},${b0[1]}`);
    expect(ctx.ops).toContain(`fill:${PAL.shelfWood}`);
    expect(ctx.ops).toContain('stroke');
    // Sill thickness is exactly 3 px vertically along both window ends
    expect(b0[1] - s0[1]).toBe(3);
    expect(b1[1] - s1[1]).toBe(3);
    // Sill top edge slope matches the back wall isometric slope (0.5)
    expect((s1[1] - s0[1]) / (s1[0] - s0[0])).toBe(0.5);
    // Sill top sits at hBot - 1, strictly below curtain bottoms (which hang to hBot + 2)
    for (let side = 0; side < 2; side += 1) {
      const gx = side === 0 ? WINDOW.x0 - 0.15 : WINDOW.x1 - 0.55;
      for (let f = 0; f < 3; f += 1) {
        const curtainBot = pane.wpt(gx + f * 0.22, WINDOW.hBot + 2);
        const sillTopAtCurtain = pane.wpt(gx + f * 0.22, WINDOW.hBot - 1);
        expect(curtainBot[1]).toBeLessThan(sillTopAtCurtain[1]);
      }
    }
  });
});

describe('static layer cache', () => {
  it('builds once across 100 frames for the same grid', () => {
    const cache = createSceneStaticCache({ logicalW: 320, logicalH: 240, wallH: 44, project, createCanvas: (w, h) => mockCanvas(w, h) as any });
    const off = { x: -16, y: 22 };
    for (let i = 0; i < 100; i += 1) cache.ensure(10, 8, off, false, paneFor());
    expect(cache.buildCount).toBe(1);
    cache.ensure(10, 9, off, false, paneFor());
    expect(cache.buildCount).toBe(2);
  });
});

describe('prop draw paths', () => {
  it('cushion is a round floor cushion and toy is a yarn ball', () => {
    const cushion = mockCtx();
    drawProp(cushion, { id: 'c', kind: 'cushion', x: 3, y: 4, z: 0 } as any, { t: 0 });
    expect(cushion.ops.some((o: string) => o.startsWith('ellipse:'))).toBe(true);
    const cushionFlat = mockCtx();
    drawProp(cushionFlat, { id: 'c', kind: 'cushion', x: 3, y: 4, z: 0 } as any, { t: 0 });
    expect(cushion.ops.join('|')).toBe(cushionFlat.ops.join('|'));
    const toy = mockCtx();
    drawProp(toy, { id: 't', kind: 'toy', x: 4, y: 4, z: 0 } as any, { t: 0 });
    expect(toy.ops.some((o: string) => o.startsWith('arc:'))).toBe(true);
    expect(toy.ops.join('|')).not.toBe(cushion.ops.join('|'));
  });
});

describe('night light', () => {
  it('ambient covers all four canvas corners', () => {
    const roomOff = { x: -16, y: 22 };
    const r = nightAmbientRect(roomOff);
    // The dynamic layer runs under the room translation, so add roomOff
    // back to land in screen space.
    const screen = { x: r.x + roomOff.x, y: r.y + roomOff.y, w: r.w, h: r.h };
    expect(screen.x).toBeLessThanOrEqual(0);
    expect(screen.y).toBeLessThanOrEqual(0);
    expect(screen.x + screen.w).toBeGreaterThanOrEqual(LOGICAL_W);
    expect(screen.y + screen.h).toBeGreaterThanOrEqual(LOGICAL_H);
    // And the painter really emits that full-canvas fill at night.
    const rect = windowRect(project);
    const row = { condition: 'clear', is_day: 0 as const, hour_utc: 0, cloud_pct: 5, precip_mm: 0 };
    const view = windowView(row, 30_000, rect) as any;
    const ctx = mockCtx();
    drawSceneDynamic(ctx, { project, gridW: 10, gridH: 8, view, pane: paneFor() as any, t: 30_000, wallH: 44, roomOff });
    const ambient = ctx.fills.find((f: any) => f.w >= LOGICAL_W && f.h >= LOGICAL_H);
    expect(ambient).toBeTruthy();
  });
  it('pixels near the lamp are warmer than the room average', () => {
    const rect = windowRect(project);
    const nightRow = { condition: 'clear', is_day: 0 as const, hour_utc: 0, cloud_pct: 5, precip_mm: 0 };
    const dayRow = { condition: 'clear', is_day: 1 as const, hour_utc: 12 * 3_600_000, cloud_pct: 5, precip_mm: 0 };
    const night = windowView(nightRow, 30_000, rect) as any;
    const day = windowView(dayRow, dayRow.hour_utc + 30_000, rect) as any;
    expect(nightGlowWarmth(night)).toBeGreaterThan(nightGlowWarmth(day));
    const centres = lampGlowCentres(project, paneFor() as any);
    const lamp = centres.find((c) => c.id === 'desk_lamp');
    expect(lamp).toBeTruthy();
    const desk = project(8, 1);
    expect(Math.abs((lamp as any).x - desk.sx)).toBeLessThan(20);
    const ctx = mockCtx();
    drawSceneDynamic(ctx, { project, gridW: 10, gridH: 8, view: night, pane: paneFor() as any, t: 30_000, wallH: 44, roomOff: { x: -16, y: 22 } });
    // Warm glow: a radial gradient whose core is a high-red amber.
    const warm = ctx.gradients.filter((g: any) => g.stops.some(([, c]: [number, string]) => {
      const m = /rgba?\((\d+),(\d+),(\d+)/.exec(c);
      return m && Number(m[1]) > 200 && Number(m[2]) > 120 && Number(m[3]) < 180;
    }));
    expect(warm.length).toBeGreaterThanOrEqual(2);
    const nearLamp = warm.some((g: any) => Math.hypot(g.x - (lamp as any).x, g.y - (lamp as any).y) < 4);
    expect(nearLamp).toBe(true);
  });
});

describe('dynamic frame budget (mock canvas)', () => {
  it('median and p95 under 4 ms over 300 dynamic frames', () => {
    const rect = windowRect(project);
    const row = { condition: 'clear', is_day: 1 as const, hour_utc: 12 * 3_600_000, cloud_pct: 5, precip_mm: 0 };
    const view = windowView(row, row.hour_utc, rect) as any;
    const timings: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const ctx = mockCtx();
      const t0 = performance.now();
      drawSceneDynamic(ctx, { project, gridW: 10, gridH: 8, view, pane: paneFor() as any, t: i * 37, wallH: 44, roomOff: { x: -16, y: 22 } });
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    console.log(`CAM_SCENE_FRAME_MEDIAN_MS=${timings[149].toFixed(4)} P95_MS=${timings[284].toFixed(4)}`);
    expect(timings[149]).toBeLessThan(4);
    expect(timings[284]).toBeLessThan(4);
  });
});

// Exercise Chrome's real Canvas2D rasterizer, including screen compositing.
// Kept separate from the recording context: paint ops cannot prove pixel light.
describe('B6b real Canvas2D pixels', () => {
  let pixels: any;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nori-b6b-pixels-'));
    const scene = new URL('../public/cam-scene.js', import.meta.url).href;
    const shared = new URL('../public/cam-shared.js', import.meta.url).href;
    const props = new URL('../public/cam-props.js', import.meta.url).href;
    const win = new URL('../public/cam-window.js', import.meta.url).href;
    const html = `<!doctype html><pre id="result">pending</pre><script type="module">
      import {drawPlankFloor, drawSceneDynamic, drawForegroundPlant, createSceneStaticCache, windowRect} from '${scene}';
      import {project} from '${shared}';
      import {drawProp} from '${props}';
      import {windowView} from '${win}';
      try {
        const canvas = () => Object.assign(document.createElement('canvas'), {width:320,height:240});
        const floor = canvas(), fg = floor.getContext('2d');
        drawPlankFloor(fg, project, 10, 8, false);
        const floorData = fg.getImageData(0,0,320,240).data;
        const lum = (data,x,y) => {const i=(Math.round(y)*320+Math.round(x))*4;return .2126*data[i]+.7152*data[i+1]+.0722*data[i+2];};
        // Sample across several integer cell edges. A grid seam would make
        // the on-edge sample distinctly darker than BOTH neighbours.
        const edges = [[2,2.51],[4,3.51],[6,4.51],[5.51,2],[3.51,4],[7.51,6]];
        const seamDips = edges.map(([x,y],i) => {
          const p=project(x,y), a=project(x+(i<3?-.08:0),y+(i<3?0:-.08)), b=project(x+(i<3?.08:0),y+(i<3?0:.08));
          return Math.min(lum(floorData,a.sx,a.sy),lum(floorData,b.sx,b.sy))-lum(floorData,p.sx,p.sy);
        });
        const plant = canvas();drawForegroundPlant(plant.getContext('2d'),project,8);
        const plantPixels=Array.from(plant.getContext('2d').getImageData(0,0,320,240).data).filter((v,i)=>i%4===3&&v>0).length;
        const off={x:-16,y:22};
        const pane={rect:windowRect(project),quad:[],wpt:(x,h)=>{const p=project(x,0);return [p.sx,p.sy-h];}};
        const view=windowView({condition:'clear',is_day:0,hour_utc:0,cloud_pct:5,precip_mm:0},90000,pane.rect);
        const render=(v=view,t=90000)=>{
          const c=canvas(),g=c.getContext('2d');
          const cache=createSceneStaticCache({project,wallH:44,logicalW:320,logicalH:240,createCanvas:()=>canvas()});
          g.drawImage(cache.ensure(10,8,off,false,null),0,0);
          g.translate(off.x,off.y);
          drawProp(g,{id:'desk',kind:'computer_desk',x:8,y:1,z:0},{t});
          drawProp(g,{id:'bed',kind:'bed',x:8,y:6,z:0},{t});
          drawSceneDynamic(g,{project,gridW:10,gridH:8,view:v,pane,t,wallH:44,roomOff:off});
          return g.getImageData(0,0,320,240).data;
        };
        const a=render(),b=render();
        let pool=0, np=0, room=0, nr=0;
        const centre=project(7.7,2.3);
        for(let x=.5;x<9.6;x+=.15) for(let y=.5;y<7.6;y+=.15){
          const p=project(x,y), l=lum(a,p.sx+off.x,p.sy+off.y);
          room+=l;nr++;
          if(Math.hypot(p.sx-centre.sx,p.sy-centre.sy)<10){pool+=l;np++;}
        }
        const timings=[];
        const perfCanvas=canvas(),g=perfCanvas.getContext('2d');
        for(let i=0;i<320;i++){
          const start=performance.now();
          drawSceneDynamic(g,{project,gridW:10,gridH:8,view,pane,t:i*37,wallH:44,roomOff:off});
          if(i>=20)timings.push(performance.now()-start);
        }
        timings.sort((a,b)=>a-b);
        const cloudy=render({...view,stars:[]});
        document.querySelector('#result').textContent=JSON.stringify({seamDips,plantPixels,ratio:(pool/np)/(room/nr),poolMean:pool/np,floorMean:room/nr,identical:a.every((v,i)=>v===b[i]),moonChangesPixels:a.some((v,i)=>v!==cloudy[i]),medianMs:timings[149],p95Ms:timings[284]});
      }catch(e){document.querySelector('#result').textContent=JSON.stringify({error:String(e)});}
    </script>`;
    const file = join(dir, 'pixels.html');
    writeFileSync(file, html);
    const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const run = spawnSync(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--allow-file-access-from-files', '--user-data-dir='+join(dir,'profile'),
      '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href], {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
    expect(run.error, 'headless Chrome must run the pixel harness').toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const match=run.stdout.match(/<pre id="result">(.*?)<\/pre>/s);
    expect(match, run.stdout).toBeTruthy();
    pixels=JSON.parse(match![1]);
    expect(pixels.error).toBeUndefined();
    console.log('CAM_B6B_PIXELS='+JSON.stringify(pixels));
  }, 40000);
  it('integer floor edges have no dark cell-border seam pixels',()=>{
    for(const dip of pixels.seamDips) expect(dip).toBeLessThan(10);
  });
  it('night desk-lamp floor pool is at least 1.8x room-floor mean luminance',()=>{
    expect(pixels.ratio).toBeGreaterThanOrEqual(1.8);
  });
  it('foreground plant is absent rather than floating outside the slab',()=>expect(pixels.plantPixels).toBe(0));
  it('same t produces byte-identical pixels',()=>expect(pixels.identical).toBe(true));
  it('clear-sky moonlight is gated by the window view stars',()=>expect(pixels.moonChangesPixels).toBe(true));
  it('real night Canvas2D lighting median and p95 stay below 4 ms',()=>{
    expect(pixels.medianMs).toBeLessThan(4);expect(pixels.p95Ms).toBeLessThan(4);
  });
});
