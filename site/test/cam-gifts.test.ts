import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { handle } from '../src/worker/index.ts';
import type { GiftEnv } from '../src/worker/cam/gifts.ts';
import { sha256Hex } from '../src/worker/limits.ts';
import { dispatchWorkflow } from '../src/worker/cam/dispatch.ts';
import { reserve, expireReservations, londonDay, settleBudget, releaseBudget } from '../src/worker/cam/budget.ts';
import { advance } from '../src/worker/cam/timeline.ts';
import { replan } from '../src/worker/cam/replan.ts';
import { safeSegment } from '../src/worker/cam/timeline.ts';
import { initialState, wakeResponse } from '../src/worker/cam/engine.ts';
import { poseAt, placementOk } from '../public/cam-shared.js';
import { writeFact, eventWrite } from '../src/worker/cam/facts.ts';
import { visitorHash } from '../src/worker/cam/auth.ts';
import { snapshot } from '../src/worker/cam/store.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
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
  function contiguous() {
    const rows = base.sql.prepare('SELECT * FROM segments WHERE superseded_at IS NULL ORDER BY start_at').all();
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].start_at).toBe(rows[i - 1].end_at);
    expect(rows.every(r => Number(r.end_at) > Number(r.start_at))).toBe(true);
    return rows;
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
  return { ...base, env, values, call, photo, dispatch, contiguous, ready };
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('live network forbidden'); }));
});
describe('catalog gifts and fact idempotency', () => {
  it('request wiring calls Spark after committed gift arrival and defers work with waitUntil', async () => {
    const t = setup();
    t.env.MODEL_API_KEY = 'fixture-model';
    t.env.CAM_SPARK_ENABLED = '1';
    t.dispatch.mockImplementation(async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '{"intents":[]}' } }] }));
    const waits: Promise<unknown>[] = [];
    const response = await handle(new Request('https://fixture/api/gift', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalog_key: 'toy', idem: 'spark-gift' }),
    }), t.env, { fetch: t.dispatch, now: () => NOW }, { waitUntil: promise => { waits.push(promise); } });
    expect(response.status).toBe(200);
    expect(t.sql.prepare("SELECT count(*) n FROM gifts WHERE status='placed'").get()?.n).toBe(1);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(t.sql.prepare("SELECT purpose,ok FROM model_calls WHERE purpose='spark_reaction'").get())
      .toMatchObject({ purpose: 'spark_reaction', ok: 1 });
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });
  it('places a gift, records reaction trigger and limits one visitor per London day', async () => {
    const t = setup();
    const first = await t.call('/api/gift', { catalog_key: 'cardboard_box', idem: 'one' });
    expect(first.status).toBe(200);
    expect(t.sql.prepare('SELECT count(*) n FROM gifts').get()?.n).toBe(1);
    expect(t.contiguous().some(s => String(s.trigger).includes('spark_reaction'))).toBe(true);
    const second = await t.call('/api/gift', { catalog_key: 'slipper', idem: 'two' });
    expect(second.status).toBe(429);
    expect(t.dispatch).not.toHaveBeenCalled();
  });
  it('same idem returns same result and does not bump world version', async () => {
    const t = setup();
    const a = await t.call('/api/gift', { catalog_key: 'toy', idem: 'same' });
    const version = (await snapshot(t.db, NOW)).world.version;
    const b = await t.call('/api/gift', { catalog_key: 'toy', idem: 'same' });
    expect(await a.json()).toEqual(await b.json());
    expect((await snapshot(t.db, NOW)).world.version).toBe(version);
    t.contiguous();
  });
  it.each(['gift', 'photo_gift'])('a full R40 room stores the first %s and places a second visitor gift', async origin => {
    const t = setup();
    t.sql.exec(readFileSync(new URL('../oneoff/r40_layout.sql', import.meta.url), 'utf8')
      .replace("CAST(strftime('%s','now') AS INTEGER)*1000", String(NOW)));
    const first = await t.call('/api/gift', { catalog_key: 'cardboard_box', idem: 'full-first' });
    expect(first.status).toBe(200);
    const firstId = 'o_' + ((await first.json()) as any).gift_id;
    t.sql.prepare('UPDATE objects SET origin=? WHERE id=?').run(JSON.stringify({ type: origin }), firstId);
    const second = await t.call('/api/gift', { catalog_key: 'cardboard_box', idem: 'full-second' },
      { 'CF-Connecting-IP': '192.0.2.2' });
    expect(second.status).toBe(200);
    const secondId = 'o_' + ((await second.json()) as any).gift_id;
    expect(t.sql.prepare('SELECT status FROM objects WHERE id=?').get(firstId)?.status).toBe('stored');
    expect(t.sql.prepare('SELECT status FROM objects WHERE id=?').get(secondId)?.status).toBe('placed');
    const stored = t.sql.prepare("SELECT payload FROM events WHERE type='object_stored'").all();
    expect(stored).toHaveLength(1);
    expect(JSON.parse(String(stored[0].payload))).toEqual({ object_id: firstId, reason: 'room_full' });
    expect(JSON.parse(String(t.sql.prepare("SELECT payload FROM events WHERE id='gift:full-second'").get()?.payload))
      .stored_id).toBe(firstId);
  });
  it('keeps the 409 and stores nothing if removing one gift cannot free a legal cell', async () => {
    const t = setup();
    t.sql.exec(readFileSync(new URL('../oneoff/r40_layout.sql', import.meta.url), 'utf8')
      .replace("CAST(strftime('%s','now') AS INTEGER)*1000", String(NOW)));
    const first = await t.call('/api/gift', { catalog_key: 'cardboard_box', idem: 'blocked-first' });
    expect(first.status).toBe(200);
    const firstId = 'o_' + ((await first.json()) as any).gift_id;
    // A static collider covers every floor cell, so storing the gift cannot help.
    t.sql.prepare("UPDATE objects SET footprint=? WHERE id='r40_static_compound'").run(JSON.stringify(
      Array.from({ length: 80 }, (_, i) => [i % 10, Math.floor(i / 10)])));
    const history = t.sql.prepare('SELECT count(*) n FROM object_states WHERE object_id=?').get(firstId)?.n;
    const response = await t.call('/api/gift', { catalog_key: 'cardboard_box', idem: 'blocked-second' },
      { 'CF-Connecting-IP': '192.0.2.2' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'no legal gift cell' });
    expect(t.sql.prepare('SELECT status FROM objects WHERE id=?').get(firstId)?.status).toBe('placed');
    expect(t.sql.prepare('SELECT count(*) n FROM object_states WHERE object_id=?').get(firstId)?.n).toBe(history);
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='object_stored' OR id='gift:blocked-second'").get()?.n).toBe(0);
    expect(t.sql.prepare('SELECT count(*) n FROM gifts').get()?.n).toBe(1);
  });
  it('seventh visitor gift stores the least familiar and leaves six in the room', async () => {
    const t = setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await t.call('/api/gift', { catalog_key: 'cushion', idem: `cap-${i}` },
        { 'CF-Connecting-IP': `192.0.2.${i}` });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      ids.push('o_' + body.gift_id);
      if (i < 6) {
        const snap = await snapshot(t.db, NOW);
        snap.state.familiarity[ids[i]] = i === 2 ? 0 : 0.9;
        t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(snap.state));
      }
      t.contiguous();
    }
    expect(t.sql.prepare("SELECT status FROM objects WHERE id=?").get(ids[2])?.status).toBe('stored');
    expect(t.sql.prepare("SELECT count(*) n FROM objects WHERE status='placed' AND origin LIKE '%gift%'").get()?.n).toBe(6);
    const stored = t.sql.prepare("SELECT payload FROM events WHERE type='object_stored'").all();
    expect(stored).toHaveLength(1);
    expect(JSON.parse(String(stored[0].payload))).toEqual({ object_id: ids[2], reason: 'visitor_room_cap' });
    expect(JSON.parse(String(t.sql.prepare("SELECT payload FROM events WHERE id='gift:cap-6'").get()?.payload))
      .stored_id).toBe(ids[2]);
    expect(t.contiguous().some(s => s.source === 'storage:carry' && s.carrying === ids[2])).toBe(true);
    await advance(t.env, NOW + 60000, 'read');
    expect(t.sql.prepare('SELECT status FROM objects WHERE id=?').get(ids[2])?.status).toBe('stored');
  });
  it('photo gifts count toward the six placed visitor objects and still allow a catalog gift', async () => {
    const t = setup();
    for (let i = 0; i < 30; i++) {
      t.sql.prepare(`INSERT INTO objects
        (id,kind,tags,size,x,y,z,footprint,rotation,blocks,placement,status,state,sprite,card_id,origin,created_at)
        VALUES (?,'parcel','[]','S',?,?,0,'[[0,0]]',0,0,'floor','placed','default','none',?,
        ?,?)`)
        .run(`photo-${i}`, 1 + (i % 5), 1 + Math.floor(i / 5), `card:photo-${i}`,
          JSON.stringify({ type: 'photo_gift', gift_id: `p${i}` }), NOW + i);
    }
    const response = await t.call('/api/gift', { catalog_key: 'toy', idem: 'after-photos' },
      { 'CF-Connecting-IP': '198.51.100.9' });
    expect(response.status).toBe(200);
    expect(t.sql.prepare("SELECT count(*) n FROM gifts WHERE kind LIKE 'catalog:%'").get()?.n).toBe(1);
  });
  it('catalog idem is scoped to the same visitor hash', async () => {
    const t = setup();
    const first = await t.call('/api/gift', { catalog_key: 'toy', idem: 'shared-idem' },
      { 'CF-Connecting-IP': '203.0.113.1' });
    const second = await t.call('/api/gift', { catalog_key: 'slipper', idem: 'shared-idem' },
      { 'CF-Connecting-IP': '203.0.113.2' });
    const a = await first.json() as { gift_id: string };
    const b = await second.json() as { gift_id: string };
    expect(a.gift_id).not.toBe(b.gift_id);
  });
  it('fact batches roll back on errors and duplicate events change nothing', async () => {
    const t = setup();
    const event = { id: 'atomic', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} };
    await expect(writeFact(t.db, event, NOW, () => [t.db.prepare('INSERT INTO nonexistent VALUES (1)')])).rejects.toThrow();
    expect(t.sql.prepare("SELECT id FROM events WHERE id='atomic'").get()).toBeUndefined();
    expect(await writeFact(t.db, event, NOW, (_, token) => [eventWrite(t.db, { ...event, id: 'side' }, token)])).toBe(true);
    const version = (await snapshot(t.db, NOW)).world.version;
    expect(await writeFact(t.db, event, NOW, () => { throw new Error('must not build'); })).toBe(false);
    expect((await snapshot(t.db, NOW)).world.version).toBe(version);
  });
});
describe('photo intake and dispatch', () => {
  it('plans the newly unwrapped gift promptly through its accepted interaction', async () => {
    const t = setup();
    t.env.CAM_LOCAL_PIPELINE = '1';
    const created = await (await t.photo('timely-photo')).json() as { gift_id: string };
    expect((await t.ready(created.gift_id)).status).toBe(200);
    const segment = t.sql.prepare(`SELECT start_at,interaction FROM segments WHERE superseded_at IS NULL
      AND target=? AND interaction IS NOT NULL ORDER BY start_at LIMIT 1`).get(`o_${created.gift_id}`);
    expect(segment).toBeDefined();
    expect(Number(segment!.start_at) - NOW).toBeLessThanOrEqual(30 * 60000);
    expect(String(segment!.interaction)).toContain(created.gift_id);
  });
  it('parcel arrival and successful unwrap each call Spark once across repeated ingest', async () => {
    const t = setup();
    t.env.MODEL_API_KEY = 'fixture-model';
    t.env.CAM_SPARK_ENABLED = '1';
    t.dispatch.mockImplementation(async url => String(url).includes('api.meta.ai')
      ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"intents":[]}' } }] })
      : new Response(null, { status: 204 }));
    const created = await (await t.photo()).json() as { gift_id: string };
    expect((await t.ready(created.gift_id)).status).toBe(200);
    expect((await t.ready(created.gift_id)).status).toBe(200);
    expect(t.sql.prepare("SELECT count(*) n FROM model_calls WHERE purpose='spark_reaction' AND ok=1").get()?.n).toBe(2);
  });
  it.each([500, 503])('ambiguous HTTP %s keeps photo processing and reservation until timeout', async status => {
    const t = setup();
    t.dispatch.mockResolvedValueOnce(new Response(null, { status }));
    const response = await t.photo();
    expect(response.status).toBe(200);
    const body = await response.json() as { gift_id: string; status: string };
    expect(body.status).toBe('processing');
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('reserved');
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
    expect(t.values.has(`giftsrc-${body.gift_id}`)).toBe(true);
    await advance(t.env, NOW + 20 * 60000, 'read');
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('failed');
    expect(t.sql.prepare('SELECT status,actual_usd FROM budget_ledger').get())
      .toMatchObject({ status: 'settled', actual_usd: 0.08 });
  });
  it('ambiguous dispatch timeout keeps reservation; refused connection releases it', async () => {
    const t = setup();
    t.dispatch.mockRejectedValueOnce(new DOMException('fixture timeout', 'TimeoutError'));
    expect((await t.photo('timeout')).status).toBe(200);
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('reserved');
    const refused = setup();
    refused.dispatch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect((await refused.photo('refused')).status).toBe(502);
    expect(refused.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('released');
  });
  it('503 without code env and 401 for wrong code', async () => {
    const t = setup();
    expect((await t.call('/api/gift/photo')).status).toBe(503);
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    expect((await t.call('/api/gift/photo', undefined, { 'X-Nori-Code': 'wrong' })).status).toBe(401);
    expect(t.values.size).toBe(0);
    expect(t.dispatch).not.toHaveBeenCalled();
  });
  it.each(['large', 'type', 'signature'])('rejects invalid %s upload before reservation', async mode => {
    const t = setup();
    const response = await t.photo('bad', mode === 'large' ? new Uint8Array(5 * 1024 * 1024 + 1) :
      mode === 'signature' ? new Uint8Array([1]) : PNG, mode === 'type' ? 'text/plain' : 'image/png');
    expect(response.status).toBe(mode === 'large' ? 413 : 415);
    expect(t.sql.prepare('SELECT count(*) n FROM budget_ledger').get()?.n).toBe(0);
    expect(t.values.size).toBe(0);
  });
  it('denies reservation without gift, source or dispatch', async () => {
    const t = setup();
    t.env.CAM_DAILY_USD = '0';
    expect((await t.photo()).status).toBe(429);
    expect(t.sql.prepare('SELECT count(*) n FROM gifts').get()?.n).toBe(0);
    expect(t.values.size).toBe(0);
    expect(t.dispatch).not.toHaveBeenCalled();
  });
  it('stores private source with TTL, reserves and dispatches exact Lane C input once', async () => {
    const t = setup();
    const response = await t.photo();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const value = t.values.get(`giftsrc-${body.gift_id}`)!;
    expect(value.options.expirationTtl).toBe(3600);
    expect(body.gift_id).toMatch(/^[0-9a-f]{32}$/);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    const [url, options] = t.dispatch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/theroyatlas/nori-aipet/actions/workflows/nori-gift.yml/dispatches');
    expect(JSON.parse(String(options?.body))).toEqual({ ref: 'master', inputs: { gift_id: body.gift_id } });
    const version = (await snapshot(t.db, NOW)).world.version;
    expect((await t.photo()).status).toBe(200);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect((await snapshot(t.db, NOW)).world.version).toBe(version);
    t.contiguous();
  });
  it('CAM_LOCAL_PIPELINE skips GitHub gift dispatch', async () => {
    const t = setup();
    t.env.CAM_LOCAL_PIPELINE = '1';
    const response = await t.photo('local-pipeline');
    expect(response.status).toBe(200);
    expect(t.dispatch).not.toHaveBeenCalled();
    t.contiguous();
  });
  it('dispatch failure releases reservation, removes source and preserves usable box', async () => {
    const t = setup();
    t.dispatch.mockResolvedValueOnce(new Response(null, { status: 422 }));
    expect((await t.photo()).status).toBe(502);
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('released');
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('failed');
    expect(t.sql.prepare("SELECT kind FROM objects WHERE origin LIKE '%photo_gift%'").get()?.kind).toBe('cardboard_box');
    expect(t.values.size).toBe(0);
    t.contiguous();
  });
  it('source authenticates and returns 404, 409 Retry-After, then raw private bytes', async () => {
    const t = setup();
    const auth = { Authorization: 'Bearer fixture-token' };
    expect((await t.call('/api/gift/source/absent', undefined, auth)).status).toBe(404);
    const result = await t.photo();
    const { gift_id: id } = await result.json() as any;
    expect((await t.call('/api/gift/source/' + id)).status).toBe(401);
    const value = t.values.get('giftsrc-' + id)!;
    t.values.delete('giftsrc-' + id);
    const missing = await t.call('/api/gift/source/' + id, undefined, auth);
    expect(missing.status).toBe(409);
    expect(missing.headers.get('Retry-After')).toBe('5');
    t.values.set('giftsrc-' + id, value);
    const source = await t.call('/api/gift/source/' + id, undefined, auth);
    expect(source.status).toBe(200);
    expect(source.headers.get('Content-Type')).toBe('image/png');
    expect(source.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(PNG);
  });
});
describe('Lane C ingest', () => {
  it('accepts sample, settles report cost, replaces parcel at same cell and ignores duplicate/opposite terminal', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const before = t.sql.prepare('SELECT * FROM objects WHERE id=?').get('o_' + id)!;
    const ready = await t.ready(id, body => {
      body.cost_usd = 0.031;
      body.pipeline[1].cost_usd = 0.031;
    });
    expect(ready.status).toBe(200);
    const after = t.sql.prepare('SELECT * FROM objects WHERE id=?').get('o_' + id)!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
    expect(after.sprite).toBe(`/media/gift-${id}.png`);
    expect(t.sql.prepare('SELECT actual_usd FROM budget_ledger').get()?.actual_usd).toBe(0.031);
    expect(t.values.size).toBe(0);
    expect(t.sql.prepare('SELECT count(*) n FROM model_calls').get()?.n).toBe(3);
    expect(JSON.parse(String(t.sql.prepare('SELECT note FROM budget_ledger').get()?.note))
      .provider_billed_verified).toBe(false);
    expect(t.sql.prepare("SELECT count(*) n FROM interactions WHERE source='compiled' AND status='accepted'").get()?.n).toBe(1);
    const version = (await snapshot(t.db, NOW)).world.version;
    expect((await t.ready(id)).status).toBe(200);
    expect((await t.call('/api/ingest', { type: 'gift_failed', gift_id: id },
      { Authorization: 'Bearer fixture-token' })).status).toBe(200);
    expect((await snapshot(t.db, NOW)).world.version).toBe(version);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('ready');
    expect((await t.call('/api/gift/source/' + id, undefined,
      { Authorization: 'Bearer fixture-token' })).status).toBe(404);
    t.contiguous();
  });
  it('rejects unsafe candidate, records capability gap without making it executable', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => {
      body.interactions[0].steps = [{ p: 'teleport' }];
      body.object_card.beyond_executor = ['teleport'];
    })).status).toBe(200);
    expect(t.sql.prepare("SELECT status FROM interactions WHERE source='compiled'").get()?.status).toBe('rejected');
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='capability_gap'").get()?.n).toBe(1);
    t.contiguous();
  });
  it('invalid card is refused without deleting source or settling budget', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => { body.object_card.tags = ['execute_code']; })).status).toBe(422);
    expect(t.values.size).toBe(1);
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('reserved');
  });
  it('gift_failed settles incurred cost, keeps shelter box and replans; duplicate is no-op', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const body = { type: 'gift_failed', gift_id: id, step: 'redraw', pipeline: [{ step: 'redraw', model: 'fake', ok: false,
      ms: 0, seconds: 0, cost_usd: 0.01, cost_basis: 'estimate' }], cost_usd: 0.01 };
    const auth = { Authorization: 'Bearer fixture-token' };
    expect((await t.call('/api/ingest', body, auth)).status).toBe(200);
    expect(t.sql.prepare('SELECT actual_usd FROM budget_ledger').get()?.actual_usd).toBe(0.01);
    const object = t.sql.prepare('SELECT * FROM objects WHERE id=?').get('o_' + id)!;
    expect(object.kind).toBe('cardboard_box');
    expect(JSON.parse(String(object.tags))).toContain('enclosed');
    const version = (await snapshot(t.db, NOW)).world.version;
    expect((await t.call('/api/ingest', body, auth)).status).toBe(200);
    expect((await snapshot(t.db, NOW)).world.version).toBe(version);
    expect(t.values.size).toBe(0);
    t.contiguous();
  });
});
describe('owner and budget', () => {
  it('owner removal preserves the original photo card provenance and raw candidate', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id)).status).toBe(200);
    const before = t.sql.prepare('SELECT * FROM object_cards WHERE object_id=?').get('o_' + id)!;
    expect(before.source).toBe('spark_vision');
    expect((await t.call('/api/owner/object', { id: 'o_' + id, op: 'remove', idem: 'remove-photo' },
      { 'X-Nori-Code': 'owner-fixture' })).status).toBe(200);
    expect(t.sql.prepare('SELECT * FROM object_cards WHERE id=?').get(String(before.id))).toEqual(before);
    expect(t.sql.prepare('SELECT card_id FROM objects WHERE id=?').get('o_' + id)?.card_id).toBe(before.id);
    t.contiguous();
  });
  it('owner remove records missing fact and replans contiguous timeline', async () => {
    const t = setup();
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const response = await t.call('/api/owner/object', { id: 'o_cardboard_box', op: 'remove', idem: 'remove' },
      { 'X-Nori-Code': 'owner-fixture' });
    expect(response.status).toBe(200);
    expect(t.sql.prepare("SELECT status FROM objects WHERE id='o_cardboard_box'").get()?.status).toBe('removed');
    expect((await snapshot(t.db, NOW)).state.missing.some(m => m.object_id === 'o_cardboard_box')).toBe(true);
    expect(t.contiguous().some(s => String(s.source).startsWith('reaction:owner:'))).toBe(true);
    expect(t.contiguous().some(s => s.action === 'search')).toBe(true);
    const version = (await snapshot(t.db, NOW)).world.version;
    expect((await t.call('/api/owner/object', { id: 'o_cardboard_box', op: 'remove', idem: 'remove' },
      { 'X-Nori-Code': 'owner-fixture' })).status).toBe(200);
    expect((await snapshot(t.db, NOW)).world.version).toBe(version);
  });
  it('reservations enforce simultaneous cap, settle stale entries and use London DST day', async () => {
    const t = setup();
    t.env.CAM_DAILY_USD = '0.08';
    const result = await Promise.all([reserve(t.env, 'owner_photo', 'a', 0.08, 10, NOW),
      reserve(t.env, 'owner_photo', 'b', 0.08, 10, NOW)]);
    expect(result.filter(Boolean)).toHaveLength(1);
    await expireReservations(t.db, NOW + 7200000);
    expect(t.sql.prepare('SELECT status,note,actual_usd FROM budget_ledger').get()).toMatchObject({
      status: 'settled', note: 'no_report', actual_usd: 0.08,
    });
    expect(londonDay(Date.UTC(2026, 6, 1, 23, 30))).toBe('2026-07-02');
  });
  it('dispatch helper refuses missing token without fetching', async () => {
    const fn = vi.fn<typeof fetch>();
    await expect(dispatchWorkflow({}, 'nori-gift.yml', { gift_id: 'a' }, fn)).rejects.toThrow('dispatch_not_configured');
    expect(fn).not.toHaveBeenCalled();
  });
  it('planner cuts do not apply interrupted effects and preserve contiguous future settlement', async () => {
    const t = setup();
    await advance(t.env, NOW, 'read');
    await writeFact(t.db, { id: 'interrupt', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} }, NOW, () => []);
    await replan(t.db, NOW);
    t.contiguous();
    await advance(t.env, NOW + 600000, 'read');
    t.contiguous();
    expect(t.sql.prepare(`SELECT count(*) n FROM events
      WHERE type='safe_fallback' AND payload NOT LIKE '%planning_segment_cap%'`).get()?.n).toBe(0);
  });
});

