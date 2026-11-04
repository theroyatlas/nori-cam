import { accessObject, levels } from './heights.ts';
import schema from '../../../public/cam/schema/interaction-spec.json' with {
    type: 'json'
};
import cardSchema from '../../../public/cam/schema/object-card.json' with {
    type: 'json'
};
import { EXECUTOR, GENERIC_POSES, EFFECTS, operationCells, bfsPath, placementOk, cellsOf, hazardActiveInState } from '../../../public/cam-shared.js';
import type { GeometryWorld, CamObject, Cell, InteractionSpec, ValidationResult, Step } from './types.ts';
// Prompt + ObjectCard/InteractionSpec contract version. The Python pipeline
// requires this on every gift_ready envelope and records it with each gift.
export const CONTRACT_VERSION = 'cam-d1fix-2';
export const HAZARD_KINDS = ['hot', 'sharp', 'fragile', 'toxic', 'unstable'];
export const SIDES = ['front', 'back', 'left', 'right', 'top'];
export const CONTACT_PRIMITIVES = ['touch', 'push', 'carry', 'drop', 'climb', 'sleep', 'set_object_state'];
export const NONCONTACT_PRIMITIVES = ['move_to', 'face', 'hold_pose', 'wait'];
// Contact primitives that move or rest Nori with the whole object: any hazard
// active in the current state blocks them whatever part they name. drop counts
// with the carry it follows; push moves the whole object even when it names a
// safe part, so it counts as whole-object contact too. touch and
// set_object_state keep part matching when a declared part is named.
export const WHOLE_OBJECT_CONTACT = new Set(['push', 'carry', 'climb', 'sleep', 'drop']);

