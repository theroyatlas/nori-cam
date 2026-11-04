import demo from '../../public/data/demo-events.json';
import { json } from './headers.ts';
import {
  addSpend, cacheGet, cachePut, costFromUsage, hashIp, parseUsd, sha256Hex, spentMicro, takeRate, toMicro, utcDay, worstCaseUsd,
} from './limits.ts';
import {
  buildPayload, optionsList, parseChoice, project, pyStrip, type DemoEvent, type Edits, type Option, type View,
} from './nori.ts';

export interface Env {
  DB: D1Database;
  MEDIA: KVNamespace;
  ASSETS: Fetcher;
  MODEL_API_KEY?: string;
  MODEL_API_BASE?: string;
  DEMO_DAILY_USD?: string;
  RATE_LIMIT_PER_10MIN?: string;
  MEDIA_UPLOAD_TOKEN?: string;
  GH_DISPATCH_TOKEN?: string;
}
export interface Deps { fetch?: typeof fetch; now?: () => number }

export const EVENTS = demo.events as DemoEvent[];
const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));
export const MAX_BODY = 4096;
export const DEFAULT_RATE = 20;
export const DEFAULT_BASE = 'https://api.meta.ai/v1';
const UPSTREAM_TIMEOUT_MS = 40_000;
const FRIENDLY_LIMIT = 'The live demo has reached its limit for now. Here are pre-recorded examples instead; the live demo resets automatically.';

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, string> = {},
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ---- input validation ------------------------------------------------------------------------------------------

export function validate(raw: unknown): { options: string[]; edits: Edits } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, 'bad_request', 'Body must be a JSON object.');
  const body = raw as Record<string, unknown>;
  const opts = body.options;
  if (!Array.isArray(opts) || opts.length !== 6) throw new HttpError(400, 'bad_options', 'Send exactly six options.');
  const texts: string[] = [];
  for (const o of opts) {
    if (typeof o !== 'string') throw new HttpError(400, 'bad_options', 'Each option must be text.');
    const t = pyStrip(o);
    const len = [...t].length;
    if (len < 1 || len > 80) throw new HttpError(400, 'bad_options', 'Each option must be 1 to 80 characters.');
    texts.push(t);
  }
  if (new Set(texts.map((t) => t.toLowerCase())).size !== 6) throw new HttpError(400, 'bad_options', 'The six options must be different from each other.');
  const edits: Edits = {};
  const e = body.edits ?? {};
  if (typeof e !== 'object' || e === null || Array.isArray(e)) throw new HttpError(400, 'bad_edits', 'edits must be an object.');
  for (const [id, op] of Object.entries(e)) {
    if (!BY_ID.has(id)) throw new HttpError(400, 'bad_edits', 'edits refers to an unknown event.');
    if (op !== 'delete' && op !== 'neutralize') throw new HttpError(400, 'bad_edits', 'An edit must be "delete" or "neutralize".');
    edits[id] = op;
  }
  return { options: texts, edits };
}

async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body is limited to 4 KB.');
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body is limited to 4 KB.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Body must be JSON.');
  }
}

// ---- result shape ----------------------------------------------------------------------------------------------

export interface Citation {
  event_id: string; visible_in_context: boolean; title: string | null; excerpt: string | null; source_url: string | null;
  attribution: string | null; license: string | null; license_url: string | null;
}
/** What is cached: independent of the order the options were shown in (the choice is stored as text). */
interface Stored { choice_text: string; reason: string; event_ids: string[] }
export interface ViewResult {
  view: View; valid: boolean; choice_id: string | null; choice_text: string | null; reason: string | null; event_ids: string[];
  citations: Citation[]; citations_visible: boolean; context_event_ids: string[]; finish_reason: string | null; cached: boolean;
}

function present(view: View, edits: Edits, options: Option[], s: Stored | null, finish: string | null, cached: boolean): ViewResult {
  const visible = new Set(project(EVENTS, edits, view).map((m) => m.event_ids[0]));
  const eventIds = s?.event_ids ?? [];
  const citations: Citation[] = eventIds.map((id) => {
    const ev = BY_ID.get(id);
    return {
      event_id: id, visible_in_context: visible.has(id), title: ev?.title ?? null, excerpt: ev?.excerpt ?? null, source_url: ev?.source_url ?? null,
      attribution: ev?.attribution ?? null, license: ev?.license ?? null, license_url: ev?.license_url ?? null,
    };
  });
  const opt = s ? options.find((o) => o.text === s.choice_text) : undefined;
  return {
    view, valid: !!s && !!opt, choice_id: opt?.id ?? null, choice_text: opt?.text ?? null, reason: s?.reason ?? null, event_ids: eventIds, citations,
    citations_visible: citations.every((c) => c.visible_in_context), context_event_ids: [...visible].sort(), finish_reason: finish, cached,
  };
}

// ---- upstream call ---------------------------------------------------------------------------------------------

const UPSTREAM_FAIL = 'The model service did not answer. Please try again in a moment.';

