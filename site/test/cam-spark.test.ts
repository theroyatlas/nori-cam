import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { snapshot, insertSegment } from '../src/worker/cam/store.ts';
import { buildSparkContext, callSpark, reactWithSpark, expireIntents,
  validateSparkIntents, validateWonderResult } from '../src/worker/cam/spark.ts';
import { intentBonus, intentTemplates } from '../src/worker/cam/intent-plan.ts';
import { planNext } from '../src/worker/cam/plan.ts';
import { advance, safeSegment } from '../src/worker/cam/timeline.ts';
import { dispatchStartedSegments } from '../src/worker/cam/triggers.ts';
import { definiteDispatchFailure, DispatchError } from '../src/worker/cam/dispatch.ts';
import { handle } from '../src/worker/index.ts';
import { runCloudWork } from '../src/worker/cam/cloud.ts';
import { utility, initialState, wakeResponse } from '../src/worker/cam/engine.ts';
import { replan } from '../src/worker/cam/replan.ts';
import { settle } from '../src/worker/cam/settle.ts';
import { writeFact } from '../src/worker/cam/facts.ts';
import { EXECUTOR } from '../public/cam-shared.js';
import { validate } from '../src/worker/cam/validate.ts';
import type { ActiveIntent, SparkIntent } from '../src/worker/cam/spark-validate.ts';
import type { SparkEnv } from '../src/worker/cam/spark.ts';
import { costFromUsage } from '../src/worker/limits.ts';

