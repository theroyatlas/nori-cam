import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { sha256Hex } from '../src/worker/limits.ts';
import { snapshot } from '../src/worker/cam/store.ts';
import { reserve } from '../src/worker/cam/budget.ts';
import { replan } from '../src/worker/cam/replan.ts';
import { codeRole } from '../src/worker/cam/auth.ts';
import { dispatchStartedSegments } from '../src/worker/cam/triggers.ts';
import { DispatchError } from '../src/worker/cam/dispatch.ts';
import { handle } from '../src/worker/index.ts';
import type { GiftEnv } from '../src/worker/cam/gifts.ts';

async function ingestSetup() {
  const t = database();
  t.sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  t.sql.prepare('UPDATE object_states SET valid_from=?').run(NOW - 86400000);
  const media = new Map<string, unknown>([['drawing.png', new Uint8Array([1])]]);
  const env: GiftEnv = { ...t.env, MEDIA_UPLOAD_TOKEN: 'test-bearer',
    OWNER_CODE_SHA256: await sha256Hex('test-owner'), JUDGE_CODE_SHA256: await sha256Hex('test-judge'),
    MEDIA: { get: async (key: string) => media.get(key) ?? null,
      delete: async (key: string) => { media.delete(key); } } as unknown as KVNamespace };
  const call = (path: string, body?: unknown, bearer = false) => handle(
    new Request(`https://fixture${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer test-bearer' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) }), env, { now: () => NOW });
  const segment = (id: number) => {
    t.sql.prepare(`INSERT INTO segments (id,start_at,end_at,action,primitive,pose,path,source,world_version,trigger)
      VALUES (?,?,?, 'use_computer','hold_pose','sit','[[2,6]]','routine',0,'{"kind":"browse"}')`)
      .run(id, NOW, NOW + 2400000);
    t.sql.prepare('UPDATE world SET timeline_until=?').run(NOW + 2400000);
  };
  const browse = { type: 'browse_result', intent_id: 'seg:999', drawing: '/media/drawing.png', cost_usd: 0.12,
    pages: [{ url: 'https://example.org/read', title: 'Read a page', read_at: NOW - 100 }] };
  return { ...t, env, call, segment, browse, media };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live network forbidden'); })));

describe('A2d ingest and replan guards', () => {
  it('rejects browse ingest when the drawing route is unavailable', async () => {
    const t = await ingestSetup();
    t.segment(999);
    await reserve(t.env, 'browse', 'seg:999', 0.3, 2, NOW);
    t.sql.prepare("UPDATE objects SET status='stored' WHERE kind='computer_desk'").run();
    const r = await t.call('/api/ingest', t.browse, true);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'drawing route unavailable' });
    expect(t.sql.prepare('SELECT status FROM budget_ledger').get()!.status).toBe('reserved');
  });
  it('rejects browse and wonder cost above configured caps', async () => {
    const t = await ingestSetup();
    t.segment(999);
    await reserve(t.env, 'browse', 'seg:999', 0.3, 2, NOW);
    expect((await t.call('/api/ingest', { ...t.browse, cost_usd: 1000 }, true)).status).toBe(400);
    t.segment(998);
    t.sql.prepare(`UPDATE segments SET trigger='{"kind":"reflect"}',action='sleep',primitive='sleep' WHERE id=998`).run();
    await reserve(t.env, 'wonder', 'seg:998', 0.1, 1, NOW);
    t.sql.prepare(`UPDATE segments SET debug=json('{"context_event_ids":["ctx"]}') WHERE id=998`).run();
    const wonder = { type: 'wonder_result', intent_id: 'seg:998', cost_usd: 5, result: {
      reflection: { summary: 'Quiet.', event_ids: ['ctx'] },
      tomorrow: { action: 'sniff', object_id: 'o_slipper', window_minutes: 120, reason_tag: 't', summary: 'Sniff.' },
      habit_candidate: null } };
    expect((await t.call('/api/ingest', wonder, true)).status).toBe(400);
  });
  it('skips a stuck browse_result so a later gift_arrived can replan', async () => {
    const t = await ingestSetup();
    t.segment(999);
    await reserve(t.env, 'browse', 'seg:999', 0.3, 2, NOW);
    expect((await t.call('/api/ingest', t.browse, true)).status).toBe(200);
    t.sql.prepare("UPDATE events SET handled_version=NULL WHERE id='ingest:seg:999:browse_result'").run();
    t.sql.prepare("UPDATE objects SET status='stored' WHERE kind='computer_desk'").run();
    t.sql.prepare("UPDATE world SET state_json=json_set(state_json,'$.nori.asleep',0)").run();
    t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
      VALUES ('gift:later','test',?,'gift_arrived','visitor','{"object_id":"o_slipper"}',1,0,NULL)`).run(NOW + 1);
    expect(await replan(t.db, NOW + 2)).toBe(true);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='ingest:seg:999:browse_result'").get()!
      .handled_version).not.toBeNull();
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='safe_fallback'").get()!.n).toBeGreaterThan(0);
    expect(await replan(t.db, NOW + 3)).toBe(true);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='gift:later'").get()!.handled_version)
      .not.toBeNull();
  });
});

