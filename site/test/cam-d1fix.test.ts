import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { handle } from '../src/worker/index.ts';
import type { GiftEnv } from '../src/worker/cam/gifts.ts';
import { sha256Hex } from '../src/worker/limits.ts';
import { validate, validateCard, hazardCardErrors, fallbackSpec, CONTRACT_VERSION, hazardsActiveInState } from '../src/worker/cam/validate.ts';
import { intentTemplates } from '../src/worker/cam/intent-plan.ts';
import { operationCells, bfsPath, placementOk, hazardActiveInState } from '../public/cam-shared.js';
import { planNext, planNextWithRefusals } from '../src/worker/cam/plan.ts';
import { gateSegments, isSafePartContact } from '../src/worker/cam/segment-gate.ts';
import { replan } from '../src/worker/cam/replan.ts';
import { advance } from '../src/worker/cam/timeline.ts';
import { initialState } from '../src/worker/cam/engine.ts';
import type { CamObject } from '../src/worker/cam/types.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

function toyCard() {
  return {
    name: 'toy box', category: 'toy', size: 'M', height: 'low', tags: ['enclosed'],
    sensations: { shelter: 0.8 },
    parts: [{ kind: 'inside', label: 'inside', side: 'front', height: 'low' }],
    states: ['default'], hazards: [],
    space: { cm: { w: 40, d: 40, h: 20 }, blocks: false, placement: 'floor',
      movable: { push: false, rotate: false, stack: false }, state_cm: {} },
    affordances: [], beyond_executor: [], summary: 'A toy box.',
  };
}

function mugCard() {
  return {
    name: 'Black Textured Mug', category: 'household', size: 'S', height: 'mid',
    tags: ['portable'], sensations: { warm: 0.9 },
    parts: [
      { kind: 'opening', label: 'mug opening', side: 'top', height: 'low' },
      { kind: 'handle', label: 'mug handle', side: 'right', height: 'low' },
    ],
    states: ['empty', 'steaming hot'],
    hazards: [{ kind: 'hot', parts: ['opening'], states: ['steaming hot'] }],
    space: { cm: { w: 12, d: 10, h: 11 }, blocks: false, placement: 'floor',
      movable: { push: true, rotate: true, stack: false }, state_cm: {} },
    affordances: [], beyond_executor: ['drinking liquid'],
    summary: 'Black textured mug holding hot steaming drink.',
  };
}

function mugObject(card: ReturnType<typeof mugCard>, state = 'steaming hot'): CamObject {
  return {
    id: 'o_mug', kind: 'household', x: 5, y: 5, z: 0, footprint: [[0, 0]],
    rotation: 0, blocks: false, placement: 'floor', status: 'placed', state,
    size: 'S', tags: ['portable'], sprite: '/media/gift-mug.png',
    origin: { type: 'photo_gift' }, card: card as unknown as CamObject['card'],
  };
}

function sniff() {
  return {
    verb: 'sniff steam', sensations: { warm: 0.8 }, approach: 'front',
    target_part: 'opening', contact: 'none',
    steps: [{ p: 'move_to', approach: 'front', gait: 'walk', ms: 3000 },
      { p: 'hold_pose', pose: 'look-up', ms: 2000 }],
    end_state: 'steaming hot', cooldown_min: 5,
  };
}

function touchHot() {
  return {
    verb: 'touch mug gently', sensations: { warm: 0.6 }, approach: 'front',
    target_part: 'opening', contact: 'touch',
    steps: [{ p: 'move_to', approach: 'front', gait: 'walk', ms: 2500 },
      { p: 'touch', part: 'opening', pose: 'wave', ms: 1000 },
      { p: 'wait', pose: 'sit', ms: 2000 }],
    end_state: 'steaming hot', cooldown_min: 10,
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
  async function photo(idem = 'd1fix-photo', bytes = PNG, type = 'image/png') {
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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('live network forbidden'); }));
});

describe('d1fix contract version', () => {
  it('pins the prompt/contract version', () => {
    expect(CONTRACT_VERSION).toBe('cam-d1fix-2');
  });
  it('the safe fallback compiles for a hazardous object', () => {
    const object = mugObject(mugCard());
    const result = validate({ objects: [object] }, object, fallbackSpec(), [5, 6]);
    expect(result.status).toBe('accepted');
    expect(result.spec?.contact).toBe('none');
    expect(result.spec?.steps.some(s => ['touch', 'push', 'carry', 'drop', 'climb', 'sleep', 'set_object_state'].includes(s.p))).toBe(false);
  });
});

