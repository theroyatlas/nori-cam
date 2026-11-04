import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { handle } from '../src/worker/index.ts';
import type { GiftEnv } from '../src/worker/cam/gifts.ts';
import { sha256Hex } from '../src/worker/limits.ts';
import { validate } from '../src/worker/cam/validate.ts';
import { normalizePlacement, placementFrom } from '../src/worker/cam/placement.ts';
import { snapshot } from '../src/worker/cam/store.ts';
import { poseAt } from '../public/cam-shared.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

// Synthetic hot mug card from the D1fix7 evidence: steaming household mug
// whose card says placement "surface". No real photo data is used anywhere.
function mugCard(placement: unknown, hazards = [{ kind: 'hot', parts: ['inside', 'opening'], states: ['steaming'] }]) {
  return {
    name: 'Steaming Mug', category: 'household', size: 'S', height: 'mid',
    tags: ['portable'], sensations: { warm: 0.9 },
    parts: [
      { kind: 'inside', label: 'inside', side: 'front', height: 'low' },
      { kind: 'opening', label: 'mug opening', side: 'front', height: 'low' },
      { kind: 'handle', label: 'mug handle', side: 'right', height: 'low' },
    ],
    states: ['steaming', 'empty'],
    hazards,
    space: { cm: { w: 12, d: 9, h: 10 }, blocks: false, placement,
      movable: { push: false, rotate: false, stack: false }, state_cm: {} },
    affordances: [], beyond_executor: [], summary: 'A steaming mug.',
  };
}

function observeSteam() {
  return {
    verb: 'observe steam', sensations: { warm: 0.5 }, approach: 'front',
    target_part: 'opening', contact: 'none',
    steps: [{ p: 'move_to', approach: 'front' }, { p: 'hold_pose', pose: 'look-up', ms: 1500 }],
    end_state: null, cooldown_min: 10,
  };
}

function touchHandle() {
  return {
    verb: 'touch handle', sensations: { warm: 0.5 }, approach: 'right',
    target_part: 'handle', contact: 'touch',
    steps: [{ p: 'move_to', approach: 'right' }, { p: 'touch', part: 'handle', pose: 'wave', ms: 1000 }],
    end_state: null, cooldown_min: 10,
  };
}

function setup() {
  const base = database();
  base.sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const values = new Map<string, { value: unknown; options: any }>();
  const kv = {
    async put(key: string, value: unknown, options: any) { values.set(key, { value, options }); },
    async delete(key: string) { values.delete(key); },
    async getWithMetadata(key: string) {
      const item = values.get(key);
      return { value: item?.value ?? null, metadata: item?.options.metadata ?? null };
    },
    async get(key: string) { return values.get(key)?.value ?? null; },
  } as unknown as KVNamespace;
  const env: GiftEnv = { ...base.env, MEDIA: kv, MEDIA_UPLOAD_TOKEN: 'fixture-token', GH_DISPATCH_TOKEN: 'fixture-gh' };
  const dispatch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  async function call(path: string, body?: unknown, headers: Record<string, string> = {}, at = NOW) {
    const form = body instanceof FormData;
    return handle(new Request('https://fixture' + path, {
      method: path.includes('/source/') ? 'GET' : 'POST',
      headers: { ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
        'CF-Connecting-IP': '192.0.2.1', ...headers },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    }), env, { now: () => at, fetch: dispatch });
  }
  async function photo(idem = 'photo-one', bytes = PNG, type = 'image/png') {
    env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const form = new FormData();
    form.set('idem', idem);
    form.set('file', new Blob([bytes], { type }), 'gift.png');
    return call('/api/gift/photo', form, { 'X-Nori-Code': 'owner-fixture' });
  }
  const sample = () => JSON.parse(readFileSync(new URL('../sample/cam/ingest-gift-ready.json', import.meta.url), 'utf8'));
  async function ready(id: string, transform: (body: any) => void = () => {}) {
    const body = sample();
    body.gift_id = id;
    body.sprite = `/media/gift-${id}.png`;
    transform(body);
    values.set(`gift-${id}.png`, { value: PNG, options: {} });
    const result = await call('/api/ingest', body, { Authorization: 'Bearer fixture-token' });
    values.delete(`gift-${id}.png`);
    return result;
  }
  return { ...base, env, values, call, photo, dispatch, ready };
}

function mugEnvelope(id: string, placement: unknown, hazards?: { kind: string; parts: string[]; states: string[] }[]) {
  return (body: any) => {
    body.name = 'Steaming Mug';
    body.size = 'S';
    body.initial_state = 'steaming';
    body.object_card = mugCard(placement, hazards);
    body.interactions = [observeSteam(), touchHandle()];
  };
}

