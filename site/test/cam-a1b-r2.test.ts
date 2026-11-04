import { describe, it, expect } from 'vitest';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { advance, tick, refreshWeather, safeSegment } from '../src/worker/cam/timeline.ts';
import {
  snapshot, readPublic, claimWorld, insertSegment, insertEvent, insertExperience, persistObject, markSettled,
} from '../src/worker/cam/store.ts';
import { settleEnded } from '../src/worker/cam/settle.ts';
import { initialState } from '../src/worker/cam/engine.ts';
import { handle } from '../src/worker/index.ts';
const HOUR = 3600000;
const MINUTE = 60000;
function fixture(counter: { calls: number }, code = 0): typeof fetch {
  return async () => {
    counter.calls++;
    return Response.json({ hourly: {
      time: Array.from({ length: 72 }, (_, i) => new Date(NOW + (i - 24) * HOUR).toISOString()),
      weather_code: Array(72).fill(code),
    } });
  };
}
describe('A1b-r2 regressions', () => {
  it('extension edge overshoots without an interruption cut', async () => {
    const { env } = database();
    await advance(env, NOW, 'cron', { planner: input => [
      safeSegment(input.start_at, input.start_at + 17 * MINUTE, input.start_at, input.world_version, [2, 6]),
    ] });
    const snap = await snapshot(env.DB);
    expect(snap.world.timeline_until).toBe(NOW + 51 * MINUTE);
    expect(snap.segments.every(s => s.cut_at === null)).toBe(true);
  });
  it('72-hour fixture refreshes each hour and preserves past weather', async () => {
    const { env, sql } = database();
    const counter = { calls: 0 };
    for (let hour = 0; hour < 3; hour++) {
      for (let minute = 0; minute < 60; minute += 20) {
        await tick(env, NOW + hour * HOUR + minute * MINUTE, { fetch: fixture(counter, hour ? 63 : 0) });
      }
    }
    expect(counter.calls).toBe(3);
    expect(sql.prepare('SELECT condition FROM weather WHERE hour_utc=?').get(NOW)?.condition).toBe('clear');
    expect(sql.prepare('SELECT count(*) AS n FROM weather WHERE hour_utc < ?').get(NOW)?.n).toBe(0);
  });
  it('failed hourly refresh retries next hour even with existing forecast', async () => {
    const { env } = database();
    const counter = { calls: 0 };
    await tick(env, NOW, { fetch: fixture(counter) });
    const offline: typeof fetch = async () => { counter.calls++; throw new Error('offline fixture'); };
    for (let minute = 60; minute < 180; minute += 5) {
      await tick(env, NOW + minute * MINUTE, { fetch: offline });
    }
    expect(counter.calls).toBe(3);
  });
  it('truncates a large valid planner result and bounds short-segment planning', async () => {
    const { env, sql } = database();
    await advance(env, NOW, 'cron', { planner: input => Array.from({ length: 40 }, (_, i) =>
      safeSegment(input.start_at + i * MINUTE, input.start_at + (i + 1) * MINUTE,
        input.start_at + i, input.world_version, [2, 6])) });
    const snap = await snapshot(env.DB);
    expect(snap.segments).toHaveLength(30);
    expect(snap.segments.filter(s => s.source !== 'safe')).toHaveLength(0);
    expect(snap.segments[0].end_at).toBe(NOW + MINUTE);
    const reasons = sql.prepare("SELECT payload FROM events WHERE type='safe_fallback'").all();
    expect(reasons).toHaveLength(1);
    expect(JSON.parse(String(reasons[0].payload)).reason).toBe('planning_segment_cap');
    expect(snap.world.timeline_until).toBeGreaterThanOrEqual(NOW + 45 * MINUTE);
  });
  it.each([180, 330])('catchup after %i minutes writes at most 30 segments', async minutes => {
    const { env, sql } = database();
    await advance(env, NOW + minutes * MINUTE, 'cron');
    expect(sql.prepare('SELECT count(*) AS n FROM segments').get()?.n).toBeLessThanOrEqual(30);
    const snap = await snapshot(env.DB);
    expect(snap.world.timeline_until).toBeGreaterThanOrEqual(NOW + (minutes + 45) * MINUTE);
    expect(snap.segments[0].source).toBe('catchup');
  });
  it('settlement gap keeps GET alive and replaces corrupt timeline with safe coverage', async () => {
    const { env, sql } = database();
    await advance(env, NOW, 'cron');
    const badState = initialState(NOW + 1);
    sql.prepare('UPDATE world SET state_json=?').run(JSON.stringify(badState));
    const at = NOW + 90 * MINUTE;
    const response = await handle(new Request('http://local/api/cam'), env, { now: () => at });
    expect(response.status).toBe(200);
    const snap = await snapshot(env.DB);
    expect(snap.state).toEqual(badState);
    expect(snap.segments).toHaveLength(1);
    expect(snap.segments[0].start_at).toBe(NOW + 1);
    expect(snap.segments[0].end_at).toBeGreaterThan(at);
    const event = sql.prepare("SELECT payload FROM events WHERE type='safe_fallback' ORDER BY rowid DESC LIMIT 1").get();
    expect(JSON.parse(String(event?.payload)).reason).toBe('settlement_gap');
    await advance(env, snap.world.timeline_until + 1, 'cron');
    expect((await snapshot(env.DB)).state.settled_through).toBe(snap.world.timeline_until);
  });
  it('already covered ended row has explicit settled marker without effects', () => {
    const s = safeSegment(NOW, NOW + MINUTE, 1, 0, [2, 6]);
    const r = settleEnded(initialState(s.end_at), [s], [], s.end_at);
    expect(r.segments[0].settled_at).toBe(s.end_at);
    expect(r.events).toEqual([]);
  });
  it('weather reads are bounded in both snapshots and public API', async () => {
    const { db, sql } = database();
    for (const hour of [-5, -4, 0]) {
      sql.prepare(`INSERT INTO weather (hour_utc,condition,fetched_at,source) VALUES (?,'clear',?,'fixture')`)
        .run(NOW + hour * HOUR, NOW);
    }
    expect((await snapshot(db, NOW)).weather).toHaveLength(2);
    expect((await readPublic(db, NOW, NOW)).weather).toHaveLength(2);
  });
  it('system events are private; 304 carries clock and ETag ignores from', async () => {
    const { env, sql } = database();
    const url = 'http://local/api/cam?from=' + NOW;
    const response = await handle(new Request(url), env, { now: () => NOW });
    const etag = response.headers.get('etag')!;
    const other = await handle(new Request(url + '1'), env, { now: () => NOW });
    expect(other.headers.get('etag')).toBe(etag);
    const cached = await handle(new Request(url, { headers: { 'If-None-Match': etag } }), env, { now: () => NOW + 1 });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('X-Server-Now')).toBe(String(NOW + 1));
    const different = await handle(new Request(url + '1', { headers: { 'If-None-Match': etag } }), env, { now: () => NOW });
    expect(different.status).toBe(304);
    expect(different.headers.get('X-Server-Now')).toBe(String(NOW));
    expect(sql.prepare("SELECT public FROM events WHERE type='timeline_extended'").get()?.public).toBe(0);
  });
});

