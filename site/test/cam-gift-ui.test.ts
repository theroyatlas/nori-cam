import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_URL,
  GIFT_KINDS,
  PHOTO_MAX_BYTES,
  PHOTO_TYPES,
  PHOTO_URL,
  STATUS_POLL_MAX_MS,
  STATUS_POLL_MS,
  STATUS_TIMEOUT_TEXT,
  STATUS_WORKING_TEXT,
  buildPhotoForm,
  catalogRequest,
  checkPhotoFile,
  createGiftStatusPoll,
  createIdemStore,
  failedGiftText,
  fileProblemText,
  friendlyError,
  giftProgressText,
  giftStatusUrl,
  interpretGiftResponse,
  isCleanMode,
  isGiftSpriteUrl,
  isValidIdem,
  newIdem,
  photoRequestParts,
  postCatalogGift,
  postPhotoGift,
  sentText,
} from '../public/cam-gift.js';

const IDEM_RE = /^[A-Za-z0-9_-]{1,128}$/;

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url instanceof Request ? url.url : url), init: init || {} });
    return handler(String(url instanceof Request ? url.url : url), init || {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('idem format (mirrors Worker identifier())', () => {
  it('newIdem satisfies /^[A-Za-z0-9_-]{1,128}$/', () => {
    for (let i = 0; i < 25; i += 1) {
      const idem = newIdem();
      expect(typeof idem).toBe('string');
      expect(IDEM_RE.test(idem)).toBe(true);
    }
  });

  it('newIdem values are unique', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newIdem()));
    expect(seen.size).toBe(50);
  });

  it('isValidIdem accepts and rejects the right shapes', () => {
    expect(isValidIdem('abc-XYZ_019')).toBe(true);
    expect(isValidIdem('a')).toBe(true);
    expect(isValidIdem('x'.repeat(128))).toBe(true);
    expect(isValidIdem('')).toBe(false);
    expect(isValidIdem('x'.repeat(129))).toBe(false);
    expect(isValidIdem('has space')).toBe(false);
    expect(isValidIdem('semi;colon')).toBe(false);
    expect(isValidIdem('at@sign')).toBe(false);
    expect(isValidIdem('slash/x')).toBe(false);
    expect(isValidIdem(null)).toBe(false);
    expect(isValidIdem(undefined)).toBe(false);
    expect(isValidIdem(42)).toBe(false);
  });
});

describe('idem retry store', () => {
  it('reuses the same idem for the same submission, renews after reset', () => {
    const store = createIdemStore();
    const first = store.get('catalog:toy');
    expect(store.get('catalog:toy')).toBe(first);
    store.reset('catalog:toy');
    expect(store.get('catalog:toy')).not.toBe(first);
    expect(IDEM_RE.test(store.get('catalog:toy'))).toBe(true);
  });

  it('keeps submissions apart', () => {
    const store = createIdemStore();
    expect(store.get('catalog:toy')).not.toBe(store.get('photo'));
  });
});

describe('photo file checks (type, 5 MB limit)', () => {
  it('accepts jpeg/png at or under the limit', () => {
    expect(checkPhotoFile({ type: 'image/jpeg', size: PHOTO_MAX_BYTES })).toEqual({ ok: true, reason: null });
    expect(checkPhotoFile({ type: 'image/png', size: 1024 })).toEqual({ ok: true, reason: null });
    expect(checkPhotoFile({ type: 'image/jpeg', size: 0 })).toEqual({ ok: true, reason: null });
  });

  it('rejects wrong types, oversize files, and missing files', () => {
    expect(checkPhotoFile({ type: 'image/gif', size: 100 })).toEqual({ ok: false, reason: 'type' });
    expect(checkPhotoFile({ type: 'text/plain', size: 10 })).toEqual({ ok: false, reason: 'type' });
    expect(checkPhotoFile({ type: '', size: 10 })).toEqual({ ok: false, reason: 'type' });
    expect(checkPhotoFile({ type: 'image/jpeg', size: PHOTO_MAX_BYTES + 1 })).toEqual({ ok: false, reason: 'size' });
    expect(checkPhotoFile({ type: 'image/png', size: 10 * 1024 * 1024 })).toEqual({ ok: false, reason: 'size' });
    expect(checkPhotoFile(null)).toEqual({ ok: false, reason: 'missing' });
    expect(checkPhotoFile(undefined)).toEqual({ ok: false, reason: 'missing' });
  });

  it('fileProblemText is short and friendly', () => {
    for (const reason of ['missing', 'type', 'size']) {
      const text = fileProblemText(reason);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(120);
    }
  });
});

