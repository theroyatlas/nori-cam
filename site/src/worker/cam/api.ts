import { json, withSecurity } from '../headers.ts';
import { advance, CamBusy, type CamEnv } from './timeline.ts';
import { readWorld, readPublic } from './store.ts';
import { weatherAt } from './weather.ts';
import { runCloudWork, type CloudEnv } from './cloud.ts';
import { workerNow } from './clock.ts';
import type { Deps } from '../api.ts';
export async function getCam(
  req: Request, env: CamEnv, now = workerNow(env), deps: Deps = {}, ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const raw = new URL(req.url).searchParams.get('from');
  const from = raw === null ? now - 60_000 : Number(raw);
  if (!Number.isSafeInteger(from) || raw?.trim() === '') return json({ error: 'invalid_from' }, 400);
  try {
    let world = await readWorld(env.DB, now);
    if (!world) return json({ error: 'cam_not_seeded' }, 503);
    let needsCloud = !!world.cloud_pending;
    if (world.pending_events || world.timeline_until < now + 120_000) {
      world = (await advance(env, now, 'read')).world;
      needsCloud = true;
    }
    const finish = async (response: Response) => {
      const cloudEnv = env as CloudEnv;
      if (needsCloud && (cloudEnv.MODEL_API_KEY || cloudEnv.GH_DISPATCH_TOKEN)) {
        const task = runCloudWork(cloudEnv, now, deps).catch(() => { console.error('cam_cloud_work_failed'); });
        if (ctx) ctx.waitUntil(task);
        else await task;
      }
      return response;
    };
    const etag = (v: number, t: number) => `W/"${v}-${t}"`;
    const matches = (value: string) => req.headers.get('If-None-Match')?.split(',')
      .some(s => s.trim() === value || s.trim() === '*');
    if (matches(etag(world.version, world.timeline_until))) return finish(withSecurity(new Response(null, {
      status: 304,
      headers: { 'Cache-Control': 'no-store', 'X-Server-Now': String(now), ETag: etag(world.version, world.timeline_until) },
    })));
    const data = await readPublic(env.DB, from, now);
    return finish(json({
      server_now: now, engine_version: data.world.engine_version, world_version: data.world.version,
      timeline_until: data.world.timeline_until, room: { grid: { w: 10, h: 8 }, window: 'london' },
      objects: data.objects.map(o => ({
        id: o.id, kind: o.kind, x: o.x, y: o.y, z: o.z, footprint: o.footprint, rotation: o.rotation,
        blocks: o.blocks, placement: o.placement, status: o.status, state: o.state, size: o.size,
        tags: o.tags, sprite: o.sprite, card: { name: o.card.name, summary: o.card.summary },
      })),
      segments: data.segments.map(s => ({
        id: s.id, start_at: s.start_at, end_at: s.end_at, action: s.action, primitive: s.primitive, pose: s.pose,
        facing: s.facing, path: s.path, z: s.z, target: s.target, part: s.part, carrying: s.carrying,
        interaction: s.interaction, effects: s.effects, cut_at: s.cut_at,
      })),
      weather: weatherAt(data.weather, now),
    }, 200, { ETag: etag(data.world.version, data.world.timeline_until) }));
  } catch (e) {
    if (e instanceof CamBusy) return json({ error: e.message }, 503);
    throw e;
  }
}