describe('contention and replan boundaries', () => {
  it('GET recovers a pending fact even with an already covered horizon', async () => {
    const t = setup();
    await advance(t.env, NOW, 'read');
    await writeFact(t.db, { id: 'recover', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} }, NOW, () => []);
    const version = (await snapshot(t.db, NOW)).world.version;
    const response = await handle(new Request('https://fixture/api/cam'), t.env, { now: () => NOW });
    expect(response.status).toBe(200);
    expect((await snapshot(t.db, NOW)).world.version).toBeGreaterThan(version);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='recover'").get()?.handled_version).not.toBeNull();
    t.contiguous();
  });
  it('cut preserves the motion prefix across corners and suppresses future effects', async () => {
    const t = setup();
    const original = safeSegment(NOW, NOW + 3000, 1, 0, [2, 6]);
    original.path = [[2, 6], [3, 6], [3, 5], [4, 5]];
    original.primitive = 'move_to';
    t.sql.prepare(`INSERT INTO segments
      (id,start_at,end_at,action,primitive,pose,path,source,world_version,effects)
      VALUES (1,?,?,?,?,?,?,?,?,?)`).run(original.start_at, original.end_at, original.action, original.primitive, original.pose,
      JSON.stringify(original.path), original.source, 0, '[]');
    t.sql.prepare('UPDATE world SET timeline_until=?').run(original.end_at);
    await writeFact(t.db, { id: 'corner', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} }, NOW, () => []);
    await replan(t.db, NOW);
    const cut = (await snapshot(t.db, NOW)).segments.find(s => s.id === 1)!;
    expect(cut.cut_at).toBe(NOW + 1500);
    for (const offset of [250, 750, 1250]) {
      const before = poseAt([original], NOW + offset)!;
      const after = poseAt([cut], NOW + offset)!;
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    }
    t.contiguous();
  });
  it('fact conflict retries geometry and every losing write changes zero rows', async () => {
    const t = setup();
    let inject = true;
    let loser: number[] = [];
    const db = { prepare: (q: string) => t.db.prepare(q), async batch(statements: D1PreparedStatement[]) {
      const first = (statements[0] as unknown as { query: string }).query;
      if (inject && first.startsWith('INSERT OR IGNORE INTO events')) {
        inject = false;
        t.sql.prepare("UPDATE world SET version=version+1,writer='other'").run();
        const result = await t.db.batch(statements);
        loser = result.map(r => r.meta.changes);
        return result;
      }
      return t.db.batch(statements);
    } } as D1Database;
    expect(await writeFact(db, { id: 'race', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} },
      NOW, (_, token) => [eventWrite(db, { id: 'race-side', at: NOW, type: 'probe', actor: 'system', payload: {} }, token)]))
      .toBe(true);
    expect(loser).toEqual([0, 0, 0]);
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE id='race-side'").get()?.n).toBe(1);
  });
  it('planner loser cannot cut, supersede, insert or mark pending events', async () => {
    const t = setup();
    await advance(t.env, NOW, 'read');
    await writeFact(t.db, { id: 'plan-race', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} }, NOW, () => []);
    let inject = true;
    let loser: number[] = [];
    const db = { prepare: (q: string) => t.db.prepare(q), async batch(statements: D1PreparedStatement[]) {
      const first = (statements[0] as unknown as { query: string }).query;
      if (inject && first.startsWith('UPDATE world')) {
        inject = false;
        t.sql.prepare("UPDATE world SET version=version+1,writer='other'").run();
        const result = await t.db.batch(statements);
        loser = result.map(r => r.meta.changes);
        return result;
      }
      return t.db.batch(statements);
    } } as D1Database;
    expect(await replan(db, NOW)).toBe(true);
    expect(loser.length).toBeGreaterThan(4);
    expect(loser.every(n => n === 0)).toBe(true);
    t.contiguous();
  });
  it('active carry extends the cut to its end', async () => {
    const t = setup();
    const s = safeSegment(NOW, NOW + 10000, 1, 0, [2, 6]);
    s.primitive = 'carry';
    t.sql.prepare(`INSERT INTO segments
      (id,start_at,end_at,action,primitive,pose,path,source,world_version,effects)
      VALUES (1,?,?,?,?,?,?,?,?,?)`).run(s.start_at, s.end_at, s.action, s.primitive, s.pose,
      JSON.stringify(s.path), s.source, s.world_version, '[]');
    t.sql.prepare('UPDATE world SET timeline_until=?').run(s.end_at);
    await writeFact(t.db, { id: 'carry-event', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} }, NOW, () => []);
    await replan(t.db, NOW);
    expect(t.sql.prepare('SELECT end_at,cut_at FROM segments WHERE id=1').get()).toMatchObject({
      end_at: NOW + 10000, cut_at: null,
    });
    expect(t.contiguous()[1].start_at).toBe(NOW + 10000);
  });
  it('pending sleeping event uses a stable arrival-time roll and remains pending', async () => {
    const t = setup();
    await advance(t.env, NOW, 'read');
    const state = initialState(NOW);
    state.nori.asleep = true;
    state.nori.curiosity = 0;
    state.nori.sleep_started_at = NOW - 600000;
    t.sql.exec("UPDATE segments SET action='sleep',primitive='sleep',completion=NULL,effects='[]'");
    expect(wakeResponse(structuredClone(state), 'sleep-event', NOW, 1)).toBe(false);
    t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(state));
    await writeFact(t.db, { id: 'sleep-event', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} }, NOW, () => []);
    const version = (await snapshot(t.db, NOW)).world.version;
    expect(await replan(t.db, NOW)).toBe(false);
    expect(await replan(t.db, NOW + 1000)).toBe(false);
    expect((await snapshot(t.db, NOW)).world.version).toBe(version);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='sleep-event'").get()?.handled_version).toBeNull();
  });
  it('missing second-state sprite rejects the unsupported transition', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => {
      body.object_card.states.push('open');
      body.interactions[0].steps.push({ p: 'set_object_state', state: 'open' });
      body.interactions[0].end_state = 'open';
    })).status).toBe(200);
    const row = t.sql.prepare("SELECT spec,status FROM interactions WHERE source='compiled'").get()!;
    const spec = JSON.parse(String(row.spec));
    expect(row.status).toBe('rejected');
    expect(spec.steps.some((s: any) => s.p === 'set_object_state')).toBe(true);
  });
  it('per-role cap denies photo without consuming global cap; expired judge code fails', async () => {
    const t = setup();
    t.env.CAM_OWNER_PHOTO_CAP = '0';
    expect((await t.photo()).status).toBe(429);
    t.env.JUDGE_CODE_SHA256 = await sha256Hex('judge-fixture');
    t.env.JUDGE_CODE_EXPIRES = '2026-11-01T00:00:00Z';
    expect((await t.call('/api/gift/photo', undefined, { 'X-Nori-Code': 'judge-fixture' })).status).toBe(401);
  });
  it('owner invalid move and non-owner remove cannot change geometry', async () => {
    const t = setup();
    expect((await t.call('/api/owner/object', { id: 'o_cardboard_box', op: 'remove', idem: 'bad' })).status).toBe(401);
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const headers = { 'X-Nori-Code': 'owner-fixture' };
    expect((await t.call('/api/owner/object', { id: 'o_cardboard_box', op: 'move', x: -1, y: 0, idem: 'outside' },
      headers)).status).toBe(422);
    expect(t.sql.prepare("SELECT status FROM objects WHERE id='o_cardboard_box'").get()?.status).toBe('placed');
  });
});


