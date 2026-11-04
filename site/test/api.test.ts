import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP } from '../src/worker/headers.ts';
import { mediaType } from '../src/worker/media.ts';
import { costFromUsage, WINDOW_MS } from '../src/worker/limits.ts';
import { DEFAULTS, KEY, kvStub, reply, setup, upstream } from './helpers.ts';

const body = (over: object = {}) => ({ options: DEFAULTS, edits: {}, ...over });
const ip = (n: number) => ({ 'CF-Connecting-IP': `203.0.113.${n}` });
const day = 24 * 3600 * 1000;
const opts = (label: string) => [...DEFAULTS.slice(0, 5), label];

describe('input validation', () => {
  it('rejects a wrong number of options', async () => {
    const { post, up } = setup();
    for (const options of [DEFAULTS.slice(0, 5), [...DEFAULTS, 'seventh'], 'nope', null]) {
      expect((await post('/api/decide', body({ options }))).status).toBe(400);
    }
    expect(up.calls).toHaveLength(0);
  });
  it('rejects empty, blank, too long (81) and non-text options; accepts exactly 80 characters', async () => {
    const { post } = setup();
    for (const bad of ['', '   ', 'x'.repeat(81), 5, null]) expect((await post('/api/decide', body({ options: [...DEFAULTS.slice(0, 5), bad] }))).status).toBe(400);
    expect((await post('/api/decide', body({ options: opts('x'.repeat(80)) }))).status).toBe(200);
  });
  it('counts characters, not UTF-16 units (80 emoji pass, 81 fail)', async () => {
    const { post } = setup();
    expect((await post('/api/decide', body({ options: opts('\u{1F41A}'.repeat(80)) }))).status).toBe(200);
    expect((await post('/api/decide', body({ options: opts('\u{1F41A}'.repeat(81)) }))).status).toBe(400);
  });
  it('rejects duplicate options', async () => {
    const { post } = setup();
    expect((await post('/api/decide', body({ options: opts(' explore FUNGI ') }))).status).toBe(400);
  });
  it('edits keys must be existing event ids and ops must be delete or neutralize', async () => {
    const { post } = setup();
    expect((await post('/api/decide', body({ edits: { E99: 'delete' } }))).status).toBe(400);
    expect((await post('/api/decide', body({ edits: { E01: 'restore' } }))).status).toBe(400);
    expect((await post('/api/decide', body({ edits: ['E01'] }))).status).toBe(400);
    expect((await post('/api/decide', body({ edits: { E01: 'delete', E02: 'neutralize' } }))).status).toBe(200);
  });
  it('limits the body to 4 KB (413) and answers 400 to non-JSON', async () => {
    const { post, up } = setup();
    expect((await post('/api/decide', body({ pad: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await post('/api/decide', '{not json')).status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });
  it('only POST on the model endpoints', async () => {
    const { call } = setup();
    const r = await call('/api/decide');
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('POST');
  });
});

describe('decide / compare', () => {
  it('sends the request to the Meta endpoint with the key only in the Authorization header', async () => {
    const { post, up } = setup();
    await post('/api/decide', body({ edits: { E01: 'delete' } }));
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0].url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(up.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(up.calls[0].payload.model).toBe('muse-spark-1.3');
    expect(JSON.stringify(up.calls[0].payload)).not.toContain(KEY);
  });
  it('returns choice, reason, event ids and citations with title, excerpt, url, licence and visibility', async () => {
    const { post } = setup({}, upstream(() => reply('A2', ['E01', 'E03'], 'I liked it')));
    const j: any = await (await post('/api/decide', body({ edits: { E01: 'delete' } }))).json();
    expect(j.choice_id).toBe('A2');
    expect(j.choice_text).toBe(DEFAULTS[2]);
    expect(j.reason).toBe('I liked it');
    expect(j.event_ids).toEqual(['E01', 'E03']);
    expect(j.citations[0]).toMatchObject({ event_id: 'E01', title: 'Kaleidoscope', visible_in_context: false });
    expect(j.citations[1]).toMatchObject({ event_id: 'E03', visible_in_context: true });
    expect(j.citations[1].source_url).toMatch(/^https:\/\/en\.wikipedia\.org\//);
    expect(j.citations[1].license).toContain('CC BY-SA');
    expect(j.citations[1].excerpt.length).toBeGreaterThan(50);
    expect(j.citations_visible).toBe(false);
  });
  it('compare asks the model twice (current and original view) and returns both', async () => {
    const { post, up } = setup();
    const j: any = await (await post('/api/compare', body({ edits: { E01: 'delete' } }))).json();
    expect(up.calls).toHaveLength(2);
    const sizes = up.calls.map((c) => JSON.parse(c.payload.messages[1].content).context.length).sort();
    expect(sizes).toEqual([19, 20]);
    expect(j.current.view).toBe('current');
    expect(j.original.view).toBe('original');
    expect(j.current.context_event_ids).toHaveLength(19);
    expect(j.original.context_event_ids).toHaveLength(20);
  });
  it('an unusable model answer is reported as valid=false and is not cached', async () => {
    const bad = upstream(() => ({ choices: [{ finish_reason: 'length', message: { content: '{"choice_id":"A0"' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    const { post } = setup({}, bad);
    const j1: any = await (await post('/api/decide', body())).json();
    expect(j1.valid).toBe(false);
    await post('/api/decide', body());
    expect(bad.calls).toHaveLength(2);
  });
  it('503 when the deployment has no model key', async () => {
    const { post } = setup({ MODEL_API_KEY: undefined });
    expect((await post('/api/decide', body())).status).toBe(503);
  });
});

describe('rate limit (20 model calls per hashed IP per 10 minutes)', () => {
  it('allows 20 and refuses the 21st with 429 + Retry-After', async () => {
    const { post, up } = setup();
    for (let i = 0; i < 20; i++) expect((await post('/api/decide', body({ options: opts(`Explore thing ${i}`) }), ip(1))).status).toBe(200);
    const r = await post('/api/decide', body({ options: opts('Explore thing 99') }), ip(1));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(((await r.json()) as any).examples_url).toBe('/data/demo-examples.json');
    expect(up.calls).toHaveLength(20);
  });
  it('another IP is not affected and the next 10-minute window starts fresh', async () => {
    const { post, state } = setup({ RATE_LIMIT_PER_10MIN: '2' });
    const o = (i: number) => body({ options: opts(`Explore thing ${i}`) });
    expect((await post('/api/decide', o(1), ip(1))).status).toBe(200);
    expect((await post('/api/decide', o(2), ip(1))).status).toBe(200);
    expect((await post('/api/decide', o(3), ip(1))).status).toBe(429);
    expect((await post('/api/decide', o(3), ip(2))).status).toBe(200);
    state.now += WINDOW_MS;
    expect((await post('/api/decide', o(4), ip(1))).status).toBe(200);
  });
  it('compare costs two calls', async () => {
    const { post } = setup({ RATE_LIMIT_PER_10MIN: '3' });
    expect((await post('/api/compare', body(), ip(1))).status).toBe(200);
    expect((await post('/api/compare', body({ options: opts('Explore other') }), ip(1))).status).toBe(429);
  });
  it('stores only salted hashes, never the IP', async () => {
    const { post, db } = setup();
    await post('/api/decide', body(), ip(7));
    const rows = db.prepare('SELECT ip_hash FROM rate_hits').all() as { ip_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(['rate_hits', 'daily_salt', 'usage_daily', 'decide_cache'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    expect(dump).not.toContain('203.0.113.7');
  });
  it('the salt rotates every UTC day (same IP, different hash)', async () => {
    const { post, db, state } = setup();
    await post('/api/decide', body(), ip(7));
    const first = (db.prepare('SELECT ip_hash FROM rate_hits').all() as { ip_hash: string }[]).map((r) => r.ip_hash);
    state.now += day;
    await post('/api/decide', body({ options: opts('Explore other') }), ip(7));
    const hashes = new Set((db.prepare('SELECT ip_hash FROM rate_hits').all() as { ip_hash: string }[]).map((r) => r.ip_hash));
    expect(hashes.size).toBe(first.length === 1 ? 1 : 2); // old bucket purged, only the new day's hash remains
    expect(hashes.has(first[0])).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM daily_salt').get() as any).n).toBe(2);
  });
});

describe('daily budget', () => {
  it('prices real usage at $1.25 in / $0.15 cached in / $4.25 out per 1M tokens', () => {
    expect(costFromUsage({ prompt_tokens: 1_000_000, completion_tokens: 0 })).toBeCloseTo(1.25, 9);
    expect(costFromUsage({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 400_000 } })).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.15 + 4.25, 9);
    expect(costFromUsage({ prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 99 } })).toBeCloseTo((10 * 0.15) / 1e6, 12);
    expect(costFromUsage(null)).toBeNull();
    expect(costFromUsage({})).toBeNull();
  });
  it('adds up the real usage and answers 429 once DEMO_DAILY_USD is reached, without calling the model', async () => {
    // each call: 100k in + 10k out = $0.125 + $0.0425 = $0.1675
    const up = upstream(() => reply('A0', [], 'x', { prompt_tokens: 100_000, completion_tokens: 10_000 }));
    const { post, db } = setup({ DEMO_DAILY_USD: '0.30' }, up);
    expect((await post('/api/decide', body({ options: opts('Explore thing 1') }))).status).toBe(200); // 0.1675
    expect((await post('/api/decide', body({ options: opts('Explore thing 2') }))).status).toBe(200); // 0.335 >= 0.30
    const r = await post('/api/decide', body({ options: opts('Explore thing 3') }));
    expect(r.status).toBe(429);
    const j: any = await r.json();
    expect(j.error).toBe('daily_budget');
    expect(j.message).toMatch(/pre-recorded examples/);
    expect(up.calls).toHaveLength(2);
    expect((db.prepare('SELECT micro_usd FROM usage_daily').get() as any).micro_usd).toBe(335000);
  });
  it('the budget starts over on the next UTC day', async () => {
    const up = upstream(() => reply('A0', [], 'x', { prompt_tokens: 1_000_000, completion_tokens: 0 }));
    const { post, state } = setup({ DEMO_DAILY_USD: '1.00' }, up);
    expect((await post('/api/decide', body())).status).toBe(200); // $1.25
    expect((await post('/api/decide', body({ options: opts('Explore other') }))).status).toBe(429);
    state.now += day;
    expect((await post('/api/decide', body({ options: opts('Explore other') }))).status).toBe(200);
  });
  it('a reply without usage is charged at the worst case so the cap still holds', async () => {
    const { post, db } = setup({}, upstream(() => reply('A0', [], 'x', null)));
    await post('/api/decide', body());
    expect((db.prepare('SELECT micro_usd FROM usage_daily').get() as any).micro_usd).toBeGreaterThan(8000);
  });
  it('/api/status shows the cap and the spend, never the key', async () => {
    const { call, post } = setup({ DEMO_DAILY_USD: '2.5' });
    await post('/api/decide', body());
    const t = await (await call('/api/status')).text();
    const j = JSON.parse(t);
    expect(j.daily_budget_usd).toBe(2.5);
    expect(j.spent_today_usd).toBeGreaterThan(0);
    expect(t).not.toContain(KEY);
  });
});

describe('24 h cache', () => {
  it('a repeat is served from D1: no model call, no cost, no rate count', async () => {
    const { post, up, db } = setup({ RATE_LIMIT_PER_10MIN: '1' });
    const a: any = await (await post('/api/decide', body(), ip(1))).json();
    const spent = (db.prepare('SELECT micro_usd FROM usage_daily').get() as any).micro_usd;
    const bRes = await post('/api/decide', body(), ip(1)); // would be 429 if it counted
    const b: any = await bRes.json();
    expect(bRes.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.reason).toBe(a.reason);
    expect((db.prepare('SELECT micro_usd FROM usage_daily').get() as any).micro_usd).toBe(spent);
  });
  it('still serves cached answers after the daily budget is spent', async () => {
    const up = upstream(() => reply('A0', [], 'x', { prompt_tokens: 2_000_000, completion_tokens: 0 }));
    const { post } = setup({ DEMO_DAILY_USD: '1' }, up);
    expect((await post('/api/decide', body())).status).toBe(200);
    expect((await post('/api/decide', body())).status).toBe(200);
    expect(up.calls).toHaveLength(1);
  });
  it('the key is the sorted options: a shuffled repeat hits and the choice is mapped back to the shown order', async () => {
    const { post, up } = setup({}, upstream(() => reply('A1', [], 'x')));
    const a: any = await (await post('/api/decide', body())).json();
    const shuffled = [...DEFAULTS].reverse();
    const b: any = await (await post('/api/decide', body({ options: shuffled }))).json();
    expect(up.calls).toHaveLength(1);
    expect(b.cached).toBe(true);
    expect(b.choice_text).toBe(a.choice_text);
    expect(b.choice_id).toBe(`A${shuffled.indexOf(a.choice_text)}`);
  });
  it('different edits are different entries; the original view ignores edits and is shared', async () => {
    const { post, up } = setup();
    await post('/api/decide', body());
    await post('/api/decide', body({ edits: { E01: 'delete' } }));
    expect(up.calls).toHaveLength(2);
    await post('/api/compare', body({ edits: { E01: 'delete' } })); // current: hit, original: miss
    expect(up.calls).toHaveLength(3);
    await post('/api/compare', body({ edits: { E02: 'neutralize' } })); // current: miss, original: hit
    expect(up.calls).toHaveLength(4);
  });
  it('entries expire after 24 hours', async () => {
    const { post, up, state } = setup();
    await post('/api/decide', body());
    state.now += day - 1000;
    await post('/api/decide', body());
    expect(up.calls).toHaveLength(1);
    state.now += 2000;
    await post('/api/decide', body());
    expect(up.calls).toHaveLength(2);
  });
});

describe('secrets and errors', () => {
  it('the key never appears in any response, including upstream failures that echo it', async () => {
    const { post, call } = setup({}, upstream(() => ({ error: { message: `bad key ${KEY}` } }), 401));
    const texts: string[] = [];
    for (const r of [await post('/api/decide', body()), await post('/api/compare', body()), await post('/api/decide', '{'), await call('/api/status'), await call('/api/nothing')]) {
      texts.push(await r.text(), JSON.stringify([...r.headers.entries()]));
    }
    for (const t of texts) expect(t).not.toContain(KEY);
  });
  it('an upstream error becomes a generic 502 without the upstream text', async () => {
    const { post } = setup({}, upstream(() => ({ error: { message: 'internal upstream detail 12345' } }), 500));
    const r = await post('/api/decide', body());
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain('12345');
  });
  it('a network failure that mentions the key becomes a generic 502', async () => {
    const boom = { calls: [], fetch: (async () => { throw new Error(`socket reset for ${KEY}`); }) as unknown as typeof fetch };
    const { post } = setup({}, boom);
    const r = await post('/api/decide', body());
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(KEY);
  });
});

describe('media', () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const withMedia = () => setup({ MEDIA: kvStub({ 'avatar.png': png, 'a.webp': png, 'b.jpg': png, 'x.txt': png }) });
  it('serves png/webp/jpg from KV with the right type and cache headers', async () => {
    const { call } = withMedia();
    for (const [n, t] of [['avatar.png', 'image/png'], ['a.webp', 'image/webp'], ['b.jpg', 'image/jpeg']]) {
      const r = await call(`/media/${n}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe(t);
      expect(r.headers.get('Cache-Control')).toContain('max-age');
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });
  it('refuses path traversal and odd names (names that survive URL normalisation reach the Worker)', async () => {
    const { call } = withMedia();
    for (const n of ['..%2favatar.png', '..%5cavatar.png', 'a/b.png', '.hidden.png', 'a..b.png', 'avatar.png%00.txt', 'x.txt', 'noext', '', 'a b.png', '%61vatar.png', '%2e%2e%2favatar.png']) {
      expect((await call(`/media/${n}`)).status, n).toBe(404);
    }
  });
  it('mediaType() itself rejects every traversal form, even ones a URL parser would have normalised away', () => {
    for (const n of ['../avatar.png', '..\avatar.png', '%2e%2e/avatar.png', '/etc/passwd.png', 'a/../b.png', '....png', '.png', 'a.png/', 'a.png ', 'a.PNG.exe']) expect(mediaType(n), n).toBeNull();
    expect(mediaType('Avatar_1-2.PNG')).toBe('image/png');
    expect(mediaType('p.jpeg')).toBe('image/jpeg');
  });
  it('404 for a missing file and no POST', async () => {
    const { call } = withMedia();
    expect((await call('/media/missing.png')).status).toBe(404);
    expect((await call('/media/avatar.png', { method: 'POST' })).status).toBe(405);
  });
});

describe('headers and static pages', () => {
  it('every Worker response carries the CSP, nosniff and Referrer-Policy, and never CORS', async () => {
    const { call, post } = setup();
    const rs = [await post('/api/decide', body()), await call('/api/status'), await call('/api/zzz'), await call('/media/avatar.png'), await call('/posts/P-1'), await call('/api/decide'), await call('/demo')];
    for (const r of rs) {
      expect(r.headers.get('Content-Security-Policy')).toBe(CSP);
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect([...r.headers.keys()].filter((k) => k.startsWith('access-control'))).toEqual([]);
    }
    const pre = await call('/api/decide', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('the CSP only names this site plus NASA and Wikimedia image hosts', () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain('https://upload.wikimedia.org');
    expect(CSP).toContain('https://images-assets.nasa.gov');
    expect(CSP).not.toContain("'unsafe-inline'");
    expect(CSP).not.toContain('*');
  });
  it('public/_headers repeats the same CSP for static assets', () => {
    const h = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
    expect(h).toContain(`Content-Security-Policy: ${CSP}`);
    expect(h).toContain('X-Content-Type-Options: nosniff');
    expect(h).toContain('Referrer-Policy: no-referrer');
  });
  it('/posts/<id> is served by the one post page; bad ids are 404', async () => {
    const { call } = setup();
    expect(await (await call('/posts/P-real-run-1')).text()).toBe('asset:/post');
    expect((await call('/posts/a%20b')).status).toBe(404);
    expect((await call('/posts/..%2f..')).status).toBe(404);
  });
  it('public pages disclose their AI identity, including the Cam entry', () => {
    const entry = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(entry).toContain('<p class="cam-identity">A shared world with a fictional AI cat.</p>');
    expect(entry).toContain('AI suggestions checked by');
    for (const p of ['demo', 'journal', 'posts', 'post', 'privacy', 'data-deletion']) {
      const html = readFileSync(new URL(`../public/${p}.html`, import.meta.url), 'utf8');
      expect(html, p).toContain('Nori is an AI pet. Its posts, feelings and choices are generated by AI models.');
    }
  });
});
