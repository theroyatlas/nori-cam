import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RIG_GOOD_POSES, alphaOn, isRigPose, mapPoint, mapPolygon,
  pointInPolygon, rigMotion, sortedParts,
} from '../public/cam-rig.js';

const source = { w: 129, h: 141 };
const target = { w: 37, h: 40 };

describe('polygon mapping (source sprite -> pixel sprite)', () => {
  it('maps corners and pivot with the manifest scale, rounded to pixels', () => {
    expect(mapPoint([0, 0], source, target)).toEqual([0, 0]);
    expect(mapPoint([129, 141], source, target)).toEqual([37, 40]);
    expect(mapPoint([50, 95], source, target)).toEqual([14, 27]);
    expect(mapPolygon([[6, 50], [98, 50]] as [number, number][], source, target)).toEqual([[2, 14], [28, 14]]);
  });
  it('is deterministic', () => {
    const poly = [[10, 10], [100, 20]] as [number, number][];
    expect(mapPolygon(poly, source, target)).toEqual(mapPolygon(poly, source, target));
  });
  it('pointInPolygon finds inside/outside', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];
    expect(pointInPolygon(5, 5, sq)).toBe(true);
    expect(pointInPolygon(15, 5, sq)).toBe(false);
    expect(pointInPolygon(0, 5, sq)).toBe(true);
  });
  it('alpha threshold is binary at 128', () => {
    expect(alphaOn(127)).toBe(0);
    expect(alphaOn(128)).toBe(255);
  });
  it('sortedParts orders by z (tail behind body)', () => {
    const parts = sortedParts({ parts: { head: { z: 3 }, tail: { z: 0 }, body: { z: 1 } } });
    expect(parts.map((p) => p.name)).toEqual(['tail', 'body', 'head']);
  });
});

describe('rigMotion', () => {
  it('is deterministic from (pose, t, segId)', () => {
    for (const t of [0, 600, 1200, 5000]) {
      expect(rigMotion('sit', t, 1)).toEqual(rigMotion('sit', t, 1));
    }
  });
  it('tail angle stays within rig max (<=10deg) for good poses', () => {
    const rig = { parts: { tail: { limits: { rot_deg_max: 10, dx_max: 2, dy_max: 2 } } } };
    for (const pose of RIG_GOOD_POSES) {
      for (let t = 0; t < 20000; t += 37) {
        const m = rigMotion(pose, t, 3, rig);
        expect(m.enabled).toBe(true);
        expect(Math.abs(m.tailAngleDeg)).toBeLessThanOrEqual(10.000001);
        if (pose === 'startled') expect(m.tailPeriodMs).toBeLessThan(2500);
        else {
          expect(m.tailPeriodMs).toBeGreaterThanOrEqual(2500);
          expect(m.tailPeriodMs).toBeLessThanOrEqual(4000);
        }
      }
    }
  });
  it('tail is faster when startled', () => {
    expect(rigMotion('startled', 0, 1).tailPeriodMs)
      .toBeLessThan(rigMotion('sit', 0, 1).tailPeriodMs);
  });
  it('respects a smaller rig tail limit', () => {
    const rig = { parts: { tail: { limits: { rot_deg_max: 4, dx_max: 1, dy_max: 1 } } } };
    for (let t = 0; t < 10000; t += 53) {
      expect(Math.abs(rigMotion('sit', t, 1, rig).tailAngleDeg)).toBeLessThanOrEqual(4.000001);
    }
  });
  it('ears never rotate, shift at most 1px, twitch at most every 4-8s', () => {
    let sawTwitch = false;
    for (let t = 0; t < 30000; t += 20) {
      const m = rigMotion('sit', t, 5);
      for (const ear of [m.earL, m.earR]) {
        expect(ear.rotDeg).toBe(0);
        expect(Math.abs(ear.dx)).toBeLessThanOrEqual(1);
        expect(ear.flatten === 0 || ear.flatten === 1).toBe(true);
      }
      expect(m.headRotDeg).toBe(0);
      if (m.earL.active || m.earR.active) sawTwitch = true;
      if (m.earPeriodMs !== undefined) {
        expect(m.earPeriodMs).toBeGreaterThanOrEqual(4000);
        expect(m.earPeriodMs).toBeLessThanOrEqual(8000);
      }
    }
    expect(sawTwitch).toBe(true);
  });
  it('head bob is at most 1px', () => {
    for (let t = 0; t < 10000; t += 25) {
      const m = rigMotion('walk', t, 2);
      expect(m.headBobPx === 0 || m.headBobPx === 1).toBe(true);
    }
  });
  it('weak poses get no rig motion', () => {
    for (const pose of ['alert_loaf', 'sleepy', 'starstruck', 'oops', 'belly_up', 'back', 'peek', 'surprised', 'love', 'neutral']) {
      expect(isRigPose(pose)).toBe(false);
      for (const t of [0, 600, 5000]) {
        const m = rigMotion(pose, t, 1);
        expect(m.enabled).toBe(false);
        expect(m.tailAngleDeg).toBe(0);
        expect(m.headBobPx).toBe(0);
        expect(m.earL.active).toBe(false);
      }
    }
  });
});

describe('purity', () => {
  it('new modules contain no Date or Math.random', () => {
    for (const f of ['../public/cam-rig.js']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toContain('Date');
      expect(src).not.toContain('Math.random');
    }
    const cam = readFileSync(new URL('../public/cam.js', import.meta.url), 'utf8');
    // Rig paths in cam.js must not introduce a second clock/RNG.
    expect(cam).not.toContain('Math.random');
  });
});
