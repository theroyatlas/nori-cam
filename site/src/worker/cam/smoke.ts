// Offline local-smoke entry only; never deploy this file.
import { getCam } from './api.ts';
import { tick, type CamEnv } from './timeline.ts';
export default {
  fetch(req: Request, env: CamEnv) { return getCam(req,env); },
  scheduled(_event: ScheduledController, env: CamEnv, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env,Date.now(),{fetch:async()=>new Response('{}',{status:503})}));
  },
};
