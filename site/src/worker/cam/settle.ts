import { applyEffects, SENSATIONS, sunCovers, placementOk, cellsOf } from '../../../public/cam-shared.js';
import { continuous, preference, clamp, assess, wakeResponse, RULES } from './engine.ts';
import type { WorldState, Segment, CamObject, Experience, CamEvent, Sensation, Weather, Sensations } from './types.ts';
import { weatherEffects, type WeatherCondition } from './weather.ts';
export function settle(input: WorldState, segment: Segment, inputObjects: CamObject[], now: number, weather?: Weather): {
    state: WorldState;
    objects: CamObject[];
    experiences: Experience[];
    events: CamEvent[];
    segment: Segment;
    error?: {
        code: 'settlement_gap';
        expected_at: number;
        actual_at: number;
    };
} {
    let state = input;
    let objects = inputObjects;
    const experiences: Experience[] = [], events: CamEvent[] = [];
    let s = {
        ...segment
    };
    const result = () => ({
        state, objects, experiences, events, segment: s
    });
    if (now < s.end_at || s.settled_at != null || s.superseded_at != null || state.settled_ids?.includes(s.id)
        || s.end_at <= state.settled_through)
        return result();
    if (s.start_at !== state.settled_through)
        return {
            ...result(), error: {
                code: 'settlement_gap', expected_at: state.settled_through,
                actual_at: s.start_at
            }
        };
    state = continuous(state, s.start_at, s.end_at, s.action);
    state.nori.z = s.z_to ?? s.z;
    const event = (type: string, at = s.end_at, payload: Record<string, unknown> = {}) => events.push({
        id: `${type}:${s.id}:${events.length}`, at, type, actor: 'nori', payload
    });
    const storms = weatherEffects({
        ...weather, condition: (weather?.condition || 'clear') as WeatherCondition,
        hour_utc: Math.floor(s.start_at / 3600000) * 3600000
    }).startleEvents;
    for (const storm of storms)
        if (storm.at_ms > s.start_at && storm.at_ms <= s.end_at) {
            const a = assess(state, 'env:weather', { sound: 1, motion: 0.4 }, `thunder:${storm.at_ms}`, s.id);
            state.wariness.sound = clamp(state.wariness.sound + 0.15 * a.startle);
            event('weather_startle', storm.at_ms, { kind: 'thunder', startle: a.startle });
        }
    if (input.nori.asleep && s.action !== 'sleep') {
        const waking = structuredClone(input);
        wakeResponse(waking, s.source, s.start_at, s.world_version, true);
        state.nori.security = waking.nori.security;
        event('woke', s.start_at);
    }
    for (const e of s.effects)
        if (e.e === 'emit_sound' && s.start_at + (e.at_ms || 0) <= s.end_at)
            event('sound_played', s.start_at + (e.at_ms || 0), {
                pattern: e.pattern, target: s.target
            });
    if (s.cut_at != null) {
        state.interrupted_ids = [...(state.interrupted_ids || []).slice(-127), s.id];
        if (s.interaction)
            event('interaction_interrupted', s.end_at, {
                interaction: s.interaction
            });
        // A cut can follow an already-settled carry leg, or cut the first carry leg.
        const carried = objects.find(o => o.id === (s.carrying || s.target) && (o.status === 'carried' || s.primitive === 'carry'));
        if (carried) {
            const end = s.path.at(-1) || [carried.x, carried.y];
            const candidates = Array.from({ length: 80 }, (_, i) => [i % 10, Math.floor(i / 10)] as [
                number,
                number
            ])
                .sort((a, b) => (Math.abs(a[0] - end[0]) + Math.abs(a[1] - end[1])) - (Math.abs(b[0] - end[0]) + Math.abs(b[1] - end[1])));
            const cell = candidates.find(([x, y]) => {
                const o = { ...carried, x, y, status: 'placed' };
                return placementOk({ objects, nori: { x: end[0], y: end[1] } }, o, cellsOf(o)).ok;
            });
            objects = objects.map(o => o.id === carried.id ? {
                ...o, x: cell?.[0] ?? o.x, y: cell?.[1] ?? o.y,
                status: cell ? 'placed' : 'stored'
            } : o);
            event('object_moved', s.end_at, { target: carried.id, reason: 'interrupted_carry_auto_drop' });
        }
    }
    else {
        if (['carry', 'drop'].includes(s.primitive) || s.effects.some(e => ['move_object', 'set_state'].includes(e.e))) {
            objects = applyEffects(objects, [s], s.end_at);
        }
        // Room-cap storage is a fact already committed at arrival. Its carry animation cannot reintroduce the gift.
        if (s.source === 'storage:carry')
            objects = objects.map(o => o.id === s.target ? { ...o, status: 'stored' } : o);
        const object = objects.find(o => o.id === s.target);
        if (s.primitive === 'climb' && (s.z_from != null || s.z > 0)) {
            const type = (s.z_to ?? s.z) < (s.z_from ?? 0) ? 'climbed_down' : s.part === 'front' ? 'climbed_mid' : 'climbed';
            event(type, s.end_at, { target: s.target, part: s.part });
        }
        if (s.primitive === 'hold_pose' && s.action === 'look_out')
            event('looked_out', s.end_at, { target: s.target });
        for (const e of s.effects) {
            if (e.e === 'physics_rejected')
                event('physics_rejected', s.end_at, { reason: e.reason });
            if (e.e === 'move_object' && e.keyframes && (e.dx || e.dy))
                event('pushed', s.end_at, { target: s.target });
            if (e.e === 'move_object' && (e.dx || e.dy))
                event('object_moved', s.end_at, {
                    target: s.target
                });
            if (e.e === 'set_state')
                event('object_state_changed', s.end_at, {
                    target: s.target, state: e.state
                });
        }
        if (s.action === 'sleep') {
            const hours = (s.end_at - s.start_at) / 3600000;
            state.nori.security = clamp(state.nori.security + 0.05);
            event('slept', s.end_at, { target: s.target });
            if (hours >= 1 / 3 && object) {
                for (const k of Object.keys(object.card.sensations))
                    preference(state, k as Sensation, RULES.prefRate, s.end_at);
                state.familiarity[object.id] = clamp((state.familiarity[object.id] || 0) + 0.05);
            }
        }
        if (s.action === 'search_missing' && s.primitive === 'hold_pose')
            event('searched_missing', s.end_at, {
                target: s.target
            });
        if (s.action === 'hide_in' && s.primitive === 'hold_pose') {
            preference(state, 'shelter', RULES.prefRate, s.end_at);
            state.nori.security = clamp(state.nori.security + 0.1);
            event('hid', s.end_at, { target: s.target });
        }
        if (s.completion?.last && object && s.interaction && !s.completion.segment_ids.some(id => state.interrupted_ids?.includes(id))
            && s.completion.segment_ids.every(id => id === s.id || state.settled_ids?.includes(id))) {
            const c = s.completion, a = assess(c.input, object.id, c.sensations, s.interaction, s.id),
              pref_deltas: Sensations = {}, wariness_deltas: Sensations = {};
            for (const [k, w] of Object.entries(c.sensations)) {
                const key = k as Sensation;
                pref_deltas[key] = preference(state, key, RULES.prefRate * w! * Math.tanh(2 * a.appraisal), s.end_at);
                const old = state.wariness[key];
                state.wariness[key] = clamp(old + 0.15 * a.startle);
                wariness_deltas[key] = state.wariness[key] - old;
            }
            const old = state.familiarity[object.id] || 0;
            state.familiarity[object.id] = clamp(old + 0.1);
            state.novelty[object.id] = (state.novelty[object.id] ?? 1) * 0.5;
            const h = state.habits[s.interaction] ?? {
                n: 0, good: 0, last_at: 0
            };
            state.habits[s.interaction] = {
                n: h.n + 1, good: h.good + (a.appraisal > 0 ? 1 : 0), last_at: s.end_at
            };
            if (object.id === 'env:sun') {
                const begin = c.start_at;
                let covered = 0;
                for (let i = 0; i < 9; i++)
                    if (sunCovers(begin + (c.end_at - begin) * (i + 0.5) / 9, c.cell, weather))
                        covered++;
                if (covered >= 5)
                    preference(state, 'warm', RULES.prefRate, s.end_at);
            }
            experiences.push({
                id: `exp:${s.interaction}:${s.id}`, at: s.end_at, object_id: object.id,
                interaction_id: s.interaction, segment_ids: c.segment_ids,
                sensations: c.sensations, ...a, pref_deltas, wariness_deltas, familiarity_delta: state.familiarity[object.id] - old,
                world_version: s.world_version
            });
            event('experience_settled', s.end_at, {
                experience: experiences[0].id, target: s.target
            });
            event('interaction_done', s.end_at, { target: s.target });
        }
    }
    state.settled_ids = [...(state.settled_ids || []).slice(-127), s.id];
    s.settled_at = now;
    return result();
}
// A1b persists this complete result in the same CAS batch as the new plan.
export function settleEnded(input: WorldState, segments: Segment[], inputObjects: CamObject[], now: number, weather?: Weather) {
    let state = input, objects = inputObjects;
    const settled: Segment[] = [], experiences: Experience[] = [], events: CamEvent[] = [];
    for (const segment of segments) {
        if (segment.end_at > now)
            break;
        // Reconcile a persisted row already covered by authoritative state, without replaying its effects.
        if (segment.settled_at != null || segment.superseded_at != null)
            continue;
        if (segment.end_at <= state.settled_through || state.settled_ids?.includes(segment.id)) {
            settled.push({ ...segment, settled_at: now });
            continue;
        }
        const result = settle(state, segment, objects, now, weather);
        if (result.error)
            return {
                state: input, objects: inputObjects, segments: [] as Segment[], experiences: [] as Experience[],
                events: [] as CamEvent[], error: result.error
            };
        state = result.state;
        objects = result.objects;
        settled.push(result.segment);
        experiences.push(...result.experiences);
        events.push(...result.events);
    }
    return { state, objects, segments: settled, experiences, events, error: undefined };
}
