import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDepthItems, drawProp, drawPropLayer, hasDrawPath, interpolateObjects, isPropVisible, kindOf } from '../public/cam-props.js';

// Minimal recording ctx: counts paint ops, no DOM canvas needed.
function mockCtx() {
  const ops: string[] = [];
  const ctx: any = {
    ops, fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    beginPath() { ops.push('path'); }, moveTo() {}, lineTo() {}, closePath() {},
    fill() { ops.push('fill'); }, stroke() { ops.push('stroke'); },
    fillRect() { ops.push('fillRect'); }, strokeRect() { ops.push('strokeRect'); },
    ellipse() { ops.push('ellipse'); }, save() {}, restore() {}, translate() {}, rotate() {},
  };
  return ctx;
}
const obj = (kind: string, x = 2, y = 2, extra: any = {}) => ({ id: `o_${kind}`, kind, x, y, z: 0, footprint: [[0, 0]], rotation: 0, status: 'placed', placement: 'floor', state: 'default', ...extra });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real: any = JSON.parse(readFileSync(new URL('./fixtures/cam-live-real.json', import.meta.url), 'utf8'));

describe('every kind in the live sample has a draw path', () => {
  it('covers all 10 live objects; sun is invisible, rest paint', () => {
    expect(real.objects).toHaveLength(10);
    for (const o of real.objects) {
      expect(hasDrawPath(kindOf(o)), kindOf(o)).toBe(true);
      const ctx = mockCtx();
      const drew = drawProp(ctx, o, { t: 0 });
      if (kindOf(o) === 'env:sun') { expect(drew).toBe(false); expect(ctx.ops.length).toBe(0); }
      else { expect(drew, kindOf(o)).toBe(true); expect(ctx.ops.length, kindOf(o)).toBeGreaterThan(0); }
    }
  });
  it('cushion paints as a single floor prop', () => {
    const ctx = mockCtx();
    expect(drawPropLayer(ctx, obj('cushion'), 'single', { t: 0 })).toBe(true);
    expect(ctx.ops).toContain('ellipse');
  });
  it('back/front split paints for bed and desk', () => {
    for (const k of ['bed', 'computer_desk']) {
      for (const layer of ['back', 'front']) {
        const ctx = mockCtx(); expect(drawPropLayer(ctx, obj(k), layer, { t: 0 })).toBe(true); expect(ctx.ops.length).toBeGreaterThan(0);
      }
    }
  });
  it('unknown kind falls back to a parcel (paints, no throw, no text API)', () => {
    const ctx = mockCtx();
    expect(drawProp(ctx, obj('gift_teapot', 3, 3), { t: 0 })).toBe(true);
    expect(ctx.ops.length).toBeGreaterThan(0);
  });
  it('water ripple and monitor scroll only when their segment is active', () => {
    const idle = mockCtx(); drawProp(idle, obj('water_bowl'), { t: 0, activeAction: 'idle_sit', activeTargetId: 'x' });
    const drink = mockCtx(); drawProp(drink, obj('water_bowl'), { t: 100, activeAction: 'drink', activeTargetId: 'o_water_bowl' });
    expect(drink.ops).toContain('ellipse'); expect(idle.ops).not.toContain('ellipse');
    const deskOff = mockCtx(); drawProp(deskOff, obj('computer_desk'), { t: 0 });
    const deskOn = mockCtx(); drawProp(deskOn, obj('computer_desk'), { t: 200, activeAction: 'use_computer', activeTargetId: 'o_computer_desk' });
    expect(deskOn.ops.length).toBeGreaterThan(deskOff.ops.length);
  });
});

describe('depth order (3 hand-picked arrangements)', () => {
  const objs = [obj('bed', 8, 6, { id: 'o_bed' }), obj('computer_desk', 8, 1, { id: 'desk' }), obj('water_bowl', 1, 5, { id: 'wb' })];
  it('Nori behind desk: desk back+front both after Nori', () => {
    const items = buildDepthItems(objs as any, { x: 8, y: 0 });
    const idx = (id: string, layer?: string) => items.findIndex((i: any) => i.id === id && (!layer || i.layer === layer));
    expect(idx('nori')).toBeLessThan(idx('desk', 'back')); expect(idx('desk', 'back')).toBeLessThan(idx('desk', 'front'));
  });
  it('Nori in front of bowls: Nori after the bowl', () => {
    const items = buildDepthItems(objs as any, { x: 1, y: 6 });
    const idx = (id: string) => items.findIndex((i: any) => i.id === id);
    expect(idx('wb')).toBeLessThan(idx('nori'));
    const behind = buildDepthItems(objs as any, { x: 1, y: 4 });
    expect(behind.findIndex((i: any) => i.id === 'nori')).toBeLessThan(behind.findIndex((i: any) => i.id === 'wb'));
  });
  it('Nori on the bed: bed back < Nori < bed front; on desk likewise', () => {
    const items = buildDepthItems(objs as any, { x: 8, y: 6 });
    const idx = (id: string, layer?: string) => items.findIndex((i: any) => i.id === id && (!layer || i.layer === layer));
    expect(idx('o_bed', 'back')).toBeLessThan(idx('nori')); expect(idx('nori')).toBeLessThan(idx('o_bed', 'front'));
    const onDesk = buildDepthItems(objs as any, { x: 8, y: 1 });
    expect(onDesk.findIndex((i: any) => i.id === 'desk' && i.layer === 'back')).toBeLessThan(onDesk.findIndex((i: any) => i.id === 'nori'));
  });
});

describe('slipper carried + interpolation + purity', () => {
  it('slipper hidden at floor when carried', () => {
    const s = obj('slipper', 3, 2, { status: 'carried' });
    expect(isPropVisible(s)).toBe(false);
    const ctx = mockCtx(); expect(drawProp(ctx, s, { t: 0 })).toBe(false); expect(ctx.ops.length).toBe(0);
    expect(buildDepthItems([s] as any, { x: 3, y: 2 }).filter((i: any) => i.kind === 'slipper')).toHaveLength(0);
  });
  it('physics keyframes interpolate; without them the effect snaps', () => {
    const slip = obj('slipper', 3, 2);
    const seg: any = { id: 1, start_at: 1000, end_at: 2000, target: slip.id, effects: [{ e: 'move_object', object_id: slip.id, dx: 1, dy: 0, keyframes: [{ at_ms: 1000, x: 3, y: 2, z: 0 }, { at_ms: 1500, x: 4, y: 2, z: 0 }] }] };
    const mid: any = interpolateObjects([slip], [seg], 1250).find((o: any) => o.id === slip.id);
    expect(mid.x).toBeCloseTo(3.5);
    const snapSeg: any = { id: 2, start_at: 1000, end_at: 2000, target: slip.id, effects: [{ e: 'move_object', object_id: slip.id, dx: 1, dy: 0 }] };
    expect((interpolateObjects([slip], [snapSeg], 1500).find((o: any) => o.id === slip.id) as any).x).toBe(3);
    expect((interpolateObjects([slip], [snapSeg], 2000).find((o: any) => o.id === slip.id) as any).x).toBe(4);
  });
  it('no Date/Math.random in cam-props.js', () => {
    const src = readFileSync(new URL('../public/cam-props.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bDate\b/); expect(src).not.toMatch(/Math\.random/);
  });
});