function ingestBody(id: string) {
  const body = JSON.parse(readFileSync(new URL('../sample/cam/ingest-gift-ready.json', import.meta.url), 'utf8'));
  body.gift_id = id;
  body.sprite = `/media/gift-${id}.png`;
  return body;
}
function failNextReplan(t: ReturnType<typeof setup>) {
  const batch = t.db.batch.bind(t.db);
  return vi.spyOn(t.db, 'batch').mockImplementation(async statements => {
    const query = (statements[0] as unknown as { query: string }).query;
    if (query.startsWith('UPDATE world') && t.sql.prepare('SELECT count(*) n FROM gifts').get()!.n) {
      throw new Error('transient D1 error');
    }
    return batch(statements);
  });
}
function countStatements(t: ReturnType<typeof setup>) {
  let count = 0;
  const prepare = t.db.prepare.bind(t.db);
  const batch = t.db.batch.bind(t.db);
  vi.spyOn(t.db, 'prepare').mockImplementation(q => {
    const stmt = prepare(q);
    for (const method of ['first', 'all', 'run'] as const) {
      const original = stmt[method].bind(stmt);
      (stmt as any)[method] = (...args: any[]) => {
        count++;
        return (original as any)(...args);
      };
    }
    return stmt;
  });
  vi.spyOn(t.db, 'batch').mockImplementation(statements => {
    count += statements.length;
    return batch(statements);
  });
  return { reset() { count = 0; }, get count() { return count; } };
}
describe('A2a-r2 security regressions', () => {
  it('GET survives transient replan failure and retries pending fact', async () => {
    const t = setup();
    await t.call('/api/gift', { catalog_key: 'toy', idem: 'first' });
    await writeFact(t.db, { id: 'pending', at: NOW, type: 'gift_arrived', actor: 'system', payload: {} }, NOW, () => []);
    const spy = failNextReplan(t);
    expect((await handle(new Request('https://fixture/api/cam'), t.env, { now: () => NOW })).status).toBe(200);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='pending'").get()?.handled_version).toBeNull();
    spy.mockRestore();
    expect((await handle(new Request('https://fixture/api/cam'), t.env, { now: () => NOW })).status).toBe(200);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='pending'").get()?.handled_version).not.toBeNull();
  });
  it('photo commits and dispatches despite post-commit replan failure', async () => {
    const t = setup();
    const spy = failNextReplan(t);
    expect((await t.photo()).status).toBe(200);
    spy.mockRestore();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('reserved');
  });
  it('failed gift advances stale timeline on its first attempt', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const response = await t.call('/api/ingest', { type: 'gift_failed', gift_id: id, step: 'redraw',
      pipeline: [], cost_usd: 0 }, { Authorization: 'Bearer fixture-token' }, NOW + 900000);
    expect(response.status).toBe(200);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('failed');
    t.contiguous();
  });
  it.each(['computer_desk', 'bed', 'water_bowl', 'food_bowl'])('refuses non-gift catalog %s', async kind => {
    const t = setup();
    expect((await t.call('/api/gift', { catalog_key: kind, idem: 'bad' })).status).toBe(400);
    expect(t.sql.prepare('SELECT count(*) n FROM gifts').get()?.n).toBe(0);
  });
  it.each(['cardboard_box', 'slipper', 'toy', 'cushion'])('gift %s has generic interactions only', async kind => {
    const t = setup();
    const result = await t.call('/api/gift', { catalog_key: kind, idem: 'copy' });
    expect(result.status).toBe(200);
    const { gift_id: id } = await result.json() as any;
    const rows = t.sql.prepare('SELECT spec FROM interactions WHERE object_id=?').all('o_' + id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0].spec)).steps).toEqual([{ p: 'move_to', part: 'front' }, { p: 'wait', ms: 1500 }]);
  });
  it('ingest requires Bearer even with valid judge code', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    t.env.JUDGE_CODE_SHA256 = await sha256Hex('judge-fixture');
    expect((await t.call('/api/ingest', { type: 'gift_failed', gift_id: id, step: 'redraw', pipeline: [], cost_usd: 0 },
      { 'X-Nori-Code': 'judge-fixture' })).status).toBe(401);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
  });
  it('ten failed codes lock out a subsequently correct owner code', async () => {
    const t = setup();
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    for (let i = 0; i < 10; i++) {
      expect((await t.call('/api/gift/photo', undefined, { 'X-Nori-Code': 'wrong' })).status).toBe(401);
    }
    expect((await t.photo()).status).toBe(401);
    expect(t.dispatch).not.toHaveBeenCalled();
  });
  it.each(['sprite', 'cost', 'failed-step'])('rejects invalid ingest %s', async mode => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const response = await t.ready(id, body => {
      if (mode === 'sprite') body.sprite = '/media/other.png';
      if (mode === 'cost') body.cost_usd = '0';
      if (mode === 'failed-step') {
        body.type = 'gift_failed';
        body.step = 'arbitrary';
      }
    });
    expect(response.status).toBe(mode === 'sprite' ? 422 : 400);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
  });
  it('judge owner operation is forbidden with 403', async () => {
    const t = setup();
    t.env.JUDGE_CODE_SHA256 = await sha256Hex('judge-fixture');
    expect((await t.call('/api/owner/object', { id: 'o_cardboard_box', op: 'remove', idem: 'judge' },
      { 'X-Nori-Code': 'judge-fixture' })).status).toBe(403);
    expect(t.sql.prepare("SELECT status FROM objects WHERE id='o_cardboard_box'").get()?.status).toBe('placed');
  });
  it.each(['declared', 'stream'])('rejects %s oversized body before reservation', async mode => {
    const t = setup();
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const headers: Record<string, string> = { 'X-Nori-Code': 'owner-fixture', 'Content-Type': 'multipart/form-data; boundary=x' };
    if (mode === 'declared') headers['Content-Length'] = String(9 * 1024 * 1024);
    const body = mode === 'declared' ? 'small' : new Uint8Array(9 * 1024 * 1024);
    const response = await handle(new Request('https://fixture/api/gift/photo', { method: 'POST', headers, body }),
      t.env, { now: () => NOW, fetch: t.dispatch });
    expect(response.status).toBe(413);
    expect(t.sql.prepare('SELECT count(*) n FROM budget_ledger').get()?.n).toBe(0);
    expect(t.dispatch).not.toHaveBeenCalled();
  });
  it('rejects spoofed JPEG magic before reservation', async () => {
    const t = setup();
    expect((await t.photo('jpeg', PNG, 'image/jpeg')).status).toBe(415);
    expect(t.sql.prepare('SELECT count(*) n FROM budget_ledger').get()?.n).toBe(0);
  });
  it('terminal budget statuses cannot be settled released or expired again', async () => {
    const t = setup();
    await reserve(t.env, 'owner_photo', 'terminal', 0.08, 10, NOW);
    const id = 'res:owner_photo:terminal';
    await settleBudget(t.db, id, 0.02, NOW, 'first').run();
    const before = t.sql.prepare('SELECT * FROM budget_ledger').get();
    await settleBudget(t.db, id, 0.4, NOW + 1, 'second').run();
    expect(t.sql.prepare('SELECT * FROM budget_ledger').get()).toEqual(before);
    await releaseBudget(t.db, id, NOW + 2).run();
    expect(t.sql.prepare('SELECT * FROM budget_ledger').get()).toEqual(before);
    await expireReservations(t.db, NOW + 8000000);
    expect(t.sql.prepare('SELECT * FROM budget_ledger').get()).toEqual(before);
    await reserve(t.env, 'owner_photo', 'released', 0.08, 10, NOW);
    await releaseBudget(t.db, 'res:owner_photo:released', NOW).run();
    expect((await settleBudget(t.db, 'res:owner_photo:released', 0.2, NOW, 'late').run()).meta.changes).toBe(0);
  });
  it.each([[60, 40], [80, 80], [100, 40], [200, 30]])('paid photo %ix%i finds legal placement', async (w, d) => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => {
      body.object_card.space.cm.w = w;
      body.object_card.space.cm.d = d;
    })).status).toBe(200);
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('ready');
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('settled');
    const snap = await snapshot(t.db, NOW);
    const object = snap.objects.find(o => o.id === 'o_' + id)!;
    expect(object.footprint).toHaveLength(Math.round(w / 40) * Math.max(1, Math.round(d / 40)));
    const pose = poseAt(snap.segments, NOW)!;
    expect(placementOk({ objects: snap.objects, nori: pose }, object).ok).toBe(true);
    t.contiguous();
  });
  it('IPv6 privacy addresses share /64 but distinct prefixes and IPv4 do not', async () => {
    const t = setup();
    const hash = (ip: string) => visitorHash(new Request('https://fixture', { headers: { 'CF-Connecting-IP': ip } }), t.env, NOW);
    expect(await hash('2001:db8:1234:5678::1')).toBe(await hash('2001:0db8:1234:5678:ffff:abcd:1234:5678'));
    expect(await hash('2001:db8:1234:5678::1')).not.toBe(await hash('2001:db8:1234:5679::1'));
    expect(await hash('192.0.2.1')).not.toBe(await hash('192.0.2.2'));
  });
  it('visitor 429 rejects before timeline work with a few statements', async () => {
    const t = setup();
    const counter = countStatements(t);
    await t.call('/api/gift', { catalog_key: 'toy', idem: 'one' });
    counter.reset();
    expect((await t.call('/api/gift', { catalog_key: 'toy', idem: 'two' })).status).toBe(429);
    console.log('visitor-429-statements', counter.count);
    expect(counter.count).toBe(4);
  });
  it('global daily visitor cap applies across IPs and resets next London day', async () => {
    const t = setup();
    t.env.CAM_VISITOR_GIFTS_DAILY = '1';
    expect((await t.call('/api/gift', { catalog_key: 'toy', idem: 'one' })).status).toBe(200);
    expect((await t.call('/api/gift', { catalog_key: 'toy', idem: 'two' }, { 'CF-Connecting-IP': '192.0.2.2' })).status).toBe(429);
    expect((await t.call('/api/gift', { catalog_key: 'toy', idem: 'tomorrow' }, {}, NOW + 86400000)).status).toBe(200);
  });
  it.each(['cap', 'sum'])('rejects untrusted pipeline cost %s', async mode => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => {
      body.cost_usd = mode === 'cap' ? 0.51 : 0.02;
      if (mode === 'cap') body.pipeline[1].cost_usd = 0.51;
    })).status).toBe(400);
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('reserved');
  });
  it('missing sprite returns retryable conflict without committing', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const response = await t.call('/api/ingest', ingestBody(id), { Authorization: 'Bearer fixture-token' });
    expect(response.status).toBe(409);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('processing');
    expect((await t.ready(id)).status).toBe(200);
  });
  it.each(['name', 'category', 'trailing-newline'])('rechecks Python %s validation on server', async mode => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => {
      if (mode === 'name') {
        body.name = '<script>';
        body.object_card.name = body.name;
      }
      else if (mode === 'category') body.object_card.category = 'weapon';
      else {
        body.name = 'Toy\n';
        body.object_card.name = body.name;
      }
    })).status).toBe(422);
  });
  it('beyond_executor capability event is private', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => { body.object_card.beyond_executor = ['private model text']; })).status).toBe(200);
    expect(t.sql.prepare("SELECT public FROM events WHERE id=?").get(`gap:${id}:card`)?.public).toBe(0);
  });
  it.each(['/api/gift', '/api/owner/object'])('%s requires JSON content type', async path => {
    const t = setup();
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    expect((await t.call(path, { catalog_key: 'toy', idem: 'type', id: 'o_cardboard_box', op: 'remove' },
      { 'Content-Type': 'text/plain', 'X-Nori-Code': 'owner-fixture' })).status).toBe(415);
  });
  it('owner idem cannot be replayed against another target', async () => {
    const t = setup();
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const headers = { 'X-Nori-Code': 'owner-fixture' };
    expect((await t.call('/api/owner/object', { id: 'o_cardboard_box', op: 'remove', idem: 'same' }, headers)).status).toBe(200);
    expect((await t.call('/api/owner/object', { id: 'o_bed', op: 'remove', idem: 'same' }, headers)).status).toBe(409);
  });
});


