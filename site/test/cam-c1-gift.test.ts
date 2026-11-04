import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  drawCarriedProp,
  giftSpriteImage,
  kindOf,
  isPropVisible,
} from '../public/cam-props.js';
import { drawPropContactShadows, PAL } from '../public/cam-scene.js';
import { depthKey } from '../public/cam-shared.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Call { name: string; args: unknown[] }
function recordCtx(): any {
  const calls: Call[] = [];
  const ctx: any = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: true,
    save() { calls.push({ name: 'save', args: [] }); },
    restore() { calls.push({ name: 'restore', args: [] }); },
    fillRect(...a: unknown[]) { calls.push({ name: 'fillRect', args: a }); },
    strokeRect(...a: unknown[]) { calls.push({ name: 'strokeRect', args: a }); },
    drawImage(...a: unknown[]) { calls.push({ name: 'drawImage', args: a }); },
    beginPath() { calls.push({ name: 'beginPath', args: [] }); },
    ellipse(...a: unknown[]) { calls.push({ name: 'ellipse', args: a }); },
    fill() { calls.push({ name: 'fill', args: [] }); },
  };
  return ctx;
}

// Image stub with per-instance dimensions; onload reads them like a browser.
const instances: any[] = [];
function stubImage() {
  instances.length = 0;
  vi.stubGlobal('Image', class {
    naturalWidth = 0;
    naturalHeight = 0;
    onload: any = null;
    onerror: any = null;
    src = '';
    constructor() { instances.push(this); }
  });
}
function ready(url: string, size: number) {
  const entry = giftSpriteImage(url)!;
  const img = instances[instances.length - 1];
  img.naturalWidth = size;
  img.naturalHeight = size;
  img.onload();
  return entry;
}

const project = (x: number, y: number, z = 0) => ({ sx: x, sy: y, x, y, z });

describe('C3 carried gift', () => {
  it('draws the parcel while loading and on error', () => {
    stubImage();
    const loading = { kind: 'household', sprite: '/media/gift-c1-loading.png', x: 1, y: 2, z: 0 };
    let c = recordCtx();
    drawCarriedProp(c, loading as any, 50, 60, {});
    expect(c.calls.some((k: Call) => k.name === 'drawImage')).toBe(false);
    expect(c.calls.some((k: Call) => k.name === 'fillRect')).toBe(true);
    expect(c.calls.some((k: Call) => k.name === 'strokeRect')).toBe(true);

    // Exactly today's parcel: same ops as a generic carried prop.
    const generic = recordCtx();
    drawCarriedProp(generic, { kind: 'toy', x: 1, y: 2, z: 0 } as any, 50, 60, {});
    expect(c.calls).toEqual(generic.calls);

    const failed = { kind: 'household', sprite: '/media/gift-c1-fail.png', x: 1, y: 2, z: 0 };
    giftSpriteImage(failed.sprite);
    instances[instances.length - 1].onerror();
    c = recordCtx();
    drawCarriedProp(c, failed as any, 50, 60, {});
    expect(c.calls.some((k: Call) => k.name === 'drawImage')).toBe(false);
    expect(c.calls).toEqual(generic.calls);
  });

  it('draws the ready 16px image hanging from the mouth (top edge sy-2)', () => {
    stubImage();
    const url = '/media/gift-c1-ready16.png';
    ready(url, 16);
    const c = recordCtx();
    drawCarriedProp(c, { kind: 'household', sprite: url, x: 1, y: 2, z: 0 } as any, 50, 60, {});
    const draws = c.calls.filter((k: Call) => k.name === 'drawImage');
    expect(draws).toHaveLength(1);
    // Factor 1: drawImage(image, dx, dy) with no dw/dh.
    expect(draws[0].args).toHaveLength(3);
    const [, dx, dy] = draws[0].args as [unknown, number, number];
    expect(dx).toBe(Math.round(50 - 16 / 2));
    expect(dy).toBe(Math.round(60 - 2));
    expect(dx).toBe(42);
    expect(dy).toBe(58);
    expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
    expect(c.imageSmoothingEnabled).toBe(false);
    expect(c.calls[0].name).toBe('save');
    expect(c.calls[c.calls.length - 1].name).toBe('restore');
  });

  it.each([[16, 16], [28, 14], [44, 11]])('downscales %ipx to %ipx wide, top edge sy-2', (size, wide) => {
    stubImage();
    const url = `/media/gift-c1-scale-${size}.png`;
    ready(url, size);
    const c = recordCtx();
    drawCarriedProp(c, { kind: 'household', sprite: url, x: 0, y: 0, z: 0 } as any, 100, 100, {});
    const draws = c.calls.filter((k: Call) => k.name === 'drawImage');
    expect(draws).toHaveLength(1);
    const args = draws[0].args as unknown[];
    if (size === 16) {
      // No downscale: drawImage(image, dx, dy).
      expect(args).toHaveLength(3);
    } else {
      expect(args).toHaveLength(5);
    }
    const dw = args.length > 3 ? args[3] : size;
    const dh = args.length > 4 ? args[4] : size;
    expect(dw).toBe(wide);
    expect(dh).toBe(wide);
    const [, dx, dy] = args as [unknown, number, number];
    expect(dx).toBe(Math.round(100 - (wide as number) / 2));
    expect(dy).toBe(Math.round(100 - 2));
    if (size === 28) {
      expect(dx).toBe(93);
      expect(dy).toBe(98);
    }
  });

  it('never throws without an Image global', () => {
    const c = recordCtx();
    expect(() => drawCarriedProp(c, { kind: 'household', sprite: '/media/gift-c1-noimg.png', x: 0, y: 0 } as any, 10, 10, {})).not.toThrow();
    expect(c.calls.some((k: Call) => k.name === 'drawImage')).toBe(false);
    expect(c.calls.some((k: Call) => k.name === 'fillRect')).toBe(true);
  });
});

