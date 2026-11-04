import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import catalog from '../public/cam/catalog.json';
import { planNext, plan } from '../src/worker/cam/plan.ts';
import { initialState } from '../src/worker/cam/engine.ts';
import { settle } from '../src/worker/cam/settle.ts';
import { sentence } from '../src/worker/cam/inspect.ts';
import { heightResponse, levels, supports } from '../src/worker/cam/heights.ts';
import { placementOk, poseAt, depthKey, EVENT_TYPES } from '../public/cam-shared.js';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { snapshot, claimWorld, insertSegment } from '../src/worker/cam/store.ts';
import { replan } from '../src/worker/cam/replan.ts';
import { writeFact } from '../src/worker/cam/facts.ts';
import { safeSegment } from '../src/worker/cam/timeline.ts';
import { advance } from '../src/worker/cam/timeline.ts';
import { inspectRoute } from '../src/worker/cam/inspect.ts';
import { validate } from '../src/worker/cam/validate.ts';
import { validateSparkIntents } from '../src/worker/cam/spark-validate.ts';
import type { CatalogEntry, Cell, Segment } from '../src/worker/cam/types.ts';
const entries = catalog.entries as unknown as CatalogEntry[];
const input = (seed = 1) => ({
    state: initialState(NOW), objects: structuredClone(entries.map(e => e.object)),
    interactions: entries.flatMap(e => e.interactions), position: [2, 6] as Cell, start_at: NOW, world_version: seed
});
const migration = readFileSync(new URL('../migrations/0004_cam_heights.sql', import.meta.url), 'utf8');
function forced(kind: string, action: string) {
    const i = input();
    i.interactions = i.interactions.filter(ix => ix.object_id === `o_${kind}` && ix.action === action);
    return { ...i, intent: { action, bonus: 10, expires_at: NOW + 3600000 } };
}
function continuity(segments: Segment[], objects = input().objects, from = 0) {
    let z = from;
    for (const s of segments) {
        expect(s.z_from ?? s.z).toBe(z);
        z = s.z_to ?? s.z;
        expect(supports(objects, s.path.at(-1)!, z), JSON.stringify(s)).toBe(true);
    }
}
describe('A2c planner physics and heights', () => {
    it('deterministic pushes are absolute, move at most one cell and settle legally', () => {
        const i = forced('slipper', 'play');
        const a = planNext(i);
        expect(a).toEqual(planNext(i));
        const s = a.find(s => s.effects.some(e => e.keyframes))!;
        expect(s).toBeDefined();
        const e = s.effects.find(e => e.keyframes)!;
        expect(Math.abs(e.dx || 0) + Math.abs(e.dy || 0)).toBe(1);
        expect(e.keyframes![0].at_ms).toBe(s.start_at);
        expect(e.at_ms).toBeLessThanOrEqual(s.end_at);
        let state = i.state;
        let objects = i.objects;
        for (const s of a)
            ({ state, objects } = settle(state, s, objects, s.end_at));
        const o = objects.find(o => o.id === 'o_slipper')!;
        expect([o.x, o.y]).toEqual([e.keyframes!.at(-1)!.x, e.keyframes!.at(-1)!.y]);
        expect(placementOk({ objects }, o).ok).toBe(true);
    });
    it('an accepted Spark play intention moves a gifted yarn ball', () => {
        const i = input();
        const toy = i.objects.find(o => o.kind === 'toy')!;
        Object.assign(toy, { x: 7, y: 4, status: 'placed' });
        const intent = {
            action: 'play' as const, object_id: toy.id, window_minutes: 30, reason_tag: 'curious', summary: 'Play.'
        };
        const checked = validateSparkIntents({ intents: [intent] }, i as never, NOW);
        expect(checked.accepted).toHaveLength(1);
        const a = planNext({
            ...i, interactions: [], intents: [{ ...intent, id: 'spark:toy', expires_at: NOW + 1800000 }]
        });
        const effect = a.flatMap(s => s.effects).find(e => e.keyframes);
        expect(effect).toBeDefined();
        expect(Math.abs(effect!.dx || 0) + Math.abs(effect!.dy || 0)).toBe(1);
    });
    it('rejection records a fixed reason and has no movement', () => {
        const i = forced('slipper', 'play');
        const o = i.objects.find(o => o.kind === 'slipper')!;
        o.placement = 'wall';
        // A wall object is still approachable, but floor physics rejects it.
        o.blocks = false;
        const a = planNext(i);
        const s = a.find(s => s.effects.some(e => e.e === 'physics_rejected'))!;
        expect(s).toBeDefined();
        const r = settle({ ...i.state, settled_through: s.start_at }, s, i.objects, s.end_at);
        expect(r.events.some(e => e.type === 'physics_rejected')).toBe(true);
        expect(r.objects.find(t => t.id === o.id)).toEqual(o);
    });
    it('climbs floor to mid to top to shelf and preserves all subsequent heights', () => {
        const i = forced('wall_shelf', 'look_out');
        const a = planNext(i);
        expect(a.filter(s => s.primitive === 'climb').map(s => [s.z_from, s.z_to])).toEqual([[0, 1], [1, 2.5], [2.5, 3]]);
        continuity(a);
        const last = a.at(-1)!;
        const state = { ...i.state, nori: { ...i.state.nori, z: 3 } };
        const b = planNext({ ...input(), state, start_at: last.end_at, position: last.path.at(-1)! });
        continuity(b, i.objects, 3);
        expect(b.slice(0, 3).map(s => s.z_to)).toEqual([2.5, 1, 0]);
    });
    it('cannot climb to a shelf without its tree and every seeded object places legally', () => {
        const i = forced('wall_shelf', 'sit_on');
        for (const o of i.objects.filter(o => o.status === 'placed'))
            expect(placementOk(i, o).ok, o.id).toBe(true);
        const shelf = i.objects.find(o => o.kind === 'wall_shelf')!;
        const objects = i.objects.filter(o => o.kind !== 'cat_tree');
        expect(validate({ objects }, shelf, i.interactions[0].spec, [5, 1]).status).toBe('rejected');
        expect(planNext({ ...i, objects }).every(s => s.target !== shelf.id)).toBe(true);
    });
    it('desk top is a real support and mid-climb projection interpolates height', () => {
        const a = planNext(forced('computer_desk', 'use_computer'));
        const s = a.find(s => s.primitive === 'climb')!;
        expect(s.z_to).toBe(1.5);
        expect(poseAt([s], s.start_at + 300)!.z).toBe(0.75);
        expect(depthKey({ x: 5, y: 0, z: 3 })).toBeGreaterThan(depthKey({ x: 5, y: 0, z: 0 }));
        continuity(a);
    });
    it('migration is idempotent and never overwrites live object positions', async () => {
        const t = database();
        t.sql.exec(migration);
        const before = await snapshot(t.db);
        t.sql.prepare("UPDATE objects SET x=7 WHERE id='o_cat_tree'").run();
        const count = t.sql.prepare('SELECT count(*) AS n FROM object_states').get();
        t.sql.exec(migration);
        expect((await snapshot(t.db)).objects.find(o => o.kind === 'cat_tree')!.x).toBe(7);
        expect(t.sql.prepare('SELECT count(*) AS n FROM object_states').get()).toEqual(count);
        expect(before.objects.find(o => o.kind === 'wall_shelf')).toBeDefined();
    });
    it('D1 settlement writes the physics endpoint and replay exposes that row', async () => {
        const t = database(NOW);
        t.sql.exec(migration);
        const snap = await snapshot(t.db, NOW);
        const a = planNext({ ...forced('slipper', 'play'), objects: snap.objects });
        const token = 'a2c';
        await t.db.batch([
            claimWorld(t.db, snap.world, token, snap.state, a.at(-1)!.end_at, NOW),
            ...a.map(s => insertSegment(t.db, s, token))
        ]);
        await advance(t.env, a.at(-1)!.end_at, 'read');
        const moved = a.flatMap(s => s.effects).find(e => e.keyframes)!;
        const response = await inspectRoute(new Request(`http://local/api/replay?from=${NOW}&to=${a.at(-1)!.end_at +
            1}`), t.env, a.at(-1)!.end_at + 1);
        const body = await response.json() as any;
        expect(body.object_states, JSON.stringify(body)).toBeDefined();
        expect(body.object_states.some((o: any) => o.object_id === 'o_slipper' &&
            o.x === moved.keyframes!.at(-1)!.x && o.y === moved.keyframes!.at(-1)!.y)).toBe(true);
    });
    it('route adapter exposes height fields without changing cache or error responses', async () => {
        const a = planNext(forced('wall_shelf', 'look_out'));
        const response = await heightResponse(new Response(JSON.stringify({ objects: input().objects, segments: a }),
          { headers: { ETag: 'example', 'Cache-Control': 'no-store' } }));
        const body = await response.json() as any;
        expect(body.objects.find((o: any) => o.kind === 'wall_shelf').levels[0].z).toBe(3);
        expect(body.segments.find((s: any) => s.primitive === 'climb').z_from).toBe(0);
        expect(response.headers.get('etag')).toBe('example');
        expect((await heightResponse(new Response(null, { status: 304 }))).status).toBe(304);
    });
    it('has distinct fixed public templates and a vocabulary immune to private raw text', () => {
        const types = [
            ...EVENT_TYPES, 'climbed', 'climbed_mid', 'climbed_down', 'pushed', 'physics_rejected', 'weather_startle'
        ];
        const texts = types.map(type => sentence(type, { kind: 'slipper' }));
        expect(new Set(texts).size).toBe(types.length);
        expect(JSON.stringify(texts)).not.toMatch(/\d|https|[a-f\d]{64}/);
        expect(sentence('gift_arrived', { kind: 'cushion' })).toBe('A visitor left a cushion by the door.');
        expect(sentence('pushed', { kind: 'slipper' })).toBe('She pushed the slipper across the floor.');
        expect(sentence('hid', { kind: 'cardboard_box' })).toBe('She curled up in the cardboard box.');
        expect(sentence('climbed', { kind: 'cat_tree' })).toBe('She climbed to the top of the cat tree.');
        expect(sentence('pushed', { kind: 'SECRET123 https://private', category: 'toy' })).toContain('yarn ball');
    });
    it('rejects a moved access tree and descends safely after support removal', () => {
        const i = forced('wall_shelf', 'look_out');
        i.objects.find(o => o.kind === 'cat_tree')!.x = 1;
        expect(planNext(i).every(s => s.z === 0)).toBe(true);
        i.state.nori.z = 3;
        i.position = [5, 0];
        i.objects = i.objects.filter(o => !['wall_shelf', 'cat_tree'].includes(o.kind));
        const a = planNext({ ...i, interactions: [] });
        expect(a[0].z_from).toBe(3);
        expect(a[0].z_to).toBe(0);
        continuity(a, i.objects, 3);
    });
    it('replanning on a shelf persists a descent before any floor walking', async () => {
        const t = database();
        t.sql.exec(migration);
        const state = initialState(NOW);
        state.nori.z = 3;
        t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(state));
        const old = { ...safeSegment(NOW - 1000, NOW, 1, 0, [5, 0]), z: 3, settled_at: NOW };
        const snap = await snapshot(t.db, NOW);
        await t.db.batch([insertSegment(t.db, old, snap.world.writer)]);
        await writeFact(t.db, {
            id: 'shelf-event', at: NOW, type: 'object_moved', actor: 'system',
            payload: { object_id: 'o_bed' }
        }, NOW, () => []);
        expect(await replan(t.db, NOW)).toBe(true);
        const next = (await snapshot(t.db, NOW)).segments;
        expect(next.filter(s => s.primitive === 'climb').slice(0, 3).map(s => s.z_to)).toEqual([2.5, 1, 0]);
        continuity(next, snap.objects, 3);
    });
    it('twenty seeded days preserve support and z continuity', () => {
        for (let seed = 1; seed <= 20; seed++) {
            const i = input(seed);
            const a = plan(i, NOW + 86400000);
            if (!Array.isArray(a))
                throw new Error(JSON.stringify(a));
            continuity(a);
        }
    });
});