async function callModel(env: Env, deps: Deps, payload: object): Promise<unknown> {
  const f = deps.fetch ?? fetch;
  const base = (env.MODEL_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await f(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MODEL_API_KEY}` },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok) throw new HttpError(502, 'upstream_error', UPSTREAM_FAIL);
    return await res.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'upstream_error', UPSTREAM_FAIL); // the upstream's own words and the key never reach the visitor
  } finally {
    clearTimeout(timer);
  }
}

// ---- handlers --------------------------------------------------------------------------------------------------

async function cacheKey(view: View, options: string[], edits: Edits): Promise<string> {
  // the edits only matter for the 'current' view: the original view ignores them, so it shares one cache entry
  const e = view === 'current' ? Object.entries(edits).sort(([a], [b]) => (a < b ? -1 : 1)) : [];
  return sha256Hex(JSON.stringify({ v: 1, view, options: [...options].sort(), edits: e }));
}

async function run(req: Request, env: Env, deps: Deps, views: View[]): Promise<{ options: Option[]; results: Partial<Record<View, ViewResult>> }> {
  const now = (deps.now ?? Date.now)();
  const { options: texts, edits } = validate(await readBody(req));
  const options = optionsList(texts);
  const results: Partial<Record<View, ViewResult>> = {};
  const misses: View[] = [];
  const keys: Partial<Record<View, string>> = {};
  for (const v of views) {
    keys[v] = await cacheKey(v, texts, edits);
    const hit = await cacheGet(env.DB, keys[v]!, now);
    if (hit) {
      try {
        results[v] = present(v, edits, options, JSON.parse(hit) as Stored, 'stop', true);
        continue;
      } catch { /* unreadable cache row: treat as a miss */ }
    }
    misses.push(v);
  }
  if (misses.length) {
    if (!env.MODEL_API_KEY) throw new HttpError(503, 'not_configured', 'The live model is not connected on this deployment.', {}, { examples_url: '/data/demo-examples.json' });
    const day = utcDay(now);
    const limit = toMicro(parseUsd(env.DEMO_DAILY_USD, 1));
    if ((await spentMicro(env.DB, day)) >= limit) {
      throw new HttpError(429, 'daily_budget', FRIENDLY_LIMIT, {}, { examples_url: '/data/demo-examples.json' });
    }
    const max = Math.floor(parseUsd(env.RATE_LIMIT_PER_10MIN, DEFAULT_RATE));
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const rate = await takeRate(env.DB, await hashIp(env.DB, ip, now), misses.length, max, now);
    if (!rate.ok) {
      throw new HttpError(429, 'rate_limited', 'You are asking quickly. Please wait a few minutes, or look at the pre-recorded examples.',
        { 'Retry-After': String(rate.retryAfterSec) }, { examples_url: '/data/demo-examples.json', retry_after_seconds: rate.retryAfterSec });
    }
    await Promise.all(misses.map(async (v) => {
      const payload = buildPayload(project(EVENTS, edits, v), texts);
      const raw = await callModel(env, deps, payload);
      const usage = (raw as { usage?: unknown } | null)?.usage;
      const cost = costFromUsage(usage) ?? worstCaseUsd(JSON.stringify(payload).length, payload.max_completion_tokens);
      await addSpend(env.DB, day, toMicro(cost));
      const p = parseChoice(raw, options);
      if (!p.valid) {
        results[v] = present(v, edits, options, null, p.finish_reason, false);
        return;
      }
      const choiceText = options.find((o) => o.id === p.choice_id)!.text;
      const stored: Stored = { choice_text: choiceText, reason: p.reason!, event_ids: p.event_ids };
      await cachePut(env.DB, keys[v]!, JSON.stringify(stored), now);
      results[v] = present(v, edits, options, stored, p.finish_reason, false);
    }));
  }
  return { options, results };
}

function failure(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message, ...e.body }, e.status, e.extra);
  return json({ error: 'internal', message: 'Something went wrong. Please try again.' }, 500); // never echo the exception
}

export async function decide(req: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    const { options, results } = await run(req, env, deps, ['current']);
    return json({ options, ...(results.current as ViewResult) });
  } catch (e) {
    return failure(e);
  }
}

export async function compare(req: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    const { options, results } = await run(req, env, deps, ['current', 'original']);
    return json({ options, current: results.current, original: results.original });
  } catch (e) {
    return failure(e);
  }
}

export async function status(env: Env, deps: Deps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const spent = (await spentMicro(env.DB, utcDay(now))) / 1e6;
  return json({
    ok: true,
    model_configured: !!env.MODEL_API_KEY,
    daily_budget_usd: parseUsd(env.DEMO_DAILY_USD, 1),
    spent_today_usd: Math.round(spent * 1e6) / 1e6,
    rate_limit_per_10_min: Math.floor(parseUsd(env.RATE_LIMIT_PER_10MIN, DEFAULT_RATE)),
  });
}
