import { describe, expect, it } from 'vitest';
import { handle } from '../src/worker/index.ts';
import { mediaType } from '../src/worker/media.ts';
import { assetsStub, kvStub } from './helpers.ts';

const TOKEN = 'upload-test-token';

function env(kv: KVNamespace) {
  return { DB: {} as D1Database, MEDIA: kv, ASSETS: assetsStub(), MEDIA_UPLOAD_TOKEN: TOKEN } as any;
}

describe('live data', () => {
  it('rejects PUT without bearer token', async () => {
    const kv = kvStub();
    const r = await handle(new Request('https://nori.test/data/live/posts.json', {
      method: 'PUT',
      body: '{"posts":[]}',
      headers: { 'Content-Type': 'application/json' },
    }), env(kv));
    expect(r.status).toBe(401);
  });

  it('rejects unknown filenames and non-json bodies', async () => {
    const kv = kvStub();
    const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    expect((await handle(new Request('https://nori.test/data/live/demo-events.json', { method: 'PUT', headers: auth, body: '{}' }), env(kv))).status).toBe(404);
    expect((await handle(new Request('https://nori.test/data/live/posts.json', { method: 'PUT', headers: auth, body: '[]' }), env(kv))).status).toBe(400);
  });

  it('stores JSON up to 1MB and serves on GET', async () => {
    const files: Record<string, Uint8Array> = {};
    const kv = {
      async put(key: string, value: ArrayBuffer) { files[key] = new Uint8Array(value); },
      async get(key: string) { const f = files[key]; return f ? f.buffer : null; },
    } as unknown as KVNamespace;
    const body = JSON.stringify({ posts: [] });
    const put = await handle(new Request('https://nori.test/data/live/posts.json', {
      method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body,
    }), env(kv));
    expect(put.status).toBe(204);
    const get = await handle(new Request('https://nori.test/data/live/posts.json'), env(kv));
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toContain('application/json');
    expect(get.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await get.text()).toBe(body);
  });

  it('rejects oversize PUT bodies', async () => {
    const kv = kvStub();
    const big = 'x'.repeat(1024 * 1024 + 1);
    const r = await handle(new Request('https://nori.test/data/live/room.json', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ big }),
    }), env(kv));
    expect(r.status).toBe(413);
  });

  it('does not serve live json from media path', () => {
    expect(mediaType('live/posts.json')).toBeNull();
  });
});
