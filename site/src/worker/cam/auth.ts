import { dailySalt, sha256Hex, takeRate, WINDOW_MS } from '../limits.ts';
import { londonDay } from './budget.ts';

export interface CodeEnv {
  DB: D1Database;
  OWNER_CODE_SHA256?: string;
  JUDGE_CODE_SHA256?: string;
  JUDGE_CODE_EXPIRES?: string;
  MEDIA_UPLOAD_TOKEN?: string;
}
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
// Canonicalize IPv6 before discarding the interface identifier, including compressed forms.
function visitorAddress(ip: string): string {
  if (!ip.includes(':')) return ip;
  try {
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split('::');
    const head = left ? left.split(':') : [];
    const tail = right ? right.split(':') : [];
    const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    return groups.slice(0, 4).map(g => g.padStart(4, '0')).join(':') + '::/64';
  } catch {
    return 'unknown';
  }
}
export async function visitorHash(req: Request, env: CodeEnv, now: number) {
  const salt = await dailySalt(env.DB, londonDay(now));
  return sha256Hex(`${salt}|${visitorAddress(req.headers.get('CF-Connecting-IP') || 'unknown')}`);
}
export async function codeRole(req: Request, env: CodeEnv, now: number): Promise<'owner' | 'judge' | null> {
  const hash = await visitorHash(req, env, now);
  const bucketKey = `code:${hash}`;
  const bucket = Math.floor(now / WINDOW_MS);
  const rate = await takeRate(env.DB, bucketKey, 1, 10, now);
  if (!rate.ok) return null;
  const candidate = await sha256Hex(req.headers.get('X-Nori-Code') || '');
  const owner = constantTimeEqual(candidate, env.OWNER_CODE_SHA256?.toLowerCase() || '0'.repeat(64));
  const judge = constantTimeEqual(candidate, env.JUDGE_CODE_SHA256?.toLowerCase() || '0'.repeat(64));
  const refund = () => env.DB.prepare(
    'UPDATE rate_hits SET n = CASE WHEN n > 0 THEN n - 1 ELSE 0 END WHERE ip_hash = ? AND bucket = ?',
  ).bind(bucketKey, bucket).run();
  if (owner && env.OWNER_CODE_SHA256) {
    await refund();
    return 'owner';
  }
  const expiry = Date.parse(env.JUDGE_CODE_EXPIRES || '2026-11-20T00:00:00Z');
  if (judge && env.JUDGE_CODE_SHA256 && now < expiry) {
    await refund();
    return 'judge';
  }
  return null;
}
export function bearer(req: Request, env: CodeEnv): boolean {
  return !!env.MEDIA_UPLOAD_TOKEN && constantTimeEqual(
    req.headers.get('Authorization') || '', `Bearer ${env.MEDIA_UPLOAD_TOKEN}`,
  );
}
