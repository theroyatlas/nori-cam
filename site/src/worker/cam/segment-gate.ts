// Final gate for every committed segment. Check path continuity, current
// hazards, and each effect in order. Refusals truncate the dependent tail
// into a recorded conservative hold, without creating movement.
import { cellsOf, hazardActiveInState } from '../../../public/cam-shared.js';
import { CONTACT_PRIMITIVES, WHOLE_OBJECT_CONTACT } from './validate.ts';
import type { CamObject, Cell, Segment } from './types.ts';

export interface GateRefusal {
    index: number;
    primitive: string;
    target: string | null;
    part: string | null;
    reason: string;
}

export interface GateResult {
    segments: Segment[];
    refusals: GateRefusal[];
}

const key = (x: number, y: number) => `${x},${y}`;
const roundCell = (c: Cell): Cell => [Math.round(c[0]), Math.round(c[1])];

// Mirror of validate(): touch and set_object_state on a declared part the
// hazard list does not cover stay legal while a hazard is active.
export function isSafePartContact(card: CamObject['card'] | undefined, part: string | null, state: string): boolean {
    if (!card || !part) return false;
    if (!card.parts.some(p => p.kind === part)) return false;
    const known = (card.states || []).includes(state);
    for (const h of card.hazards || []) {
        const hs = Array.isArray(h.states) ? h.states : [];
        const stateHit = !hs.length || hs.includes(state) || (!known && hs.length > 0);
        const parts = Array.isArray(h.parts) ? h.parts : [];
        if (stateHit && (!parts.length || parts.includes(part))) return false;
    }
    return true;
}

function hazardCells(objects: CamObject[]): Map<string, string> {
    const cells = new Map<string, string>();
    for (const o of objects) {
        if (!hazardActiveInState(o.card, o.state)) continue;
        if (o.status && o.status !== 'placed') continue;
        if (o.placement && o.placement !== 'floor') continue;
        for (const [x, y] of cellsOf(o))
            if (!cells.has(key(x, y))) cells.set(key(x, y), o.id);
    }
    return cells;
}

function applyGateEffects(objects: CamObject[], s: Segment): CamObject[] {
    let out = objects;
    for (const e of s.effects || []) {
        const id = e.object_id || s.target;
        if (!id) continue;
        if (e.e === 'move_object' && (e.dx || e.dy))
            out = out.map(o => o.id === id ? { ...o, x: o.x + (e.dx || 0), y: o.y + (e.dy || 0) } : o);
        else if (e.e === 'set_state' && typeof e.state === 'string')
            out = out.map(o => o.id === id ? {
                ...o, state: e.state as string,
                ...(e.footprint ? { footprint: e.footprint } : {}),
                ...(e.sprite ? { sprite: e.sprite } : {}),
            } : o);
    }
    if (s.primitive === 'carry' && s.target)
        out = out.map(o => o.id === s.target ? { ...o, status: 'carried' } : o);
    if (s.primitive === 'drop' && s.target)
        out = out.map(o => o.id === s.target ? { ...o, status: 'placed' } : o);
    return out;
}

function refuse(segments: Segment[], sim: CamObject[], pos: Cell, index: number, reason: string): GateResult {
    const bad = segments[index];
    const kept = segments.slice(0, index);
    const lastEnd = segments[segments.length - 1].end_at;
    const refusal: GateRefusal = { index, primitive: bad.primitive, target: bad.target, part: bad.part, reason };
    const safe: Cell = [pos[0], pos[1]];
    const base = {
        ...bad, target: null, part: null, carrying: null, interaction: null,
        cut_at: null, completion: undefined,
    };
    // Never invent an escape: when already on a hazard, stopping in place is
    // the only conservative outcome and is explicitly recorded.
    const heldReason = hazardCells(sim).has(key(...roundCell(safe))) ? reason + ' (no safe exit)' : reason;
    return {
        segments: [...kept, {
            ...base, end_at: lastEnd, action: 'idle_sit', primitive: 'hold_pose',
            pose: 'sit', path: [safe], effects: [{ e: 'hazard_refused', reason: heldReason }], source: 'safe',
        }], refusals: [{ ...refusal, reason: heldReason }],
    };
}

