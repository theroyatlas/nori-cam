import { describe, it, expect, vi, beforeEach } from 'vitest';
import { database, NOW } from '../scripts/cam-test-db.ts';
import handleDefault, { handle } from '../src/worker/index.ts';
import { resetVirtualClock, setVirtualNow, workerNow } from '../src/worker/cam/clock.ts';

beforeEach(() => {
  resetVirtualClock();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('live network forbidden'); }));
});

function localEnv(extra: Record<string, unknown> = {}) {
  const { env, sql } = database();
  return { env: { ...env, ...extra } as any, sql };
}

describe('workerNow without the local flag', () => {
  it.each([undefined, '0', '', '2'])('passes real time through when CAM_LOCAL_PIPELINE=%s', (flag) => {
    const env = flag === undefined ? {} : { CAM_LOCAL_PIPELINE: flag };
    expect(workerNow(env, 123456789)).toBe(123456789);
    expect(setVirtualNow(env, 999)).toBe(false);
    expect(workerNow(env, 123456789)).toBe(123456789);
  });
});

describe('workerNow with CAM_LOCAL_PIPELINE=1', () => {
  const env = () => ({ CAM_LOCAL_PIPELINE: '1' });
  it('latches the first real now and ignores later ones until advanced', () => {
    expect(workerNow(env(), 1000)).toBe(1000);
    expect(workerNow(env(), 2000)).toBe(1000);
    expect(setVirtualNow(env(), 5000)).toBe(true);
    expect(workerNow(env(), 6000)).toBe(5000);
  });
  it('rejects non-integer or negative targets', () => {
    workerNow(env(), 1000);
    expect(setVirtualNow(env(), NaN)).toBe(false);
    expect(setVirtualNow(env(), 1.5)).toBe(false);
    expect(setVirtualNow(env(), -1)).toBe(false);
    expect(workerNow(env(), 2000)).toBe(1000);
  });
});

describe('clock control endpoint', () => {
  it('answers 404 without the local flag', async () => {
    const { env } = localEnv();
    for (const method of ['GET', 'POST']) {
      const res = await handle(new Request('https://fixture/api/cam/test/clock', { method }), env, {});
      expect(res.status).toBe(404);
    }
  });
  it('answers 404 when the flag has another value', async () => {
    const { env } = localEnv({ CAM_LOCAL_PIPELINE: '0' });
    const res = await handle(new Request('https://fixture/api/cam/test/clock'), env, {});
    expect(res.status).toBe(404);
  });
  it('sets and reports virtual time with the local flag', async () => {
    const { env } = localEnv({ CAM_LOCAL_PIPELINE: '1' });
    const bad = await handle(new Request('https://fixture/api/cam/test/clock',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"now":"nope"}' }), env, {});
    expect(bad.status).toBe(400);
    const set = await handle(new Request('https://fixture/api/cam/test/clock',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now: NOW }) }), env, {});
    expect(set.status).toBe(200);
    expect((await set.json()) as { now: number }).toEqual({ now: NOW });
    const got = await handle(new Request('https://fixture/api/cam/test/clock'), env, {});
    expect((await got.json()) as { now: number }).toEqual({ now: NOW });
    const put = await handle(new Request('https://fixture/api/cam/test/clock', { method: 'PUT' }), env, {});
    expect(put.status).toBe(405);
  });
});

describe('reads and cron follow the virtual clock only when flagged', () => {
  it('/api/cam server_now follows the preset virtual clock', async () => {
    const { env } = localEnv({ CAM_LOCAL_PIPELINE: '1' });
    await handle(new Request('https://fixture/api/cam/test/clock',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now: NOW }) }), env, {});
    const res = await handle(new Request('https://fixture/api/cam'), env, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.server_now).toBe(NOW);
    expect(body.timeline_until).toBeGreaterThanOrEqual(NOW + 10 * 60000);
    expect(body.segments.some((s: any) => s.start_at <= NOW && s.end_at > NOW)).toBe(true);
  });
  it('/api/cam keeps real time without the flag', async () => {
    const { env } = localEnv();
    const before = Date.now();
    const res = await handle(new Request('https://fixture/api/cam'), env, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.server_now).toBeGreaterThanOrEqual(before);
    expect(body.server_now).toBeLessThanOrEqual(Date.now());
  });
  it('scheduled cron extends the horizon from the virtual clock', async () => {
    const { env } = localEnv({ CAM_LOCAL_PIPELINE: '1' });
    expect(setVirtualNow(env as any, NOW)).toBe(true);
    const waited: Promise<unknown>[] = [];
    await handleDefault.scheduled({} as any, env as any, { waitUntil(p: Promise<unknown>) { waited.push(p); } } as any);
    await Promise.all(waited);
    const body = (await (await handle(new Request('https://fixture/api/cam'), env, {})).json()) as any;
    expect(body.server_now).toBe(NOW);
    expect(body.timeline_until).toBeGreaterThanOrEqual(NOW + 45 * 60000);
  });
});