describe('A2a-r2 additional boundaries', () => {
  it.each(['catalog', 'ready', 'failed', 'owner'])('%s post-commit replan failure preserves success', async mode => {
    const t = setup();
    if (mode === 'catalog' || mode === 'owner') {
      await t.call('/api/gift', { catalog_key: 'toy', idem: 'first' });
    }
    let id = '';
    if (mode === 'ready' || mode === 'failed') {
      ({ gift_id: id } = await (await t.photo()).json() as any);
    }
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const spy = failNextReplan(t);
    let response: Response;
    if (mode === 'catalog') {
      response = await t.call('/api/gift', { catalog_key: 'cushion', idem: 'another' }, { 'CF-Connecting-IP': '192.0.2.2' });
    } else if (mode === 'ready') {
      response = await t.ready(id);
    } else if (mode === 'failed') {
      response = await t.call('/api/ingest', { type: 'gift_failed', gift_id: id, step: 'redraw', pipeline: [], cost_usd: 0 },
        { Authorization: 'Bearer fixture-token' });
    } else {
      response = await t.call('/api/owner/object', { id: 'o_cardboard_box', op: 'remove', idem: 'owner-fail' },
        { 'X-Nori-Code': 'owner-fixture' });
    }
    spy.mockRestore();
    expect(response.status).toBe(200);
    if (mode === 'ready' || mode === 'failed') {
      expect(t.sql.prepare('SELECT status FROM gifts WHERE id=?').get(id)?.status).toBe(mode === 'ready' ? 'ready' : 'failed');
      expect(t.sql.prepare('SELECT status FROM budget_ledger').get()?.status).toBe('settled');
    }
  });
  it('impossible paid footprint clamps to the parcel cell', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const before = t.sql.prepare('SELECT x,y FROM objects WHERE id=?').get('o_' + id)!;
    expect((await t.ready(id, body => {
      body.object_card.space.cm.w = 1000;
      body.object_card.space.cm.d = 1000;
    })).status).toBe(200);
    const object = t.sql.prepare('SELECT x,y,footprint FROM objects WHERE id=?').get('o_' + id)!;
    expect(object).toMatchObject({ ...before, footprint: '[[0,0]]' });
    expect(t.sql.prepare('SELECT status FROM gifts').get()?.status).toBe('ready');
  });
  it('simultaneous visitors cannot exceed global cap', async () => {
    const t = setup();
    t.env.CAM_VISITOR_GIFTS_DAILY = '1';
    const responses = await Promise.all([1, 2].map(n => t.call('/api/gift', { catalog_key: 'toy', idem: 'cap' + n },
      { 'CF-Connecting-IP': '192.0.2.' + n })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 429]);
    expect(t.sql.prepare('SELECT count(*) n FROM gifts').get()?.n).toBe(1);
  });
  it('default global cap is forty visitor gifts', async () => {
    const t = setup();
    for (let i = 0; i < 40; i++) {
      t.sql.prepare(`INSERT INTO gifts (id,idem,insert_token,giver,kind,status,object_id,created_at,updated_at)
        VALUES (?,?,'fixture',?,'catalog:toy','placed','fixture',?,?)`).run('cap' + i, 'cap' + i, 'visitor:' + i, NOW, NOW);
    }
    expect((await t.call('/api/gift', { catalog_key: 'toy', idem: 'over-cap' })).status).toBe(429);
  });
  it('configurable photo cost cap and sum tolerance are applied', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    t.env.CAM_PHOTO_MAX_USD = '0.03';
    expect((await t.ready(id, body => {
      body.cost_usd = 0.04;
      body.pipeline[1].cost_usd = 0.04;
    })).status).toBe(400);
    expect((await t.ready(id, body => { body.cost_usd = 0.0005; })).status).toBe(200);
  });
  it('unexpected route failure logs only error class and message and answers 500', async () => {
    const t = setup();
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(t.db, 'prepare').mockImplementation(() => { throw new TypeError('fixture database unavailable'); });
    const response = await t.call('/api/gift', { catalog_key: 'toy', idem: 'private-body' }, { 'X-Nori-Code': 'private-code' });
    expect(response.status).toBe(500);
    expect(logger.mock.calls).toEqual([['cam_gift_error', 'TypeError', 'fixture database unavailable']]);
    logger.mockRestore();
  });
});