const proposal = (object_id: string, extra: Partial<SparkIntent> = {}): SparkIntent => ({
  action: 'approach', object_id, window_minutes: 120, reason_tag: 'curious', summary: 'Visit the object.', ...extra,
});
describe('planner intent influence', () => {
  it('search becomes a scored candidate for a missing object and uses executor primitives', async () => {
    const t = await setup();
    const object = t.snap.objects.find(o => o.id === t.id)!;
    object.status = 'removed';
    t.snap.state.missing.push({ object_id: t.id, kind: object.kind, x: object.x, y: object.y,
      familiarity: 0.8, since: NOW });
    const intent = { ...proposal(t.id, { action: 'search' }), id: 'intent:search:0', expires_at: NOW + 600000 };
    const ix = intentTemplates([intent], t.snap.objects, [], NOW)[0];
    expect(intentBonus([intent], ix, NOW)).toBe(1);
    let chosen = 0;
    for (let seed = 0; seed < 20; seed++) {
      const segments = planNext({ state: t.snap.state, objects: t.snap.objects, interactions: [],
        start_at: NOW, world_version: seed, position: [2, 6], intents: [intent] });
      if (segments.some(s => s.source === intent.id)) chosen++;
      expect(segments.every(s => s.primitive in EXECUTOR)).toBe(true);
    }
    expect(chosen).toBeGreaterThan(0);
  });
  it('all object templates pass the fixed executor validator for a matching catalog object', async () => {
    const t = await setup();
    // The current seed has no window object. Supply an explicit placed viewpoint fixture.
    t.snap.objects.find(o => o.kind === 'drawing_wall')!.tags.push('viewpoint');
    const cases: [SparkIntent['action'], string][] = [
      ['approach', t.id], ['sniff', t.id], ['carry', t.id], ['hide_in', t.box.id],
      ['lie_on', t.snap.objects.find(o => o.tags.includes('soft'))!.id],
      ['sit_on', t.snap.objects.find(o => o.tags.includes('high_place'))!.id],
      ['look_out', t.snap.objects.find(o => o.tags.includes('viewpoint'))!.id],
      ['sleep_at', t.box.id], ['play', t.id],
    ];
    for (const [action, id] of cases) {
      const intent = { ...proposal(id, { action, ...(action === 'carry' ? { destination_id: t.box.id } : {}) }),
        id: `intent:template:${action}`, expires_at: NOW + 600000 };
      const ix = intentTemplates([intent], t.snap.objects, [], NOW)[0];
      expect(ix, action).toBeDefined();
      const result = validate({ objects: t.snap.objects }, t.snap.objects.find(o => o.id === id)!, ix.spec, [2, 6]);
      expect(result.status, `${action}: ${JSON.stringify(result.checks.filter(c => !c.ok))}`).not.toBe('rejected');
    }
  });
  it('adds exactly I, ignore subtracts, fixed seeds change choices using existing primitives', async () => {
    const t = await setup();
    const object = t.snap.objects.find(o => o.id === t.id)!;
    const ix = t.snap.interactions.find(i => i.object_id === t.id)!;
    const intent: ActiveIntent = { action: 'try_interaction', interaction_id: ix.id, window_minutes: 120,
      reason_tag: 'test', summary: 'Try.', id: 'intent:fixed:0', expires_at: NOW + 600000 };
    const ignored: ActiveIntent = { ...proposal(t.id, { action: 'ignore' }), id: 'intent:ignore:0', expires_at: NOW + 600000 };
    const baseline = utility(t.snap.state, object, ix, NOW);
    expect(utility(t.snap.state, object, ix, NOW, 0, intentBonus([intent], ix, NOW)) - baseline).toBeCloseTo(1.2);
    expect(utility(t.snap.state, object, ix, NOW, 0, intentBonus([ignored], ix, NOW)) - baseline).toBeCloseTo(-1.2);
    expect(intentBonus([intent], ix, NOW + 600000)).toBe(0);
    const other = t.snap.interactions.find(i => i.object_id !== t.id)!;
    expect(intentBonus([intent, ignored], other, NOW)).toBe(0);
    const counts = [0, 0, 0];
    for (let seed = 1; seed <= 100; seed++) {
      for (const [n, intents] of [[], [intent], [ignored]].entries()) {
        const result = planNext({ state: t.snap.state, objects: t.snap.objects, interactions: t.snap.interactions,
          start_at: NOW, world_version: seed, position: [2, 6], intents });
        if (result.some(s => s.interaction === ix.id)) counts[n]++;
        expect(result.every(s => s.primitive in EXECUTOR)).toBe(true);
      }
    }
    expect(counts[1]).toBeGreaterThan(counts[0]);
    expect(counts[2]).toBeLessThan(counts[0]);
    console.log('intent-choice-counts', { baseline: counts[0], accepted: counts[1], ignored: counts[2] });
  });
  it('approach/sniff templates can be selected', async () => {
    const t = await setup();
    for (const action of ['approach', 'sniff'] as const) {
      const intent = { ...proposal(t.id, { action }), id: `intent:template:${action}`, expires_at: NOW + 600000 };
      expect(intentTemplates([intent], t.snap.objects, [], NOW)).toHaveLength(1);
      const result = planNext({ state: t.snap.state, objects: t.snap.objects, interactions: [],
        start_at: NOW, world_version: 1, position: [2, 6], intents: [intent] });
      expect(result.some(s => s.source === intent.id)).toBe(true);
    }
  });
  it('computer behaviour keeps a browse trigger on a <=25 minute segment', async () => {
    const t = await setup();
    const ix = t.snap.interactions.find(i => i.action === 'use_computer')!;
    expect(ix).toBeDefined();
    const result = planNext({ state: t.snap.state, objects: t.snap.objects, interactions: [ix],
      start_at: NOW, world_version: 1, position: [2, 6],
      intent: { action: 'use_computer', bonus: 2, expires_at: NOW + 600000 } });
    const browse = result.find(s => s.trigger?.kind === 'browse');
    expect(browse).toBeDefined();
    expect(browse!.end_at - browse!.start_at).toBeGreaterThanOrEqual(10 * 60000);
    expect(browse!.end_at - browse!.start_at).toBeLessThanOrEqual(25 * 60000);
  });
});
async function browseSetup(start = NOW) {
  const t = database();
  Object.assign(t.env, { CAM_BROWSE_ENABLED: '1' });
  t.sql.prepare(`INSERT INTO segments (id,start_at,end_at,action,primitive,pose,path,source,world_version,trigger)
    VALUES (999,?,?,'use_computer','hold_pose','sit','[[2,6]]','routine',0,'{"kind":"browse"}')`)
    .run(start, start + 600000);
  return t;
}
describe('lifecycle wiring and A2a leftovers', () => {
  it('settled sleep to awake transition produces one Spark plan', async () => {
    const t = await setup();
    t.env.CAM_SPARK_ENABLED = '1';
    t.env.MODEL_API_KEY = 'fixture-only';
    const sleep = safeSegment(NOW, NOW + 60000, 800, 0, [2, 6]);
    sleep.action = 'sleep';
    sleep.primitive = 'sleep';
    const awake = safeSegment(NOW + 60000, NOW + 61000, 801, 0, [2, 6]);
    await t.db.batch([insertSegment(t.db, sleep, t.snap.world.writer), insertSegment(t.db, awake, t.snap.world.writer)]);
    t.sql.prepare('UPDATE world SET timeline_until=?').run(NOW + 61000);
    await advance(t.env, NOW + 61000, 'read');
    const client = vi.fn<typeof fetch>(async () => reply([]));
    await runCloudWork(t.env, NOW + 61000, { fetch: client });
    await runCloudWork(t.env, NOW + 61000, { fetch: client });
    expect(client).toHaveBeenCalledTimes(1);
    expect(t.sql.prepare("SELECT purpose FROM model_calls").get()?.purpose).toBe('spark_plan');
  });
  it('fires one Spark for each committed arrival, unwrap and waking event', async () => {
    const t = await setup();
    t.env.CAM_SPARK_ENABLED = '1';
    t.env.MODEL_API_KEY = 'fixture-only';
    await advance(t.env, NOW, 'read');
    const put = t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version) VALUES (?,'fixture',?,?,'system','{}',1,0,0)`);
    for (const type of ['gift_arrived', 'gift_unwrapped', 'woke']) put.run(type, NOW, type);
    const client = vi.fn<typeof fetch>(async () => reply([]));
    await runCloudWork(t.env, NOW, { fetch: client });
    await runCloudWork(t.env, NOW, { fetch: client });
    expect(client).toHaveBeenCalledTimes(3);
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='spark_result'").get()?.n).toBe(3);
    expect(t.sql.prepare("SELECT count(*) n FROM model_calls WHERE purpose='spark_plan'").get()?.n).toBe(1);
  });
  it('advance fails a 20-minute processing photo, settles estimate and preserves the parcel', async () => {
    const t = await setup();
    t.sql.prepare(`INSERT INTO gifts (id,idem,insert_token,giver,kind,status,object_id,created_at,updated_at)
      VALUES ('stuck','stuck','fixture','owner','photo','processing',?,?,?)`).run(t.box.id, NOW - 1200001, NOW);
    t.sql.prepare(`INSERT INTO budget_ledger (id,day,purpose,status,est_usd,created_at)
      VALUES ('res:owner_photo:stuck','2026-11-02','owner_photo','reserved',0.08,?)`).run(NOW - 1200001);
    await advance(t.env, NOW, 'read');
    await advance(t.env, NOW, 'read');
    expect(t.sql.prepare("SELECT status FROM gifts WHERE id='stuck'").get()?.status).toBe('failed');
    expect(String(t.sql.prepare("SELECT pipeline FROM gifts WHERE id='stuck'").get()?.pipeline)).toContain('timeout');
    expect(t.sql.prepare("SELECT actual_usd,status FROM budget_ledger WHERE id='res:owner_photo:stuck'").get())
      .toMatchObject({ actual_usd: 0.08, status: 'settled' });
    expect(t.sql.prepare('SELECT status FROM objects WHERE id=?').get(t.box.id)?.status).toBe('placed');
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE id='gift-terminal:stuck'").get()?.n).toBe(1);
  });
  it('distinguishes definite 4xx/refused from ambiguous 5xx/timeouts', () => {
    expect(definiteDispatchFailure(new DispatchError(true, 422))).toBe(true);
    expect(definiteDispatchFailure({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
    expect(definiteDispatchFailure(new DispatchError(false, 500))).toBe(false);
    expect(definiteDispatchFailure(new DOMException('timeout', 'TimeoutError'))).toBe(false);
  });

});
describe('segment trigger claims', () => {
  it('concurrent claims dispatch once with required workflow inputs', async () => {
    const t = await browseSetup();
    const dispatch = vi.fn(async (..._args: unknown[]) => {});
    await Promise.all([dispatchStartedSegments(t.env, NOW, { dispatch }), dispatchStartedSegments(t.env, NOW, { dispatch })]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]).toEqual([t.env, 'nori-wake.yml', { reason: 'computer', intent_id: 'seg:999' }, undefined]);
    expect(t.sql.prepare('SELECT trigger_status FROM segments WHERE id=999').get()?.trigger_status).toBe('dispatched');
  });
  it('future, superseded and ended segments never dispatch', async () => {
    const t = await browseSetup(NOW + 60000);
    const dispatch = vi.fn(async () => {});
    await dispatchStartedSegments(t.env, NOW, { dispatch });
    t.sql.prepare('UPDATE segments SET superseded_at=? WHERE id=999').run(NOW);
    await dispatchStartedSegments(t.env, NOW + 60001, { dispatch });
    await dispatchStartedSegments(t.env, NOW + 7200000, { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('budget denied leaves segment playable and sends nothing', async () => {
    const t = await browseSetup();
    const dispatch = vi.fn(async () => {});
    await dispatchStartedSegments({ ...t.env, CAM_DAILY_USD: '0' }, NOW, { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(t.sql.prepare('SELECT trigger_status,end_at,superseded_at FROM segments WHERE id=999').get())
      .toMatchObject({ trigger_status: 'budget_denied', end_at: NOW + 600000, superseded_at: null });
  });
  it('failure releases and permits exactly one retry then remains failed', async () => {
    const t = await browseSetup();
    const dispatch = vi.fn(async () => { throw new DispatchError(true, 422); });
    for (let n = 0; n < 4; n++) await dispatchStartedSegments(t.env, NOW + n, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(t.sql.prepare('SELECT trigger_status FROM segments WHERE id=999').get()?.trigger_status).toBe('failed');
    const rows = t.sql.prepare('SELECT status FROM budget_ledger').all();
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === 'released')).toBe(true);
  });
  it('no retry once the running segment ends', async () => {
    const t = await browseSetup();
    const dispatch = vi.fn(async () => { throw new DispatchError(true, 422); });
    await dispatchStartedSegments(t.env, NOW, { dispatch });
    await dispatchStartedSegments(t.env, NOW + 600000, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('ambiguous dispatch failure keeps the reservation and skips retry', async () => {
    const t = await browseSetup();
    const dispatch = vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); });
    for (let n = 0; n < 3; n++) await dispatchStartedSegments(t.env, NOW + n, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(t.sql.prepare('SELECT trigger_status FROM segments WHERE id=999').get()?.trigger_status).toBe('uncertain');
    expect(t.sql.prepare("SELECT status FROM budget_ledger WHERE id='res:browse:seg:999'").get()?.status).toBe('reserved');
  });
  it('CAM_LOCAL_PIPELINE marks reflect dispatched without GitHub workflow', async () => {
    const t = database();
    Object.assign(t.env, { CAM_REFLECT_ENABLED: '1', CAM_LOCAL_PIPELINE: '1' });
    t.sql.prepare(`INSERT INTO segments (id,start_at,end_at,action,primitive,pose,path,source,world_version,trigger)
      VALUES (998,?,?, 'sleep','sleep','sleep','[[2,6]]','routine',0,'{"kind":"reflect"}')`)
      .run(NOW, NOW + 1800000);
    const dispatch = vi.fn(async () => {});
    await dispatchStartedSegments(t.env, NOW, { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(t.sql.prepare('SELECT trigger_status FROM segments WHERE id=998').get()?.trigger_status).toBe('dispatched');
  });
  it('Spark runs only when CAM_SPARK_ENABLED is exactly 1', async () => {
    const t = await setup();
    t.env.MODEL_API_KEY = 'fixture-only';
    await advance(t.env, NOW, 'read');
    t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version) VALUES ('gift_arrived','fixture',?,'gift_arrived','system','{}',1,0,0)`)
      .run(NOW);
    const client = vi.fn<typeof fetch>(async () => reply([]));
    for (const enabled of [undefined, 'false', 'off', '0']) {
      t.env.CAM_SPARK_ENABLED = enabled;
      await runCloudWork(t.env, NOW, { fetch: client });
    }
    t.env.CAM_SPARK_ENABLED = '1';
    await runCloudWork(t.env, NOW, { fetch: client });
    expect(client).toHaveBeenCalledTimes(1);
  });
});
const reply = (intents: SparkIntent[]) => Response.json({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ intents }) } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
});
// Recorded real upstream reply: finish "stop" after 1117 reasoning tokens, content is valid JSON.
const RECORDED_CONTENT = '{"intents": [{"action": "hide_in", "object_id": "o_cardboard_box", "window_minutes": 60, ' +
  '"reason_tag": "exploration", "summary": "Hide inside the cardboard box to explore and rest."}]}';
