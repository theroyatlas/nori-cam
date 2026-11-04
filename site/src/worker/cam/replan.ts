import { descent, heightSegment } from './heights.ts';
import { templateEvidence } from './evidence.ts';
import { drawingSequence, canDrawingSequence } from './drawing-plan.ts';
import { poseAt, bfsPath, operationCells, hazardActiveInState } from '../../../public/cam-shared.js';
import { gateSegments } from './segment-gate.ts';
import { wakeResponse } from './engine.ts';
import { snapshot, claimWorld, insertSegment, insertEvent } from './store.ts';
import { safeSegment } from './timeline.ts';
import { planNext } from './plan.ts';
import { settle } from './settle.ts';
import { writerGuard } from './facts.ts';
import type { Cell, Segment } from './types.ts';
function cutPath(s: Segment, cut: number): Cell[] {
    const pose = poseAt([s], cut)!;
    const lengths = s.path.slice(1).map((c, i) => Math.hypot(c[0] - s.path[i][0], c[1] - s.path[i][1]));
    let remaining = lengths.reduce((a, b) => a + b, 0) * (cut - s.start_at) / (s.end_at - s.start_at);
    const path: Cell[] = [s.path[0]];
    for (let i = 0; i < lengths.length && remaining >= lengths[i]; i++) {
        path.push(s.path[i + 1]);
        remaining -= lengths[i];
    }
    path.push([pose.x, pose.y]);
    return path;
}
export async function replan(db: D1Database, now: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const snap = await snapshot(db, now);
        const pending = await db.prepare(`SELECT id,type,payload,at,world_version FROM events e WHERE handled_version IS NULL
      AND NOT EXISTS (SELECT 1 FROM events d WHERE d.id='sleep-defer:' || e.id || ':' || ?)
      ORDER BY at,id LIMIT 30`).bind(snap.world.version)
            .all<{
            id: string;
            type: string;
            payload: string;
            at: number;
            world_version: number;
        }>();
        if (!pending.results.length)
            return false;
        const event = pending.results.find(e => e.type === 'browse_result') ||
            pending.results.find(e => e.type === 'gift_unwrapped') ||
            pending.results.find(e => e.type === 'gift_arrived') || pending.results[0];
        let cut = now + 1500;
        const drawing = pending.results.find(e => e.type === 'browse_result');
        if (drawing) {
            const active = snap.segments.find(s => s.start_at <= now && s.end_at > now);
            if (active)
                cut = Math.max(cut, active.end_at);
        }
        const carry = snap.segments.find(s => s.start_at <= cut && s.end_at > cut && ['carry', 'climb'].includes(s.primitive));
        if (carry)
            cut = carry.end_at;
        let projection = structuredClone(snap.state);
        let geometry = snap.objects;
        const retained = snap.segments.filter(s => s.start_at < cut).map(s => {
            if (s.end_at <= cut)
                return s;
            return { ...s, end_at: cut, cut_at: cut, path: cutPath(s, cut),
                trigger: s.primitive === 'sleep' && s.trigger?.kind === 'reflect'
                    ? { ...s.trigger, planned_end_at: s.trigger.planned_end_at ?? s.end_at } : s.trigger };
        });
        for (const s of retained) {
            const result = settle(projection, s, geometry, cut);
            if (result.error)
                throw new Error('replan_settlement_gap');
            projection = result.state;
            geometry = result.objects;
        }
        if (event.type === 'spark_result' && projection.nori.asleep) {
            const token = crypto.randomUUID();
            const version = snap.world.version + 1;
            const results = await db.batch([
                claimWorld(db, snap.world, token, snap.state, snap.world.timeline_until, now),
                db.prepare(`UPDATE events SET handled_version=? WHERE id=? AND handled_version IS NULL AND ${writerGuard}`)
                    .bind(version, event.id, token),
            ]);
            if (results[0].meta.changes)
                return true;
            continue;
        }
        // One deterministic roll per event, even if multiple reads retry while she remains asleep.
        if (!wakeResponse(projection, event.id, event.at, event.world_version)) {
            await db.batch([
                insertEvent(db, {
                    id: `sleep-defer:${event.id}:${snap.world.version}`, at: now,
                    type: 'sleep_deferred', actor: 'system', payload: {}
                }, snap.world.version, snap.world.writer, undefined, 0)
            ]);
            return false;
        }
        const token = crypto.randomUUID();
        const version = snap.world.version + 1;
        let id = Math.max(version * 1000000000, (snap.last?.id ?? 0) + 1);
        const pose = poseAt(retained, cut) || poseAt(snap.last ? [snap.last] : [], cut) || { x: 2, y: 6 };
        let position: Cell = [pose.x, pose.y];
        const gateStart: Cell = [...position];
        const gateObjects = geometry;
        // A moving segment may be interrupted between cells. Preserve its exact position in the transition.
        const floorSegments: Segment[] = [];
        let floorAt = cut;
        let height = projection.nori.z || 0;
        if (projection.settled_through < cut) {
            const bridge = safeSegment(projection.settled_through, cut, id++, version, position, `reaction:${event.id}`);
            bridge.z = height;
            floorSegments.push(bridge);
        }
        for (const leg of descent(geometry, position, height)) {
            let down = safeSegment(floorAt, floorAt + 600, id++, version, position, `reaction:${event.id}`);
            down = heightSegment({
                ...down, primitive: 'climb', pose: 'jump', target: leg.target, part: leg.part,
                path: [position, leg.cell]
            }, height, leg.z);
            floorSegments.push(down);
            floorAt = down.end_at;
            position = leg.cell;
            height = leg.z;
        }
        const transition = safeSegment(floorAt, floorAt + 1000, id++, version, position, `reaction:${event.id}`);
        const rounded: Cell = [Math.round(position[0]), Math.round(position[1])];
        transition.path = [position, rounded];
        position = rounded;
        const segments: Segment[] = [...floorSegments, transition];
        const refusalNotes: { object_id: string; reason: string }[] = [];
        const payload = JSON.parse(event.payload) as {
            object_id?: string;
            stored_id?: string;
        };
        const object = geometry.find(o => o.id === payload.object_id && o.status === 'placed');
        const world = { objects: geometry };
        const missing = snap.state.missing.find(m => m.object_id === payload.object_id);
        const destinations: Cell[] = object ? operationCells(object, undefined, world) : missing ? [[missing.x, missing.y]] : [];
        let at = transition.end_at;
        const stored = geometry.find(o => o.id === payload.stored_id && o.status === 'stored');
        // D1fix4 (P1-c): never carry an object with an active hazard back into the
        // room; the gift stays stored and the refusal is recorded with the writes.
        const storedHot = !!stored && hazardActiveInState(stored.card, stored.state);
        if (storedHot) refusalNotes.push({ object_id: stored!.id,
            reason: `storage carry refused: hazard active in state '${stored!.state}'` });
        if (stored && !storedHot) {
            const pickup = operationCells({ ...stored, status: 'placed' }, undefined, world)
                .map(c => bfsPath(world, position, c)).filter((p): p is Cell[] => !!p).sort((a, b) => a.length - b.length)[0];
            if (pickup) {
                const approach = safeSegment(at, at + Math.max(500, pickup.length * 500), id++, version, position, 'storage:approach');
                approach.path = pickup;
                approach.action = 'walk';
                approach.primitive = 'move_to';
                approach.pose = 'walk';
                segments.push(approach);
                position = pickup.at(-1)!;
                at = approach.end_at;
                const exit = bfsPath(world, position, [0, 7]);
                if (exit) {
                    const stow = safeSegment(at, at + Math.max(500, exit.length * 500), id++, version, position, 'storage:carry');
                    stow.path = exit;
                    stow.action = 'carry';
                    stow.primitive = 'carry';
                    stow.pose = 'walk';
                    stow.target = stored.id;
                    stow.carrying = stored.id;
                    segments.push(stow);
                    position = exit.at(-1)!;
                    at = stow.end_at;
                }
            }
        }
        const routes = destinations.map(c => bfsPath(world, position, c))
            .filter((p): p is Cell[] => !!p).sort((a, b) => a.length - b.length);
        if (routes[0] && !drawing) {
            const walk = safeSegment(at, at + Math.max(500, routes[0].length * 500), id++, version, position, `reaction:${event.id}`);
            walk.path = routes[0];
            walk.action = 'walk';
            walk.primitive = 'move_to';
            walk.pose = 'walk';
            walk.target = object?.id ?? null;
            if (missing)
                walk.action = 'search';
            segments.push(walk);
            position = routes[0].at(-1)!;
            at = walk.end_at;
        }
        const reaction = safeSegment(at, at + 1500, id++, version, position, `reaction:${event.id}`);
        reaction.pose = snap.state.nori.asleep ? 'startled' : 'look_up';
        reaction.target = object?.id ?? null;
        reaction.trigger = { kind: 'spark_reaction' };
        if (!drawing) {
            segments.push(reaction);
            at = reaction.end_at;
        }
        // Forecast only; authoritative settlement remains at the existing cursor.
        for (const segment of segments) {
            const result = settle(projection, segment, geometry, segment.end_at);
            if (result.error)
                throw new Error('reaction_settlement_gap');
            projection = result.state;
            geometry = result.objects;
        }
        if (drawing) {
            const sequencePos = position;
            if (!canDrawingSequence(geometry, sequencePos)) {
                const token = crypto.randomUUID();
                const version = snap.world.version + 1;
                const results = await db.batch([
                    claimWorld(db, snap.world, token, snap.state, snap.world.timeline_until, now),
                    insertEvent(db, {
                        id: `replan-skip:${drawing.id}:${version}`, at: now, type: 'safe_fallback', actor: 'system',
                        payload: { reason: 'drawing_route_unavailable', event_id: drawing.id },
                    }, version, token, undefined, 0),
                    db.prepare(`UPDATE events SET handled_version=? WHERE id=? AND handled_version IS NULL AND ${writerGuard}`)
                        .bind(version, drawing.id, token),
                ]);
                if (results[0].meta.changes) return true;
                continue;
            }
            const sequence = drawingSequence(geometry, position, at, id, version, `drawing:${drawing.id}`);
            segments.push(...sequence);
            for (const segment of sequence) {
                const result = settle(projection, segment, geometry, segment.end_at);
                if (result.error)
                    throw new Error('drawing_settlement_gap');
                projection = result.state;
                geometry = result.objects;
            }
            if (sequence.length) {
                at = sequence.at(-1)!.end_at;
                position = sequence.at(-1)!.path.at(-1)!;
            }
        }
        const next = planNext({
            state: projection, objects: geometry, interactions: snap.interactions,
            start_at: at, world_version: version, position, intents: snap.intents,
            preferred_gift: event.type === 'gift_unwrapped' ? object?.id : undefined
        });
        segments.push(...next.slice(0, Math.max(0, 30 - segments.length)));
        // Gate every committed segment against geometry at the start of the
        // new sequence; refusals become recorded conservative holds.
        {
            const gated = gateSegments(segments, gateObjects, gateStart);
            if (gated.segments !== segments) {
                // A gated result is a new array; the fast path returns the input
                // itself, which must not be cleared before spreading.
                segments.length = 0;
                segments.push(...gated.segments);
            }
        }
        const until = segments.at(-1)!.end_at;
        const writes: D1PreparedStatement[] = [
            claimWorld(db, snap.world, token, snap.state, until, now),
            db.prepare(`UPDATE segments SET superseded_at=? WHERE start_at>=? AND superseded_at IS NULL AND ${writerGuard}`)
                .bind(now, cut, token)
        ];
        for (const s of retained.filter(s => s.cut_at === cut)) {
            writes.push(db.prepare(`UPDATE segments SET end_at=?,cut_at=?,path=?,trigger=? WHERE id=? AND ${writerGuard}`)
                .bind(cut, cut, JSON.stringify(s.path), JSON.stringify(s.trigger), s.id, token));
        }
        writes.push(...templateEvidence(db, snap, segments, token));
        writes.push(...segments.map(s => insertSegment(db, s, token)));
        for (const s of segments)
            for (const e of s.effects || [])
                if (e.e === 'hazard_refused')
                    writes.push(insertEvent(db, { id: `hazard-refused:${s.id}:${version}`, at: s.start_at,
                        type: 'interaction_rejected', actor: 'system',
                        payload: { reason: e.reason, segment_id: s.id, target: s.target } }, version, token, undefined, 0));
        for (const note of refusalNotes)
            writes.push(insertEvent(db, { id: `storage-refused:${event.id}:${version}`, at: now,
                type: 'interaction_rejected', actor: 'system',
                payload: { object_id: note.object_id, reason: note.reason } }, version, token, undefined, 0));
        for (const e of pending.results) {
            writes.push(db.prepare(`UPDATE events SET handled_version=? WHERE id=? AND handled_version IS NULL AND ${writerGuard}`)
                .bind(version, e.id, token));
        }
        const results = await db.batch(writes);
        if (results[0].meta.changes)
            return true;
    }
    throw new Error('cam_cas_busy');
}
// Facts are authoritative once committed. A planner outage must not undo them.
export async function bestEffortReplan(db: D1Database, now: number): Promise<void> {
    try {
        await replan(db, now);
    }
    catch (error) {
        console.error('cam_replan_failed', error instanceof Error ? error.name : 'UnknownError',
          error instanceof Error ? error.message : 'unknown error');
    }
}
