import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { handle } from '../src/worker/index.ts';
import { sha256Hex } from '../src/worker/limits.ts';
import { snapshot, insertSegment } from '../src/worker/cam/store.ts';
import { reserve } from '../src/worker/cam/budget.ts';
import { dispatchStartedSegments } from '../src/worker/cam/triggers.ts';
import { reactWithSpark } from '../src/worker/cam/spark.ts';
import { planNext, explorationBonus } from '../src/worker/cam/plan.ts';
import { templateEvidence } from '../src/worker/cam/evidence.ts';
import { intentTemplates } from '../src/worker/cam/intent-plan.ts';
import type { GiftEnv } from '../src/worker/cam/gifts.ts';
import type { ActiveIntent } from '../src/worker/cam/spark-validate.ts';

async function setup() {
  const t = database();
  t.sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  t.sql.prepare('UPDATE object_states SET valid_from=?').run(NOW - 86400000);
  const media = new Map<string, unknown>([['drawing.png', new Uint8Array([1])]]);
  const env: GiftEnv = { ...t.env, MEDIA_UPLOAD_TOKEN: 'test-bearer',
    OWNER_CODE_SHA256: await sha256Hex('test-owner'), JUDGE_CODE_SHA256: await sha256Hex('test-judge'),
    MEDIA: { get: async (key: string) => media.get(key) ?? null,
      delete: async (key: string) => { media.delete(key); } } as unknown as KVNamespace };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('unexpected call'); });
  const call = (path: string, body?: unknown, code?: string, bearer = false, at = NOW) => handle(
    new Request(`https://fixture${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(code ? { 'X-Nori-Code': code } : {}),
        ...(bearer ? { Authorization: 'Bearer test-bearer' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) }), env, { now: () => at, fetch });
  const event = (id: string, type = 'gift_arrived', payload = {}, isPublic = 1) => t.sql.prepare(`INSERT INTO events
    (id,insert_token,at,type,actor,payload,public,world_version,handled_version) VALUES (?,'test',?,?,'visitor',?,?,0,0)`)
    .run(id, NOW - 1000, type, JSON.stringify(payload), isPublic);
  const segment = (id: number, kind = 'browse', start = NOW, end = NOW + 2400000) => {
    t.sql.prepare(`INSERT INTO segments (id,start_at,end_at,action,primitive,pose,path,source,world_version,trigger)
      VALUES (?,?,?,? ,?,'sit','[[2,6]]','routine',0,?)`)
      .run(id, start, end, kind === 'reflect' ? 'sleep' : 'use_computer', kind === 'reflect' ? 'sleep' : 'hold_pose',
        JSON.stringify({ kind }));
    t.sql.prepare('UPDATE world SET timeline_until=?').run(end);
  };
  const browse = { type: 'browse_result', intent_id: 'seg:999', drawing: '/media/drawing.png', cost_usd: 0.12,
    pages: [{ url: 'https://example.org/read', title: 'Read a page', read_at: NOW - 100 }] };
  return { ...t, env, media, call, event, segment, browse, fetch };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live network forbidden'); })));

describe('inspection routes', () => {
  it('caps replay range and defaults to the last hour with no-store', async () => {
    const t = await setup();
    const r = await t.call('/api/replay');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ from: NOW - 3600000, to: NOW, truncated: false });
    expect((await t.call(`/api/replay?from=${NOW - 72 * 3600000 - 1}`)).status).toBe(400);
    expect((await t.call(`/api/replay?from=${NOW}&to=${NOW - 1}`)).status).toBe(400);
  });
  it('reconstructs moved and removed objects at from rather than their current position', async () => {
    const t = await setup();
    t.sql.prepare("UPDATE objects SET x=9,y=7,status='removed' WHERE id='o_slipper'").run();
    t.sql.prepare("UPDATE object_states SET valid_to=? WHERE object_id='o_slipper'").run(NOW - 10000);
    t.sql.prepare(`INSERT INTO object_states
      (object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause)
      VALUES ('o_slipper',?,9,7,0,'[[0,0]]',0,'removed','default','none','remove')`).run(NOW - 10000);
    const r: any = await (await t.call('/api/replay')).json();
    expect(r.objects.find((o: any) => o.id === 'o_slipper')).toMatchObject({ x: 3, y: 2, status: 'placed' });
    expect(r.object_states.find((o: any) => o.object_id === 'o_slipper')).toMatchObject({ status: 'removed' });
  });
  it('caps inspect traffic at sixty calls per visitor per ten minutes with Retry-After', async () => {
    const t = await setup();
    Object.assign(t.env as GiftEnv & { CAM_INSPECT_RATE_10MIN?: string }, { CAM_INSPECT_RATE_10MIN: '60' });
    for (let i = 0; i < 60; i++) expect((await t.call('/api/record')).status).toBe(200);
    const blocked = await t.call('/api/record');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect((await t.call('/api/replay')).status).toBe(429);
    const ix = t.sql.prepare("SELECT id FROM interactions WHERE object_id='o_slipper' LIMIT 1").get()!;
    expect((await t.call(`/api/interaction/${ix.id}?debug=1`, undefined, 'test-judge')).status).toBe(429);
    expect((await t.call('/api/record', undefined, undefined, true)).status).toBe(429);
  });
  it('sets truncated when replay object_states exceed the cap', async () => {
    const t = await setup();
    const from = NOW - 5001;
    for (let i = 0; i < 5001; i++) {
      t.sql.prepare(`INSERT INTO object_states
        (object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause)
        VALUES ('o_slipper',?,3,0,0,'[[0,0]]',0,'placed','default','none',?)`)
        .run(from + i, `bulk:${i}`);
    }
    const r: any = await (await t.call(`/api/replay?from=${from}&to=${NOW}`)).json();
    expect(r.object_states).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });
  it('reports truncation at two hundred segments and five hundred events', async () => {
    const t = await setup();
    for (let i = 0; i < 201; i++) t.segment(i, 'browse', NOW - 10000, NOW - 1000);
    for (let i = 0; i < 501; i++) t.event(`event:${i}`);
    const r: any = await (await t.call('/api/replay')).json();
    expect(r.segments).toHaveLength(200);
    expect(r.events).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });
  it('public record never interpolates digits, URLs, hashes, codes or raw model data', async () => {
    const t = await setup();
    t.event('secret:123', 'gift_arrived', { visitor_hash: 'abc123', code: 'test-owner',
      source_url: 'https://secret.example/photo.png', beyond_executor: 'FORBIDDEN', raw: 'RAW_SECRET' });
    t.event('reflection', 'wonder_result', { summary: 'PRIVATE_REFLECTION' }, 0);
    const text = await (await t.call('/api/record')).text();
    expect(text).not.toMatch(/\d|abc|test-owner|https|FORBIDDEN|RAW_SECRET|PRIVATE_REFLECTION/);
    expect(JSON.parse(text).record).toEqual(['A visitor left a gift by the door.']);
  });
  it('judge debug strips visitor identifiers and source photos; owner sees costs', async () => {
    const t = await setup();
    t.event('secret', 'gift_arrived', { visitor_hash: 'PRIVATE_HASH', photo_source: 'https://private/photo',
      nested: { source_url: 'PRIVATE_SOURCE', giver: 'visitor:PRIVATE_HASH' } });
    t.sql.prepare(`INSERT INTO model_calls VALUES ('call',?,'wonder','test','seg:1',1,0.123,10,'done')`).run(NOW);
    const judge = await (await t.call('/api/record?debug=1', undefined, 'test-judge')).text();
    expect(judge).not.toMatch(/PRIVATE_HASH|PRIVATE_SOURCE|https:\/\/private/);
    const owner: any = await (await t.call('/api/record?debug=1', undefined, 'test-owner')).json();
    expect(owner.model_costs[0].cost_usd).toBe(0.123);
    expect(owner.events[0].payload).toContain('PRIVATE_HASH');
    expect((await t.call('/api/record?debug=1', undefined, 'wrong')).status).toBe(401);
  });
  it('brain context needs Bearer and retains public and private events within the byte cap', async () => {
    const t = await setup();
    expect((await t.call('/api/brain/context')).status).toBe(401);
    for (let i = 0; i < 300; i++) t.event(`event:${i}`, 'example', { text: '界'.repeat(500) }, i % 2);
    const text = await (await t.call('/api/brain/context', undefined, undefined, true)).text();
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(48 * 1024);
    expect(JSON.parse(text).events.some((e: any) => e.public === 0)).toBe(true);
    expect(JSON.parse(text).events.some((e: any) => e.public === 1)).toBe(true);
  });
  it('exposes the six evidence stages for catalog and photo gift fixtures', async () => {
    const t = await setup();
    const gift: any = await (await t.call('/api/gift', { catalog_key: 'toy', idem: 'catalog-evidence' })).json();
    const catalogIx = t.sql.prepare('SELECT id FROM interactions WHERE object_id=?').get(`o_${gift.gift_id}`)!;
    const sample = JSON.parse(readFileSync(new URL('../sample/cam/ingest-gift-ready.json', import.meta.url), 'utf8'));
    t.sql.prepare(`INSERT INTO object_cards (id,object_id,created_at,source,card,raw)
      VALUES ('photo-card','photo-object',?,'spark_vision',?,'photo raw')`).run(NOW, JSON.stringify(sample.object_card));
    t.sql.prepare(`INSERT INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks,gaps)
      VALUES ('photo-ix','photo-object','photo-card',?,'compiled',?,'accepted','[]','[]')`)
      .run(NOW, JSON.stringify(sample.interactions[0]));
    for (const id of [catalogIx.id, 'photo-ix']) {
      const response = await t.call(`/api/interaction/${id}`);
      expect(response.status).toBe(200);
      const r: any = await response.json();
      for (const key of ['object_card', 'specs', 'validator_results', 'executed_segments', 'state_changes', 'experiences']) {
        expect(r).toHaveProperty(key);
      }
      expect(r.validator_results.status).toBe('accepted');
      expect(r.object_card).toBeTruthy();
      expect(r).not.toHaveProperty('debug');
      expect((await t.call(`/api/interaction/${id}?debug=1`, undefined, 'wrong')).status).toBe(401);
    }
  });
  it('links settled segments, persistent effects, sound and experiences to their spec', async () => {
    const t = await setup();
    const ix = t.sql.prepare("SELECT id FROM interactions WHERE object_id='o_slipper' LIMIT 1").get()!;
    t.segment(42, 'browse', NOW - 2000, NOW - 1000);
    t.sql.prepare('UPDATE segments SET interaction=?,settled_at=? WHERE id=42').run(ix.id, NOW - 1000);
    t.sql.prepare(`INSERT INTO object_states
      (object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause)
      VALUES ('o_slipper',?,4,3,0,'[[0,0]]',0,'placed','default','sprite','42')`).run(NOW - 1000);
    t.event('sound_played:42:1', 'sound_played', { pattern: 'note', target: 'o_slipper' });
    t.sql.prepare(`INSERT INTO experiences
      (id,at,object_id,interaction_id,segment_ids,sensations,startle,appraisal,reaction,
       pref_deltas,wariness_deltas,familiarity_delta,world_version)
      VALUES ('exp',?,'o_slipper',?,'[42]','{}',0.2,0.3,'love','{}','{}',0.1,1)`).run(NOW, ix.id);
    const r: any = await (await t.call(`/api/interaction/${ix.id}`)).json();
    expect(r.executed_segments[0]).toMatchObject({ id: 42, settled_at: NOW - 1000 });
    expect(r.state_changes[0].cause).toBe('42');
    expect(r.sound_events[0].id).toBe('sound_played:42:1');
    expect(r.experiences).toEqual([{ id: 'exp', at: NOW, reaction: 'love' }]);
    const debug: any = await (await t.call(`/api/interaction/${ix.id}?debug=1`, undefined, 'test-judge')).json();
    expect(debug.debug.experiences[0].appraisal).toBe(0.3);
  });
  it('persists and resolves generated template ids after expiry', async () => {
    const t = await setup();
    const snap = await snapshot(t.db, NOW);
    const intent: ActiveIntent = { id: 'intent:fixture:0', action: 'sniff', object_id: 'o_slipper',
      window_minutes: 120, reason_tag: 'test', summary: 'Sniff.', expires_at: NOW + 7200000 };
    snap.intents = [intent];
    const ix = intentTemplates([intent], snap.objects, [], NOW)[0];
    const planned = planNext({ state: snap.state, objects: snap.objects, interactions: [], intents: [intent],
      position: [2, 6], start_at: NOW, world_version: 1 });
    expect(planned.some(s => s.interaction === ix.id)).toBe(true);
    await t.db.batch([...templateEvidence(t.db, snap, planned, snap.world.writer),
      ...planned.map(s => insertSegment(t.db, s, snap.world.writer))]);
    const r = await t.call(`/api/interaction/${ix.id}`, undefined, undefined, false, NOW + 86400000);
    expect(r.status).toBe(200);
    expect((await r.json() as any).specs[0].source).toBe('intent_template');
  });
});

describe('cloud result ingest', () => {
  it('accepts browse receipts, a drawing and actual cost; replay exposes the real pages', async () => {
    const t = await setup();
    t.segment(999);
    await reserve(t.env, 'browse', 'seg:999', 0.3, 2, NOW);
    expect((await t.call('/api/ingest', t.browse, undefined, true)).status).toBe(200);
    expect(t.sql.prepare("SELECT * FROM objects WHERE id='drawing:seg:999'").get())
      .toMatchObject({ kind: 'drawing', sprite: '/media/drawing.png', placement: 'wall' });
    expect(t.sql.prepare("SELECT * FROM budget_ledger WHERE id='res:browse:seg:999'").get())
      .toMatchObject({ status: 'settled', actual_usd: 0.12 });
    const debug = JSON.parse(String(t.sql.prepare('SELECT debug FROM segments WHERE id=999').get()!.debug));
    expect(debug.pages).toEqual(t.browse.pages);
    const replay: any = await (await t.call('/api/replay', undefined, undefined, false, NOW + 1)).json();
    expect(replay.segments.find((s: any) => s.id === 999).pages).toEqual(t.browse.pages);
    const actions = t.sql.prepare("SELECT action,primitive FROM segments WHERE source LIKE 'drawing:%' ORDER BY start_at").all();
    expect(actions.some(a => a.action === 'sketch' && a.primitive === 'hold_pose')).toBe(true);
    expect(actions.some(a => a.action === 'pin_drawing' && a.primitive === 'hold_pose')).toBe(true);
  });
  it('duplicate browse is a no-op even if the media is no longer available', async () => {
    const t = await setup();
    t.segment(999);
    await reserve(t.env, 'browse', 'seg:999', 0.3, 2, NOW);
    await t.call('/api/ingest', t.browse, undefined, true);
    const version = t.sql.prepare('SELECT version FROM world').get()!.version;
    t.media.clear();
    const r: any = await (await t.call('/api/ingest', t.browse, undefined, true)).json();
    expect(r.duplicate).toBe(true);
    expect(t.sql.prepare('SELECT version FROM world').get()!.version).toBe(version);
  });
  it('accepts a late result and correlates the retry reservation', async () => {
    const t = await setup();
    t.segment(999, 'browse', NOW - 1800000, NOW - 600000);
    t.sql.prepare('UPDATE world SET state_json=json_set(state_json,\'$.settled_through\',?)').run(NOW - 1800000);
    await reserve(t.env, 'browse', 'seg:999', 0.3, 2, NOW - 1800000);
    t.sql.prepare("UPDATE budget_ledger SET status='released'").run();
    await reserve(t.env, 'browse', 'seg:999:retry', 0.3, 2, NOW - 1200000);
    const r = await t.call('/api/ingest', t.browse, undefined, true);
    expect(r.status).toBe(200);
    expect(t.sql.prepare("SELECT status FROM budget_ledger WHERE id='res:browse:seg:999:retry'").get()!.status).toBe('settled');
    expect(t.sql.prepare("SELECT count(*) n FROM segments WHERE action='pin_drawing'").get()!.n).toBeGreaterThan(0);
  });
  it('retries missing KV drawings and rejects too many pages without settling', async () => {
    const t = await setup();
    t.segment(999);
    await reserve(t.env, 'browse', 'seg:999', 0.3, 2, NOW);
    t.media.clear();
    const r = await t.call('/api/ingest', t.browse, undefined, true);
    expect(r.status).toBe(409);
    expect(r.headers.get('Retry-After')).toBe('5');
    expect((await t.call('/api/ingest', { ...t.browse, pages: Array(11).fill(t.browse.pages[0]) }, undefined, true)).status)
      .toBe(400);
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()!.status).toBe('reserved');
  });
  it('stores the oldest drawing beyond three', async () => {
    const t = await setup();
    for (let i = 0; i < 4; i++) {
      t.segment(999 + i);
      await reserve({ ...t.env, CAM_DAILY_USD: '10' }, 'browse', `seg:${999 + i}`, 0.3, 10, NOW + i);
      expect((await t.call('/api/ingest', { ...t.browse, intent_id: `seg:${999 + i}` }, undefined, true, NOW + i)).status).toBe(200);
      t.sql.prepare('UPDATE segments SET superseded_at=? WHERE id=?').run(NOW, 999 + i);
    }
    expect(t.sql.prepare("SELECT count(*) n FROM objects WHERE kind='drawing' AND status='placed'").get()!.n).toBe(3);
    expect(t.sql.prepare("SELECT status FROM objects WHERE id='drawing:seg:999'").get()!.status).toBe('stored');
  });
});

async function wonderSetup() {
  const t = await setup();
  t.segment(998, 'reflect');
  t.event('context-event', 'experience_settled');
  t.env.CAM_REFLECT_ENABLED = '1';
  const dispatch = vi.fn(async () => {});
  await dispatchStartedSegments(t.env, NOW, { dispatch });
  const context: any = await (await t.call('/api/brain/context?intent_id=seg:998', undefined, undefined, true)).json();
  const body = { type: 'wonder_result', intent_id: 'seg:998', cost_usd: 0.04, result: {
    reflection: { summary: 'PRIVATE_REFLECTION', event_ids: [context.events[0].id] },
    tomorrow: { action: 'sniff', object_id: 'o_slipper', window_minutes: 1200, reason_tag: 'test', summary: 'Try again.' },
    habit_candidate: 'soft' } };
  return { ...t, body, dispatch };
}
describe('Wonder and feature switches', () => {
  it('wonder ingest while asleep does not wake Nori when the roll would wake', async () => {
    const t = await wonderSetup();
    t.sql.prepare(`UPDATE world SET state_json=json_set(state_json,'$.nori.asleep',1,'$.nori.sleep_started_at',?)`)
      .run(NOW - 600000);
    expect((await t.call('/api/ingest', t.body, undefined, true)).status).toBe(200);
    const state = JSON.parse(String(t.sql.prepare('SELECT state_json FROM world').get()!.state_json));
    expect(state.nori.asleep).toBe(1);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE type='reflection'").get()!.handled_version)
      .not.toBeNull();
  });
  it('stores a private reflection, validated intent, costs and a small exploration bonus only', async () => {
    const t = await wonderSetup();
    const before = (await snapshot(t.db, NOW)).state;
    expect((await t.call('/api/ingest', t.body, undefined, true)).status).toBe(200);
    const after = await snapshot(t.db, NOW);
    expect(after.state.prefs).toEqual(before.prefs);
    expect(after.state.habits).toEqual(before.habits);
    expect(after.state.exploration?.sensation).toBe('soft');
    const ix = after.interactions.find(i => i.object_id === 'o_slipper')!;
    expect(explorationBonus(after.state, ix, NOW)).toBe(0.1);
    expect(explorationBonus(after.state, ix, NOW + 86400000)).toBe(0);
    expect(after.intents.some(i => i.window_minutes === 1200)).toBe(true);
    expect(t.sql.prepare("SELECT public FROM events WHERE id='ingest:seg:998:wonder_result'").get()!.public).toBe(0);
    expect(await (await t.call('/api/record')).text()).not.toContain('PRIVATE_REFLECTION');
    expect(await (await t.call('/api/record?debug=1', undefined, 'test-owner')).text()).toContain('PRIVATE_REFLECTION');
    expect(t.sql.prepare("SELECT status,actual_usd FROM budget_ledger WHERE purpose='wonder'").get())
      .toMatchObject({ status: 'settled', actual_usd: 0.04 });
    expect((await (await t.call('/api/ingest', t.body, undefined, true)).json() as any).duplicate).toBe(true);
  });
  it.each(['extra', 'unseen'])('rejects invalid Wonder output: %s', async mode => {
    const t = await wonderSetup();
    const result: any = t.body.result;
    if (mode === 'extra') result.extra = true;
    else result.reflection.event_ids = ['not-in-context'];
    expect((await t.call('/api/ingest', t.body, undefined, true)).status).toBe(400);
    expect(t.sql.prepare("SELECT count(*) n FROM intents WHERE source='wonder'").get()!.n).toBe(0);
  });
  it('claims reflect concurrently at most once per London day', async () => {
    const t = await setup();
    t.env.CAM_REFLECT_ENABLED = '1';
    t.segment(1, 'reflect');
    t.segment(2, 'reflect');
    const dispatch = vi.fn(async () => {});
    await Promise.all([dispatchStartedSegments(t.env, NOW, { dispatch }), dispatchStartedSegments(t.env, NOW, { dispatch })]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]).toEqual([t.env, 'nori-wake.yml', { reason: 'reflect', intent_id: 'seg:1' }, undefined]);
  });
  it.each(['browse', 'reflect'])('disabled %s plays with zero dispatches and one event', async kind => {
    const t = await setup();
    t.segment(999, kind);
    const dispatch = vi.fn(async () => {});
    await dispatchStartedSegments(t.env, NOW, { dispatch });
    await dispatchStartedSegments(t.env, NOW, { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='feature_disabled'").get()!.n).toBe(1);
    expect(t.sql.prepare('SELECT superseded_at FROM segments WHERE id=999').get()!.superseded_at).toBeNull();
  });
  it('disabled Spark makes zero calls and records one event', async () => {
    const t = await setup();
    t.env.CAM_SPARK_ENABLED = '0';
    for (let n = 0; n < 2; n++) await reactWithSpark(t.env, 'spark_reaction', 'seg:999', NOW, t.fetch);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='feature_disabled'").get()!.n).toBe(1);
    expect(t.sql.prepare('SELECT count(*) n FROM budget_ledger').get()!.n).toBe(0);
  });
  it('bare brain context binds the latest dispatched reflect and rejects citations outside the returned context', async () => {
    const t = await wonderSetup();
    const response = await t.call('/api/brain/context', undefined, undefined, true);
    expect(response.status).toBe(200);
    const context: any = await response.json();
    const stored = JSON.parse(String(t.sql.prepare('SELECT debug FROM segments WHERE id=998').get()!.debug));
    expect(stored.context_event_ids).toEqual(context.events.map((e: any) => e.id));
    t.event('added-later');
    t.body.result.reflection.event_ids = ['added-later'];
    expect((await t.call('/api/ingest', t.body, undefined, true)).status).toBe(400);
  });
  it('expired template evidence remains inspectable without becoming a perpetual planner candidate', async () => {
    const t = await setup();
    const s = await snapshot(t.db, NOW);
    const intent: ActiveIntent = { id: 'intent:expired:0', action: 'sniff', object_id: 'o_slipper',
      expires_at: NOW, window_minutes: 10, reason_tag: 'test', summary: 'Visit.' };
    const ix = intentTemplates([{ ...intent, expires_at: NOW + 1 }], s.objects, [], NOW)[0];
    const result = planNext({ state: s.state, objects: s.objects, interactions: [ix], intents: [intent],
      position: [2, 6], start_at: NOW, world_version: 1 });
    expect(result.some(segment => segment.interaction === ix.id)).toBe(false);
  });
  it('short sleep never dispatches reflection', async () => {
    const t = await setup();
    t.env.CAM_REFLECT_ENABLED = '1';
    t.segment(1, 'reflect', NOW, NOW + 29 * 60000);
    const dispatch = vi.fn(async () => {});
    await dispatchStartedSegments(t.env, NOW, { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('planner attaches reflect to sleep segments lasting at least thirty minutes', async () => {
    const t = await setup();
    const s = await snapshot(t.db, NOW);
    const ix = s.interactions.find(i => i.action === 'sleep')!;
    const segments = planNext({ state: s.state, objects: s.objects, interactions: [ix], position: [2, 6],
      start_at: NOW, world_version: 0, intent: { action: 'sleep', expires_at: NOW + 600000, bonus: 10 } });
    expect(segments.find(s => s.trigger?.kind === 'reflect')?.primitive).toBe('sleep');
  });
});
