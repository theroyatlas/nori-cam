import { describe, expect, it } from 'vitest';
import { handle } from '../src/worker/index.ts';
import { assetsStub, kvStub } from './helpers.ts';

const TOKEN = 'upload-test-token';

function env(kv: KVNamespace) {
  return { DB: {} as D1Database, MEDIA: kv, ASSETS: assetsStub(), MEDIA_UPLOAD_TOKEN: TOKEN } as any;
}

describe('media upload', () => {
  it('rejects PUT without bearer token', async () => {
    const kv = kvStub();
    const r = await handle(new Request('https://nori.test/media/pic.png', { method: 'PUT', body: new Uint8Array([1, 2]) }), env(kv));
    expect(r.status).toBe(401);
  });

  it('rejects non-image extensions and oversize bodies', async () => {
    const kv = kvStub();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await handle(new Request('https://nori.test/media/x.gif', { method: 'PUT', headers: auth, body: new Uint8Array(10) }), env(kv))).status).toBe(415);
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    expect((await handle(new Request('https://nori.test/media/big.png', { method: 'PUT', headers: auth, body: big }), env(kv))).status).toBe(413);
  });

  it('stores PNG and serves it on GET', async () => {
    const files: Record<string, Uint8Array> = {};
    const kv = {
      async put(name: string, value: ArrayBuffer) { files[name] = new Uint8Array(value); },
      async get(name: string) { const f = files[name]; return f ? f.buffer : null; },
    } as unknown as KVNamespace;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const put = await handle(new Request('https://nori.test/media/nori.png', {
      method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: png,
    }), env(kv));
    expect(put.status).toBe(204);
    const get = await handle(new Request('https://nori.test/media/nori.png'), env(kv));
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/png');
  });
});
