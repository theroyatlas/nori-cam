import { describe, expect, it } from 'vitest';
import { mediaType } from '../src/worker/media.ts';
import { LAST_KEY, MIN_GAP_MS, wakeTick } from '../src/worker/wake.ts';

function kv() {
  const m: Record<string, string> = {};
  const ns = {
    async get(k: string) { return m[k] ?? null; },
    async put(k: string, v: string) { m[k] = v; },
  } as unknown as KVNamespace;
  return { m, ns };
}

function gh(opts: { next?: string; stateStatus?: number; queued?: number; running?: number; dispatch?: number }) {
  const calls: { url: string; method: string; auth: string | null; body?: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    calls.push({ url, method: init.method || 'GET', auth: h.get('Authorization'), body: init.body as string | undefined });
    if (url.includes('/contents/longrun/state.json')) {
      return new Response(JSON.stringify({ next_wake_at: opts.next }), { status: opts.stateStatus ?? 200 });
    }
    if (url.includes('status=queued')) return new Response(JSON.stringify({ total_count: opts.queued ?? 0 }), { status: 200 });
    if (url.includes('status=in_progress')) return new Response(JSON.stringify({ total_count: opts.running ?? 0 }), { status: 200 });
    if (url.endsWith('/dispatches')) return new Response(null, { status: opts.dispatch ?? 204 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const NOW = Date.parse('2026-11-01T06:40:00Z');

describe('cron wake', () => {
  it('does nothing without a token', async () => {
    const k = kv();
    const g = gh({});
    expect(await wakeTick({ MEDIA: k.ns }, NOW, g.f)).toBe('no_token');
    expect(g.calls.length).toBe(0);
  });

  it('waits while next_wake_at is in the future', async () => {
    const k = kv();
    const g = gh({ next: '2026-11-01T07:00:00+00:00' });
    expect(await wakeTick({ MEDIA: k.ns, GH_DISPATCH_TOKEN: 't' }, NOW, g.f)).toBe('not_due');
    expect(g.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('dispatches master when due and nothing is running, then holds off for the gap', async () => {
    const k = kv();
    const g = gh({ next: '2026-11-01T06:35:54+00:00' });
    expect(await wakeTick({ MEDIA: k.ns, GH_DISPATCH_TOKEN: 'tok' }, NOW, g.f)).toBe('dispatched');
    const post = g.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.github.com/repos/theroyatlas/nori-aipet/actions/workflows/nori-wake.yml/dispatches');
    expect(post?.auth).toBe('Bearer tok');
    expect(JSON.parse(post?.body || '{}')).toEqual({ ref: 'master' });
    expect(k.m[LAST_KEY]).toBe(String(NOW));
    const again = gh({ next: '2026-11-01T06:35:54Z' });
    expect(await wakeTick({ MEDIA: k.ns, GH_DISPATCH_TOKEN: 'tok' }, NOW + MIN_GAP_MS - 1, again.f)).toBe('recent_dispatch');
    expect(again.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('does not stack runs', async () => {
    const k = kv();
    expect(await wakeTick({ MEDIA: k.ns, GH_DISPATCH_TOKEN: 't' }, NOW, gh({ next: '2026-11-01T06:00:00Z', running: 1 }).f)).toBe('busy');
    expect(await wakeTick({ MEDIA: k.ns, GH_DISPATCH_TOKEN: 't' }, NOW, gh({ next: '2026-11-01T06:00:00Z', queued: 1 }).f)).toBe('busy');
  });

  it('reports auth problems and a failed dispatch without recording a dispatch', async () => {
    const k = kv();
    expect(await wakeTick({ MEDIA: k.ns, GH_DISPATCH_TOKEN: 't' }, NOW, gh({ stateStatus: 401 }).f)).toBe('state_http_401');
    expect(await wakeTick({ MEDIA: k.ns, GH_DISPATCH_TOKEN: 't' }, NOW, gh({ next: '2026-11-01T06:00:00Z', dispatch: 403 }).f)).toBe('dispatch_http_403');
    expect(k.m[LAST_KEY]).toBeUndefined();
  });

  it('the dispatch marker cannot be read through /media/', () => {
    expect(mediaType(LAST_KEY)).toBeNull();
  });
});
