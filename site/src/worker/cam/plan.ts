import { accessObject, climbRoute, descent, heightSegment, levels } from './heights.ts';
import { simulatePush } from './physics.ts';
import { hash } from './rng.ts';
import { intentBonus, intentTemplates, matchesIntent } from './intent-plan.ts';
import type { ActiveIntent } from './spark-validate.ts';
import { bfsPath, operationCells, EXECUTOR, sunPatchAt, sunCovers, cellsOf, walkable } from '../../../public/cam-shared.js';
import { choose, utility, assess, londonHour, RULES } from './engine.ts';
import manifest from '../../../public/cam/manifest.json' with { type: 'json' };
import { random } from './rng.ts';
import { validate, hazardsActiveInState } from './validate.ts';
import { gateSegments } from './segment-gate.ts';
import type { GateResult } from './segment-gate.ts';
import { weatherEffects, type WeatherCondition } from './weather.ts';
import { settle, settleEnded } from './settle.ts';
import type { WorldState, CamObject, Interaction, Segment, Cell, Weather, Effect } from './types.ts';
// Canonical renderer mapping with explicit substitutes for unshipped art.
export function renderPose(pose: string): string {
    const canonical = pose.replaceAll('-', '_');
    if (canonical in manifest)
        return canonical;
    if (['sleep_bed', 'sleep_pillow', 'belly_up', 'box', 'in_box'].includes(canonical))
        return 'sleepy';
    if (['sneak', 'dash'].includes(canonical))
        return 'walk';
    if (['back', 'peek', 'ponder', 'question', 'laptop', 'browse', 'watching'].includes(canonical))
        return 'look_up';
    return 'sit';
}
export interface PlanInput {
    state: WorldState;
    unsettled?: Segment[];
    objects: CamObject[];
    interactions: Interaction[];
    start_at: number;
    world_version: number;
    position: Cell;
    preferred_gift?: string;
    weather?: Weather;
    intents?: ActiveIntent[];
    intent?: {
        expires_at: number;
        action: string;
        bonus: number;
    };
    reaction?: {
        event_id: string;
        pose: string;
    };
    brain?: {
        browse_used: number;
        wonder_used: boolean;
        pending: boolean;
    };
}
export interface ScoredCandidate {
    ix: Interaction;
    object: CamObject;
    score: number;
}
export function choiceProbabilities(scores: number[]): number[] {
    if (!scores.length)
        return [];
    const max = Math.max(...scores), weights = scores.map(v => Math.exp((v - max) / RULES.temperature)),
      sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / sum);
}
export function candidateScores(input: PlanInput, startAt = input.start_at): ScoredCandidate[] {
    const { state } = input, objects = input.objects.map(o => ({
        ...o
    }));
    const climate = weatherEffects({
        condition: (input.weather?.condition || 'clear') as WeatherCondition,
        cloud_pct: input.weather?.condition === 'overcast' ? 100 : input.weather?.cloud_pct, precip_mm: input.weather?.precip_mm
    });
    const sun = objects.find(o => o.id === 'env:sun'), patch = climate.sunPatchAllowed ? sunPatchAt(startAt, input.weather) : null;
    if (sun && patch) {
        sun.x = Math.ceil(patch.x + 1);
        sun.y = 4;
    }
    const intents = (input.intents || []).filter(i => i.expires_at > startAt);
    const interactions = [
        ...input.interactions, ...intentTemplates(intents, objects, input.interactions, startAt)
    ].map(ix => {
        const o = objects.find(o => o.id === ix.object_id);
        if (!o || !levels(o).length || ix.spec.steps.some(s => s.p === 'climb'))
            return ix;
        const steps = structuredClone(ix.spec.steps);
        const approach = steps.findIndex(s => s.p === 'move_to');
        if (approach >= 0)
            steps.splice(approach + 1, 0, { p: 'climb', part: 'top' });
        return { ...ix, spec: { ...ix.spec, steps } };
    });
    return interactions.flatMap(ix => {
        if (ix.id.startsWith('template:') &&
            !intents.some(i => ix.id === `template:${i.id}` || (i.action === 'try_interaction' && i.interaction_id === ix.id)))
            return [];
        let object = objects.find(o => o.id === ix.object_id);
        if (object && ix.action === 'search_missing') {
            const missing = state.missing.find(m => m.object_id === object!.id);
            if (!missing)
                return [];
            object = { ...object, x: missing.x, y: missing.y, status: 'placed', blocks: false };
        }
        if (!object)
            return [];
        const destination = ix.spec.steps.find(s => s.p === 'drop')?.at;
        if (ix.spec.steps.some(s => s.p === 'carry') && destination && object.x === destination[0] && object.y === destination[1])
            return [];
        if (object.status !== 'placed')
            return [];
        if (object.id === 'env:sun' && !patch)
            return [];
        if (ix.action === 'use_computer' && (state.nori.asleep || state.nori.curiosity < 0.6 ||
            (input.brain?.browse_used ?? 0) >= 2 || input.brain?.pending))
            return [];
        const last = state.habits[ix.id]?.last_at;
        if (!ix.spec.steps.some(s => s.p === 'sleep') && last != null && startAt - last < ix.spec.cooldown_min * 60000)
            return [];
        const distance = Math.abs(object.x - input.position[0]) + Math.abs(object.y - input.position[1]);
        const bonus = input.intent && input.intent.expires_at > startAt && input.intent.action === ix.action
            ? input.intent.bonus : intentBonus(intents, ix, startAt);
        return [
            {
                ix, object, score: utility(state, object, ix, startAt, distance, bonus) +
                    climate.cozyBoost * (ix.spec.sensations.shelter || 0) +
                    explorationBonus(state, ix, startAt) +
                    (levels(object).length ? state.prefs.height * 0.3 + state.prefs.view_far * 0.2 +
                        (ix.spec.steps.some(s => s.p === 'sleep') && (londonHour(startAt) < 7 ||
                            londonHour(startAt) >= 13 && londonHour(startAt) < 16) ? 0.4 : 0) : 0)
            }
        ];
    });
}
function planNextRaw(input: PlanInput): Segment[] {
    const { state, start_at, world_version } = input, objects = input.objects.map(o => ({
        ...o
    })), world = {
        objects, nori: { x: input.position[0], y: input.position[1] }
    };
    let z = state.nori.z || 0;
    let initialPosition: Cell = [...input.position];
    const down = descent(objects, initialPosition, z);
    if (down.length)
        initialPosition = down.at(-1)!.cell;
    const containing = objects.find(o => o.blocks && cellsOf(o).some(c => c[0] === initialPosition[0] && c[1] === initialPosition[1]));
    const exit = !down.length && containing && (containing.tags.includes('enclosed') ||
        containing.tags.includes('high_place')) ? operationCells(containing, undefined, world)[0] : undefined;
    if (exit)
        initialPosition = exit;
    world.nori = { x: initialPosition[0], y: initialPosition[1] };
    const climate = weatherEffects({
        condition: (input.weather?.condition || 'clear') as WeatherCondition,
        cloud_pct: input.weather?.condition === 'overcast' ? 100 : input.weather?.cloud_pct, precip_mm: input.weather?.precip_mm
    });
    const sun = objects.find(o => o.id === 'env:sun'), patch = climate.sunPatchAllowed ? sunPatchAt(start_at, input.weather) : null;
    if (sun && patch) {
        sun.x = Math.ceil(patch.x + 1);
        sun.y = 4;
    }
    const intents = (input.intents || []).filter(i => i.expires_at > start_at);
    const candidates = candidateScores(input, start_at);
    // Rest competes while object interactions are available.
    const preferred = candidates.filter(c => c.object.id === input.preferred_gift &&
        validate(world, c.object, c.ix.spec, initialPosition).spec);
    if (preferred.length) candidates.splice(0, candidates.length, ...preferred);
    const restChosen = candidates.length > 0 && !preferred.length && !(input.intent && input.intent.expires_at > start_at) && !input.reaction &&
        choose([...candidates.map(c => c.score), 1.3], world_version, start_at) === candidates.length;
    if (restChosen)
        candidates.length = 0;
    let chosen: typeof candidates[number] | undefined;
    while (candidates.length) {
        const index = choose(candidates.map(c => c.score), world_version, start_at), candidate = candidates[index],
          v = validate(world, candidate.object, candidate.ix.spec, initialPosition);
        if (v.spec) {
            chosen = {
                ...candidate, ix: {
                    ...candidate.ix, spec: v.spec
                }
            };
            break;
        }
        candidates.splice(index, 1);
    }
    let objectPosition: Cell = chosen ? [chosen.object.x, chosen.object.y] : [0, 0];
    let at = start_at, position: Cell = [...input.position], facing = 1;
    const segments: Segment[] = [];
    // CAS increments world_version per replan. Reserve 999 for the final assessment
    // (the schema allows at most eight steps across an 80-cell room).
    const baseId = Math.max(world_version * 1000000000, ...(state.settled_ids || []).map(id => id + 1));
    const add = (primitive: string, pose: string, ms: number, path: Cell[] = [position], effects: Effect[] = [],
      action = chosen?.ix.action || 'interact', part: string | null = null) => {
        const cap = EXECUTOR[primitive];
        ms = Math.max(cap.min_ms, Math.min(cap.max_ms, ms));
        if (ms === 0)
            return;
        pose = renderPose(pose);
        effects = effects.filter(e => e.e !== 'move_object' || !!e.dx || !!e.dy || !!e.keyframes);
        const last = path.at(-1)!, first = path[0], dx = (last[0] - first[0]) - (last[1] - first[1]);
        if (dx)
            facing = dx > 0 ? 1 : -1;
        segments.push({
            id: baseId + segments.length, start_at: at, end_at: at + ms, action, primitive, pose, facing,
            path: path.map(c => [...c]), z, target: chosen?.object.id || null, part,
            carrying: primitive === 'carry' ? chosen?.object.id || null : null, interaction: chosen?.ix.id || null,
            effects, source: chosen ? 'interaction:' + chosen.ix.id : 'routine', world_version, cut_at: null,
            settled_at: null, superseded_at: null, trigger: null
        });
        at += ms;
        position = [...last];
    };
    const climb = (cell: Cell, to: number, target: string, part: string) => {
        add('climb', 'jump', 600, [position, cell], [], 'sit_on', part);
        const s = segments.at(-1)!;
        Object.assign(s, heightSegment(s, z, to), { target });
        z = to;
    };
    if (input.reaction) {
        add('hold_pose', input.reaction.pose, 1200, undefined, [], 'startled');
        segments[0].source = 'reaction:' + input.reaction.event_id;
        segments[0].interaction = null;
        return segments;
    }
    for (const leg of down)
        climb(leg.cell, leg.z, leg.target, leg.part);
    if (containing && !exit && !down.length) {
        // D1fix4 (P1-b, req 3): walkable() already excludes hazard-active cells;
        // route out with BFS instead of stepping straight onto the nearest cell.
        const at: Cell = [Math.round(position[0]), Math.round(position[1])];
        const safe = new Set(walkable(world).map(([x, y]) => `${x},${y}`));
        const dest = walkable(world).sort((a, b) => (Math.abs(a[0] - at[0]) + Math.abs(a[1] - at[1])) -
            (Math.abs(b[0] - at[0]) + Math.abs(b[1] - at[1])))[0];
        let route = dest ? bfsPath(world, at, dest) : null;
        if (!route && dest) {
            // Already standing on an unsafe cell: step out first, then route.
            const step = [[at[0] - 1, at[1]], [at[0] + 1, at[1]], [at[0], at[1] - 1], [at[0], at[1] + 1]]
                .find(([x, y]) => safe.has(`${x},${y}`));
            const rest = step ? bfsPath(world, step as Cell, dest) : null;
            route = step && rest ? [at, ...rest] : null;
        }
        if (route && route.length > 1)
            for (let j = 1; j < route.length; j++)
                add('move_to', 'walk', 667, [route[j - 1], route[j]], [], 'recover');
        else
            add('wait', 'sit', 30000, undefined, [], 'idle_sit');
        return segments;
    }
    if (!input.intent && !intents.some(i => i.action === 'search')) {
        const missing = state.missing.filter(m => start_at >= m.since &&
            start_at - m.since < 72 * 3600000).find(m => random(world_version, start_at,
              m.object_id) < m.familiarity * (1 - (start_at - m.since) / (72 * 3600000)) * 0.15);
        if (missing) {
            const path = bfsPath(world, initialPosition, [missing.x, missing.y]);
            if (path) {
                if (exit)
                    add('climb', 'jump', 600, [position, exit], [], 'walk');
                for (let j = 1; j < path.length; j++)
                    add('move_to', 'sneak', 1000, [path[j - 1], path[j]], [], 'search_missing');
                add('hold_pose', 'ponder', 3000, undefined, [], 'search_missing');
                for (const s of segments) {
                    s.target = missing.object_id;
                    s.interaction = null;
                    s.source = 'routine';
                }
                return segments;
            }
        }
    }
    if (exit) {
        add('climb', 'jump', 600, [position, exit], [], 'walk');
        const s = segments.at(-1)!;
        s.target = containing!.id;
        s.interaction = null;
        s.source = 'routine';
    }
    if (!chosen) {
        add('hold_pose', 'alert-loaf', 300000, undefined, [], 'idle_sit');
        return segments;
    }
    const selectedIntent = intents.find(i => i.action !== 'ignore' && matchesIntent(i, chosen!.ix));
    const lastId = baseId + 999, assessment = assess(state, chosen.object.id, chosen.ix.spec.sensations, chosen.ix.id, lastId);
    const retreat = (count: number) => {
        for (const leg of descent(objects, position, z))
            climb(leg.cell, leg.z, leg.target, leg.part);
        for (let i = 0; i < count; i++) {
            const moves: Cell[] = [
                [position[0] - 1, position[1]], [position[0] + 1, position[1]], [position[0], position[1] - 1],
                [position[0], position[1] + 1]
            ];
            const dest = moves.filter(c => bfsPath(world, position, c)?.length === 2).sort((a, b) => (Math.abs(b[0] -
                chosen.object.x) + Math.abs(b[1] - chosen.object.y)) - (Math.abs(a[0] - chosen.object.x) + Math.abs(a[1] -
                chosen.object.y)))[0];
            if (dest)
                add('move_to', 'dash', 334, [position, dest], [], 'react');
        }
    };
    let contactReacted = false;
    // F3: the object's state as planner-added movement sees it, tracking the
    // same set_object_state transitions validate() checks per step.
    let effectState = chosen.object.state;
    const wary = Object.keys(chosen.ix.spec.sensations).some(s => state.wariness[s as keyof typeof state.wariness] > 0.1);
    for (const step of chosen.ix.spec.steps) {
        if (step.p === 'move_to') {
            // D1fix4 (P2): route on the state at this step, not the entry state:
            // an earlier set_object_state may have armed a hazard to walk around.
            const simChosen = { ...chosen.object, state: effectState };
            const pathWorld = { ...world, objects: objects.map(o => o.id === simChosen.id ? simChosen : o) };
            const paths = operationCells(accessObject(simChosen, objects) || simChosen, step.approach || step.part,
              pathWorld).map(c => bfsPath(pathWorld, position, c)).filter((p): p is Cell[] => !!p).sort((a, b) => a.length - b.length);
            const path = paths[0];
            if (!path)
                continue;
            const gait = wary ? 'sneak' : step.gait || 'walk', speed = EXECUTOR.move_to.speeds![gait];
            for (let i = 1; i < path.length; i++)
                add('move_to', gait, Math.ceil(1000 / speed), [path[i - 1], path[i]], [], 'walk', step.part || null);
            if (step.part === 'inside' && chosen.object.tags.includes('enclosed') && chosen.object.origin?.type === 'prefab')
                add('climb', 'jump', 600, [position, [chosen.object.x, chosen.object.y]], [], 'hide_in', 'inside');
            if (wary)
                add('wait', 'alert-loaf', 2000 + Math.floor(random(world_version, at) * 2000));
        }
        else if (step.p === 'carry') {
            const path = step.at ? bfsPath(world, position, step.at) : [position];
            if (!path)
                continue;
            if (path.length === 1)
                add('carry', 'walk', 500, undefined, [], 'carry');
            for (let j = 1; j < path.length; j++) {
                const dx = path[j][0] - path[j - 1][0], dy = path[j][1] - path[j - 1][1];
                add('carry', 'walk', 667, [path[j - 1], path[j]], [{
                        e: 'move_object', dx, dy
                    }], 'carry');
                objectPosition = [objectPosition[0] + dx, objectPosition[1] + dy];
            }
        }
        else if (step.p === 'climb') {
            const chain = climbRoute(chosen.object, objects);
            for (const leg of chain)
                climb([leg.object.x, leg.object.y], leg.level.z, leg.object.id, leg.level.part);
            if (!chain.length)
                climb([chosen.object.x, chosen.object.y], 0, chosen.object.id, 'top');
        }
        else if (step.p === 'face') {
            const dx = (chosen.object.x - position[0]) - (chosen.object.y - position[1]);
            if (dx)
                facing = dx > 0 ? 1 : -1;
        }
        else if (step.p === 'set_object_state') {
            if (step.state && chosen.object.card.states.includes(step.state)) effectState = step.state;
            // Zero-duration operations fold into the preceding segment; they never create timeline gaps.
            const e: Effect = {
                e: 'set_state', state: step.state, sprite: chosen.object.state_sprites?.[step.state!]
            };
            const cm = chosen.object.card.space.state_cm[step.state!];
            if (cm) {
                const w = Math.max(1, Math.round(cm.w / 40)), h = Math.max(1, Math.round(cm.d / 40));
                e.footprint = Array.from({
                    length: w * h
                }, (_, i) => [i % w, Math.floor(i / w)]);
            }
            if (!segments.length)
                add('wait', 'sit', 500);
            segments.at(-1)!.effects.push(e);
        }
        else {
            const cap = EXECUTOR[step.p], ms = step.ms ?? (step.p === 'sleep' ? 1200000 +
                Math.floor(random(world_version, at) * 4200000) : Math.max(1000, cap.min_ms));
            let effects = structuredClone(step.effects || []);
            if (step.p === 'push' && step.dir && !effects.some(e => e.e === 'move_object'))
                effects.push({
                    e: 'move_object', dx: step.dir[0], dy: step.dir[1]
                });
            if (step.p === 'drop' && step.at && !effects.some(e => e.e === 'move_object'))
                effects.push({
                    e: 'move_object', dx: step.at[0] - objectPosition[0], dy: step.at[1] - objectPosition[1]
                });
            // Cron checks every five minutes; a one-minute computer pose can finish between both ticks.
            const duration = chosen.ix.action === 'use_computer' && step.p === 'hold_pose'
                ? Math.min(25 * 60000, Math.max(ms, 10 * 60000)) : ms;
            // F3: the planner never moves an object with a hazard active in its
            // current state. An explicit push there would be rejected by
            // validate() (push is whole-object contact under F4), so
            // planner-added move_object effects are skipped the same way.
            const hazardBlocksPush = hazardsActiveInState(chosen.object.card, effectState);
            const pushing = chosen.object.card.space.movable.push && !hazardBlocksPush &&
                (step.p === 'push' || chosen.ix.action === 'play' && ['touch', 'hold_pose'].includes(step.p));
            let physicsDuration = duration;
            if (pushing) {
                effects = effects.filter(e => e.e !== 'move_object');
                try {
                    const h = hash(baseId + segments.length);
                    const dirs: Cell[] = step.p === 'push' && step.dir ? [step.dir] : [[1, 0], [0, 1], [-1, 0], [0, -1]];
                    let result: ReturnType<typeof simulatePush> | undefined;
                    for (let i = 0; i < dirs.length; i++) {
                        const dir = dirs[(h + i) % dirs.length];
                        result = simulatePush({
                            object: chosen.object, world: { objects, nori: { x: position[0], y: position[1] } },
                            velocity: [dir[0] * (8 + h % 8), dir[1] * (8 + h % 8)]
                        });
                        if (result.effect.dx || result.effect.dy)
                            break;
                    }
                    if (!result)
                        throw new Error('no trajectory');
                    effects.push({
                        ...result.effect, at_ms: at + (result.effect.at_ms || 0),
                        keyframes: result.keyframes.map(f => ({ ...f, at_ms: at + f.at_ms }))
                    });
                    physicsDuration = Math.max(duration, result.effect.at_ms || 0);
                    if (!result.effect.dx && !result.effect.dy)
                        effects.push({ e: 'physics_rejected', reason: 'blocked' });
                }
                catch {
                    effects.push({ e: 'physics_rejected', reason: 'illegal_input_or_placement' });
                }
            }
            add(step.p, step.pose || cap.poses[0] || 'sit', physicsDuration, undefined, effects,
              step.p === 'sleep' ? 'sleep' : chosen.ix.action || 'interact', step.part || null);
        }
        if (!contactReacted && ['touch', 'push', 'carry', 'drop', 'climb', 'hold_pose', 'sleep'].includes(step.p)) {
            contactReacted = true;
            if (assessment.startle > 0.15)
                add('hold_pose', 'startled', 1200, undefined, [], 'startled');
            if (assessment.startle > 0.35) {
                retreat(1);
                add('hold_pose', 'look-up', 1500, undefined, [], 'react');
            }
        }
    }
    if (!segments.length)
        add('wait', 'sit', 500);
    if (chosen.object.id === 'env:sun' && (!sunCovers(start_at, position, input.weather) || !sunCovers(at, position, input.weather))) {
        return [
            {
                ...segments[0], end_at: start_at + 30000, action: 'idle_sit', primitive: 'wait', pose: 'sit',
                path: [input.position], target: null, interaction: null, effects: []
            }
        ];
    }
    const reactionStart = segments.length;
    if (assessment.appraisal < -0.4)
        retreat(2);
    add('hold_pose', assessment.reaction, 1500, undefined, [], 'react');
    // Assessment seed uses the final id, shared verbatim by settlement.
    const last = segments.at(-1)!;
    last.id = lastId;
    const longestSleep = segments.filter(s => s.primitive === 'sleep').sort((a, b) => (b.end_at - b.start_at) - (a.end_at - a.start_at))[0];
    if (longestSleep && longestSleep.end_at - longestSleep.start_at >= 30 * 60000)
        longestSleep.trigger = {
            kind: 'reflect'
        };
    const finalAssessment = assess(state, chosen.object.id, chosen.ix.spec.sensations, chosen.ix.id, last.id);
    last.completion = {
        last: true, segment_ids: segments.map(s => s.id), sensations: chosen.ix.spec.sensations, input: {
            ...state, nori: { ...state.nori }, prefs: { ...state.prefs },
            familiarity: { ...state.familiarity }, novelty: { ...state.novelty }
        }, assessment: finalAssessment, cell: segments[Math.max(0, reactionStart - 1)].path.at(-1)!,
        start_at: segments.find(s => s.primitive === 'sleep' || s.primitive === 'hold_pose')?.start_at ?? start_at,
        end_at: segments[Math.max(0, reactionStart - 1)].end_at
    };
    if (chosen.ix.action === 'use_computer')
        segments.find(s => s.primitive === 'hold_pose')!.trigger = {
            kind: 'browse'
        };
    if (selectedIntent)
        for (const s of segments)
            s.source = selectedIntent.id;
    return segments;
}
// D1fix4: every planNext caller gets gated segments; the raw planner stays
// available for diagnosis. Refusals ride on the replacement segment as a
// hazard_refused marker effect so DB writers can record them as events.
export function planNext(input: PlanInput): Segment[] {
    return gateSegments(planNextRaw(input), input.objects, input.position).segments;
}
export function planNextWithRefusals(input: PlanInput): GateResult {
    return gateSegments(planNextRaw(input), input.objects, input.position);
}
export interface PlanError {
    error: {
        code: 'settlement_gap';
        expected_at: number;
        actual_at: number;
    };
}
export function plan(input: PlanInput, until: number): Segment[] | PlanError {
    const all: Segment[] = [];
    let state = structuredClone(input.state), objects = structuredClone(input.objects), position = input.position, start = input.start_at;
    // Ended, unsettled segments come from the caller's CAS snapshot in timeline order.
    const backlog = settleEnded(state, input.unsettled || [], objects, start, input.weather);
    if (backlog.error)
        return { error: backlog.error };
    state = backlog.state;
    objects = backlog.objects;
    if (state.settled_through !== start)
        return {
            error: { code: 'settlement_gap', expected_at: state.settled_through, actual_at: start }
        };
    while (start < until) {
        const next = planNext({
            ...input, state, objects, position, start_at: start, reaction: all.length ? undefined : input.reaction
        });
        for (const seg of next) {
            const r = settle(state, seg, objects, seg.end_at, input.weather);
            if (r.error)
                return { error: r.error };
            state = r.state;
            objects = r.objects;
        }
        all.push(...next);
        const last = next.at(-1)!;
        position = last.path.at(-1)!;
        start = last.end_at;
    }
    return all;
}
// A temporary exploration nudge; preferences and learned habits remain settlement-owned.
export function explorationBonus(state: WorldState, ix: Interaction, now: number) {
    const hint = state.exploration;
    return hint && hint.expires_at > now && (ix.spec.sensations[hint.sensation] || 0) > 0 ? 0.1 : 0;
}