// Each phase tests every SQL statement, not only aggregate counts or duplicate IDs.
describe('stale settlement guard probes', () => {
  it('two stale snapshots settle the same ended rows: every loser statement changes zero rows', async () => {
    const { db } = database();
    const base = await snapshot(db, NOW);
    const segments = [1, 2].map(id => safeSegment(NOW + id - 1, NOW + id, id, 0, [2, 6]));
    await db.batch([claimWorld(db, base.world, 'seed', base.state, NOW + 2, NOW),
      ...segments.map(s => insertSegment(db, s, 'seed'))]);
    const first = await snapshot(db, NOW);
    const stale = await snapshot(db, NOW);
    const result = settleEnded(first.state, first.segments, first.objects, NOW + 3);
    const writes = (token: string, suffix: string) => result.segments.flatMap(s => {
      const object = { ...stale.objects[0], x: stale.objects[0].x + 1 };
      const event = { id: `guard-event:${s.id}:${suffix}`, at: s.end_at, type: 'probe', actor: 'nori', payload: {} };
      const experience = {
        id: `guard-exp:${s.id}:${suffix}`, at: s.end_at, object_id: object.id, interaction_id: 'fixture',
        segment_ids: [s.id], sensations: {}, startle: 0, appraisal: 0, reaction: 'neutral', pref_deltas: {},
        wariness_deltas: {}, familiarity_delta: 0, world_version: 1,
      };
      return [insertEvent(db, event, 2, token, s.id), insertExperience(db, experience, token, s.id),
        ...persistObject(db, object, s, token), markSettled(db, s, token)];
    });
    // Losing token while rows remain unsettled isolates the writer-token guards.
    await db.batch([claimWorld(db, first.world, 'winner', result.state, NOW + 2, NOW + 3)]);
    const losingUnsettled = await db.batch([
      claimWorld(db, stale.world, 'loser', result.state, NOW + 2, NOW + 3), ...writes('loser', 'loser'),
    ]);
    expect(losingUnsettled.map(r => r.meta.changes)).toEqual(Array(13).fill(0));
    const winning = await db.batch(writes('winner', 'first'));
    expect(winning.every(r => r.meta.changes === 1)).toBe(true);
    const losingSettled = await db.batch([
      claimWorld(db, stale.world, 'loser', result.state, NOW + 2, NOW + 3), ...writes('loser', 'loser'),
    ]);
    expect(losingSettled.map(r => r.meta.changes)).toEqual(Array(13).fill(0));
    // Current writer, already settled rows, fresh IDs: uniqueness cannot mask missing row guards.
    const covered = await db.batch(writes('winner', 'fresh'));
    expect(covered.map(r => r.meta.changes)).toEqual(Array(12).fill(0));
  });
});

