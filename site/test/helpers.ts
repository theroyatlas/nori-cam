import { readFileSync } from 'node:fs';
import { handle } from '../src/worker/index.ts';
import type { Deps, Env } from '../src/worker/api.ts';
import { makeDb } from './d1shim.ts';

export const KEY = 'sk-test-SECRET-key-0123456789abcdef';
export const DEFAULTS = ['Explore kaleidoscope patterns', 'Explore coral reef structures', 'Explore bioluminescence',
  'Explore murmuration', 'Explore fungi', 'Explore moss textures'];
export const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

export function fixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/consistency.json', import.meta.url), 'utf8'));
}

export function assetsStub(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL) {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(`asset:${u.pathname}`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  } as unknown as Fetcher;
}

export function kvStub(files: Record<string, Uint8Array> = {}): KVNamespace {
  return { async get(name: string) { const f = files[name]; return f ? f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) : null; } } as unknown as KVNamespace;
}

export interface Upstream { calls: { url: string; headers: Record<string, string>; payload: any }[]; fetch: typeof fetch }

/** Fake model service. `answer(payload, n)` returns the chat-completions envelope; default picks the first listed option. */
export function upstream(answer?: (payload: any, n: number) => unknown, status = 200): Upstream {
  const calls: Upstream['calls'] = [];
  const f = (async (url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, payload });
    const body = answer ? answer(payload, calls.length) : reply('A0', ['E01'], 'because it is nice');
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetch: f };
}

export function reply(choice: string, eventIds: string[], reason: string, usage: unknown = { prompt_tokens: 3000, completion_tokens: 100 }) {
  return { model: 'muse-spark-1.3', usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ choice_id: choice, event_ids: eventIds, reason }) } }] };
}

export function setup(over: Partial<Env> = {}, up: Upstream = upstream()) {
  const { db, d1 } = makeDb();
  const state = { now: T0 };
  const env: Env = { DB: d1, MEDIA: kvStub(), ASSETS: assetsStub(), MODEL_API_KEY: KEY, ...over } as Env;
  const deps: Deps = { fetch: up.fetch, now: () => state.now };
  const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    handle(new Request(`https://nori.test${path}`, { ...init, headers: { ...(init.headers as object), ...headers } }), env, deps);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }, headers);
  return { db, env, state, up, call, post };
}
