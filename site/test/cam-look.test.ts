import { describe, it, expect } from 'vitest';
import {
  BASE_OUTLINE,
  DEFAULT_LOOK,
  PRODUCT_LOOK,
  LIGHT,
  PALETTE_OVERRIDES,
  CAT_REAL_SCALE,
  CAT_MID_SCALE,
  CAT_DEFAULT_SCALE,
  parseLook,
  parseLookParams,
  outlineFor,
  paletteFor,
  lightFor,
  poolScaleFor,
  dayWashFor,
  patchColorFor,
  extraDecorFor,
  catScaleFor,
  mix,
  shade,
} from '../public/cam-look.js';
import { OUTLINE, PROP_KINDS } from '../public/cam-props.js';
import { PAL, DECOR, DECOR_FLOOR_CELLS } from '../public/cam-scene.js';

function lum(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('look params (owner pick 2026-11-03: c + mid is the product default)', () => {
  it('missing, empty or unknown look -> c; missing or unknown catScale -> mid', () => {
    const product = { look: 'c', catReal: false, catMid: true };
    expect(parseLookParams(null)).toEqual(product);
    expect(parseLookParams(undefined)).toEqual(product);
    expect(parseLookParams('')).toEqual(product);
    expect(parseLookParams('?look=z')).toEqual(product);
    expect(parseLookParams('?look=A&catScale=big')).toEqual(product);
    expect(parseLook(null)).toBe(PRODUCT_LOOK);
    expect(parseLook('')).toBe('c');
  });
  it('the pre-B10 rendering stays reachable with look=default&catScale=current', () => {
    expect(parseLookParams('?look=default&catScale=current')).toEqual({ look: DEFAULT_LOOK, catReal: false, catMid: false });
    expect(parseLook('default')).toBe(DEFAULT_LOOK);
  });
  it('accepts a, b, c and keeps catScale independent of look', () => {
    for (const look of ['a', 'b', 'c']) {
      expect(parseLookParams(`?look=${look}`)).toEqual({ look, catReal: false, catMid: true });
      expect(parseLookParams(`?look=${look}&catScale=real`)).toEqual({ look, catReal: true, catMid: false });
      expect(parseLookParams(`?look=${look}&catScale=mid`)).toEqual({ look, catReal: false, catMid: true });
      expect(parseLookParams(`?look=${look}&catScale=current`)).toEqual({ look, catReal: false, catMid: false });
    }
    expect(parseLookParams(new URLSearchParams('look=b&catScale=real') as any)).toEqual({ look: 'b', catReal: true, catMid: false });
  });
});

describe('B10b default look leaves every renderer constant unchanged', () => {
  it('shares the single outline colour with cam-props', () => {
    expect(BASE_OUTLINE).toBe(OUTLINE);
  });
  it('paletteFor(default) returns the very same object, with no overrides', () => {
    expect(PALETTE_OVERRIDES.default ?? {}).toEqual({});
    expect(paletteFor('default', PAL)).toBe(PAL);
    expect(paletteFor('zzz', PAL)).toBe(PAL);
  });
  it('outlineFor(default/unknown) returns the base outline for any fill', () => {
    for (const fill of ['#c69c62', '#e8b4b8', '#3e2f26', 'not-a-colour', '']) {
      expect(outlineFor('default', fill, OUTLINE)).toBe(OUTLINE);
      expect(outlineFor('zzz', fill, OUTLINE)).toBe(OUTLINE);
    }
  });
  it('light multipliers are all 1 under default', () => {
    expect(lightFor('default')).toEqual({ day: 1, night: 1, dust: 1, block: 1 });
    expect(lightFor('zzz')).toEqual(LIGHT.default);
  });
  it('no extra decor under default or look a', () => {
    expect(extraDecorFor('default')).toEqual([]);
    expect(extraDecorFor('a')).toEqual([]);
    expect(extraDecorFor('zzz')).toEqual([]);
  });
  it('no day wash or pool scaling under default', () => {
    expect(dayWashFor('default')).toBeNull();
    expect(dayWashFor('zzz')).toBeNull();
    expect(poolScaleFor('default')).toBe(1);
    expect(poolScaleFor('zzz')).toBe(1);
    expect(patchColorFor('default')).toEqual([255, 240, 190]);
    expect(patchColorFor('zzz')).toEqual([255, 240, 190]);
  });
  it('cat scale is 1 unless catScale=real or catScale=mid', () => {
    expect(CAT_DEFAULT_SCALE).toBe(1);
    expect(catScaleFor(false)).toBe(1);
    expect(catScaleFor(true)).toBe(CAT_REAL_SCALE);
    expect(catScaleFor(false, true)).toBe(CAT_MID_SCALE);
    expect(catScaleFor('mid')).toBe(CAT_MID_SCALE);
    expect(CAT_REAL_SCALE).toBeLessThan(CAT_MID_SCALE);
    expect(CAT_MID_SCALE).toBeLessThan(1);
    expect(CAT_MID_SCALE).toBeCloseTo((CAT_DEFAULT_SCALE + CAT_REAL_SCALE) / 2, 10);
  });
});

describe('B10b look table contents', () => {
  it('a warms the light, softens outlines toward the fill, and adds no decor', () => {
    expect(lightFor('a').day).toBeGreaterThan(1);
    expect(lightFor('a').night).toBeGreaterThan(1);
    expect(lightFor('a').dust).toBeGreaterThan(1);
    expect(lightFor('a').block).toBeGreaterThan(1);
    const soft = outlineFor('a', '#c69c62', OUTLINE);
    expect(soft).not.toBe(OUTLINE);
    expect(Math.abs(lum(soft) - lum('#c69c62'))).toBeLessThan(Math.abs(lum(OUTLINE) - lum('#c69c62')));
    expect(poolScaleFor('a')).toBeGreaterThan(1);
  });
  it('b keeps neutral day light but cools the night, with selective outlines plus decor', () => {
    expect(lightFor('b').day).toBe(1);
    expect(lightFor('b').night).toBeLessThan(1);
    const sel = outlineFor('b', '#c69c62', OUTLINE);
    expect(sel).not.toBe(OUTLINE);
    expect(lum(sel)).toBeLessThan(lum('#c69c62'));
    const decor = extraDecorFor('b');
    expect(decor.length).toBeGreaterThanOrEqual(4);
    expect(decor.length).toBeLessThanOrEqual(6);
    expect(dayWashFor('b')).not.toBe(dayWashFor('a'));
    expect(patchColorFor('b')).not.toEqual(patchColorFor('a'));
  });
  it('c combines b outlines/decor with a warm light between b and a', () => {
    expect(outlineFor('c', '#c69c62', OUTLINE)).toBe(outlineFor('b', '#c69c62', OUTLINE));
    expect(lightFor('c').day).toBeGreaterThan(lightFor('b').day);
    expect(lightFor('c').day).toBeLessThan(lightFor('a').day);
    expect(lightFor('c').night).toBeGreaterThan(lightFor('b').night);
    expect(lightFor('c').night).toBeLessThan(lightFor('a').night);
    expect(lightFor('c').block).toBe(lightFor('b').block);
    expect(extraDecorFor('c')).toEqual(extraDecorFor('b'));
    expect(poolScaleFor('c')).toBeGreaterThan(1);
    expect(poolScaleFor('c')).toBeLessThan(poolScaleFor('a'));
  });
  it('c palette is b warmed halfway toward a', () => {
    for (const k of ['wallCream', 'wainscot', 'woodLight', 'rugBase']) {
      expect(PALETTE_OVERRIDES.c[k]).toBe(mix(PALETTE_OVERRIDES.b[k], PALETTE_OVERRIDES.a[k], 0.5));
      expect(PALETTE_OVERRIDES.c[k]).not.toBe(PALETTE_OVERRIDES.a[k]);
      expect(PALETTE_OVERRIDES.c[k]).not.toBe(PALETTE_OVERRIDES.b[k]);
    }
    expect(paletteFor('c', PAL)).not.toBe(PAL);
  });
  it('every look gets its own day wash', () => {
    const washes = new Set([dayWashFor('a'), dayWashFor('b'), dayWashFor('c')]);
    expect(washes.size).toBe(3);
  });
  it('extra decor is wall-only and never on floor paths', () => {
    for (const d of extraDecorFor('c')) {
      expect(['back', 'left']).toContain(d.wall);
      expect(DECOR.map((x: any) => x.id)).not.toContain(d.id);
    }
    expect(DECOR_FLOOR_CELLS).toEqual([]);
    // Stays clear of the window span (back wall x 5.2..9.2) and of grid walls.
    for (const d of extraDecorFor('c')) {
      if (d.wall === 'back') {
        expect(d.along1).toBeLessThanOrEqual(5.2);
      }
      expect(d.along0).toBeGreaterThanOrEqual(0);
      expect(d.along1).toBeLessThanOrEqual(10);
    }
  });
  it('prop kinds are untouched: decor adds no world object', () => {
    for (const d of extraDecorFor('c')) {
      expect(PROP_KINDS).not.toContain(d.id);
    }
  });
  it('mix/shade helpers behave', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(shade('#ffffff', 1)).toBe('#000000');
    expect(shade('#3e2f26', 0)).toBe('#3e2f26');
  });
});
