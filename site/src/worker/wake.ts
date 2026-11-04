/**
 * Cloudflare cron -> GitHub workflow_dispatch for the Nori cloud wake.
 *
 * GitHub's own schedule drops most runs (only 2 scheduled runs fired between 2026-10-31T21:00Z and 2026-11-01T05:00Z
 * for a 15-minute cron), so the Worker's cron asks GitHub to run nori-wake.yml once Nori's own next_wake_at has passed.
 * The workflow's wake gate still decides; this only knocks.
 * The token is a fine-grained PAT for this one repo (Actions: read and write, Contents: read), set with
 * `wrangler secret put GH_DISPATCH_TOKEN`. Without it the cron does nothing.
 */
export interface WakeEnv {
  MEDIA: KVNamespace;
  GH_DISPATCH_TOKEN?: string;
}

export const REPO = 'theroyatlas/nori-aipet';
export const WORKFLOW = 'nori-wake.yml';
const GH = 'https://api.github.com';
// no dot: media.ts serves only names with an image extension, so this key can never be read through /media/
export const LAST_KEY = 'wake-last-dispatch';
export const MIN_GAP_MS = 10 * 60 * 1000;

function parseWake(text: string | undefined): number {
  if (!text) return NaN;
  const t = text.trim();
  return Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(t) ? t : t + 'Z');
}

export async function wakeTick(env: WakeEnv, now: number = Date.now(), fetchFn: typeof fetch = fetch): Promise<string> {
  const token = env.GH_DISPATCH_TOKEN;
  if (!token) return 'no_token';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nori-aipet-wake',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const st = await fetchFn(`${GH}/repos/${REPO}/contents/longrun/state.json?ref=data`,
    { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } });
  if (st.status === 401 || st.status === 403) return `state_http_${st.status}`;
  if (st.status === 200) {
    try {
      const state = (await st.json()) as { next_wake_at?: string };
      const at = parseWake(state.next_wake_at);
      if (!Number.isNaN(at) && at > now) return 'not_due';
    } catch {
      // unreadable state: let the workflow's own gate decide
    }
  }

  const last = Number((await env.MEDIA.get(LAST_KEY)) || 0);
  if (last && now - last < MIN_GAP_MS) return 'recent_dispatch';

  for (const status of ['queued', 'in_progress']) {
    const r = await fetchFn(`${GH}/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=1`, { headers });
    if (r.status !== 200) return `runs_http_${r.status}`;
    const body = (await r.json()) as { total_count?: number };
    if ((body.total_count || 0) > 0) return 'busy';
  }

  const d = await fetchFn(`${GH}/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'master' }),
  });
  if (d.status !== 204) return `dispatch_http_${d.status}`;
  await env.MEDIA.put(LAST_KEY, String(now));
  return 'dispatched';
}
