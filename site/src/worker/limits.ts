// D1-backed rate limit, daily budget and result cache. Nothing here stores a visitor's content or a plain IP.

export const WINDOW_MS = 10 * 60 * 1000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PRICE = { input: 1.25, cachedInput: 0.15, output: 4.25 } as const; // USD per 1M tokens (official price)

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (s: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Salt that rotates every UTC day. Created once per day, random, kept only in D1. */
export async function dailySalt(db: D1Database, day: string): Promise<string> {
  const rnd = hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  await db.prepare('INSERT OR IGNORE INTO daily_salt (day, salt) VALUES (?, ?)').bind(day, rnd).run();
  const row = await db.prepare('SELECT salt FROM daily_salt WHERE day = ?').bind(day).first<{ salt: string }>();
  return row!.salt;
}

export async function hashIp(db: D1Database, ip: string, now: number): Promise<string> {
  const day = utcDay(now);
  return sha256Hex(`${await dailySalt(db, day)}|${ip}`);
}

export interface RateResult { ok: boolean; count: number; retryAfterSec: number }

/** Count `calls` model calls for this hashed IP in the current 10-minute bucket; ok=false when the cap is exceeded. */
export async function takeRate(db: D1Database, ipHash: string, calls: number, max: number, now: number): Promise<RateResult> {
  const bucket = Math.floor(now / WINDOW_MS);
  const row = await db
    .prepare('INSERT INTO rate_hits (ip_hash, bucket, n) VALUES (?, ?, ?) ON CONFLICT (ip_hash, bucket) DO UPDATE SET n = n + excluded.n RETURNING n')
    .bind(ipHash, bucket, calls)
    .first<{ n: number }>();
  const count = row?.n ?? calls;
  // old buckets are of no use; keep the table small
  await db.prepare('DELETE FROM rate_hits WHERE bucket < ?').bind(bucket - 1).run();
  return { ok: count <= max, count, retryAfterSec: Math.max(1, Math.ceil(((bucket + 1) * WINDOW_MS - now) / 1000)) };
}

export const toMicro = (usd: number): number => Math.round(usd * 1e6);
export function parseUsd(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function spentMicro(db: D1Database, day: string): Promise<number> {
  const row = await db.prepare('SELECT micro_usd FROM usage_daily WHERE day = ?').bind(day).first<{ micro_usd: number }>();
  return row?.micro_usd ?? 0;
}
export async function addSpend(db: D1Database, day: string, micro: number): Promise<void> {
  await db
    .prepare('INSERT INTO usage_daily (day, micro_usd, calls) VALUES (?, ?, 1) ON CONFLICT (day) DO UPDATE SET micro_usd = micro_usd + excluded.micro_usd, calls = calls + 1')
    .bind(day, micro)
    .run();
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Cost in USD from a chat-completions `usage` object at the official prices; null when the reply carried no usable usage. */
export function costFromUsage(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, any>;
  const input = int(u.prompt_tokens ?? u.input_tokens);
  const output = int(u.completion_tokens ?? u.output_tokens);
  if (input === 0 && output === 0) return null;
  const cachedRaw = int(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
  const cached = Math.min(cachedRaw, input);
  return ((input - cached) * PRICE.input + cached * PRICE.cachedInput + output * PRICE.output) / 1e6;
}

/** When the reply has no usage, charge the worst case for this request so the daily cap still holds. */
export const worstCaseUsd = (promptChars: number, maxOutput: number): number =>
  (Math.ceil(promptChars / 2) * PRICE.input + maxOutput * PRICE.output) / 1e6;

export async function cacheGet(db: D1Database, key: string, now: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT body FROM decide_cache WHERE key = ? AND created_at > ?')
    .bind(key, now - CACHE_TTL_MS)
    .first<{ body: string }>();
  return row?.body ?? null;
}
export async function cachePut(db: D1Database, key: string, body: string, now: number): Promise<void> {
  await db
    .prepare('INSERT INTO decide_cache (key, body, created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body, created_at = excluded.created_at')
    .bind(key, body, now)
    .run();
  await db.prepare('DELETE FROM decide_cache WHERE created_at < ?').bind(now - CACHE_TTL_MS).run();
}