describe('C3 carried draw order', () => {
  it('carried (front layer) sorts after the cat at the same spot, so it draws in front', () => {
    // Mirrors cam.js: the carried item uses layer 'front' (depth +0.5) at
    // Nori's position, the cat item uses her pose part; items sort by depthKey.
    const x = 5; const y = 6;
    const cat = depthKey({ x, y, z: 0, part: null });
    const carried = depthKey({ x, y, z: 0, layer: 'front' });
    expect(carried).toBeGreaterThan(cat);
    const items = [
      { id: 'carried', depth: carried },
      { id: 'nori', depth: cat },
    ].sort((a, b) => a.depth - b.depth);
    expect(items.map((i) => i.id)).toEqual(['nori', 'carried']);
  });
});

describe('C3 gift contact shadow', () => {
  it.each([[16, 10], [28, 17]])('gift %ipx sprite -> wide flat shadow, centre +3', (size, rx) => {
    stubImage();
    const url = `/media/gift-c3-shadow${size}.png`;
    ready(url, size);
    const c = recordCtx();
    drawPropContactShadows(
      c,
      [{ id: 'g', kind: 'household', sprite: url, x: 30, y: 40, z: 0, status: 'placed' } as any],
      project as any,
      isPropVisible as any,
      kindOf as any,
    );
    const ellipses = c.calls.filter((k: Call) => k.name === 'ellipse');
    expect(ellipses).toHaveLength(1);
    const [x, y, erx, ery] = ellipses[0].args as [number, number, number, number];
    expect(erx).toBe(Math.max(8, Math.round(size * 0.62)));
    expect(erx).toBe(rx);
    expect(ery).toBe(4);
    expect(x).toBe(30);
    expect(y).toBe(40 + 3);
    expect(c.fillStyle).toBe(PAL.shadow);
  });

  it('leaves non-gift props exactly as today', () => {
    stubImage();
    const c = recordCtx();
    drawPropContactShadows(
      c,
      [
        { id: 't', kind: 'toy', x: 30, y: 40, z: 0, status: 'placed' } as any,
        { id: 'l', kind: 'household', sprite: '/media/gift-c1-shadow-loading.png', x: 50, y: 60, z: 0, status: 'placed' } as any,
      ],
      project as any,
      isPropVisible as any,
      kindOf as any,
    );
    const ellipses = c.calls.filter((k: Call) => k.name === 'ellipse');
    expect(ellipses).toHaveLength(2);
    expect(ellipses[0].args).toEqual([30, 42, 10, 4, 0, 0, Math.PI * 2]);
    // Loading gift keeps today's default shadow.
    expect(ellipses[1].args).toEqual([50, 62, 10, 4, 0, 0, Math.PI * 2]);
  });
});