// A hazard is active in a state when it lists no states (all states), lists the
// state, or the state is unknown (not a declared card state: fail closed).
export function hazardsActiveInState(card: { states: string[]; hazards?: { states: string[] }[] } | undefined,
  state: string): boolean {
  // D1fix4: one shared test lives in cam-shared.js; this keeps the established name.
  return hazardActiveInState(card, state);
}
type Schema = {
    type?: string | string[];
    enum?: unknown[];
    required?: string[];
    properties?: Record<string, Schema>;
    additionalProperties?: boolean | Schema;
    items?: Schema;
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    maxProperties?: number;
};
export function schemaErrors(value: unknown, s: Schema, path = '$'): string[] {
    const errors: string[] = [];
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (s.type && !types.includes(type) && !(types.includes('integer') && Number.isInteger(value)))
        return [path + ': type'];
    if (s.enum && !s.enum.includes(value))
        errors.push(path + ': enum');
    if (typeof value === 'number' && (!Number.isFinite(value) || (s.minimum != null && value < s.minimum) ||
        (s.maximum != null && value > s.maximum)))
        errors.push(path + ': range');
    if (typeof value === 'string' && (value.length < (s.minLength ?? 0) || value.length > (s.maxLength ?? Infinity)))
        errors.push(path + ': length');
    if (Array.isArray(value)) {
        if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? Infinity))
            errors.push(path + ': count');
        if (s.items)
            value.forEach((v, i) => errors.push(...schemaErrors(v, s.items!, path + '.' + i)));
    }
    else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const k of s.required || [])
            if (!(k in record))
                errors.push(path + '.' + k + ': required');
        if (Object.keys(record).length > (s.maxProperties ?? Infinity))
            errors.push(path + ': count');
        for (const [k, v] of Object.entries(record)) {
            const child = s.properties?.[k];
            if (child)
                errors.push(...schemaErrors(v, child, path + '.' + k));
            else if (s.additionalProperties === false)
                errors.push(path + '.' + k + ': unknown');
            else if (typeof s.additionalProperties === 'object')
                errors.push(...schemaErrors(v, s.additionalProperties, path + '.' + k));
        }
    }
    return errors;
}
export function hazardCardErrors(raw: unknown): string[] {
    const errors: string[] = [];
    if (!raw || typeof raw !== 'object')
        return ['hazards: card required'];
    const card = raw as Record<string, unknown>;
    const parts = Array.isArray(card.parts) ? card.parts : [];
    const declared = new Set(parts.map((p: unknown) =>
        p && typeof p === 'object' ? (p as Record<string, unknown>).kind : undefined));
    const states = Array.isArray(card.states) ? (card.states as unknown[]) : [];
    const hazards = Array.isArray((card as Record<string, unknown>).hazards)
        ? (card as Record<string, unknown>).hazards as unknown[] : null;
    if (!hazards || hazards.length > 8)
        return ['hazards: list required'];
    hazards.forEach((h, i) => {
        const hazard = h as Record<string, unknown>;
        if (!hazard || typeof hazard !== 'object' || !HAZARD_KINDS.includes(hazard.kind as string))
            errors.push(`hazards.${i}: unknown kind`);
        else {
            const hparts = Array.isArray(hazard.parts) ? hazard.parts : null;
            const hstates = Array.isArray(hazard.states) ? hazard.states : null;
            if (!hparts || !hstates || hparts.some(p => typeof p !== 'string' || !declared.has(p)) ||
                hstates.some(s => typeof s !== 'string' || !states.includes(s)))
                errors.push(`hazards.${i}: parts/states inconsistent`);
        }
    });
    return errors;
}
// Explicit safe fallback when no candidate is legal: approach from the front
// and hold a non-contact pose. Uses only existing executor primitives.
export function fallbackSpec(side = 'front'): InteractionSpec {
    return {
        verb: 'observe from a safe distance', sensations: {}, approach: side,
        target_part: null, contact: 'none',
        steps: [{ p: 'move_to', approach: side }, { p: 'hold_pose', pose: 'look-up', ms: 1500 }],
        end_state: null, cooldown_min: 60,
    };
}
export function validateCard(raw: unknown, prefab = false): string[] {
    const errors = schemaErrors(raw, cardSchema as Schema);
    if (!prefab && raw && typeof raw === 'object' && 'prop_poses' in raw)
        errors.push('prop_poses is prefab-only');
    if (!prefab && raw && typeof raw === 'object' && 'hazards' in raw)
        errors.push(...hazardCardErrors(raw));
    return errors;
}
export function validate(world: GeometryWorld, object: CamObject | undefined, raw: unknown, from: Cell): ValidationResult {
    const checks: ValidationResult['checks'] = [], gaps: ValidationResult['gaps'] = [];
    const check = (name: string, ok: boolean, reason: string) => checks.push({
        check: name, ok, reason: ok ? null : reason
    });
    if (!object || object.status !== 'placed' || !object.card) {
        check('object', false, 'missing, unplaced or no card');
        return {
            status: 'rejected', checks, gaps, spec: null
        };
    }
    const spec = structuredClone(raw) as InteractionSpec;
    if (spec && Array.isArray(spec.steps)) {
        const fallback: Step[] = [];
        for (const step of spec.steps) {
            if (!step || typeof step !== 'object') {
                fallback.push(step);
                continue;
            }
            const gap = (reason: string) => gaps.push({
                primitive: step.p, reason
            });
            // Unknown parameters are never silently made executable by a fallback.
            if (Object.keys(step).some(k => !['p', 'part', 'pose', 'gait', 'ms', 'dir', 'at', 'state', 'effects', 'approach'].includes(k))) {
                fallback.push(step);
                continue;
            }
            if (step.p === 'look_through') {
                gap('look-through unavailable');
                fallback.push({
                    p: 'face', part: step.part
                }, {
                    p: 'hold_pose', pose: 'look-up', ms: 1500
                });
            }
            else if (step.p === 'pull') {
                gap('pull unavailable; opposite-side push');
                fallback.push({
                    ...step, p: 'push', dir: step.dir ? [-step.dir[0], -step.dir[1]] : undefined
                });
            }
            else if (step.p === 'hide_in' || step.p === 'hide_under') {
                gap('generic occlusion unavailable');
                fallback.push({
                    p: 'move_to', part: 'front'
                }, {
                    p: 'hold_pose', pose: 'alert-loaf', ms: 3000
                });
            }
            else
                fallback.push(step);
        }
        spec.steps = fallback;
    }
    const errors = schemaErrors(spec, schema as Schema);
    check('schema', !errors.length, errors.join('; '));
    if (errors.length)
        return {
            status: 'rejected', checks, gaps, spec: null
        };
    const declaredParts = new Set(object.card.parts.map(p => p.kind));
    const cardStates: string[] = object.card.states;
    const hazards = object.card.hazards || [];
    if (spec.approach !== undefined)
        check('contract.approach', SIDES.includes(spec.approach), 'unknown approach side');
    if (spec.target_part !== undefined && spec.target_part !== null)
        check('contract.target', declaredParts.has(spec.target_part), 'undeclared target part');
    const stepKinds = new Set(spec.steps.map(s => s.p));
    if (spec.contact !== undefined)
        check('contract.contact', spec.contact === 'none'
            ? !CONTACT_PRIMITIVES.some(p => stepKinds.has(p))
            : (CONTACT_PRIMITIVES.includes(spec.contact) || spec.contact === 'hold_pose') && stepKinds.has(spec.contact),
            'contact inconsistent with steps');
    if (spec.allowed_states !== undefined) {
        check('contract.states', spec.allowed_states.every(s => cardStates.includes(s)), 'allowed states inconsistent');
        if (spec.allowed_states.length && spec.end_state !== null)
            check('contract.end_state', spec.allowed_states.includes(spec.end_state), 'end state outside allowed states');
    }
    // Runtime state gate (R3): a non-empty allowed_states only permits the
    // object's current state. Catalog/prefab interactions omit allowed_states,
    // so they behave exactly as before.
    if (Array.isArray(spec.allowed_states) && spec.allowed_states.length)
        check('contract.current_state', spec.allowed_states.includes(object.state),
            'object state outside allowed states');
    if (spec.target_part !== undefined && spec.target_part !== null)
        for (const [i, s] of spec.steps.entries())
            if (s.part && CONTACT_PRIMITIVES.includes(s.p) && s.part !== spec.target_part)
                check(i + '.target', false, 'contact part differs from target part');
    let position = from;
    let simulated = structuredClone(object);
    // F7: each contact step is checked against the state the object is in at
    // that step, tracking set_object_state transitions (not just the start
    // state plus end_state). Unknown step states stay hazardous (fail closed).
    let stepState = object.state;
    for (const [i, s] of spec.steps.entries()) {
        const prefix = String(i), part = object.card.parts.find(p => p.kind === s.part), cap = EXECUTOR[s.p];
        check(prefix + '.primitive', !!cap, 'unsupported primitive');
        if (s.part)
            check(prefix + '.part', !!part || (s.p === 'move_to' && !!s.part && SIDES.includes(s.part)), 'missing part');
        if (s.approach)
            check(prefix + '.approach', SIDES.includes(s.approach), 'unknown approach side');
        if (s.pose)
            check(prefix + '.pose', GENERIC_POSES.includes(s.pose) || (object.origin?.type === 'prefab' &&
                (object.card.prop_poses || []).includes(s.pose)), 'unapproved pose');
        if (s.pose && cap && s.p !== 'hold_pose')
            check(prefix + '.pose_primitive', cap.poses.includes(s.pose) || (s.p === 'sleep' &&
                object.origin?.type === 'prefab' && (object.card.prop_poses || []).includes(s.pose)), 'pose incompatible with primitive');
        if (s.gait)
            check(prefix + '.gait', s.p === 'move_to', 'gait only on move_to');
        if (s.ms != null && cap)
            check(prefix + '.duration', s.ms >= cap.min_ms && s.ms <= cap.max_ms, 'duration outside executor range');
        if (s.p === 'move_to') {
            // D1fix4 (P2): route on the state at this step, not the entry state:
            // an earlier set_object_state may have armed a hazard to walk around.
            // The backstop below still refuses a path that crosses an armed
            // footprint; the starting cell is exempt since Nori stands there.
            const stepped = { ...simulated, state: stepState };
            const stepWorld = { ...world, objects: world.objects.map(o => o.id === simulated.id ? stepped : o) };
            const paths = operationCells(accessObject(simulated, world.objects) || simulated, s.approach || s.part,
              stepWorld).map(c => bfsPath(stepWorld, position, c)).filter((p): p is Cell[] => !!p).sort((a, b) => a.length - b.length);
            const armed = (cell: Cell) => cell[0] === position[0] && cell[1] === position[1] ? false :
              world.objects.some(o => hazardActiveInState(o.card, o.id === simulated.id ? stepState : o.state) &&
                cellsOf(o.id === simulated.id ? simulated : o).some(([cx, cy]) => cx === cell[0] && cy === cell[1]));
            const safePaths = paths.filter(p => !p.some(armed));
            check(prefix + '.reachable', !!safePaths.length, safePaths.length ? 'unreachable operation cell' :
              paths.length ? 'path crosses an armed hazard' : 'unreachable operation cell');
            if (safePaths.length)
                position = safePaths[0].at(-1)!;
            else if (paths.length)
                position = paths[0].at(-1)!;
        }
        if (['touch', 'push', 'carry', 'climb'].includes(s.p) && !(s.p === 'climb' && levels(object).length))
            check(prefix + '.distance', Math.abs(position[0] - simulated.x) + Math.abs(position[1] - simulated.y) <= 1, 'not adjacent');
        if (s.p === 'touch')
            check(prefix + '.height', !!part && ['floor', 'low'].includes(part.height), 'touch too high');
        if (CONTACT_PRIMITIVES.includes(s.p)) {
            const named = s.part || spec.target_part || undefined;
            const namedDeclared = named !== undefined && declaredParts.has(named);
            // Fail closed: an unknown step state activates every state-limited
            // hazard. The declared end_state still counts (D1fix2 case C).
            const stateKnown = cardStates.includes(stepState);
            for (const h of hazards) {
                const stateHit = !h.states.length || h.states.includes(stepState) ||
                    (!stateKnown && h.states.length > 0) ||
                    (spec.end_state !== null && h.states.includes(spec.end_state));
                // Whole-object contact (push/carry/climb/sleep/drop, or an
                // unnamed contact part) is blocked by any active hazard;
                // touch/set_object_state match parts only when a declared part
                // is named.
                const partHit = WHOLE_OBJECT_CONTACT.has(s.p) || !namedDeclared
                    ? true : !h.parts.length || h.parts.includes(named!);
                if (partHit && stateHit)
                    check(prefix + '.hazard', false, `hazard ${h.kind} on ${namedDeclared ? named : 'object'}`);
            }
        }
        if (s.p === 'carry') {
            check(prefix + '.carry', object.tags.includes('portable') && object.size === 'S', 'carry requires portable S');
            if (s.at) {
                check(prefix + '.carry_path', !!bfsPath(world, position, s.at), 'unreachable carry destination');
                simulated = {
                    ...simulated, x: simulated.x + s.at[0] - position[0], y: simulated.y + s.at[1] - position[1], status: 'carried'
                };
                position = s.at;
            }
        }
        if (s.p === 'climb' && !levels(object).length)
            check(prefix + '.climb', s.part === 'top' && object.tags.includes('high_place') && ['M',
                'L'].includes(object.size) && !!part && ['low', 'mid'].includes(part.height), 'cannot climb');
        if (s.p === 'climb' && levels(object).length) {
            const access = accessObject(object, world.objects);
            check(prefix + '.climb_access', s.part === 'top' && !!access && Math.abs(position[0] - access.x) +
                Math.abs(position[1] - access.y) <= 1, 'no reachable climb chain');
        }
        if (s.p === 'push') {
            check(prefix + '.push', object.tags.includes('pushable') && ['S', 'M'].includes(object.size) && !!s.dir &&
                Math.abs(s.dir[0]) + Math.abs(s.dir[1]) === 1, 'illegal push');
            if (s.dir) {
                check(prefix + '.push_side', position[0] === simulated.x - s.dir[0] &&
                    position[1] === simulated.y - s.dir[1], 'push from opposite side');
                simulated = {
                    ...simulated, x: simulated.x + s.dir[0], y: simulated.y + s.dir[1]
                };
                check(prefix + '.placement', placementOk({ ...world, nori: { x: position[0], y: position[1] } },
                  simulated).ok, 'push destination blocked');
            }
        }
        if (s.p === 'drop') {
            check(prefix + '.drop', !!s.at, 'missing drop point');
            if (s.at) {
                check(prefix + '.drop_distance', Math.abs(s.at[0] - position[0]) + Math.abs(s.at[1] - position[1]) <= 1,
                  'drop beyond reach');
                simulated = {
                    ...simulated, x: s.at[0], y: s.at[1], status: 'placed'
                };
                check(prefix + '.placement', placementOk({ ...world, nori: { x: position[0], y: position[1] } },
                  simulated).ok, 'drop blocked');
            }
        }
        if (s.p === 'set_object_state') {
            // The object's state for later contact steps is whatever this
            // validated transition sets (checked below against card states).
            if (s.state && object.card.states.includes(s.state)) stepState = s.state;
            check(prefix + '.state', object.card.states.includes(s.state || '') && !!object.state_sprites?.[s.state ||
                ''], 'unknown state or missing sprite');
            const cm = object.card.space.state_cm[s.state || ''];
            if (cm) {
                const w = Math.max(1, Math.round(cm.w / 40)), h = Math.max(1, Math.round(cm.d / 40));
                simulated = {
                    ...simulated, footprint: Array.from({
                        length: w * h
                    }, (_, i) => [i % w, Math.floor(i / w)] as Cell)
                };
                check(prefix + '.placement', w <= 2 && h <= 2 && placementOk({ ...world, nori: { x: position[0],
                        y: position[1] } }, simulated).ok, 'state footprint blocked');
            }
            if (hazardActiveInState(simulated.card, stepState))
                check(prefix + '.hazard_under_nori', !cellsOf(simulated).some(([x, y]) =>
                    x === position[0] && y === position[1]), 'state would activate hazard under Nori');
        }
        for (const e of s.effects || []) {
            check(prefix + '.effect', EFFECTS.includes(e.e) && ['touch', 'push', 'carry', 'drop',
                'set_object_state'].includes(s.p), 'effects only on contact steps');
            if (e.object_id)
                check(prefix + '.effect_target', e.object_id === object.id, 'cross-object effects forbidden');
            if (e.at_ms != null)
                check(prefix + '.effect_time', e.at_ms <= (s.ms ?? cap?.max_ms ?? 0), 'effect outside segment');
            if (e.e === 'emit_sound')
                check(prefix + '.sound', !!object.card.sensations.sound, 'object has no sound');
            if (e.e === 'move_object')
                check(prefix + '.movement', ['push', 'carry', 'drop'].includes(s.p) && Math.hypot(e.dx || 0, e.dy ||
                    0) <= 1 && placementOk(world, {
                    ...object, x: object.x + (e.dx || 0), y: object.y + (e.dy || 0)
                }).ok, 'illegal movement');
            if (e.e === 'set_state')
                check(prefix + '.effect_state', s.p === 'set_object_state' && e.state === s.state,
                  'state effect must match validated transition');
        }
    }
    check('object_contact', spec.steps.some(s => ['move_to', 'touch', 'push', 'carry', 'drop', 'climb',
        'sleep'].includes(s.p)), 'no approach or contact step');
    if (spec.end_state !== null)
        check('end_state', object.card.states.includes(spec.end_state), 'unknown end state');
    return {
        status: checks.some(c => !c.ok) ? 'rejected' : gaps.length ? 'degraded' : 'accepted', checks, gaps,
        spec: checks.some(c => !c.ok) ? null : spec
    };
}