describe('d1fix worker validation', () => {
  it('accepts an ordinary object with a legal contact interaction', () => {
    const card = toyCard();
    const object = mugObject(card as unknown as ReturnType<typeof mugCard>);
    object.id = 'o_toy';
    object.tags = ['enclosed'];
    const touch = {
      verb: 'touch box', sensations: { shelter: 0.5 }, approach: 'front',
      target_part: 'inside', contact: 'touch',
      steps: [{ p: 'move_to', part: 'inside' }, { p: 'touch', part: 'inside', ms: 1000 }],
      end_state: null, cooldown_min: 10,
    };
    expect(validateCard(card)).toEqual([]);
    const result = validate({ objects: [object] }, object, touch, [2, 6]);
    expect(result.status).toBe('accepted');
  });
  it('accepts non-contact sniffing of the hot mug but refuses hot contact', () => {
    const object = mugObject(mugCard());
    const world = { objects: [object] };
    const ok = validate(world, object, sniff(), [5, 6]);
    expect(ok.status).toBe('accepted');
    const bad = validate(world, object, touchHot(), [5, 6]);
    expect(bad.status).toBe('rejected');
    expect(bad.checks.some(c => !c.ok && (c.reason || '').includes('hazard hot'))).toBe(true);
  });
  it('treats an unknown object state as hazardous (fail closed)', () => {
    // A photo gift from the old contract starts in 'default', which is not a
    // declared card state: every state-limited hazard counts as active.
    const object = mugObject(mugCard(), 'default');
    const world = { objects: [object] };
    const bad = validate(world, object, { ...touchHot(), end_state: null }, [5, 6]);
    expect(bad.status).toBe('rejected');
    expect(bad.checks.some(c => !c.ok && (c.reason || '').includes('hazard hot'))).toBe(true);
  });
  it('refuses interactions targeting undeclared parts', () => {
    const object = mugObject(mugCard());
    const result = validate({ objects: [object] }, object,
      { ...sniff(), contact: 'touch', steps: [{ p: 'touch', part: 'viewport', ms: 1000 }] }, [5, 6]);
    expect(result.status).toBe('rejected');
    expect(result.checks.some(c => !c.ok && c.check.endsWith('.part'))).toBe(true);
  });
  it('refuses unknown primitives and keeps beyond-executor actions as gaps', () => {
    const object = mugObject(mugCard());
    const result = validate({ objects: [object] }, object,
      { verb: 'fly over', sensations: { warm: 0.5 }, steps: [{ p: 'teleport', part: 'front', ms: 500 }],
        end_state: null, cooldown_min: 5 }, [5, 6]);
    expect(result.status).toBe('rejected');
  });
  it('refuses photo cards without a hazard list', () => {
    const card = mugCard() as unknown as Record<string, unknown>;
    delete card.hazards;
    expect(hazardCardErrors(card).some(e => e.includes('hazards'))).toBe(true);
  });
});

describe('d1fix2 manager counterexamples (rework 1)', () => {
  const states = ['empty', 'steaming hot'];
  const card = (hazards: unknown[], openingHeight = 'low') => ({
    name: 'Black Textured Mug', category: 'household', size: 'S', height: 'low', tags: ['portable'],
    sensations: { warm: 0.9 },
    parts: [{ kind: 'opening', label: 'opening', side: 'front', height: openingHeight },
      { kind: 'handle', label: 'handle', side: 'right', height: 'low' }],
    states, hazards,
    space: { cm: { w: 12, d: 10, h: 11 }, blocks: false, placement: 'floor',
      movable: { push: true, rotate: true, stack: false }, state_cm: {} },
    affordances: [], beyond_executor: [], summary: 'mug',
  });
  const obj = (c: ReturnType<typeof card>, state = 'default') => ({
    id: 'o_mug', kind: 'household', x: 5, y: 5, z: 0, footprint: [[0, 0]] as [number, number][],
    rotation: 0, blocks: false, placement: 'floor', status: 'placed', state, size: 'S', tags: ['portable'],
    sprite: '/media/gift-mug.png', origin: { type: 'photo_gift' },
    card: c as unknown as CamObject['card'],
  });
  const touch = (end: string | null) => ({
    verb: 'touch mug', sensations: { warm: 0.5 }, approach: 'front',
    target_part: 'opening', contact: 'touch',
    steps: [{ p: 'move_to', approach: 'front' }, { p: 'touch', part: 'opening', pose: 'wave', ms: 1000 }],
    end_state: end, cooldown_min: 10,
  });
  const carry = {
    verb: 'carry mug', sensations: { warm: 0.5 }, approach: 'front', contact: 'carry',
    steps: [{ p: 'move_to', approach: 'front' }, { p: 'carry' }], end_state: null, cooldown_min: 10,
  };
  const hotStateOnly = [{ kind: 'hot', parts: ['opening'], states: ['steaming hot'] }];
  const hotAllStates = [{ kind: 'hot', parts: ['opening'], states: [] as string[] }];
  function status(o: ReturnType<typeof obj>, spec: unknown) {
    const world = { objects: [o] };
    const r = validate(world as never, o as never, spec, [5, 6]);
    return r;
  }
  it('A: touch on the hot opening with an unknown state is rejected', () => {
    const r = status(obj(card(hotStateOnly)), touch(null));
    expect(r.status).toBe('rejected');
    expect(r.checks.some(c => !c.ok && (c.reason || '').includes('hazard hot'))).toBe(true);
  });
  it('B: touch on the hot opening while steaming hot is rejected', () => {
    expect(status(obj(card(hotStateOnly), 'steaming hot'), touch(null)).status).toBe('rejected');
  });
  it('C: touch ending steaming hot is rejected', () => {
    expect(status(obj(card(hotStateOnly)), touch('steaming hot')).status).toBe('rejected');
  });
  it('D: carry without a named part is whole-object contact and is rejected', () => {
    const r = status(obj(card(hotAllStates)), carry);
    expect(r.status).toBe('rejected');
    expect(r.checks.some(c => !c.ok && (c.reason || '').includes('hazard hot'))).toBe(true);
  });
  it('E: touch on the hot opening with an all-states hazard is rejected', () => {
    expect(status(obj(card(hotAllStates)), touch(null)).status).toBe('rejected');
  });
  it('touch on a safe part while empty stays legal', () => {
    const handleTouch = { ...touch(null), target_part: 'handle',
      steps: [{ p: 'move_to', approach: 'front' }, { p: 'touch', part: 'handle', pose: 'wave', ms: 1000 }] };
    expect(status(obj(card(hotAllStates), 'empty'), handleTouch).status).toBe('accepted');
  });
});