describe('A2a-r2 preserved owner and card contracts', () => {
  it('concurrent owner idem with different targets conflicts', async () => {
    const t = setup();
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const responses = await Promise.all(['o_cardboard_box', 'o_bed'].map(id =>
      t.call('/api/owner/object', { id, op: 'remove', idem: 'race' }, { 'X-Nori-Code': 'owner-fixture' })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it('photo gift requires an initial state from the card states', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id, body => { body.object_card.states = ['open']; })).status).toBe(422);
    expect((await t.ready(id, body => { delete body.initial_state; })).status).toBe(422);
    expect((await t.ready(id, body => { body.initial_state = 'lava'; })).status).toBe(422);
  });
});

describe('placement while Nori is inside a blocking object', () => {
  // Stands Nori on the seeded cardboard box cell (6,4) from NOW (the settled_through anchor) onward.
  async function noriInBox(t: ReturnType<typeof setup>) {
    const segment = safeSegment(NOW, NOW + 600000, 0, 0, [6, 4]);
    t.sql.exec('DELETE FROM segments');
    t.sql.prepare(`INSERT INTO segments
      (start_at,end_at,action,primitive,pose,path,source,world_version,effects)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(segment.start_at, segment.end_at, segment.action, segment.primitive,
      segment.pose, JSON.stringify(segment.path), segment.source, 0, '[]');
    t.sql.prepare('UPDATE world SET timeline_until=?').run(segment.end_at);
    const pose = poseAt((await snapshot(t.db, NOW)).segments, NOW);
    expect([pose?.x, pose?.y]).toEqual([6, 4]);
  }
  it('catalog gift lands on a legal cell while Nori is inside the cardboard box', async () => {
    const t = setup();
    await noriInBox(t);
    const response = await t.call('/api/gift', { catalog_key: 'toy', idem: 'toy-in-box' });
    expect(response.status).toBe(200);
    const { gift_id: id } = await response.json() as any;
    const placed = t.sql.prepare('SELECT x,y FROM objects WHERE id=?').get('o_' + id)!;
    expect([placed.x, placed.y]).not.toEqual([6, 4]);
    t.contiguous();
  });
  it('owner move of the slipper lands on a legal cell while Nori is inside the cardboard box', async () => {
    const t = setup();
    await noriInBox(t);
    t.env.OWNER_CODE_SHA256 = await sha256Hex('owner-fixture');
    const response = await t.call('/api/owner/object', { id: 'o_slipper', op: 'move', x: 1, y: 1, idem: 'slipper-in-box' },
      { 'X-Nori-Code': 'owner-fixture' });
    expect(response.status).toBe(200);
    expect(t.sql.prepare("SELECT x,y FROM objects WHERE id='o_slipper'").get()).toMatchObject({ x: 1, y: 1 });
    t.contiguous();
  });
  it('photo gift_ready unwraps a 2x2 parcel while Nori is inside the cardboard box', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    await noriInBox(t);
    // A 40 cm card is a 1x1 footprint, which the fallback also produces; 80 cm makes a legal placement observable.
    const response = await t.ready(id, body => { body.object_card.space.cm = { w: 80, d: 80, h: 20 }; });
    expect(response.status).toBe(200);
    const object = (await snapshot(t.db, NOW)).objects.find(o => o.id === 'o_' + id)!;
    expect(object.footprint).toHaveLength(4);
    expect(object.footprint.map(([x, y]) => [object.x + x, object.y + y])).not.toContainEqual([6, 4]);
    t.contiguous();
  });
});
