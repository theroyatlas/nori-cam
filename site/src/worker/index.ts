import { inspectRoute } from './cam/inspect.ts';
import { runCloudWork } from './cam/cloud.ts';
import { compare, decide, status, type Deps, type Env } from './api.ts';
import { json, withSecurity } from './headers.ts';
import { media, putMedia } from './media.ts';
import { getLive, putLive } from './live.ts';
import { wakeTick } from './wake.ts';
import { heightResponse } from './cam/heights.ts';
import { getCam } from './cam/api.ts';
import { clockRoute, workerNow } from './cam/clock.ts';
import { tick } from './cam/timeline.ts';
import { giftRoute, type GiftEnv } from './cam/gifts.ts';

const POST_ID = /^[A-Za-z0-9_-]{1,80}$/;

export async function handle(
  req: Request, env: GiftEnv, deps: Deps = {}, ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const response = await route(req, env, deps, ctx);
  const path = new URL(req.url).pathname;
  if (response.ok && ['/api/ingest', '/api/gift', '/api/gift/photo'].includes(path)) {
    const task = () => runCloudWork(env, workerNow(env, (deps.now || Date.now)()), deps)
      .catch(() => { console.error('cam_cloud_work_failed'); });
    if (ctx) ctx.waitUntil(task());
    else if (env.MODEL_API_KEY || env.GH_DISPATCH_TOKEN) await task();
  }
  return response;
}
async function route(
  req: Request, env: GiftEnv, deps: Deps, ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (['/api/replay', '/api/record', '/api/brain/context'].includes(path) || path.startsWith('/api/interaction/')) {
    return inspectRoute(req, env, workerNow(env, (deps.now || Date.now)()));
  }

  if (['/api/gift', '/api/gift/photo', '/api/ingest', '/api/owner/object'].includes(path)
    || path.startsWith('/api/gift/source/') || path.startsWith('/api/gift/status/')) return giftRoute(req, env, deps);

  if (path === '/api/cam') {
    if (method !== 'GET') return json({ error: 'method_not_allowed', message: 'Use GET.' }, 405, { Allow: 'GET' });
    return heightResponse(await getCam(req, env, deps.now?.(), deps, ctx));
  }

  if (path === '/api/decide' || path === '/api/compare') {
    if (method !== 'POST') return json({ error: 'method_not_allowed', message: 'Use POST.' }, 405, { Allow: 'POST' });
    return path === '/api/decide' ? decide(req, env, deps) : compare(req, env, deps);
  }
  if (path === '/api/status') {
    if (method !== 'GET') return json({ error: 'method_not_allowed', message: 'Use GET.' }, 405, { Allow: 'GET' });
    return status(env, deps);
  }
  if (path === '/api/cam/test/clock') return clockRoute(req, env);
  if (path.startsWith('/api/')) return json({ error: 'not_found', message: 'No such endpoint.' }, 404);

  if (path.startsWith('/media/')) {
    const name = path.slice('/media/'.length).replace(/\/$/, '');
    if (method === 'PUT') return putMedia(name, req, env.MEDIA, env.MEDIA_UPLOAD_TOKEN);
    if (method !== 'GET' && method !== 'HEAD') return json({ error: 'method_not_allowed', message: 'Use GET.' }, 405, { Allow: 'GET, HEAD, PUT' });
    return media(name, env.MEDIA);
  }

  if (path.startsWith('/data/live/')) {
    const name = path.slice('/data/live/'.length).replace(/\/$/, '');
    if (method === 'PUT') return putLive(name, req, env.MEDIA, env.MEDIA_UPLOAD_TOKEN);
    if (method === 'GET' || method === 'HEAD') return getLive(name, env.MEDIA, method);
    return json({ error: 'method_not_allowed', message: 'Use GET, HEAD, or PUT.' }, 405, { Allow: 'GET, HEAD, PUT' });
  }

  // /posts/<id> is one static page that reads its id from the address (see public/post.js)
  if (path.startsWith('/posts/')) {
    const id = path.slice('/posts/'.length).replace(/\/$/, '');
    if (!POST_ID.test(id)) return withSecurity(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    const page = await env.ASSETS.fetch(new Request(new URL('/post', url), { method: 'GET' }));
    return withSecurity(page, { 'Cache-Control': 'no-cache' });
  }

  return withSecurity(await env.ASSETS.fetch(req));
}

export default {
  fetch(req: Request, env: GiftEnv, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, {}, ctx);
  },
  // Cloudflare cron (wrangler.toml [triggers]): ask GitHub to run the Nori cloud wake once Nori's next_wake_at has passed
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env, workerNow(env)).catch((e) => console.log('cam_error', String(e).slice(0,120))));
    ctx.waitUntil(wakeTick(env)
      .then((r) => console.log('wake', r))
      .catch((e) => console.log('wake_error', String(e).slice(0, 120))));
  },
};