describe('catalog request building', () => {
  it('covers all four kinds with the Worker shape', () => {
    expect(GIFT_KINDS).toEqual(['cardboard_box', 'slipper', 'toy', 'cushion']);
    for (const kind of GIFT_KINDS) {
      const req = catalogRequest(kind, 'idem-1');
      expect(req.url).toBe('/api/gift');
      expect(req.url).toBe(CATALOG_URL);
      expect(req.method).toBe('POST');
      expect(req.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(req.body)).toEqual({ catalog_key: kind, idem: 'idem-1' });
    }
  });

  it('postCatalogGift posts JSON and maps success to a sent message', async () => {
    const { fn, calls } = fakeFetch(() => jsonRes({ gift_id: 'g1', status: 'placed' }));
    const result = await postCatalogGift('toy', 'idem-9', fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/gift');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ catalog_key: 'toy', idem: 'idem-9' });
    expect(result.ok).toBe(true);
    expect(result.giftId).toBe('g1');
    expect(result.giftStatus).toBe('placed');
    expect(result.message).toBe(sentText(false));
  });

  it('postCatalogGift maps the 429 day-limit message', async () => {
    const { fn } = fakeFetch(() => jsonRes({ error: 'one gift per visitor per London day' }, 429));
    const result = await postCatalogGift('toy', 'idem-9', fn);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.message).toMatch(/one gift per day/i);
  });

  it('postCatalogGift reports a network failure without throwing', async () => {
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const result = await postCatalogGift('toy', 'idem-9', failing);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});

describe('photo request building', () => {
  it('uses multipart fields and keeps the code out of the URL', async () => {
    const code = 'judge-code-zzz-9f8e7d';
    const { fn, calls } = fakeFetch(() => jsonRes({ gift_id: 'g2', status: 'processing' }));
    const file = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
    const result = await postPhotoGift(file, 'photo-idem-1', code, fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/gift/photo');
    expect(calls[0].url).toBe(PHOTO_URL);
    expect(calls[0].url).not.toContain(code);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Nori-Code']).toBe(code);
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('idem')).toBe('photo-idem-1');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(String(calls[0].url)).not.toContain('idem');
    expect(result.ok).toBe(true);
    expect(result.message).toBe(sentText(true));
  });

  it('buildPhotoForm carries exactly file and idem', () => {
    const file = new Blob(['x'], { type: 'image/jpeg' });
    const form = buildPhotoForm(file, 'abc');
    const stored = form.get('file') as Blob;
    expect(stored).toBeInstanceOf(Blob);
    expect(stored.type).toBe('image/jpeg');
    expect(stored.size).toBe(1);
    expect(form.get('idem')).toBe('abc');
    expect(photoRequestParts()).toEqual({ url: '/api/gift/photo', method: 'POST' });
  });
});

describe('status and error-message mapping', () => {
  it('maps Worker statuses to short friendly text', () => {
    expect(friendlyError(401, 'invalid code')).toMatch(/code/i);
    expect(friendlyError(413, 'payload too large')).toMatch(/5 MB/);
    expect(friendlyError(415, 'jpeg or png required')).toMatch(/JPEG or PNG/);
    expect(friendlyError(415, 'image signature does not match')).toMatch(/JPEG or PNG/);
    expect(friendlyError(429, 'one gift per visitor per London day')).toMatch(/one gift per day/i);
    expect(friendlyError(429, 'daily visitor gift cap reached')).not.toMatch(/one gift per day/i);
    expect(friendlyError(429, 'photo budget exhausted')).not.toMatch(/one gift per day/i);
    expect(friendlyError(503, 'photo gifts not enabled')).toMatch(/off right now/i);
    expect(friendlyError(409, 'gift already exists; retry')).toMatch(/already sent/i);
    expect(friendlyError(409, 'idempotency target differs')).toMatch(/already sent/i);
    expect(friendlyError(409, 'no legal gift cell')).toMatch(/room is full.*try again later/i);
    expect(friendlyError(409, 'world busy')).not.toMatch(/already sent/i);
    expect(friendlyError(400, 'unknown catalog key')).toMatch(/shelf/i);
    expect(friendlyError(500, 'gift operation unavailable')).toMatch(/napping|try again/i);
    expect(friendlyError(502, 'photo dispatch failed')).toMatch(/try again/i);
  });

  it('interpretGiftResponse keeps the friendly text for error statuses', async () => {
    const cases: Array<[number, unknown, RegExp]> = [
      [401, { error: 'invalid code' }, /code/i],
      [409, { error: 'no legal gift cell' }, /room is full/i],
      [429, { error: 'one gift per visitor per London day' }, /one gift per day/i],
      [503, { error: 'photo gifts not enabled' }, /off right now/i],
      [500, { error: 'gift operation unavailable' }, /try again/i],
    ];
    for (const [status, body, pattern] of cases) {
      const result = await interpretGiftResponse(jsonRes(body, status), true);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
      expect(result.message).toMatch(pattern);
    }
  });

  it('interpretGiftResponse survives a non-JSON error body', async () => {
    const res = new Response('bad gateway', { status: 502 });
    const result = await interpretGiftResponse(res, false);
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('sent text tells the visitor to watch the room', () => {
    expect(sentText(false)).toMatch(/watch the room/i);
    expect(sentText(true)).toMatch(/watch the room/i);
  });
});

describe('photo constants', () => {
  it('match the Worker photo rules', () => {
    expect(PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(PHOTO_TYPES).toEqual(['image/jpeg', 'image/png']);
  });
});

describe('photo progress constants', () => {
  it('polls every 3 s for at most 4 minutes', () => {
    expect(STATUS_POLL_MS).toBe(3000);
    expect(STATUS_POLL_MAX_MS).toBe(4 * 60 * 1000);
  });

  it('builds the status URL for a gift id', () => {
    const id = '0'.repeat(32);
    expect(giftStatusUrl(id)).toBe(`/api/gift/status/${id}`);
  });

  it('working and timeout lines match the panel copy', () => {
    expect(STATUS_WORKING_TEXT).toBe('Nori is looking at your photo...');
    expect(STATUS_TIMEOUT_TEXT).toBe('Still working - keep watching the room.');
  });
});

describe('gift sprite URL acceptance', () => {
  it('accepts only same-origin /media/ PNG files', () => {
    expect(isGiftSpriteUrl('/media/gift-0123456789abcdef0123456789abcdef.png')).toBe(true);
    expect(isGiftSpriteUrl('/media/a.png')).toBe(true);
  });

  it('rejects remote URLs, other paths and other file types', () => {
    for (const bad of [
      'https://example.com/media/gift-1.png',
      'http://localhost/media/gift-1.png',
      '//media/gift-1.png',
      '/media/gift-1.png?x=1',
      '/media/gift-1.png#frag',
      '/media/sub/gift-1.png',
      '/media/../gift-1.png',
      '/media/gift-1.jpg',
      '/media/gift-1.PNG',
      '/media/gift-1',
      '/media/',
      '/cam/obj/toy.png',
      'data:image/png;base64,aaaa',
      '/media/gift-1.png ',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(isGiftSpriteUrl(bad)).toBe(false);
    }
  });
});

describe('gift progress text', () => {
  it('maps processing and unknown statuses to the working line', () => {
    expect(giftProgressText('processing', null, null)).toBe(STATUS_WORKING_TEXT);
    expect(giftProgressText('mystery', null, null)).toBe(STATUS_WORKING_TEXT);
  });

  it('announces ready and placed gifts by name', () => {
    expect(giftProgressText('ready', 'toy box', null)).toBe('toy box is in the room!');
    expect(giftProgressText('placed', 'slipper', null)).toBe('slipper is in the room!');
    expect(giftProgressText('ready', null, null)).toBe('Your gift is in the room!');
    expect(giftProgressText('placed', '', null)).toBe('Your gift is in the room!');
  });

  it('maps every failure reason to a friendly sentence', () => {
    expect(failedGiftText('content_refused')).toMatch(/pass on that photo/i);
    expect(failedGiftText('draw_failed')).toMatch(/couldn't draw/i);
    expect(failedGiftText('timeout')).toMatch(/ran out of time/i);
    expect(failedGiftText('unavailable')).toMatch(/didn't work out/i);
    for (const unknown of [undefined, null, 'bogus', 42]) {
      expect(failedGiftText(unknown)).toBe(failedGiftText('unavailable'));
    }
    expect(giftProgressText('failed', null, 'content_refused')).toBe(failedGiftText('content_refused'));
    expect(giftProgressText('failed', null, 'draw_failed')).toBe(failedGiftText('draw_failed'));
    expect(giftProgressText('failed', null, 'timeout')).toBe(failedGiftText('timeout'));
    expect(giftProgressText('failed', null, 'unavailable')).toBe(failedGiftText('unavailable'));
  });
});

describe('gift status polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function statusRes(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }
  function processingBody() {
    return { gift_id: 'g1', status: 'processing', name: null, sprite: null, reason: null, updated_at: 1 };
  }

  it('fetches the status URL immediately and every 3 s while processing', async () => {
    const seen: string[] = [];
    const updates: Array<[unknown, boolean]> = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      return statusRes(processingBody());
    }) as unknown as typeof fetch;
    const poll = createGiftStatusPoll({ giftId: 'g1', fetchFn, onUpdate: (body, done) => { updates.push([body, done]); } });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['/api/gift/status/g1']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toEqual(['/api/gift/status/g1', '/api/gift/status/g1']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toHaveLength(3);
    expect(updates).toHaveLength(3);
    expect(updates.every(([body, done]) => (body as { status: string }).status === 'processing' && done === false)).toBe(true);
    poll.stop();
  });

  it('stops on a ready status and reports the sprite body once', async () => {
    const ready = { gift_id: 'g1', status: 'ready', name: 'toy box', sprite: '/media/gift-g1.png', reason: null, updated_at: 2 };
    const seen: string[] = [];
    const updates: Array<[unknown, boolean]> = [];
    const bodies = [processingBody(), processingBody(), ready];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      return statusRes(bodies[Math.min(seen.length - 1, bodies.length - 1)]);
    }) as unknown as typeof fetch;
    const poll = createGiftStatusPoll({ giftId: 'g1', fetchFn, onUpdate: (body, done) => { updates.push([body, done]); } });
    poll.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(seen).toHaveLength(3);
    expect(updates).toHaveLength(3);
    expect(updates[2]).toEqual([ready, true]);
    expect(poll.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(seen).toHaveLength(3);
  });

  it('stops on a failed status without another fetch', async () => {
    const failed = { gift_id: 'g1', status: 'failed', name: null, sprite: null, reason: 'draw_failed', updated_at: 2 };
    let calls = 0;
    const updates: Array<[unknown, boolean]> = [];
    const fetchFn = (async () => {
      calls += 1;
      return statusRes(failed);
    }) as unknown as typeof fetch;
    const poll = createGiftStatusPoll({ giftId: 'g1', fetchFn, onUpdate: (body, done) => { updates.push([body, done]); } });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(updates).toEqual([[failed, true]]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(1);
  });

  it('reports a timeout after 4 minutes of processing and stops', async () => {
    let calls = 0;
    const updates: Array<[unknown, boolean]> = [];
    const fetchFn = (async () => {
      calls += 1;
      return statusRes(processingBody());
    }) as unknown as typeof fetch;
    const poll = createGiftStatusPoll({ giftId: 'g1', fetchFn, onUpdate: (body, done) => { updates.push([body, done]); } });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(poll.stopped).toBe(false);
    const mid = calls;
    expect(mid).toBeGreaterThan(10);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(poll.stopped).toBe(true);
    expect(updates[updates.length - 1]).toEqual([null, true]);
    const final = calls;
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls).toBe(final);
  });

  it('stop() halts polling and network errors keep it going', async () => {
    let calls = 0;
    const updates: Array<[unknown, boolean]> = [];
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return statusRes(processingBody());
    }) as unknown as typeof fetch;
    const poll = createGiftStatusPoll({ giftId: 'g1', fetchFn, onUpdate: (body, done) => { updates.push([body, done]); } });
    poll.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toBe(3);
    expect(updates).toHaveLength(2);
    poll.stop();
    expect(poll.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(3);
  });
});

describe('clean mode', () => {
  it('hides the gift UI only for clean=1', () => {
    expect(isCleanMode('?clean=1')).toBe(true);
    expect(isCleanMode('clean=1')).toBe(true);
    expect(isCleanMode(new URLSearchParams('clean=1'))).toBe(true);
    expect(isCleanMode('?clean=0')).toBe(false);
    expect(isCleanMode('?a=1')).toBe(false);
    expect(isCleanMode('')).toBe(false);
    expect(isCleanMode(null)).toBe(false);
    expect(isCleanMode(undefined)).toBe(false);
  });
});