const RECORDED_USAGE = { completion_tokens: 1249, prompt_tokens: 698, total_tokens: 1947,
  completion_tokens_details: { reasoning_tokens: 1117 } };
const recordedReply = () => replyText(RECORDED_CONTENT);
const replyText = (content: string) => Response.json({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: RECORDED_USAGE,
});
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('live network forbidden'); })));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup() {
  const t = database();
  const snap = await snapshot(t.db, NOW);
  const env: SparkEnv = { ...t.env, MODEL_API_KEY: 'fixture-only', CAM_SPARK_ENABLED: '1' };
  const id = snap.objects.find(o => o.kind === 'slipper')!.id;
  const box = snap.objects.find(o => o.kind === 'cardboard_box')!;
  return { ...t, snap, env, id, box };
}
describe('A2e spark_result replan', () => {
  const intentId = 'intent:spark-test:0';
  async function sparkPending(t: Awaited<ReturnType<typeof setup>>, asleep: boolean) {
    await advance(t.env, NOW, 'read');
    const state = initialState(NOW);
    state.nori.asleep = asleep;
    state.nori.curiosity = asleep ? 1 : 0.3;
    if (asleep) state.nori.sleep_started_at = NOW - 600000;
    t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(state));
    t.sql.prepare(`INSERT INTO intents
      (id,created_at,source,model,trigger_event,raw,accepted,rejected,status,expires_at)
      VALUES (?,?,'spark_reaction','test','spark-result:test','{}',?,NULL,'active',?)`)
      .run(intentId, NOW, JSON.stringify(proposal(t.id)), NOW + 600000);
    t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
      VALUES ('spark-result:test','test',?,'spark_result','brain','{}',1,0,NULL)`).run(NOW);
  }
  it('while awake replans with the accepted intent bonus in the timeline', async () => {
    const t = await setup();
    await sparkPending(t, false);
    expect(await replan(t.db, NOW)).toBe(true);
    const withIntent = t.sql.prepare('SELECT source FROM segments WHERE superseded_at IS NULL AND source=?')
      .get(intentId);
    expect(withIntent).toBeDefined();
    t.sql.prepare("DELETE FROM segments WHERE superseded_at IS NULL").run();
    t.sql.prepare("UPDATE events SET handled_version=NULL WHERE id='spark-result:test'").run();
    t.sql.prepare('DELETE FROM intents').run();
    expect(await replan(t.db, NOW + 1)).toBe(true);
    expect(t.sql.prepare('SELECT source FROM segments WHERE superseded_at IS NULL AND source=?').get(intentId)).toBeUndefined();
  });
  it('while asleep never cuts sleep even when the wake roll would succeed', async () => {
    const t = await setup();
    const state = initialState(NOW);
    state.nori.asleep = true;
    state.nori.curiosity = 1;
    state.nori.sleep_started_at = NOW - 600000;
    state.settled_through = NOW;
    t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(state));
    const sleep = safeSegment(NOW, NOW + 3600000, 805, 0, [2, 6]);
    sleep.action = 'sleep';
    sleep.primitive = 'sleep';
    await t.db.batch([insertSegment(t.db, sleep, t.snap.world.writer)]);
    t.sql.prepare('UPDATE world SET timeline_until=?').run(NOW + 3600000);
    t.sql.prepare(`INSERT INTO intents
      (id,created_at,source,model,trigger_event,raw,accepted,rejected,status,expires_at)
      VALUES (?,?,'spark_reaction','test','spark-result:test','{}',?,NULL,'active',?)`)
      .run(intentId, NOW, JSON.stringify(proposal(t.id)), NOW + 600000);
    t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
      VALUES ('spark-result:test','test',?,'spark_result','brain','{}',1,0,NULL)`).run(NOW);
    const snap = await snapshot(t.db, NOW);
    let projection = structuredClone(snap.state);
    for (const s of snap.segments.filter(seg => seg.start_at < NOW + 1500)) {
      const end = Math.min(s.end_at, NOW + 1500);
      const seg = s.end_at <= NOW + 1500 ? s : { ...s, end_at: end, cut_at: end, path: s.path };
      const result = settle(projection, seg, snap.objects, NOW + 1500);
      projection = result.state;
    }
    let wouldWake = false;
    for (let v = 0; v < 200; v++) {
      if (wakeResponse(structuredClone(projection), 'spark-result:test', NOW, v)) { wouldWake = true; break; }
    }
    expect(wouldWake).toBe(true);
    expect(projection.nori.asleep).toBe(true);
    const version = snap.world.version;
    const segmentsBefore = t.sql.prepare('SELECT count(*) n FROM segments').get()!.n;
    expect(await replan(t.db, NOW)).toBe(true);
    const stateAfter = JSON.parse(String(t.sql.prepare('SELECT state_json FROM world').get()!.state_json));
    expect(stateAfter.nori.asleep).toBe(true);
    expect((await snapshot(t.db, NOW)).world.version).toBeGreaterThan(version);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='spark-result:test'").get()!.handled_version)
      .not.toBeNull();
    expect(t.sql.prepare('SELECT count(*) n FROM segments').get()!.n).toBe(segmentsBefore);
  });
  it('pending wonder_result while asleep still defers without waking', async () => {
    const t = await setup();
    const state = initialState(NOW);
    state.nori.asleep = true;
    state.nori.curiosity = 0;
    state.nori.sleep_started_at = NOW - 600000;
    t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(state));
    t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
      VALUES ('wonder-pending','test',?,'wonder_result','brain','{}',0,0,NULL)`).run(NOW);
    expect(await replan(t.db, NOW)).toBe(false);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='wonder-pending'").get()!.handled_version).toBeNull();
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='sleep_deferred'").get()!.n).toBe(1);
  });
  it('spark_result facts stay pending on insert', async () => {
    const t = await setup();
    await writeFact(t.db, { id: 'spark-pending', at: NOW, type: 'spark_result', actor: 'brain', payload: {} },
      NOW, () => []);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='spark-pending'").get()!.handled_version).toBeNull();
  });
  it('A2f: unsettled sleep at the cut is treated as asleep even when stored state is awake', async () => {
    const t = await setup();
    const state = initialState(NOW);
    state.nori.asleep = false;
    state.nori.curiosity = 1;
    state.settled_through = NOW;
    t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(state));
    const sleep = safeSegment(NOW, NOW + 3600000, 802, 0, [2, 6]);
    sleep.action = 'sleep';
    sleep.primitive = 'sleep';
    await t.db.batch([insertSegment(t.db, sleep, t.snap.world.writer)]);
    t.sql.prepare('UPDATE world SET timeline_until=?').run(NOW + 3600000);
    t.sql.prepare(`INSERT INTO intents
      (id,created_at,source,model,trigger_event,raw,accepted,rejected,status,expires_at)
      VALUES (?,?,'spark_reaction','test','spark-result:test','{}',?,NULL,'active',?)`)
      .run(intentId, NOW, JSON.stringify(proposal(t.id)), NOW + 600000);
    t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
      VALUES ('spark-result:test','test',?,'spark_result','brain','{}',1,0,NULL)`).run(NOW);
    const snap = await snapshot(t.db, NOW);
    let projection = structuredClone(snap.state);
    for (const s of snap.segments.filter(seg => seg.start_at < NOW + 1500)) {
      const end = Math.min(s.end_at, NOW + 1500);
      const seg = s.end_at <= NOW + 1500 ? s : { ...s, end_at: end, cut_at: end, path: s.path };
      const result = settle(projection, seg as typeof s, snap.objects, NOW + 1500);
      if (result.error) throw new Error('test_setup_gap');
      projection = result.state;
    }
    expect(projection.nori.asleep).toBe(true);
    let wouldWake = false;
    for (let v = 0; v < 200; v++) {
      if (wakeResponse(structuredClone(projection), 'spark-result:test', NOW, v)) { wouldWake = true; break; }
    }
    expect(wouldWake).toBe(true);
    const sleepEndBefore = t.sql.prepare('SELECT end_at FROM segments WHERE id=802').get()!.end_at;
    const segmentsBefore = t.sql.prepare('SELECT count(*) n FROM segments').get()!.n;
    expect(await replan(t.db, NOW)).toBe(true);
    expect(t.sql.prepare('SELECT end_at FROM segments WHERE id=802').get()!.end_at).toBe(sleepEndBefore);
    expect(t.sql.prepare('SELECT count(*) n FROM segments WHERE superseded_at IS NULL AND source LIKE ?')
      .get('reaction:%')?.n ?? 0).toBe(0);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='spark-result:test'").get()!.handled_version)
      .not.toBeNull();
  });
  it('A2f: spark_result plans with intent when segments wake her before the cut but stored state is asleep', async () => {
    const t = await setup();
    const anchor = NOW - 600000;
    const state = initialState(anchor);
    state.nori.asleep = true;
    state.nori.curiosity = 0.3;
    state.nori.sleep_started_at = anchor;
    state.settled_through = anchor;
    t.sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(state));
    const endedSleep = safeSegment(anchor, NOW, 803, 0, [2, 6]);
    endedSleep.action = 'sleep';
    endedSleep.primitive = 'sleep';
    const awake = safeSegment(NOW, NOW + 3600000, 804, 0, [2, 6]);
    awake.action = 'idle_sit';
    awake.primitive = 'hold_pose';
    await t.db.batch([
      insertSegment(t.db, endedSleep, t.snap.world.writer),
      insertSegment(t.db, awake, t.snap.world.writer),
    ]);
    t.sql.prepare('UPDATE world SET timeline_until=?').run(NOW + 3600000);
    t.sql.prepare(`INSERT INTO intents
      (id,created_at,source,model,trigger_event,raw,accepted,rejected,status,expires_at)
      VALUES (?,?,'spark_reaction','test','spark-result:test','{}',?,NULL,'active',?)`)
      .run(intentId, NOW, JSON.stringify(proposal(t.id)), NOW + 600000);
    t.sql.prepare(`INSERT INTO events
      (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
      VALUES ('spark-result:test','test',?,'spark_result','brain','{}',1,0,NULL)`).run(NOW);
    expect(await replan(t.db, NOW)).toBe(true);
    const withIntent = t.sql.prepare('SELECT source FROM segments WHERE superseded_at IS NULL AND source=?')
      .get(intentId);
    expect(withIntent).toBeDefined();
    t.sql.prepare('DELETE FROM segments WHERE superseded_at IS NULL').run();
    t.sql.prepare("UPDATE events SET handled_version=NULL WHERE id='spark-result:test'").run();
    t.sql.prepare('DELETE FROM intents').run();
    t.sql.prepare(`INSERT INTO intents
      (id,created_at,source,model,trigger_event,raw,accepted,rejected,status,expires_at)
      VALUES (?,?,'spark_reaction','test','spark-result:test','{}',?,NULL,'active',?)`)
      .run(intentId, NOW, JSON.stringify(proposal(t.id)), NOW + 600000);
    expect(await replan(t.db, NOW + 1)).toBe(true);
    expect(t.sql.prepare('SELECT source FROM segments WHERE superseded_at IS NULL AND source=?').get(intentId)).toBeUndefined();
  });
});
describe('closed intent validators', () => {
  it('accepts valid intents and rejects the entire envelope on an extra top-level key', async () => {
    const t = await setup();
    expect(validateSparkIntents({ intents: [proposal(t.id)] }, t.snap, NOW).accepted).toHaveLength(1);
    expect(validateSparkIntents({ intents: [proposal(t.id)], reflection: {} }, t.snap, NOW).accepted).toHaveLength(0);
    expect(validateSparkIntents({ intents: Array(4).fill(proposal(t.id)) }, t.snap, NOW).accepted).toHaveLength(0);
  });
  it.each([9, 721, NaN, Infinity])('rejects window %s', async window_minutes => {
    const t = await setup();
    expect(validateSparkIntents({ intents: [proposal(t.id, { window_minutes })] }, t.snap, NOW).accepted).toHaveLength(0);
  });
  it.each([10, 720])('accepts window boundary %s', async window_minutes => {
    const t = await setup();
    expect(validateSparkIntents({ intents: [proposal(t.id, { window_minutes })] }, t.snap, NOW).accepted).toHaveLength(1);
  });
  it('rejects unknown/unplaced objects, action keys and overlong summaries', async () => {
    const t = await setup();
    for (const intent of [proposal('unknown'), { ...proposal(t.id), preference_delta: 1 },
      proposal(t.id, { summary: 'x'.repeat(161) }), proposal(t.id, { action: 'fight' as any })]) {
      expect(validateSparkIntents({ intents: [intent] }, t.snap, NOW).accepted).toHaveLength(0);
    }
    t.snap.objects.find(o => o.id === t.id)!.status = 'stored';
    expect(validateSparkIntents({ intents: [proposal(t.id)] }, t.snap, NOW).accepted).toHaveLength(0);
  });
  it('hide_in requires enclosed and a prefab with an approved box pose', async () => {
    const t = await setup();
    const check = () => validateSparkIntents({ intents: [proposal(t.box.id, { action: 'hide_in' })] }, t.snap, NOW);
    expect(check().accepted).toHaveLength(1);
    t.box.tags = [];
    expect(check().accepted).toHaveLength(0);
    t.box.tags = ['enclosed'];
    t.box.origin = { type: 'photo_gift' };
    expect(check().accepted).toHaveLength(0);
    t.box.origin = { type: 'prefab' };
    t.box.card.prop_poses = [];
    expect(check().accepted).toHaveLength(0);
  });
  it('carry requires portable S and a placed enclosed/soft/bed destination', async () => {
    const t = await setup();
    const o = t.snap.objects.find(o => o.id === t.id)!;
    const check = () => validateSparkIntents({ intents: [proposal(t.id,
      { action: 'carry', destination_id: t.box.id })] }, t.snap, NOW).accepted.length;
    expect(check()).toBe(1);
    o.size = 'M';
    expect(check()).toBe(0);
    o.size = 'S';
    o.tags = [];
    expect(check()).toBe(0);
    o.tags = ['portable'];
    t.box.tags = [];
    expect(check()).toBe(0);
    t.box.tags = ['soft'];
    expect(check()).toBe(1);
    t.box.status = 'removed';
    expect(check()).toBe(0);
  });
  it('try_interaction uses only accepted/degraded snapshot rows and search only missing objects', async () => {
    const t = await setup();
    const ix = t.snap.interactions.find(i => i.object_id === t.id)!;
    const intent = { action: 'try_interaction', interaction_id: ix.id, window_minutes: 120,
      reason_tag: 'test', summary: 'Try it.' };
    expect(validateSparkIntents({ intents: [intent] }, t.snap, NOW).accepted).toHaveLength(1);
    t.sql.prepare("UPDATE interactions SET status='rejected' WHERE id=?").run(ix.id);
    expect(validateSparkIntents({ intents: [intent] }, await snapshot(t.db, NOW), NOW).accepted).toHaveLength(0);
    expect(validateSparkIntents({ intents: [proposal(t.id, { action: 'search' })] }, t.snap, NOW).accepted).toHaveLength(0);
    t.snap.state.missing.push({ object_id: t.id, kind: 'slipper', x: 3, y: 3, familiarity: 0.8, since: NOW });
    expect(validateSparkIntents({ intents: [proposal(t.id, { action: 'search' })] }, t.snap, NOW).accepted).toHaveLength(1);
  });
  it('Wonder checks reflection evidence, separate window, vocabulary and strict keys', async () => {
    const t = await setup();
    const valid = { reflection: { summary: 'A day.', event_ids: ['event-1'] },
      tomorrow: proposal(t.id, { window_minutes: 1440 }), habit_candidate: 'soft' };
    expect(validateWonderResult(valid, t.snap, NOW, ['event-1']).valid).toBe(true);
    expect(validateWonderResult(valid, t.snap, NOW, []).valid).toBe(false);
    expect(validateWonderResult({ ...valid, habit_candidate: 'combat' }, t.snap, NOW, ['event-1']).valid).toBe(false);
    expect(validateWonderResult({ ...valid, habit_candidate: ['soft'] as unknown as string }, t.snap, NOW, ['event-1']).valid)
      .toBe(false);
    expect(validateWonderResult({ ...valid, tomorrow: proposal(t.id, { window_minutes: 1441 }) },
      t.snap, NOW, ['event-1']).valid).toBe(false);
    expect(validateWonderResult({ ...valid, intents: [] }, t.snap, NOW, ['event-1']).valid).toBe(false);
  });
});
describe('Spark calls, claims and ledger', () => {
  it('sends one JSON call with canonical endpoint/model; settles reported usage', async () => {
    const t = await setup();
    const client = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('muse-spark-1.3');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(t.sql.prepare("SELECT status FROM budget_ledger").get()?.status).toBe('reserved');
      return reply([proposal(t.id)]);
    });
    const result = await callSpark('spark_reaction', buildSparkContext(t.snap, NOW),
      { env: t.env, now: NOW, triggerId: 'gift-1', fetch: client });
    expect(result.status).toBe('completed');
    expect(client.mock.calls[0][0]).toBe('https://api.meta.ai/v1/chat/completions');
    expect(t.sql.prepare('SELECT ok,cost_usd FROM model_calls').get()).toMatchObject({ ok: 1, cost_usd: 0.0003375 });
    expect(t.sql.prepare('SELECT status,actual_usd FROM budget_ledger').get())
      .toMatchObject({ status: 'settled', actual_usd: 0.0003375 });
  });
  it('budget denied makes zero client calls and records an event', async () => {
    const t = await setup();
    t.env.CAM_SPARK_DAILY_USD = '0';
    const client = vi.fn<typeof fetch>();
    const result = await callSpark('spark_plan', buildSparkContext(t.snap, NOW),
      { env: t.env, now: NOW, triggerId: 'awake-1', fetch: client });
    expect(result.status).toBe('budget_denied');
    expect(client).not.toHaveBeenCalled();
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='budget_denied'").get()?.n).toBe(1);
  });
  it('concurrent duplicate trigger calls the client once and commits idempotent intent facts', async () => {
    const t = await setup();
    await advance(t.env, NOW, 'read');
    const client = vi.fn<typeof fetch>(async () => reply([proposal(t.id)]));
    await Promise.all([reactWithSpark(t.env, 'spark_reaction', 'same', NOW, client),
      reactWithSpark(t.env, 'spark_reaction', 'same', NOW, client)]);
    expect(client).toHaveBeenCalledTimes(1);
    expect(t.sql.prepare('SELECT id,status FROM intents').get()).toMatchObject({ id: 'intent:same:0', status: 'active' });
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='intent_accepted'").get()?.n).toBe(1);
  });
  it('timeout records ok=0, settles estimate and timeline continues', async () => {
    const t = await setup();
    vi.useFakeTimers();
    const client = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = callSpark('spark_reaction', buildSparkContext(t.snap, NOW),
      { env: t.env, now: NOW, triggerId: 'timeout', fetch: client });
    await vi.advanceTimersByTimeAsync(20001);
    expect((await pending).status).toBe('failed');
    expect(t.sql.prepare('SELECT ok,cost_usd FROM model_calls').get()).toMatchObject({ ok: 0, cost_usd: 0.01 });
    expect(t.sql.prepare('SELECT status,actual_usd FROM budget_ledger').get())
      .toMatchObject({ status: 'settled', actual_usd: 0.01 });
    await advance(t.env, NOW, 'read');
    expect((await snapshot(t.db, NOW)).world.timeline_until).toBeGreaterThan(NOW);
  });
  it('failure and missing usage both settle at estimate', async () => {
    const t = await setup();
    await callSpark('spark_plan', buildSparkContext(t.snap, NOW), { env: t.env, now: NOW, triggerId: 'fail',
      fetch: async () => { throw new Error('offline'); } });
    await callSpark('spark_plan', buildSparkContext(t.snap, NOW), { env: t.env, now: NOW, triggerId: 'no-usage',
      fetch: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"intents":[]}' } }] }) });
    const rows = t.sql.prepare('SELECT status,actual_usd FROM budget_ledger').all();
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === 'settled' && r.actual_usd === 0.01)).toBe(true);
  });
  it('expires intents and emits expiry once across retries', async () => {
    const t = await setup();
    await advance(t.env, NOW, 'read');
    await reactWithSpark(t.env, 'spark_plan', 'expiry', NOW, async () => reply([proposal(t.id)]));
    await Promise.all([expireIntents(t.db, NOW + 121 * 60000), expireIntents(t.db, NOW + 121 * 60000)]);
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type='intent_expired'").get()?.n).toBe(1);
    expect(t.sql.prepare('SELECT status FROM intents').get()?.status).toBe('expired');
  });
  it('context is <=12 KB and includes no payload secrets, card text or photo URL', async () => {
    const t = await setup();
    t.snap.objects[0].card.beyond_executor = ['private-extra'];
    t.snap.objects[0].sprite = 'https://photo.test/secret.png';
    const context = buildSparkContext({ ...t.snap, events: Array.from({ length: 10000 }, (_, n) => ({
      at: NOW - n, type: 'gift_arrived', public: 1, payload: { visitor_hash: 'private-hash', code: 'private-code' },
    })) }, NOW);
    const json = JSON.stringify(context);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(12288);
    for (const secret of ['private-extra', 'photo.test', 'private-hash', 'private-code', 'visitor_hash']) {
      expect(json).not.toContain(secret);
    }
    expect(context.events[0]).toContain(new Date(NOW - context.events.length + 1).toISOString());
  });
  it('recorded real reply gives each intent its validator verdict, never invalid_spark_envelope', async () => {
    const t = await setup();
    await advance(t.env, NOW, 'read');
    await reactWithSpark(t.env, 'spark_reaction', 'recorded', NOW, async () => recordedReply());
    const verdict = validateSparkIntents(JSON.parse(RECORDED_CONTENT), t.snap, NOW);
    const rows = t.sql.prepare('SELECT id,status,rejected FROM intents').all();
    expect(rows).toHaveLength(verdict.accepted.length + verdict.rejected.length);
    for (const a of verdict.accepted) {
      expect(rows.find(r => r.id === `intent:recorded:${a.index}`)).toMatchObject({ status: 'active', rejected: null });
    }
    for (const r of verdict.rejected) {
      expect(rows.find(x => x.id === `intent:recorded:${r.index}`)).toMatchObject({ status: 'rejected', rejected: r.reason });
    }
    expect(rows.map(r => r.rejected)).not.toContain('invalid_spark_envelope');
  });
  it('finish_reason length with null content: ok=0, finish_length, real usage cost, no intents', async () => {
    const t = await setup();
    await advance(t.env, NOW, 'read');
    const usage = { prompt_tokens: 698, completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1198 } };
    await reactWithSpark(t.env, 'spark_reaction', 'length', NOW, async () => Response.json({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }], usage }));
    expect(t.sql.prepare('SELECT ok,summary,cost_usd FROM model_calls').get())
      .toMatchObject({ ok: 0, summary: 'finish_length', cost_usd: costFromUsage(usage) });
    expect(t.sql.prepare('SELECT status,actual_usd FROM budget_ledger').get())
      .toMatchObject({ status: 'settled', actual_usd: costFromUsage(usage) });
    expect(t.sql.prepare('SELECT count(*) n FROM intents').get()?.n).toBe(0);
    expect(t.sql.prepare("SELECT count(*) n FROM events WHERE type IN ('intent_accepted','intent_rejected')").get()?.n)
      .toBe(0);
  });
  it('finish_reason stop with null content fails as no_content and writes no intents', async () => {
    const t = await setup();
    await advance(t.env, NOW, 'read');
    await reactWithSpark(t.env, 'spark_plan', 'no-content', NOW, async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }], usage: RECORDED_USAGE }));
    expect(t.sql.prepare('SELECT ok,summary FROM model_calls').get()).toMatchObject({ ok: 0, summary: 'no_content' });
    expect(t.sql.prepare('SELECT count(*) n FROM intents').get()?.n).toBe(0);
  });
  it('request body asks for reasoning_effort low and 4096 completion tokens', async () => {
    const t = await setup();
    const client = vi.fn<typeof fetch>(async () => recordedReply());
    await callSpark('spark_reaction', buildSparkContext(t.snap, NOW),
      { env: t.env, now: NOW, triggerId: 'effort', fetch: client });
    const body = JSON.parse(String(client.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 4096 });
  });
  it('stores the exact raw content text of a parsed but invalid reply in intents.raw', async () => {
    const t = await setup();
    await advance(t.env, NOW, 'read');
    const content = '{"intents": [{"action": "fight", "object_id": "o_cardboard_box", "window_minutes": 60, ' +
      '"reason_tag": "combat", "summary": "Fight the box."}]}';
    await reactWithSpark(t.env, 'spark_reaction', 'invalid', NOW, async () => replyText(content));
    expect(t.sql.prepare("SELECT raw,status,rejected FROM intents WHERE id='intent:invalid:0'").get())
      .toMatchObject({ raw: content, status: 'rejected', rejected: 'unknown_action' });
  });
  it('caps the stored raw text at 4000 characters', async () => {
    const t = await setup();
    await advance(t.env, NOW, 'read');
    const content = `{"intents": [], "pad": "${'p'.repeat(5000)}"}`;
    await reactWithSpark(t.env, 'spark_reaction', 'long', NOW, async () => replyText(content));
    expect(t.sql.prepare("SELECT raw,rejected FROM intents WHERE id='intent:long:-1'").get())
      .toMatchObject({ raw: content.slice(0, 4000), rejected: 'invalid_spark_envelope' });
  });
});