describe('d1fix2 planner runtime state gate', () => {
  const touchIx = {
    id: 'ix-touch', object_id: 'o_mug', action: 'interact',
    spec: {
      verb: 'touch mug gently', sensations: { warm: 0.5 }, approach: 'front',
      target_part: 'opening', contact: 'touch', allowed_states: ['empty'],
      steps: [{ p: 'move_to', approach: 'front' }, { p: 'touch', part: 'opening', pose: 'wave', ms: 1000 }],
      end_state: null, cooldown_min: 10,
    },
  };
  const sniffIx = {
    id: 'ix-sniff', object_id: 'o_mug', action: 'interact',
    spec: {
      verb: 'sniff steam', sensations: { warm: 0.5 }, approach: 'front',
      target_part: 'opening', contact: 'none',
      steps: [{ p: 'move_to', approach: 'front' }, { p: 'hold_pose', pose: 'look-up', ms: 2000 }],
      end_state: null, cooldown_min: 10,
    },
  };
  const mugIn = (state: string) => mugObject(mugCard(), state);
  it('the contact interaction is legal while the mug is empty', () => {
    const o = mugIn('empty');
    expect(validate({ objects: [o] }, o, touchIx.spec, [5, 6]).status).toBe('accepted');
  });
  it('the planner skips the contact interaction once the mug is steaming hot', () => {
    const o = mugIn('steaming hot');
    expect(validate({ objects: [o] }, o, touchIx.spec, [5, 6]).status).toBe('rejected');
    const segments = planNext({
      state: initialState(), objects: [o], interactions: [touchIx, sniffIx] as never,
      position: [5, 6], start_at: 0, world_version: 1,
      intent: { expires_at: 60000, action: 'no-such-action', bonus: 0 },
    });
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every(s => s.interaction !== 'ix-touch')).toBe(true);
    expect(segments.some(s => s.interaction === 'ix-sniff')).toBe(true);
  });
});

describe('d1fix ingest', () => {
  it('refuses content-safety failures, uncertain answers and the person rule', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => { body.content_safety = { ok: false, reason: 'nudity' }; })).status).toBe(422);
    expect((await t.ready(id, body => { delete body.content_safety; })).status).toBe(422);
    expect((await t.ready(id, body => { body.identifiable_person_present = true; })).status).toBe(422);
    expect((await t.ready(id, body => { delete body.object_card.hazards; })).status).toBe(422);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
  });
  it('refuses the legacy D1 contract without crashing', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const response = await t.ready(id, body => {
      delete body.contract_version;
      delete body.content_safety;
      delete body.identifiable_person_present;
      body.safe = false;
      body.person_present = false;
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'unsupported contract version' });
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
  });
  it('compiles the safe sniff, refuses hot touch, and records the version', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const card = mugCard();
    const response = await t.ready(id, body => {
      body.name = card.name;
      body.size = card.size;
      body.object_card = card;
      body.initial_state = 'steaming hot';
      body.interactions = [sniff(), touchHot()];
    });
    expect(response.status).toBe(200);
    const rows = t.sql.prepare("SELECT id,status,spec FROM interactions WHERE source='compiled' ORDER BY id").all() as any[];
    expect(rows.map(r => r.status).sort()).toEqual(['accepted', 'rejected']);
    const event = t.sql.prepare("SELECT payload FROM events WHERE type='object_understood'").get() as any;
    expect(JSON.parse(event.payload)).toMatchObject({ contract_version: 'cam-d1fix-2' });
    expect(t.sql.prepare('SELECT state FROM objects WHERE id=?').get('o_' + id)).toMatchObject({ state: 'steaming hot' });
  });
  it('refuses a missing or non-card initial state and enters the world in it', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => { delete body.initial_state; })).status).toBe(422);
    expect((await t.ready(id, body => { body.initial_state = 'lava'; })).status).toBe(422);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
  });
  it('refuses the real D1 Spark output shape as legacy', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const response = await t.ready(id, body => {
      delete body.contract_version;
      delete body.content_safety;
      delete body.identifiable_person_present;
      delete body.initial_state;
      body.safe = false;
      body.person_present = false;
      body.object_card = {
        name: 'Black Textured Mug', category: 'household', size: 'S', height: 'mid',
        tags: ['portable', 'water'], sensations: { warm: 0.9 },
        parts: [
          { kind: 'opening', label: 'mug opening', side: 'top', height: 'mid' },
          { kind: 'handle', label: 'mug handle', side: 'right', height: 'mid' },
        ],
        states: ['empty', 'steaming hot'],
        space: { cm: { w: 12, d: 10, h: 11 }, blocks: false, placement: 'surface',
          movable: { push: true, rotate: true, stack: false }, state_cm: {} },
        affordances: [{ verb: 'hold warm drink', effect_text: 'keeps drink hot and steaming', sensations: ['warm'] }],
        beyond_executor: ['drinking liquid'],
        summary: 'Black textured mug holding hot steaming drink on table.',
      };
      body.interactions = [{
        verb: 'touch mug gently', sensations: { warm: 0.6 },
        steps: [{ p: 'move_to', part: 'front', gait: 'walk', ms: 2500 },
          { p: 'touch', part: 'front', pose: 'wave', ms: 1000 },
          { p: 'wait', pose: 'sit', ms: 2000 }],
        end_state: 'steaming hot', cooldown_min: 10,
      }];
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'unsupported contract version' });
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
  });
  it('falls back to an explicit safe interaction when nothing is legal', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const card = mugCard();
    const response = await t.ready(id, body => {
      body.name = card.name;
      body.size = card.size;
      body.object_card = card;
      body.initial_state = 'steaming hot';
      body.interactions = [touchHot()];
    });
    expect(response.status).toBe(200);
    expect(t.sql.prepare("SELECT status FROM interactions WHERE source='compiled'").get()?.status).toBe('rejected');
    const fallback = t.sql.prepare("SELECT status,spec FROM interactions WHERE source='fallback'").get() as any;
    expect(fallback?.status).toBe('accepted');
    const spec = JSON.parse(fallback.spec);
    expect(spec.contact).toBe('none');
    expect(spec.steps.every((s: any) => ['move_to', 'face', 'hold_pose', 'wait'].includes(s.p))).toBe(true);
    const compiled = t.sql.prepare("SELECT spec FROM interactions WHERE source='compiled'").all() as any[];
    expect(compiled.every(r => !JSON.parse(r.spec).steps.some((s: any) => s.p === 'teleport'))).toBe(true);
  });
  it('keeps beyond-executor actions as capability gaps, never compiled', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const response = await t.ready(id, body => {
      body.interactions = [{ verb: 'fly over', sensations: {}, steps: [{ p: 'teleport', ms: 500 }],
        end_state: null, cooldown_min: 5 }];
      body.object_card.beyond_executor = ['teleport'];
    });
    expect(response.status).toBe(200);
    expect(t.sql.prepare("SELECT status FROM interactions WHERE source='compiled'").get()?.status).toBe('rejected');
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='capability_gap'").get()?.n).toBeGreaterThan(0);
  });
});