function compiledByVerb(t: ReturnType<typeof setup>, id: string) {
  const rows = t.sql.prepare(
    `SELECT spec, status FROM interactions WHERE object_id=? AND source='compiled'`).all('o_' + id) as any[];
  const out = new Map<string, string>();
  for (const row of rows) out.set(JSON.parse(String(row.spec)).verb, String(row.status));
  return out;
}

function understoodPayload(t: ReturnType<typeof setup>, id: string) {
  const row = t.sql.prepare(`SELECT payload FROM events WHERE id=?`).get(`understood:${id}`) as any;
  return JSON.parse(String(row.payload));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('live network forbidden'); }));
});

describe('d1fix7 surface placement normaliser', () => {
  it('normalises placement values', () => {
    expect(normalizePlacement('wall')).toBe('wall');
    for (const raw of ['surface', 'table', '', undefined, null, 'shelf', 42, 'FLOOR']) {
      expect(normalizePlacement(raw)).toBe('floor');
    }
    expect(normalizePlacement('floor')).toBe('floor');
  });

  it('reports the original card value only when normalised', () => {
    expect(placementFrom('wall')).toBeNull();
    expect(placementFrom('floor')).toBeNull();
    expect(placementFrom('surface')).toBe('surface');
    expect(placementFrom('table')).toBe('table');
    expect(placementFrom('')).toBe('other');
    expect(placementFrom(undefined)).toBe('other');
    expect(placementFrom('FLOOR')).toBe('other');
  });

  it('unwraps the surface hot mug onto the floor, off Nori, with steam observable', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo('surface-mug')).json() as any;
    const response = await t.ready(id, mugEnvelope(id, 'surface'));
    expect(response.status).toBe(200);

    const snap = await snapshot(t.db, NOW);
    const object = snap.objects.find(o => o.id === 'o_' + id)!;
    expect(object.status).toBe('placed');
    expect(object.placement).toBe('floor');
    // Nori stands at (2,6) in the default seed world; the hot gift must not land on her.
    const nori = poseAt(snap.segments, NOW) || { x: 2, y: 6 };
    expect([object.x, object.y]).not.toEqual([Math.round(nori.x), Math.round(nori.y)]);

    // The stored card keeps what Spark said.
    const stored = JSON.parse(String(t.sql.prepare(
      `SELECT card FROM object_cards WHERE object_id=?`).get('o_' + id)!.card));
    expect(stored.space.placement).toBe('surface');

    // The normalisation is recorded on the existing event.
    expect(understoodPayload(t, id)).toMatchObject({ placement_from: 'surface' });

    // The compiled "observe steam" interaction is accepted, and the checker agrees.
    expect(compiledByVerb(t, id).get('observe steam')).toBe('accepted');
    const world = { objects: snap.objects };
    expect(validate(world as never, object as never, observeSteam(), [2, 6]).status).toBe('accepted');

    // "touch handle" behaviour under the unchanged hazard rules.
    const touch = validate(world as never, object as never, touchHandle(), [2, 6]);
    expect(compiledByVerb(t, id).get('touch handle')).toBe(touch.status);
    expect(touch.status).toBe('accepted');
  });

  it('places a non-hazard surface card on the floor too', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo('surface-plain')).json() as any;
    const response = await t.ready(id, mugEnvelope(id, 'surface', []));
    expect(response.status).toBe(200);
    const snap = await snapshot(t.db, NOW);
    const object = snap.objects.find(o => o.id === 'o_' + id)!;
    expect(object.status).toBe('placed');
    expect(object.placement).toBe('floor');
    expect(understoodPayload(t, id)).toMatchObject({ placement_from: 'surface' });
  });

  it('leaves a wall card unchanged with no placement_from', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo('wall-card')).json() as any;
    const response = await t.ready(id, mugEnvelope(id, 'wall', []));
    expect(response.status).toBe(200);
    const snap = await snapshot(t.db, NOW);
    const object = snap.objects.find(o => o.id === 'o_' + id)!;
    expect(object.status).toBe('placed');
    expect(object.placement).toBe('wall');
    const payload = understoodPayload(t, id);
    expect(payload).not.toHaveProperty('placement_from');
    const stored = JSON.parse(String(t.sql.prepare(
      `SELECT card FROM object_cards WHERE object_id=?`).get('o_' + id)!.card));
    expect(stored.space.placement).toBe('wall');
  });
});
