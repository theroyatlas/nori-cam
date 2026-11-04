import { supports } from './heights.ts';
import { templateEvidence } from './evidence.ts';
import { expirePhotoGifts } from './gift-timeout.ts';
import { runCloudWork, type CloudEnv } from './cloud.ts';
import { bestEffortReplan } from './replan.ts';
import { expireReservations } from './budget.ts';
import { planNext, type PlanInput } from './plan.ts';
import { gateSegments } from './segment-gate.ts';
import { settle, settleEnded } from './settle.ts';
import { snapshot, claimWorld, insertSegment, insertEvent, insertExperience, persistObject, markSettled,
  supersedeUnsettled, } from './store.ts';
import { fetchWeather, weatherAt, weatherRowsToUpsert, HOUR_MS } from './weather.ts';
import type { CamEvent, Segment, Cell } from './types.ts';
export interface CamEnv {
    DB: D1Database;
}
export interface TimelineDeps {
    fetch?: typeof fetch;
    planner?: typeof planNext;
}
const MINUTE = 60000;
const MAX_SEGMENTS = 30;
export class CamBusy extends Error {
    constructor() { super('cam_cas_busy'); }
}
export function safeSegment(start: number, end: number, id: number, version: number, position: Cell, source = 'safe'): Segment {
    return {
        id, start_at: start, end_at: end, action: 'idle_sit', primitive: 'hold_pose', pose: 'sit', facing: 1,
        path: [position], z: 0, target: null, part: null, carrying: null, interaction: null, effects: [], source,
        world_version: version, cut_at: null, settled_at: null, superseded_at: null, trigger: null,
    };
}
// Only cron calls this. Read-time backfill never contacts an upstream.
export async function refreshWeather(env: CamEnv, now: number, fetchFn: typeof fetch = fetch) {
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    // Claim before fetching: failures and simultaneous ticks consume only one attempt per hour.
    const fallback = weatherAt([], now);
    const marker = await env.DB.prepare(`INSERT INTO weather
    (hour_utc,condition,temp_c,cloud_pct,precip_mm,wind_kph,is_day,fetched_at,source)
    VALUES (?,'clear',12,0,0,0,?,?,'fallback')
    ON CONFLICT(hour_utc) DO UPDATE SET fetched_at=excluded.fetched_at WHERE weather.fetched_at < ?`)
        .bind(hour, fallback.is_day, now, hour).run();
    if (!marker.meta.changes)
        return;
    const hours = await fetchWeather(fetchFn);
    const statements = weatherRowsToUpsert(hours.filter(h => h.hour_utc >= hour), now);
    if (statements.length)
        await env.DB.batch(statements.map(s => env.DB.prepare(s.sql).bind(...s.params)));
}
export async function advance(env: CamEnv, now: number, mode: 'cron' | 'read', deps: TimelineDeps = {}) {
    await expirePhotoGifts(env, now);
    await expireReservations(env.DB, now);
    const pendingWorld = await snapshot(env.DB, now);
    if (pendingWorld.world.timeline_until > now + 1500)
        await bestEffortReplan(env.DB, now);
    for (let attempt = 0; attempt < 3; attempt++) {
        const snap = await snapshot(env.DB, now);
        const { world } = snap;
        const threshold = now + (mode === 'cron' ? 30 : 2) * MINUTE;
        const extend = world.timeline_until < threshold;
        const ended = snap.segments.filter(s => s.end_at <= now).slice(0, 30);
        if (!extend && !ended.length)
            return { won: false, world };
        const token = crypto.randomUUID();
        const version = world.version + 1;
        let state = snap.state;
        let objects = snap.objects;
        const writes: D1PreparedStatement[] = [];
        let settlementError: unknown;
        try {
            for (const segment of ended) {
                const r = settleEnded(state, [segment], objects, now, weatherAt(snap.weather, segment.start_at));
                if (r.error)
                    throw new Error(JSON.stringify(r.error));
                const settled = r.segments[0];
                if (!settled)
                    continue;
                for (const o of r.objects) {
                    if (JSON.stringify(o) !== JSON.stringify(objects.find(old => old.id === o.id))) {
                        writes.push(...persistObject(env.DB, o, settled, token));
                    }
                }
                writes.push(...r.events.map(e => insertEvent(env.DB, e, version, token, segment.id,
                  e.type === 'weather_startle' ? 0 : 1)), ...r.experiences.map(e => insertExperience(env.DB, e, token,
                    segment.id)), markSettled(env.DB, settled, token));
                state = r.state;
                objects = r.objects;
            }
        }
        catch (error) {
            // Discard the entire tick's partial settlement; the replacement settles on a later tick.
            settlementError = error;
            writes.length = 0;
            state = snap.state;
            objects = snap.objects;
        }
        let until = world.timeline_until;
        if (settlementError) {
            const reason = settlementError instanceof Error && settlementError.message.includes('settlement_gap')
                ? 'settlement_gap' : 'settlement_error';
            until = Math.max(now + 10 * MINUTE, world.timeline_until, state.settled_through + 1);
            const covering = safeSegment(state.settled_through, until, Math.max(version * 1000000000,
              (snap.last?.id ?? 0) + 1), version, snap.last?.path.at(-1) || [2, 6]);
            covering.z = supports(snap.objects, covering.path[0], state.nori.z || 0) ? state.nori.z || 0 : 0;
            const gatedCover = gateSegments([covering], objects, covering.path[0]).segments[0];
            writes.push(supersedeUnsettled(env.DB, now, token), insertSegment(env.DB, gatedCover, token));
            for (const e of gatedCover.effects || [])
                if (e.e === 'hazard_refused') writes.push(insertEvent(env.DB, {
                    id: `hazard-refused:${gatedCover.id}:${version}`, at: gatedCover.start_at,
                    type: 'interaction_rejected', actor: 'system',
                    payload: { reason: e.reason, segment_id: gatedCover.id, target: gatedCover.target },
                }, version, token, undefined, 0));
            writes.push(insertEvent(env.DB, {
                id: `settlement-fallback:${version}`, at: now, type: 'safe_fallback', actor: 'system', payload: { reason },
            }, version, token, undefined, 0));
            console.log('cam_safe_fallback', reason);
        }
        if (extend && !settlementError) {
            const horizon = now + (mode === 'cron' ? 45 : 10) * MINUTE;
            const pending = snap.segments.filter(s => s.end_at > state.settled_through);
            // Forecast on copies; only ended rows change authoritative state.
            let projection = state;
            let geometry = objects;
            let forecastError = false;
            for (const segment of pending) {
                const r = settle(projection, segment, geometry, until, weatherAt(snap.weather, segment.start_at));
                if (r.error) {
                    forecastError = true;
                    break;
                }
                projection = r.state;
                geometry = r.objects;
            }
            let position: Cell = snap.last?.path.at(-1) || [2, 6];
            let nextId = Math.max(version * 1000000000, (snap.last?.id ?? 0) + 1);
            const planned: Segment[] = [];
            const events: CamEvent[] = [];
            const fallback = (end: number, source: string, reason: string) => {
                const candidate = safeSegment(until, end, nextId++, version, position, source);
                candidate.z = supports(geometry, position, projection.nori.z || 0) ? projection.nori.z || 0 : 0;
                const s = gateSegments([candidate], geometry, position).segments[0];
                planned.push(s);
                until = end;
                const r = settle(projection, s, geometry, end, weatherAt(snap.weather, s.start_at));
                projection = r.state;
                geometry = r.objects;
                console.log('cam_' + source, reason);
                events.push({
                    id: `${source}:${s.id}`, at: s.start_at, type: source === 'catchup' ? 'catchup' : 'safe_fallback',
                    actor: 'system', payload: { reason },
                });
            };
            if (now - until > 45 * MINUTE)
                fallback(now, 'catchup', 'bounded_catchup');
            while (until < horizon) {
                // Reserve one slot for continuous coverage if tiny segments exhaust the request budget.
                if (planned.length >= MAX_SEGMENTS - 1) {
                    fallback(horizon, 'safe', 'planning_segment_cap');
                    break;
                }
                try {
                    if (forecastError)
                        throw new Error('forecast_settlement_gap');
                    const weather = weatherAt(snap.weather, until);
                    const storm = weather.effects.startleEvents.find(e => e.at_ms === until);
                    const input: PlanInput = {
                        state: projection, objects: geometry, interactions: snap.interactions, start_at: until,
                        world_version: version, position, weather, intents: snap.intents,
                        reaction: storm ? { event_id: `thunder:${storm.at_ms}`, pose: 'startled' } : undefined,
                    };
                    let next = (deps.planner || planNext)(input);
                    // D1fix4: gate planner output even from an injected planner.
                    next = gateSegments(next, geometry, position).segments;
                    if (!next.length)
                        throw new Error('empty_planner_timeline');
                    next = next.slice(0, MAX_SEGMENTS - 1 - planned.length);
                    let cursor = until;
                    for (const s of next) {
                        if (s.start_at !== cursor || s.end_at <= s.start_at)
                            throw new Error('invalid_planner_timeline');
                        cursor = s.end_at;
                    }
                    // Horizon is a planning target; only weather/hour boundaries interrupt actions.
                    const boundary = Math.min((Math.floor(until / HOUR_MS) + 1) * HOUR_MS,
                      ...weather.effects.startleEvents.filter(e => e.at_ms > until).map(e => e.at_ms));
                    next = next.filter(s => s.start_at < boundary).map(s => s.end_at > boundary && s.primitive !== 'climb'
                        ? { ...s, end_at: boundary, cut_at: boundary, completion: undefined,
                            trigger: s.primitive === 'sleep' && s.trigger?.kind === 'reflect'
                              ? { ...s.trigger, planned_end_at: s.end_at } : s.trigger } : s);
                    let trialState = projection;
                    let trialObjects = geometry;
                    for (const s of next) {
                        const r = settle(trialState, s, trialObjects, s.end_at, input.weather);
                        if (r.error)
                            throw new Error('forecast_settlement_gap');
                        trialState = r.state;
                        trialObjects = r.objects;
                    }
                    projection = trialState;
                    geometry = trialObjects;
                    planned.push(...next);
                    const last = next.at(-1)!;
                    until = last.end_at;
                    position = last.path.at(-1)!;
                    nextId = Math.max(nextId, last.id + 1);
                }
                catch (error) {
                    const reason = error instanceof Error && error.message === 'forecast_settlement_gap'
                        ? 'forecast_settlement_gap' : 'planner_error';
                    fallback(Math.min(horizon, until + 10 * MINUTE), 'safe', reason);
                }
            }
            writes.push(...templateEvidence(env.DB, snap, planned, token));
            writes.push(...planned.map(s => insertSegment(env.DB, s, token)));
            for (const s of planned)
                for (const e of s.effects || [])
                    if (e.e === 'hazard_refused')
                        writes.push(insertEvent(env.DB, { id: `hazard-refused:${s.id}:${version}`, at: s.start_at,
                            type: 'interaction_rejected', actor: 'system',
                            payload: { reason: e.reason, segment_id: s.id, target: s.target } }, version, token, undefined, 0));
            writes.push(...events.map(e => insertEvent(env.DB, e, version, token, undefined, 0)));
            writes.push(insertEvent(env.DB, {
                id: `extend:${world.timeline_until}`, at: now, type: 'timeline_extended', actor: 'system', payload: { until },
            }, version, token, undefined, 0));
        }
        const result = await env.DB.batch([claimWorld(env.DB, world, token, state, until, now), ...writes]);
        if (result[0].meta.changes)
            return {
                won: true,
                world: {
                    ...world, version, writer: token, state_json: JSON.stringify(state), timeline_until: until, updated_at: now
                },
            };
    }
    throw new CamBusy();
}
export async function tick(env: CamEnv, now: number, deps: TimelineDeps = {}) {
    try {
        await refreshWeather(env, now, deps.fetch);
    }
    catch { /* Weather cannot stop the timeline. */ }
    const result = await advance(env, now, 'cron', deps);
    await runCloudWork(env as CloudEnv, now, deps);
    return result;
}