export function gateSegments(segments: Segment[], objects: CamObject[], start: Cell): GateResult {
    if (!segments.length) return { segments, refusals: [] };
    let sim = objects.map(o => ({ ...o }));
    let pos: Cell = [...start];
    const find = (id: string | null) => (id ? sim.find(o => o.id === id) : undefined);
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const armed = hazardCells(sim);
        const path = Array.isArray(s.path) && s.path.length ? s.path : [pos];
        if (path[0][0] !== pos[0] || path[0][1] !== pos[1])
            return refuse(segments, sim, pos, i, 'path does not start at Nori position');
        const hit = path.map(roundCell).find(([x, y]) => armed.has(key(x, y)));
        const conservativeHold = s.primitive === 'hold_pose' && path.length === 1 &&
            (s.effects || []).length === 1 && s.effects[0].e === 'hazard_refused';
        if (hit && !conservativeHold) return refuse(segments, sim, pos, i,
            `path crosses hazard-active object ${armed.get(key(hit[0], hit[1]))} at [${hit[0]},${hit[1]}]`);
        if ((CONTACT_PRIMITIVES as readonly string[]).includes(s.primitive)) {
            const target = find(s.target);
            if (target && hazardActiveInState(target.card, target.state)) {
                const partOk = (s.primitive === 'touch' || s.primitive === 'set_object_state') &&
                    !WHOLE_OBJECT_CONTACT.has(s.primitive) &&
                    isSafePartContact(target.card, s.part, target.state);
                if (!partOk) return refuse(segments, sim, pos, i,
                    `${s.primitive}${s.part ? ' on ' + s.part : ''} refused: hazard active on ${target.id} in state '${target.state}'`);
            }
        }
        // Apply each effect to a temporary world only after checking it. A
        // refused segment commits none of its effects.
        let trial = sim;
        const end = path[path.length - 1];
        for (const e of s.effects || []) {
            const id = e.object_id || s.target;
            const target = id ? trial.find(o => o.id === id) : undefined;
            if (e.e === 'move_object' && (e.dx || e.dy || e.keyframes) && target &&
                hazardActiveInState(target.card, target.state))
                return refuse(segments, sim, pos, i,
                    `move_object refused: hazard active on ${target.id} in state '${target.state}'`);
            if (e.e === 'set_state') {
                if (!target || typeof e.state !== 'string' || !target.card?.states?.includes(e.state) ||
                    !target.state_sprites?.[e.state])
                    return refuse(segments, sim, pos, i, 'set_state refused: unknown state or missing sprite');
            }
            trial = applyGateEffects(trial, { ...s, primitive: 'hold_pose', effects: [e] });
            if (e.e === 'set_state' && target && hazardActiveInState(target.card, e.state!)) {
                const after = hazardCells(trial.filter(o => o.id === target.id));
                if (after.has(key(...roundCell(pos))) || after.has(key(...roundCell(end))))
                    return refuse(segments, sim, pos, i, 'set_state refused: hazard under Nori');
                // Conservatively inspect the remaining planned path up to the
                // next change of this object; do not simulate new movement.
                for (const future of segments.slice(i + 1)) {
                    if ((future.path || []).some(([x, y]) => after.has(key(Math.round(x), Math.round(y)))))
                        return refuse(segments, sim, pos, i, 'set_state refused: later path on hazard');
                    if ((future.effects || []).some(f => (f.object_id || future.target) === target.id &&
                        (f.e === 'set_state' || f.e === 'move_object'))) break;
                }
            }
        }
        sim = applyGateEffects(trial, { ...s, effects: [] });
        pos = path[path.length - 1];
    }
    return { segments, refusals: [] };
}
