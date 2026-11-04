import { json } from '../headers.ts';

// LOCAL-ONLY virtual clock for the P1g fake-model chain.
//
// The runner advances Worker time in steps (skipping only waiting, never a
// stage) so plan -> act -> settle -> reflect -> after can be observed in
// minutes of wall time instead of hours. The clock is active ONLY when
// env.CAM_LOCAL_PIPELINE === '1'. With any other value every helper below
// behaves exactly as today (real Date.now()), and the HTTP control endpoint
// answers 404.
//
// Wiring: cron ticks (src/worker/index.ts scheduled), /api/cam reads
// (cam/api.ts getCam default), gift/ingest timestamps (cam/gifts.ts
// giftRoute) and post-ingest cloud work (handle waitUntil) all resolve `now`
// through workerNow(). tick()/advance()/getCam() already take `now` as a
// parameter, so plan.ts, engine.ts and settle.ts are untouched.
let virtualNow: number | null = null;

function localPipeline(env: object): boolean {
  const flags = env as { CAM_LOCAL_PIPELINE?: unknown; CAM_LOCAL_WALL_CLOCK?: unknown };
  return flags.CAM_LOCAL_PIPELINE === '1' && flags.CAM_LOCAL_WALL_CLOCK !== '1';
}

export function workerNow(env: object, realNow: number = Date.now()): number {
  if (!localPipeline(env)) return realNow;
  if (virtualNow === null) virtualNow = realNow;
  return virtualNow;
}

export function setVirtualNow(env: object, to: number): boolean {
  if (!localPipeline(env)) return false;
  if (!Number.isSafeInteger(to) || to < 0) return false;
  virtualNow = to;
  return true;
}

export function resetVirtualClock(): void {
  virtualNow = null;
}

export async function clockRoute(req: Request, env: object): Promise<Response> {
  if (!localPipeline(env)) return json({ error: 'not_found' }, 404);
  if (req.method === 'GET') return json({ now: workerNow(env) });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const to = (body as { now?: unknown } | null)?.now;
  if (typeof to !== 'number' || !setVirtualNow(env, to)) return json({ error: 'invalid_now' }, 400);
  return json({ now: workerNow(env) });
}
