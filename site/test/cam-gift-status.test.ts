import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { handle } from '../src/worker/index.ts';
import type { GiftEnv } from '../src/worker/cam/gifts.ts';
import { sha256Hex } from '../src/worker/limits.ts';
import { advance } from '../src/worker/cam/timeline.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const AUTH = { Authorization: 'Bearer fixture-token' };
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
      method: path.includes('/source/') || path.includes('/status/') ? 'GET' : 'POST',
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
  async function ready(id: string) {
    const body = sample();
    body.gift_id = id;
    body.sprite = `/media/gift-${id}.png`;
    values.set(`gift-${id}.png`, { value: PNG, options: {} });
    const result = await call('/api/ingest', body, AUTH);
    values.delete(`gift-${id}.png`);
    return result;
  }
  async function fail(id: string, step: string) {
    return call('/api/ingest', { type: 'gift_failed', gift_id: id, step,
      pipeline: [{ step, model: 'fake', ok: false, ms: 1, seconds: 0, cost_usd: 0.01, cost_basis: 'estimate' }],
      cost_usd: 0.01 }, AUTH);
  }
  return { ...base, env, values, call, photo, ready, fail, dispatch };
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('live network forbidden'); }));
});

describe('gift status endpoint', () => {
  it('reports processing with null name/sprite/reason and no private fields', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    const response = await t.call(`/api/gift/status/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as any;
    expect(Object.keys(body).sort()).toEqual(['gift_id', 'name', 'reason', 'sprite', 'status', 'updated_at']);
    expect(body).toMatchObject({ gift_id: id, status: 'processing', name: null, sprite: null, reason: null });
    expect(typeof body.updated_at).toBe('number');
    const raw = JSON.stringify(body);
    for (const secret of ['visitor:', 'photo-one', 'giftsrc', 'insert_token', 'pipeline', 'cost_usd',
      'fixture-gh', 'owner-fixture', ' [REDACTED]']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('reports ready with the card name and the /media/ sprite', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.photo()).json() as any;
    expect((await t.ready(id)).status).toBe(200);
    const body = await (await t.call(`/api/gift/status/${id}`)).json() as any;
    expect(body).toMatchObject({ gift_id: id, status: 'ready', name: 'toy box',
      sprite: `/media/gift-${id}.png`, reason: null });
    expect(typeof body.updated_at).toBe('number');
  });

  it('reports placed catalog gifts with the card name but no sprite or reason', async () => {
    const t = setup();
    const { gift_id: id } = await (await t.call('/api/gift', { catalog_key: 'cardboard_box', idem: 'one' })).json() as any;
    const body = await (await t.call(`/api/gift/status/${id}`)).json() as any;
    expect(body).toMatchObject({ gift_id: id, status: 'placed', name: 'cardboard box', sprite: null, reason: null });
  });

  it.each([
    ['understand', 'content_refused'],
    ['box', 'draw_failed'],
    ['redraw', 'draw_failed'],
    ['pixelize', 'draw_failed'],
    ['fetch_source', 'unavailable'],
    ['upload', 'unavailable'],
    ['ingest', 'unavailable'],
  ])('maps failed step %s to public reason %s', async (step, reason) => {
    const t = setup();
    const { gift_id: id } = await (await t.photo(`photo-${step}`)).json() as any;
    expect((await t.fail(id, step)).status).toBe(200);
    const body = await (await t.call(`/api/gift/status/${id}`)).json() as any;
    expect(body).toMatchObject({ gift_id: id, status: 'failed', name: null, sprite: null, reason });
  });

  it('maps dispatch failure and photo timeout to public reasons', async () => {
    const refused = setup();
    refused.dispatch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect((await refused.photo('refused')).status).toBe(502);
    const refusedId = refused.sql.prepare('SELECT id FROM gifts').get()!.id as string;
    expect(await (await refused.call(`/api/gift/status/${refusedId}`)).json()).toMatchObject({
      status: 'failed', name: null, sprite: null, reason: 'unavailable',
    });
    const slow = setup();
    const { gift_id: slowId } = await (await slow.photo('slow')).json() as any;
    await advance(slow.env, NOW + 20 * 60000, 'read');
    expect(await (await slow.call(`/api/gift/status/${slowId}`)).json()).toMatchObject({
      status: 'failed', name: null, sprite: null, reason: 'timeout',
    });
  });

  it('returns 404 for unknown and malformed ids', async () => {
    const t = setup();
    expect((await t.call(`/api/gift/status/${'0'.repeat(32)}`)).status).toBe(404);
    for (const bad of ['nope', 'ABCDEF0123456789abcdef0123456789', '0'.repeat(33), '0'.repeat(31), 'has space']) {
      expect((await t.call(`/api/gift/status/${bad}`)).status).toBe(404);
    }
    expect((await t.call('/api/gift/status/')).status).toBe(404);
  });

  it('rejects non-GET methods', async () => {
    const t = setup();
    const response = await handle(new Request('https://fixture/api/gift/status/' + '0'.repeat(32),
      { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.1' } }), t.env, { now: () => NOW });
    expect(response.status).toBe(405);
  });
});
