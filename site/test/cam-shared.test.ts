import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORIGIN_X, ORIGIN_Y, POSES, depthKey, poseAt, project } from '../public/cam-shared.js';

const fixtureUrl = new URL('../public/cam/fixture/now.json', import.meta.url);
const sampleUrl = new URL('../sample/cam/now.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const segments = fixture.segments;

describe('project', () => {
  it('projects the origin', () => {
    const p = project(0, 0, 0);
    expect(p.sx).toBe(ORIGIN_X);
    expect(p.sy).toBe(ORIGIN_Y);
  });

  it('uses 2:1 isometric steps and z lift', () => {
    expect(project(1, 0, 0).sx).toBe(ORIGIN_X + 16);
    expect(project(1, 0, 0).sy).toBe(ORIGIN_Y + 8);
    expect(project(0, 1, 0).sx).toBe(ORIGIN_X - 16);
    expect(project(0, 1, 0).sy).toBe(ORIGIN_Y + 8);
    expect(project(2, 3, 0).sx).toBe((2 - 3) * 16 + ORIGIN_X);
    expect(project(2, 3, 0).sy).toBe((2 + 3) * 8 + ORIGIN_Y);
    expect(project(2, 3, 2).sy).toBe((2 + 3) * 8 + ORIGIN_Y - 32);
  });
});

describe('poseAt', () => {
  it('is continuous at every segment boundary of the fixture', () => {
    for (let i = 0; i + 1 < segments.length; i += 1) {
      const at = segments[i + 1].start_at;
      const before = poseAt(segments, at - 0.001);
      const after = poseAt(segments, at);
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(Math.abs((before?.x ?? 0) - (after?.x ?? 0))).toBeLessThan(0.01);
      expect(Math.abs((before?.y ?? 0) - (after?.y ?? 0))).toBeLessThan(0.01);
    }
  });

  it('is 2.5 tiles along the path at the middle of segment 3', () => {
    const seg = segments.find((s: { id: number }) => s.id === 3);
    const mid = (seg.start_at + seg.end_at) / 2;
    const p = poseAt(segments, mid);
    expect(p?.segmentId).toBe(3);
    expect(p?.distance).toBeCloseTo(2.5, 9);
    expect(p?.x).toBeCloseTo(4, 9);
    expect(p?.y).toBeCloseTo(5.5, 9);
  });

  it('faces -1 at the start of segment 9', () => {
    const seg = segments.find((s: { id: number }) => s.id === 9);
    expect(poseAt(segments, seg.start_at)?.facing).toBe(-1);
  });

  it('gives the same output for the same input', () => {
    expect(poseAt(segments, 7700)).toEqual(poseAt(segments, 7700));
    expect(poseAt(segments, 11200)).toEqual(poseAt(segments, 11200));
    expect(project(3, 5, 1)).toEqual(project(3, 5, 1));
  });

  it('clamps outside the timeline and peaks hop mid-climb', () => {
    expect(poseAt(segments, -100)?.segmentId).toBe(segments[0].id);
    expect(poseAt(segments, 999999)?.segmentId).toBe(segments[segments.length - 1].id);
    const seg5 = segments.find((s: { id: number }) => s.id === 5);
    const mid5 = poseAt(segments, (seg5.start_at + seg5.end_at) / 2);
    expect(mid5?.hop).toBeCloseTo(10, 9);
    expect(poseAt(segments, 7000)?.hop).toBe(0);
  });

  it('covers every fixture pose in POSES', () => {
    for (const s of segments) expect(POSES).toContain(s.pose);
  });
});

describe('depthKey', () => {
  it('orders box-back < cat-inside < box-front', () => {
    const back = depthKey({ x: 6, y: 4, layer: 'back' });
    const cat = depthKey({ x: 6, y: 4, part: 'inside' });
    const front = depthKey({ x: 6, y: 4, layer: 'front' });
    expect(back).toBeCloseTo(9.99, 9);
    expect(cat).toBeCloseTo(10.25, 9);
    expect(front).toBeCloseTo(10.5, 9);
    expect(back).toBeLessThan(cat);
    expect(cat).toBeLessThan(front);
  });
});

describe('fixture copy', () => {
  // B8: the full-room fixture now also carries the seeded world objects (catalog placed set),
  // so it is no longer byte-identical to the sample. Everything except objects is still identical,
  // and every sample object is still present with the same kind, cell, z and status.
  it('is the sample plus the B8 seeded world objects', () => {
    const sampleJson = JSON.parse(readFileSync(sampleUrl, 'utf8'));
    const { objects: fixtureObjects, ...fixtureRest } = fixture;
    const { objects: sampleObjects, ...sampleRest } = sampleJson;
    expect(fixtureRest).toEqual(sampleRest);
    for (const o of sampleObjects) {
      const got = fixtureObjects.find((x: { id: string }) => x.id === o.id);
      expect(got).toBeDefined();
      expect([got.kind, got.x, got.y, got.z, got.status]).toEqual([o.kind, o.x, o.y, o.z, o.status]);
    }
  });

  it('has contiguous segments', () => {
    for (let i = 0; i + 1 < segments.length; i += 1) {
      expect(segments[i].end_at).toBe(segments[i + 1].start_at);
    }
  });
});