describe('d1fix3 interaction-safety holes (F1-F7)', () => {
  const hotObject = (state = 'steaming hot') => mugObject(mugCard(), state);
  const playIntent = (id = 'play:1') => ({ id, action: 'play' as const, object_id: 'o_mug',
    window_minutes: 60, reason_tag: 'test', summary: 'Play.', expires_at: 60000 });

  it('F1 refuses envelopes carrying legacy safe/person_present whatever the values', async () => {
    const t = setup();
    const patches: [string, (b: any) => void][] = [
      ['safe-false', b => { b.safe = false; }],
      ['safe-true', b => { b.safe = true; }],
      ['person-true', b => { b.person_present = true; }],
      ['person-false', b => { b.person_present = false; }],
    ];
    for (const [name, patch] of patches) {
      const { gift_id: id } = await (await t.photo('f1-' + name)).json() as any;
      const response = await t.ready(id, patch);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: 'legacy safety field' });
    }
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
  });

  it('F2 play templates keep allowed_states, target_part and contact', () => {
    const object = hotObject();
    const restricted = { id: 'ix-restricted', object_id: 'o_mug', action: 'interact',
      spec: { verb: 'touch handle', sensations: { motion: 0.8 }, approach: 'front',
        target_part: 'handle', contact: 'touch', allowed_states: ['empty'],
        steps: [{ p: 'move_to', approach: 'front' }, { p: 'touch', part: 'handle', pose: 'wave', ms: 1000 }],
        end_state: null, cooldown_min: 10 } };
    const [template] = intentTemplates([playIntent()], [object], [restricted], 0);
    expect(template.spec).toMatchObject({ contact: 'touch', target_part: 'handle', allowed_states: ['empty'] });
    // On the hot mug the derived template is rejected like the original ...
    expect(validate({ objects: [object] }, object, template.spec, [5, 6]).status).toBe('rejected');
    // ... and the planner emits no contact or movement for it.
    const segments = planNext({ state: initialState(), objects: [object],
      interactions: [restricted, template], intents: [playIntent()], position: [5, 6],
      start_at: 0, world_version: 1 });
    expect(segments.some(s => s.primitive === 'touch')).toBe(false);
    expect(segments.flatMap(s => s.effects).some(e => e.e === 'move_object')).toBe(false);
  });

  it('F3 the planner adds no movement to an object with an active hazard', () => {
    const object = hotObject();
    const sniffIx = { id: 'ix-sniff', object_id: 'o_mug', action: 'interact',
      spec: { verb: 'sniff steam', sensations: { motion: 0.8 }, approach: 'front',
        target_part: 'opening', contact: 'none',
        steps: [{ p: 'move_to', approach: 'front' }, { p: 'hold_pose', pose: 'look-up', ms: 2000 }],
        end_state: null, cooldown_min: 10 } };
    const [template] = intentTemplates([playIntent()], [object], [sniffIx], 0);
    expect(template.spec.contact).toBe('none');
    const segments = planNext({ state: initialState(), objects: [object],
      interactions: [sniffIx, template], intents: [playIntent()], position: [5, 4],
      start_at: 0, world_version: 1 });
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.flatMap(s => s.effects).some(e => e.e === 'move_object')).toBe(false);
    for (const s of segments)
      for (const [x, y] of s.path) expect(x === 5 && y === 5).toBe(false);
  });

  it('F4 push counts as whole-object contact for hazards; safe-part touch stays legal', () => {
    const card = mugCard();
    card.hazards = [{ kind: 'unstable', parts: ['opening'], states: [] as string[] }];
    const object = mugObject(card as never, 'empty');
    const push = { verb: 'push mug', sensations: {}, target_part: 'handle', contact: 'push',
      steps: [{ p: 'move_to', approach: 'front' }, { p: 'push', part: 'handle', dir: [0, -1], ms: 1000 }],
      end_state: null, cooldown_min: 1 };
    const rejected = validate({ objects: [object] }, object, push, [5, 6]);
    expect(rejected.status).toBe('rejected');
    expect(rejected.checks.some(c => !c.ok && (c.reason || '').includes('hazard unstable'))).toBe(true);
    const touch = { verb: 'touch handle', sensations: {}, target_part: 'handle', contact: 'touch',
      steps: [{ p: 'move_to', approach: 'front' }, { p: 'touch', part: 'handle', pose: 'wave', ms: 1000 }],
      end_state: null, cooldown_min: 10 };
    expect(validate({ objects: [object] }, object, touch, [5, 6]).status).toBe('accepted');
  });

  it('F5 planned paths and standing cells avoid a hazardous object', () => {
    const object = hotObject();
    const world = { objects: [object] };
    expect(operationCells(object, 'front', world)).not.toContainEqual([5, 5]);
    const path = bfsPath(world, [5, 4], [5, 6]);
    expect(path).not.toBeNull();
    expect(path!.some(([x, y]) => x === 5 && y === 5)).toBe(false);
    const segments = planNext({ state: initialState(), objects: [object],
      interactions: [{ id: 'ix-fallback', object_id: 'o_mug', action: 'interact', spec: fallbackSpec() }],
      position: [5, 4], start_at: 0, world_version: 1 });
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments)
      for (const [x, y] of s.path) expect(x === 5 && y === 5).toBe(false);
  });

  it('F6 an approach side resolves as a side, never through a part lookup', () => {
    const card = mugCard();
    card.parts = [{ kind: 'front', label: 'front', side: 'left', height: 'low' }];
    card.hazards = [];
    const object = { ...mugObject(card as never, 'empty'), blocks: true };
    // Front of [5,5] is [5,6], not the part's left side [4,5].
    expect(operationCells(object, 'front', { objects: [object] })).toEqual([[5, 6]]);
    expect(fallbackSpec('back')).toMatchObject({ approach: 'back' });
  });

  it('F6 the fallback tries the other sides when the front is unreachable', () => {
    const edge = { ...hotObject('empty'), blocks: true, x: 5, y: 7 };
    const world = { objects: [edge] };
    expect(validate(world, edge, fallbackSpec('front'), [5, 5]).status).toBe('rejected');
    expect(validate(world, edge, fallbackSpec('back'), [5, 5]).status).not.toBe('rejected');
  });

  it('F6 ingest records an explicit outcome instead of silence when no side is legal', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo('f6-boxed')).json() as any;
    // Box Nori in so no approach side is reachable from her cell.
    t.sql.prepare('UPDATE objects SET x=?,y=? WHERE id=?').run(1, 6, 'o_cardboard_box');
    t.sql.prepare('UPDATE objects SET x=?,y=? WHERE id=?').run(3, 6, 'o_slipper');
    t.sql.prepare('UPDATE objects SET x=?,y=? WHERE id=?').run(2, 7, 'o_computer_desk');
    const response = await t.ready(id, body => {
      body.interactions = [];
      body.object_card.space.blocks = true;
    });
    expect(response.status).toBe(200);
    expect(t.sql.prepare("SELECT status FROM interactions WHERE source='fallback'").get()).toMatchObject({ status: 'rejected' });
    const event = t.sql.prepare("SELECT payload FROM events WHERE type='interaction_rejected' AND payload LIKE '%no safe interaction%'").get();
    expect(event).not.toBeNull();
  });

