import { reactWithSpark, expireIntents, type SparkEnv } from './spark.ts';
import { dispatchStartedSegments, type TriggerEnv, type TriggerDeps } from './triggers.ts';
export type CloudEnv = SparkEnv & TriggerEnv;
// Run after committed facts/response construction; no network is ever performed in a CAS builder.
export async function runCloudWork(env: CloudEnv, now: number, deps: TriggerDeps = {}) {
  await expireIntents(env.DB, now);
  // Independent external work shares the request lifetime; a slow dispatch must not delay Spark's timeout.
  const dispatched = dispatchStartedSegments(env, now, deps).catch(() => { console.error('cam_trigger_failed'); });
  if (env.CAM_SPARK_ENABLED === '1' && env.MODEL_API_KEY) {
    const events = await env.DB.prepare(`SELECT e.id,e.type FROM events e
      WHERE e.type IN ('gift_arrived','gift_unwrapped','nori_awake','woke') AND e.at>=?
      AND NOT EXISTS (SELECT 1 FROM model_calls m WHERE m.id='spark:' || e.id)
      ORDER BY e.at,e.id LIMIT 3`).bind(now - 86400000).all<{ id: string; type: string }>();
    // A bounded backlog shares one 20-second window rather than extending waitUntil to a minute.
    let committed = Promise.resolve();
    const commitQueue = (work: () => Promise<void>) => {
      const result = committed.then(work);
      committed = result.catch(() => {});
      return result;
    };
    const results = await Promise.allSettled(events.results.map(e => reactWithSpark(env,
      e.type === 'nori_awake' || e.type === 'woke' ? 'spark_plan' : 'spark_reaction', e.id, now, deps.fetch, commitQueue)));
    if (results.some(r => r.status === 'rejected')) console.error('cam_spark_fact_failed');
  }
  await dispatched;
}
