import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { animState } from '../public/cam-anim.js';

const fixture = JSON.parse(
  readFileSync(new URL('../public/cam/fixture/now.json', import.meta.url), 'utf8'),
);
const manifest = JSON.parse(
  readFileSync(new URL('../public/cam/manifest.json', import.meta.url), 'utf8'),
);
const segments = fixture.segments;
const seg = (id: number) => segments.find((s: { id: number }) => s.id === id);

describe('animState determinism', () => {
  it('same input gives same output', () => {
    for (const t of [0, 1500, 10750, 10880, 11560, 30000, 56050]) {
      expect(animState(segments, t, manifest)).toEqual(animState(segments, t, manifest));
    }
  });

  it('has no NaN anywhere across the loop', () => {
    for (let t = 0; t < 61000; t += 37) {
      const a = animState(segments, t, manifest);
      for (const v of [a.scaleX, a.scaleY, a.dx, a.dy, a.rot, a.blink, a.shadowScale]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      for (const o of a.overlays) {
        expect(Number.isFinite(o.dx)).toBe(true);
        expect(Number.isFinite(o.dy)).toBe(true);
        expect(Number.isFinite(o.alpha)).toBe(true);
      }
      for (const fx of Object.values(a.objectFx) as { shearX: number; dy: number; flap: number }[]) {
        expect(Number.isFinite(fx.shearX)).toBe(true);
        expect(Number.isFinite(fx.dy)).toBe(true);
        expect(Number.isFinite(fx.flap)).toBe(true);
      }
    }
  });
});

describe('anticipation and landing (segment 5 climb)', () => {
  it('crouches just before segment 5 and not earlier', () => {
    const s5 = seg(5);
    const crouched = animState(segments, s5.start_at - 50, manifest);
    expect(crouched.scaleY).toBeLessThan(0.97);
    expect(crouched.scaleY).toBeGreaterThan(0.88);
    const earlier = animState(segments, s5.start_at - 400, manifest);
    // Only breathing may move scaleY this far from the climb.
    expect(earlier.scaleY).toBeGreaterThan(0.97);
  });

  it('squashes after the climb then recovers', () => {
    const s6 = seg(6);
    const landed = animState(segments, s6.start_at + 5, manifest);
    expect(landed.scaleY).toBeLessThan(0.92);
    const settled = animState(segments, s6.start_at + 600, manifest);
    expect(settled.scaleY).toBeGreaterThan(0.95);
    expect(settled.scaleY).toBeLessThan(1.05);
  });

  it('shadow shrinks at hop peak', () => {
    const s5 = seg(5);
    const mid = animState(segments, (s5.start_at + s5.end_at) / 2, manifest);
    expect(mid.shadowScale).toBeLessThan(0.75);
    expect(mid.shadowScale).toBeGreaterThan(0.4);
  });
});

describe('box reaction', () => {
  it('wobbles after landing in the box and decays to zero', () => {
    const s6 = seg(6);
    const mid = animState(segments, s6.start_at + 175, manifest);
    const fx = mid.objectFx['o_box1'];
    expect(fx).toBeDefined();
    expect(Math.abs(fx.shearX)).toBeGreaterThan(0.05);
    expect(fx.flap).toBeGreaterThan(0);
    const dust = mid.overlays.filter((o) => o.type === 'dust');
    expect(dust.length).toBeGreaterThanOrEqual(4);
    expect(dust.length).toBeLessThanOrEqual(6);
    const after = animState(segments, s6.start_at + 400, manifest);
    expect(after.objectFx['o_box1']).toBeUndefined();
  });

  it('wobbles when jumping out (segment 8)', () => {
    const s8 = seg(8);
    const mid = animState(segments, s8.start_at + 175, manifest);
    expect(mid.objectFx['o_box1']).toBeDefined();
  });
});

describe('blink', () => {
  it('never overlaps a jump/climb', () => {
    for (let t = 0; t < 61000; t += 25) {
      const i = segments.findIndex(
        (s: { start_at: number; end_at: number }) => t >= s.start_at && t < s.end_at,
      );
      const s = segments[i];
      const a = animState(segments, t, manifest);
      if (s.primitive === 'climb' || s.pose === 'jump') expect(a.blink).toBe(0);
    }
  });

  it('blinks sometimes while sitting and never while sleeping', () => {
    let sawBlink = false;
    for (let t = seg(1).start_at; t < seg(1).end_at; t += 20) {
      if (animState(segments, t, manifest).blink > 0.1) sawBlink = true;
    }
    expect(sawBlink).toBe(true);
    for (let t = seg(7).start_at; t < seg(7).end_at; t += 500) {
      expect(animState(segments, t, manifest).blink).toBe(0);
    }
  });
});

describe('overlays and transitions', () => {
  it('drifts z glyphs while sleeping', () => {
    const a = animState(segments, 30000, manifest);
    const zs = a.overlays.filter((o) => o.type === 'z');
    expect(zs.length).toBe(2);
    const b = animState(segments, 31200, manifest);
    expect(b.overlays.filter((o) => o.type === 'z')[0].dy)
      .not.toBe(zs[0].dy);
  });

  it('pops ! at the start of hide_in only', () => {
    const s5 = seg(5);
    const a = animState(segments, s5.start_at + 100, manifest);
    expect(a.overlays.some((o) => o.type === '!')).toBe(true);
    const late = animState(segments, s5.start_at + 550, manifest);
    expect(late.overlays.some((o) => o.type === '!')).toBe(false);
  });

  it('pose changes are hard cuts: the state carries no transition', () => {
    const s2 = seg(2);
    expect(animState(segments, s2.start_at + 60, manifest)).not.toHaveProperty('transition');
    expect(animState(segments, s2.start_at + 500, manifest)).not.toHaveProperty('transition');
  });

  it('hard-cuts pose changes at hop boundaries (no transition state)', () => {
    const s6 = seg(6);
    expect(animState(segments, s6.start_at + 30, manifest)).not.toHaveProperty('transition');
    const s8 = seg(8);
    expect(animState(segments, s8.start_at + 30, manifest)).not.toHaveProperty('transition');
  });

  it('breathes on idle: scaleY oscillates by about 1 px, slower asleep', () => {
    const vals = new Set<number>();
    for (let t = 0; t < 4000; t += 100) {
      vals.add(Number(animState(segments, t, manifest).scaleY.toFixed(4)));
    }
    expect(vals.size).toBeGreaterThan(3);
  });
});

describe('purity', () => {
  it('cam-anim.js contains no Date or Math.random', () => {
    const src = readFileSync(new URL('../public/cam-anim.js', import.meta.url), 'utf8');
    expect(src).not.toContain('Date');
    expect(src).not.toContain('Math.random');
  });
});