describe('d1fix4 final segment gate (P1-a, P1-b, P1-c, P2)', () => {
  const hotMug = (state = 'steaming hot') => mugObject(mugCard(), state);
  const playInt = (id = 'play:1') => ({ id, action: 'play' as const, object_id: 'o_mug',
    window_minutes: 60, reason_tag: 'test', summary: 'Play.', expires_at: 60000 });
  let segId = 1000;
  const seg = (primitive: string, path: [number, number][], extra: any = {}): any => {
    const id = segId++;
    return { id, start_at: id * 1000, end_at: id * 1000 + 500, action: 'interact', primitive,
      pose: 'walk', facing: 1, path, z: 0, target: 'o_mug', part: null, carrying: null,
      interaction: 'ix', effects: [], source: 'interaction:ix', world_version: 1,
      cut_at: null, settled_at: null, superseded_at: null, trigger: null, ...extra };
  };

  it('shares one hazard-active test between cam-shared.js and validate.ts', () => {
    const card = mugCard() as any;
    expect(hazardActiveInState(card, 'empty')).toBe(false);
    for (const state of ['steaming hot', 'default', 'mystery'])
      expect(hazardActiveInState(card, state)).toBe(true);
    for (const state of ['empty', 'steaming hot', 'default', 'mystery'])
      expect(hazardActiveInState(card, state)).toBe(hazardsActiveInState(card, state));
    expect(hazardActiveInState({ states: [], hazards: [] }, 'empty')).toBe(false);
  });

  it('P1-a: ingest puts a hazardous non-blocking gift beside Nori, never on her', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo('p1a-hot')).json() as any;
    const response = await t.ready(id, (body: any) => {
      body.interactions = [];
      body.object_card.space.blocks = false;
      body.object_card.hazards = [{ kind: 'hot', parts: ['inside'], states: [] }];
      t.sql.prepare('UPDATE objects SET status=? WHERE id<>?').run('stored', 'o_' + id);
      t.sql.prepare('UPDATE objects SET x=2,y=6 WHERE id=?').run('o_' + id);
    });
    expect(response.status).toBe(200);
    const obj = t.sql.prepare('SELECT x,y FROM objects WHERE id=?').get('o_' + id) as any;
    expect([obj.x, obj.y]).not.toEqual([2, 6]);
    expect(t.sql.prepare('SELECT id FROM events WHERE id=?').get(`placed-off-nori:${id}`)).not.toBeNull();
    for (const row of t.sql.prepare('SELECT path FROM segments WHERE superseded_at IS NULL').all() as any[]) {
      for (const [x, y] of JSON.parse(row.path as string) as [number, number][])
        expect(Math.round(x) === obj.x && Math.round(y) === obj.y).toBe(false);
    }
  });

  it('P1-b: recovery routes around a hazardous cell instead of into it', () => {
    const calmCard = mugCard() as never;
    (calmCard as any).hazards = [];
    const obstacle = { ...mugObject(calmCard, 'empty'), id: 'o_box', blocks: true };
    const hot = hotMug();
    hot.x = 5;
    hot.y = 4;
    const segments = planNext({ state: initialState(), objects: [obstacle, hot], interactions: [],
      position: [5, 5], start_at: 0, world_version: 1 });
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0]).toMatchObject({ action: 'recover' });
    for (const s of segments)
      for (const [x, y] of s.path) expect(x === 5 && y === 4).toBe(false);
  });

  it('already on a hazard: conservatively stops and records the refusal', () => {
    const { segments, refusals } = planNextWithRefusals({ state: initialState(), objects: [hotMug()],
      interactions: [], position: [5, 5], start_at: 0, world_version: 1 });
    expect(refusals[0].reason).toMatch(/no safe exit/);
    expect(segments[0]).toMatchObject({ primitive: 'hold_pose', path: [[5, 5]] });
    expect(segments[0].effects[0]).toMatchObject({ e: 'hazard_refused' });
  });

  it('planner-error fallback is gated and records a refusal on an occupied hazard', async () => {
    const t = database();
    const card = JSON.parse((t.sql.prepare('SELECT card FROM object_cards WHERE id=?')
      .get('card:o_slipper') as any).card);
    card.hazards = [{ kind: 'hot', parts: [], states: [] }];
    t.sql.prepare('UPDATE object_cards SET card=? WHERE id=?').run(JSON.stringify(card), 'card:o_slipper');
    t.sql.prepare("UPDATE objects SET status='stored' WHERE id<>'o_slipper'").run();
    t.sql.prepare("UPDATE objects SET status='placed',x=2,y=6 WHERE id='o_slipper'").run();
    await advance(t.env, NOW, 'read', { planner: () => { throw new Error('fixture'); } });
    const row = t.sql.prepare('SELECT primitive,path,effects FROM segments WHERE superseded_at IS NULL').get() as any;
    expect(row.primitive).toBe('hold_pose');
    expect(JSON.parse(row.path)).toEqual([[2, 6]]);
    expect(JSON.parse(row.effects)[0].e).toBe('hazard_refused');
    const event = t.sql.prepare("SELECT payload FROM events WHERE type='interaction_rejected'").get() as any;
    expect(JSON.parse(event.payload).reason).toMatch(/no safe exit/);
  });

  it('P1-c: replan never carries a hazard-active stored gift', async () => {
    const t = setup();
    const card = JSON.parse((t.sql.prepare('SELECT card FROM object_cards WHERE id=?')
      .get('card:o_slipper') as any).card);
    card.hazards = [{ kind: 'hot', parts: ['front'], states: [] }];
    delete card.prop_poses;
    t.sql.prepare('UPDATE object_cards SET card=? WHERE id=?').run(JSON.stringify(card), 'card:o_slipper');
    t.sql.prepare('UPDATE objects SET status=?,origin=? WHERE id=?')
      .run('stored', JSON.stringify({ type: 'photo_gift', gift_id: 'fixture' }), 'o_slipper');
    t.sql.prepare(`INSERT INTO events(id,insert_token,at,type,actor,payload,public,world_version,handled_version)
      VALUES (?,?,?,?,?,?,?,?,NULL)`)
      .run('gift:review', 'fixture', NOW, 'gift_arrived', 'visitor',
        JSON.stringify({ stored_id: 'o_slipper' }), 1, 1);
    expect(await replan(t.db, NOW)).toBe(true);
    expect(t.sql.prepare("SELECT id FROM segments WHERE source='storage:carry' AND superseded_at IS NULL")
      .all()).toEqual([]);
    const evt = t.sql.prepare("SELECT payload FROM events WHERE id LIKE 'storage-refused:%'").get() as any;
    expect(evt).not.toBeNull();
    expect(JSON.parse(evt.payload).reason).toMatch(/hazard active/);
  });

  it('P2: later paths are planned against the armed state, not the entry state', () => {
    const card = { name: 'Mug', category: 'household', size: 'S', height: 'low',
      tags: ['portable', 'pushable'], sensations: { motion: 0.8 },
      parts: [{ kind: 'opening', label: 'opening', side: 'front', height: 'low' },
        { kind: 'handle', label: 'handle', side: 'right', height: 'low' }],
      states: ['empty', 'hot'], hazards: [{ kind: 'hot', parts: ['opening'], states: ['hot'] }],
      space: { cm: { w: 12, d: 10, h: 11 }, blocks: false, placement: 'floor',
        movable: { push: true, rotate: true, stack: false }, state_cm: {} },
      affordances: [], beyond_executor: [], summary: 'mug' };
    const obj: CamObject = { id: 'o_mug', kind: 'household', x: 5, y: 5, z: 0, footprint: [[0, 0]],
      rotation: 0, blocks: false, placement: 'floor', status: 'placed', state: 'empty', size: 'S',
      tags: card.tags, sprite: '/media/gift-mug.png', state_sprites: { empty: 'empty.png', hot: 'hot.png' },
      origin: { type: 'photo_gift' }, card: card as any };
    const spec = { verb: 'heat and inspect', sensations: {},
      steps: [{ p: 'move_to', approach: 'front' }, { p: 'set_object_state', part: 'handle', state: 'hot' },
        { p: 'move_to', approach: 'back' }, { p: 'hold_pose', pose: 'look-up', ms: 1500 }],
      end_state: null, cooldown_min: 1 };
    expect(validate({ objects: [obj] }, obj, spec, [5, 6]).status).toBe('accepted');
    const segments = planNext({ state: initialState(), objects: [obj],
      interactions: [{ id: 'heat', object_id: 'o_mug', action: 'interact', spec: spec as any }],
      position: [5, 6], start_at: 0, world_version: 1 });
    const armedAt = segments.findIndex(s => (s.effects || []).some((e: any) => e.e === 'set_state' && e.state === 'hot'));
    expect(armedAt).toBeGreaterThanOrEqual(0);
    for (const s of segments.slice(armedAt + 1))
      for (const [x, y] of s.path) expect(x === 5 && y === 5).toBe(false);
  });

  it('gate: contact and movement on an armed hazard become a recorded hold', () => {
    const hot = hotMug();
    const gated = gateSegments(
      [seg('move_to', [[5, 6], [5, 6]]), seg('carry', [[5, 6]])], [hot], [5, 6]);
    expect(gated.refusals.length).toBe(1);
    expect(gated.refusals[0].reason).toMatch(/carry.*hazard active/);
    expect(gated.segments.length).toBe(2);
    expect(gated.segments[1]).toMatchObject({ primitive: 'hold_pose', target: null });
    expect(gated.segments[1].effects[0]).toMatchObject({ e: 'hazard_refused' });
    const touch = gateSegments([seg('touch', [[5, 6]], { part: 'handle' })], [hot], [5, 6]);
    expect(touch.refusals).toEqual([]);
    expect(touch.segments.length).toBe(1);
    expect(isSafePartContact(hot.card, 'handle', 'steaming hot')).toBe(true);
    expect(isSafePartContact(hot.card, 'opening', 'steaming hot')).toBe(false);
  });

  it('gate: contact after arming truncates the tail with a recorded hold', () => {
    const obj = { ...mugObject(mugCard(), 'empty'), state_sprites: { 'steaming hot': 'hot.png' } };
    const plan = [seg('move_to', [[5, 6], [5, 4]], { effects: [{ e: 'set_state', state: 'steaming hot' }] }),
      seg('touch', [[5, 4]], { part: 'opening' })];
    const gated = gateSegments(plan, [obj], [5, 6]);
    expect(gated.refusals.length).toBe(1);
    expect(gated.refusals[0].reason).toMatch(/touch on opening.*hazard active/);
    expect(gated.segments.length).toBe(2);
    expect(gated.segments[1]).toMatchObject({ primitive: 'hold_pose', target: null });
    expect(gated.segments[1].path).toEqual([[5, 4]]);
    expect(gated.segments[1].effects[0]).toMatchObject({ e: 'hazard_refused' });
  });

  it('gate: refuses to arm under Nori before applying any effect', () => {
    const obj = { ...mugObject(mugCard(), 'empty'), state_sprites: { 'steaming hot': 'hot.png' } };
    const plan = [seg('move_to', [[5, 6], [5, 5]], { effects: [{ e: 'set_state', state: 'steaming hot' }] })];
    const gated = gateSegments(plan, [obj], [5, 6]);
    expect(gated.refusals[0].reason).toMatch(/hazard under Nori/);
    expect(gated.segments[0]).toMatchObject({ primitive: 'hold_pose', path: [[5, 6]] });
    expect(gated.segments[0].effects[0].e).toBe('hazard_refused');
  });

  it('rejects unsupported states in validation and the final gate', () => {
    const obj = mugObject(mugCard(), 'empty');
    const spec = { verb: 'heat', sensations: {}, steps: [{ p: 'move_to', approach: 'front' },
      { p: 'set_object_state', part: 'handle', state: 'steaming hot' }], end_state: null, cooldown_min: 1 };
    expect(validate({ objects: [obj] }, obj, spec, [5, 6]).status).toBe('rejected');
    expect(gateSegments([seg('hold_pose', [[5, 6]], { effects: [{ e: 'set_state', state: 'steaming hot' }] })],
      [obj], [5, 6]).refusals[0].reason).toMatch(/missing sprite/);
  });

  it('rejects validated arming while Nori stands on the future hazard', () => {
    const obj = { ...mugObject(mugCard(), 'empty'), state_sprites: { 'steaming hot': 'hot.png' } };
    const spec = { verb: 'heat', sensations: {}, steps: [{ p: 'set_object_state', part: 'handle', state: 'steaming hot' },
      { p: 'move_to', approach: 'front' }], end_state: null, cooldown_min: 1 };
    const result = validate({ objects: [obj] }, obj, spec, [5, 5]);
    expect(result.status).toBe('rejected');
    expect(result.checks.some(c => !c.ok && (c.reason || '').includes('hazard under Nori'))).toBe(true);
  });

  it('checks effects in order and refuses an armed object move', () => {
    const obj = { ...mugObject(mugCard(), 'empty'), state_sprites: { 'steaming hot': 'hot.png' } };
    const gated = gateSegments([seg('hold_pose', [[5, 6]], { effects: [
      { e: 'set_state', state: 'steaming hot' }, { e: 'move_object', dx: 0, dy: 1 }] })], [obj], [5, 6]);
    expect(gated.refusals[0].reason).toMatch(/move_object refused/);
    expect(gated.segments[0].effects.map((e: any) => e.e)).toEqual(['hazard_refused']);
  });

  it('refuses discontinuous paths even in hazard-free worlds', () => {
    const obj = { ...mugObject(mugCard(), 'empty'), card: { ...mugCard(), hazards: [] } } as CamObject;
    const gated = gateSegments([seg('move_to', [[4, 4], [4, 5]])], [obj], [2, 2]);
    expect(gated.refusals[0].reason).toMatch(/does not start/);
    expect(gated.segments[0].path).toEqual([[2, 2]]);
  });

  it('preserves a fractional position on refusal and checks exact continuity', () => {
    const obj = hotMug();
    const gated = gateSegments([seg('move_to', [[5.2, 5.2], [5, 6]])], [obj], [5.1, 5.1]);
    expect(gated.refusals[0].reason).toMatch(/does not start/);
    expect(gated.segments[0].path).toEqual([[5.1, 5.1]]);
  });

  it('refuses arming if a later planned path enters the new hazard', () => {
    const obj = { ...mugObject(mugCard(), 'empty'), state_sprites: { 'steaming hot': 'hot.png' } };
    const gated = gateSegments([seg('hold_pose', [[5, 6]], { effects: [{ e: 'set_state', state: 'steaming hot' }] }),
      seg('move_to', [[5, 6], [5, 5]])], [obj], [5, 6]);
    expect(gated.refusals[0].reason).toMatch(/later path/);
    expect(gated.segments).toHaveLength(1);
  });

  it('gate: hazard-free worlds pass through untouched', () => {
    const card = mugCard() as any;
    card.hazards = [];
    const obj = mugObject(card, 'empty');
    const segs: any[] = [seg('carry', [[5, 5]],
      { carrying: 'o_mug', effects: [{ e: 'move_object', dx: 1, dy: 0 }] })];
    expect(gateSegments(segs, [obj], [5, 5]).segments).toBe(segs);
  });

  it('placement refuses a hazard-active object on Nori’s cell', () => {
    const hot = hotMug();
    const world = { objects: [] as CamObject[], nori: { x: 5, y: 5 } };
    const refused = placementOk(world, hot);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('hazard on Nori');
    const calm = { ...hot, card: { ...hot.card, hazards: [] } };
    expect(placementOk(world, calm).ok).toBe(true);
  });

  it('play template for hazard-free objects touches the front part again', () => {
    const card = mugCard() as any;
    card.hazards = [];
    card.parts = [{ kind: 'handle', label: 'handle', side: 'right', height: 'low' },
      { kind: 'front', label: 'front', side: 'left', height: 'low' }];
    const obj = mugObject(card, 'empty');
    const [template] = intentTemplates([playInt()], [obj], [], 0);
    expect(template.spec.steps[0]).toMatchObject({ p: 'move_to', part: 'front' });
    expect(template.spec.steps[1]).toMatchObject({ p: 'touch', part: 'front' });
  });
}); // d1fix4, nested inside the d1fix3 block above
}); // d1fix3 F1-F6 block