describe('A2d auth and gifts', () => {
  it('allows thirty sequential judge codes in one window after refunding successful attempts', async () => {
    const t = database();
    t.sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
    const env = { ...t.env, JUDGE_CODE_SHA256: await sha256Hex('judge-secret'),
      JUDGE_CODE_EXPIRES: '2026-12-01T00:00:00Z' };
    const req = () => new Request('https://fixture/api/record', { headers: { 'X-Nori-Code': 'judge-secret',
      'CF-Connecting-IP': '203.0.113.44' } });
    for (let i = 0; i < 30; i++) expect(await codeRole(req(), env, NOW)).toBe('judge');
    const bucket = Math.floor(NOW / 600000);
    expect(t.sql.prepare('SELECT n FROM rate_hits WHERE ip_hash LIKE ? AND bucket=?')
      .get('code:%', bucket)!.n).toBeLessThanOrEqual(10);
  });
  it('allows at most ten code comparisons per bucket under parallel guesses', async () => {
    const t = database();
    t.sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
    const env = { ...t.env, OWNER_CODE_SHA256: await sha256Hex('secret-owner') };
    const req = () => new Request('https://fixture/api/record', { headers: { 'X-Nori-Code': 'wrong',
      'CF-Connecting-IP': '203.0.113.10' } });
    let comparisons = 0;
    const orig = sha256Hex;
    const shaSpy = vi.spyOn(await import('../src/worker/limits.ts'), 'sha256Hex')
      .mockImplementation(async (s: string) => {
        if (s === 'wrong') comparisons++;
        return orig(s);
      });
    const results = await Promise.all(Array.from({ length: 20 }, () => codeRole(req(), env, NOW)));
    shaSpy.mockRestore();
    expect(results.filter(r => r === 'owner')).toHaveLength(0);
    expect(comparisons).toBeLessThanOrEqual(10);
    const bucket = Math.floor(NOW / 600000);
    expect(t.sql.prepare('SELECT n FROM rate_hits WHERE ip_hash LIKE ? AND bucket=?')
      .get('code:%', bucket)!.n).toBe(20);
  });
  it('refuses a correct code after ten wrong attempts in the same window', async () => {
    const t = database();
    t.sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
    const env = { ...t.env, JUDGE_CODE_SHA256: await sha256Hex('judge-secret'),
      JUDGE_CODE_EXPIRES: '2026-12-01T00:00:00Z' };
    const wrong = () => new Request('https://fixture/api/record', { headers: { 'X-Nori-Code': 'bad',
      'CF-Connecting-IP': '203.0.113.55' } });
    const right = () => new Request('https://fixture/api/record', { headers: { 'X-Nori-Code': 'judge-secret',
      'CF-Connecting-IP': '203.0.113.55' } });
    for (let i = 0; i < 10; i++) expect(await codeRole(wrong(), env, NOW)).toBeNull();
    expect(await codeRole(right(), env, NOW)).toBeNull();
  });
  it('reflect definite failure releases the day claim for one later retry', async () => {
    const t = database();
    t.sql.prepare(`INSERT INTO segments (id,start_at,end_at,action,primitive,pose,path,source,world_version,trigger)
      VALUES (5,?,?, 'sleep','sleep','sleep','[[2,6]]','routine',0,'{"kind":"reflect"}')`)
      .run(NOW, NOW + 3600000);
    Object.assign(t.env, { CAM_REFLECT_ENABLED: '1', GH_DISPATCH_TOKEN: 'token' });
    const dispatch = vi.fn(async () => { throw new DispatchError(true, 422); });
    await dispatchStartedSegments(t.env, NOW, { dispatch });
    expect(t.sql.prepare("SELECT count(*) n FROM model_calls WHERE id LIKE 'reflect-day:%'").get()!.n).toBe(0);
    await dispatchStartedSegments(t.env, NOW + 1, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