it('hourly weather attempt claim prevents simultaneous upstream calls', async () => {
  const { env } = database();
  const counter = { calls: 0 };
  await Promise.all([refreshWeather(env, NOW, fixture(counter)), refreshWeather(env, NOW, fixture(counter))]);
  expect(counter.calls).toBe(1);
});
it('ETag ignores from range even when the playhead moves backwards', async () => {
  const { env } = database();
  const a = await handle(new Request('http://local/api/cam?from=' + NOW), env, { now: () => NOW });
  const b = await handle(new Request('http://local/api/cam?from=' + (NOW - 1), {
    headers: { 'If-None-Match': a.headers.get('etag')! },
  }), env, { now: () => NOW });
  expect(b.status).toBe(304);
});
it('all system event types are private and insertEvent accepts visibility', async () => {
  const { env, db, sql } = database();
  const counter = { calls: 0 };
  for (let minute = 0; minute < 120; minute += 5) {
    await tick(env, NOW + minute * MINUTE, { fetch: fixture(counter, 95) });
  }
  await advance(env, NOW + 6 * HOUR, 'cron', { planner: () => { throw new Error('fixture'); } });
  const system = sql.prepare(`SELECT type, public FROM events
    WHERE type IN ('timeline_extended','safe_fallback','catchup','weather_startle')`).all();
  for (const type of ['timeline_extended', 'safe_fallback', 'catchup', 'weather_startle']) {
    expect(system.some(e => e.type === type)).toBe(true);
  }
  expect(system.every(e => e.public === 0)).toBe(true);
  const snap = await snapshot(db, NOW);
  await insertEvent(db, { id: 'explicit-private', at: NOW, type: 'test', actor: 'system', payload: {} },
    snap.world.version, snap.world.writer, undefined, 0).run();
  expect(sql.prepare("SELECT public FROM events WHERE id='explicit-private'").get()?.public).toBe(0);
});