describe('d1fix3 interaction-safety holes (F1-F7, continued)', () => {
  const hotObject = (state = 'steaming hot') => mugObject(mugCard(), state);

  it('F7 contact is checked against the state at each step', () => {
    const object = { ...hotObject('empty'),
      state_sprites: { empty: 'empty.png', 'steaming hot': 'hot.png' } };
    const world = { objects: [object] };
    const transition = { verb: 'heat and touch', sensations: {}, contact: 'touch', target_part: null,
      steps: [{ p: 'move_to', approach: 'front' },
        { p: 'set_object_state', part: 'handle', state: 'steaming hot' },
        { p: 'touch', part: 'opening', pose: 'wave', ms: 1000 },
        { p: 'set_object_state', part: 'handle', state: 'empty' }],
      end_state: 'empty', cooldown_min: 1 };
    const bad = validate(world, object, transition, [5, 4]);
    expect(bad.status).toBe('rejected');
    expect(bad.checks.some(c => !c.ok && (c.reason || '').includes('hazard hot'))).toBe(true);
    // Control: touching while empty without the transition stays legal.
    const control = { verb: 'touch opening', sensations: {}, contact: 'touch', target_part: 'opening',
      steps: [{ p: 'move_to', approach: 'front' }, { p: 'touch', part: 'opening', pose: 'wave', ms: 1000 }],
      end_state: null, cooldown_min: 10 };
    expect(validate(world, object, control, [5, 4]).status).toBe('accepted');
  });
});
