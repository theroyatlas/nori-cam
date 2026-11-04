// Pure shared helpers for Nori Cam. No DOM, no Date, no randomness.
export const TILE_W = 32;
export const TILE_H = 16;
export const ORIGIN_X = 160;
export const ORIGIN_Y = 48;
export const POSES = [
    'sit',
    'stretch',
    'walk',
    'look_up',
    'jump',
    'alert_loaf',
    'sleepy',
];
export function project(x, y, z = 0) {
    const sx = (x - y) * 16 + ORIGIN_X;
    const sy = (x + y) * 8 + ORIGIN_Y - z * 16;
    return { sx, sy, x: sx, y: sy };
}
function segmentProgress(seg, t) {
    const dur = seg.end_at - seg.start_at;
    if (!(dur > 0))
        return t < seg.start_at ? 0 : 1;
    const p = (t - seg.start_at) / dur;
    return p < 0 ? 0 : p > 1 ? 1 : p;
}
function pathLengths(path) {
    const legs = [];
    let total = 0;
    for (let i = 0; i + 1 < path.length; i += 1) {
        const dx = path[i + 1][0] - path[i][0];
        const dy = path[i + 1][1] - path[i][1];
        const len = Math.hypot(dx, dy);
        legs.push({ dx, dy, len });
        total += len;
    }
    return { legs, total };
}
function facingForLeg(legs, legIndex, fallback) {
    for (let i = legIndex; i >= 0; i -= 1) {
        const leg = legs[i];
        if (!leg || leg.len === 0)
            continue;
        const sdx = (leg.dx - leg.dy) * 16;
        if (sdx > 0)
            return 1;
        if (sdx < 0)
            return -1;
    }
    return fallback === -1 ? -1 : 1;
}
export function poseAt(segments, t) {
    if (!Array.isArray(segments) || segments.length === 0)
        return null;
    let seg = null;
    for (const s of segments) {
        if (t >= s.start_at && t < s.end_at) {
            seg = s;
            break;
        }
    }
    if (!seg) {
        seg = t < segments[0].start_at ? segments[0] : segments[segments.length - 1];
    }
    const path = Array.isArray(seg.path) && seg.path.length ? seg.path : [[0, 0]];
    const p = segmentProgress(seg, t);
    const { legs, total } = pathLengths(path);
    let x = path[0][0];
    let y = path[0][1];
    let legIndex = 0;
    let travelled = 0;
    if (total > 0 && legs.length) {
        const targetDist = p * total;
        let acc = 0;
        let placed = false;
        for (let i = 0; i < legs.length; i += 1) {
            const leg = legs[i];
            if (leg.len === 0)
                continue;
            if (targetDist <= acc + leg.len || i === legs.length - 1) {
                const f = leg.len === 0 ? 0 : (targetDist - acc) / leg.len;
                const cf = f < 0 ? 0 : f > 1 ? 1 : f;
                x = path[i][0] + leg.dx * cf;
                y = path[i][1] + leg.dy * cf;
                legIndex = i;
                travelled = targetDist;
                placed = true;
                break;
            }
            acc += leg.len;
        }
        if (!placed) {
            const last = path[path.length - 1];
            x = last[0];
            y = last[1];
            legIndex = legs.length - 1;
            travelled = total;
        }
    }
    let facing;
    if (!legs.length || total === 0) {
        facing = seg.facing === -1 ? -1 : 1;
    }
    else {
        facing = facingForLeg(legs, legIndex, seg.facing);
    }
    const hop = seg.primitive === 'climb' ? 40 * p * (1 - p) : 0;
    return {
        x,
        y,
        z: typeof seg.z_from === 'number' && typeof seg.z_to === 'number'
            ? seg.z_from + (seg.z_to - seg.z_from) * p : typeof seg.z === 'number' ? seg.z : 0,
        pose: seg.pose,
        facing,
        segmentId: seg.id,
        action: seg.action,
        primitive: seg.primitive ?? null,
        target: seg.target ?? null,
        part: seg.part ?? null,
        hop,
        distance: travelled,
    };
}
export function depthKey(item) {
    if (!item || typeof item !== 'object')
        return 0;
    const height = Number.isFinite(item.z) ? item.z * 0.01 : 0;
    const layer = item.layer ?? item.depthLayer ?? null;
    if (layer === 'back')
        return item.x + item.y + height - 0.01;
    if (layer === 'front')
        return item.x + item.y + height + 0.5;
    if (layer === 'inside' || item.part === 'inside') {
        let bx = item.x;
        let by = item.y;
        if (typeof item.targetX === 'number' && typeof item.targetY === 'number') {
            bx = item.targetX;
            by = item.targetY;
        }
        else if (item.targetPos && typeof item.targetPos.x === 'number') {
            bx = item.targetPos.x;
            by = item.targetPos.y;
        }
        return bx + by + height + 0.25;
    }
    return item.x + item.y + height;
}
// Engine contract additions. Keep the v0 POSES array unchanged for old renderers.
export const TAGS = [
    'soft', 'enclosed', 'portable', 'high_place', 'viewpoint', 'pushable', 'pressable', 'computer', 'water', 'blocker'
];
export const SENSATIONS = ['soft', 'shelter', 'height', 'view_far', 'sound', 'motion', 'light', 'warm'];
export const PARTS = [
    'top', 'front', 'opening', 'inside', 'under', 'handle', 'pressable', 'movable', 'viewport'
];
export const ACTIONS = [
    'idle_sit', 'walk', 'sneak', 'sniff', 'look_up', 'sleep', 'lie_on', 'hide_in', 'hide_behind', 'sit_on', 'look_out',
    'carry', 'drop', 'play', 'use_computer', 'sketch', 'pin_drawing', 'drink', 'search_missing', 'stretch',
    'startled', 'interact', 'react'
];
export const GENERIC_POSES = [
    'walk', 'sneak', 'dash', 'sit', 'alert-loaf', 'sleepy', 'belly-up', 'stretch', 'look-up', 'back', 'peek', 'wave',
    'jump', 'startled', 'surprised', 'starstruck', 'love', 'question', 'unimpressed', 'grumpy', 'giggle', 'meh',
    'ponder', 'neutral', 'oops'
];
export const EFFECTS = ['emit_sound', 'wobble', 'move_object', 'set_state', 'glow', 'particles'];
export const EXECUTOR = Object.freeze({
    move_to: {
        poses: ['walk', 'sneak', 'dash'], min_ms: 0, max_ms: 120000, speeds: {
            walk: 1.5, sneak: 1, dash: 3
        }
    }, face: {
        poses: [], min_ms: 0, max_ms: 0
    }, touch: {
        poses: ['wave'], min_ms: 500, max_ms: 3000
    }, push: {
        poses: ['dash'], min_ms: 800, max_ms: 2000
    }, carry: {
        poses: ['walk'], min_ms: 0, max_ms: 120000
    }, drop: {
        poses: ['sit'], min_ms: 500, max_ms: 500
    }, climb: {
        poses: ['jump'], min_ms: 600, max_ms: 600
    }, hold_pose: {
        poses: GENERIC_POSES, min_ms: 1000, max_ms: 1800000
    }, wait: {
        poses: ['sit', 'alert-loaf'], min_ms: 500, max_ms: 60000
    }, set_object_state: {
        poses: [], min_ms: 0, max_ms: 0
    }, sleep: {
        poses: ['sleepy', 'belly-up'], min_ms: 1200000, max_ms: 5400000
    },
});
export const PRIMITIVES = Object.keys(EXECUTOR);
export const EVENT_TYPES = [
    'gift_arrived', 'gift_unwrapped', 'gift_failed', 'object_placed', 'object_moved', 'object_removed', 'object_stored',
    'object_state_changed', 'slept', 'woke', 'hid', 'carried', 'played', 'looked_out', 'used_computer',
    'browse_result', 'drawing_pinned', 'intent_accepted', 'intent_rejected', 'intent_done', 'wonder_reflection',
    'searched_missing', 'safe_fallback', 'catchup', 'object_understood', 'interaction_compiled',
    'interaction_rejected', 'capability_gap', 'interaction_done', 'interaction_interrupted', 'sound_played',
    'experience_settled', 'budget_denied', 'wish_created', 'wish_matched', 'wish_expired'
];
const key = ([x, y]) => `${x},${y}`;
const adjacent = ([x, y]) => [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
const inside = ([x, y]) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 10 && y >= 0 && y < 8;
// Interaction safety (F5): an object with a hazard active in its current state
// is never stood on or routed through. A hazard is active when it lists no
// states (all states), lists the state, or the object's state is not a
// declared card state (unknown: fail closed). Objects without hazards behave
// exactly as before.
//
// D1fix4: the single shared hazard-active test. validate.ts delegates to
// hazardActiveInState so the rule exists in exactly one place.
export function hazardActiveInState(card, state) {
    const hazards = card && card.hazards;
    if (!hazards || !hazards.length)
        return false;
    const states = (card && card.states) || [];
    const known = states.includes(state);
    return hazards.some(h => {
        const hs = h && Array.isArray(h.states) ? h.states : [];
        return !hs.length || hs.includes(state) || (!known && hs.length > 0);
    });
}
function hazardActive(object) {
    return !!object && hazardActiveInState(object && object.card, object && object.state);
}
export function cellsOf(object) {
    if (object.status && object.status !== 'placed')
        return [];
    if (object.placement && object.placement !== 'floor')
        return [];
    return (object.footprint || [[0, 0]]).map(([x, y]) => object.rotation === 90 ? [object.x - y,
        object.y + x] : [object.x + x, object.y + y]);
}
export function walkable(world) {
    // D1fix4: cells under a hazard-active object are not walkable, like blocked
    // cells. Worlds without hazards are unaffected.
    const blocked = new Set((world.objects || []).filter(o => o.blocks || hazardActive(o)).flatMap(cellsOf).map(key));
    const cells = [];
    for (let y = 0; y < 8; y++)
        for (let x = 0; x < 10; x++)
            if (!blocked.has(key([x, y])))
                cells.push([x, y]);
    return cells;
}
export function bfsPath(world, from, to) {
    if (!inside(from) || !inside(to))
        return null;
    const free = new Uint8Array(80);
    free.fill(1);
    for (const o of world.objects || []) {
        if (o.blocks || hazardActive(o))
            for (const [x, y] of cellsOf(o))
                if (inside([x, y]))
                    free[y * 10 + x] = 0;
    }
    const start = from[1] * 10 + from[0];
    const end = to[1] * 10 + to[0];
    if (!free[start] || !free[end])
        return null;
    const previous = new Int16Array(80);
    previous.fill(-2);
    previous[start] = -1;
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
        const at = queue[i];
        if (at === end) {
            const path = [];
            for (let n = at; n !== -1; n = previous[n])
                path.push([n % 10, Math.floor(n / 10)]);
            return path.reverse();
        }
        const x = at % 10;
        const neighbours = [x > 0 ? at - 1 : -1, x < 9 ? at + 1 : -1, at - 10, at + 10];
        for (const n of neighbours)
            if (n >= 0 && n < 80 && free[n] && previous[n] === -2) {
                previous[n] = at;
                queue.push(n);
            }
    }
    return null;
}
export function operationCells(object, part, world, freeCells) {
    const occupied = cellsOf(object);
    // An approach side is resolved as a side, never through a part lookup: a
    // part whose kind is a side name must not redirect the approach (F6).
    const side = ['front', 'back', 'left', 'right', 'top'].includes(part) ? part :
        (object.card?.parts || object.parts || []).find(p => p.kind === part)?.side || 'front';
    const offset = {
        front: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0]
    };
    const free = freeCells || new Set(walkable(world).map(key));
    const own = new Set(occupied.map(key));
    const candidates = !object.blocks &&
        side === 'top' ? occupied : occupied.flatMap(c => side === 'top' ? adjacent(c) : [[c[0] + offset[side][0],
            c[1] + offset[side][1]]]);
    // Virtual nonblocking objects use their actual floor point.
    if (!object.blocks && side !== 'top')
        candidates.push([object.x, object.y]);
    // Nori's standing cells never include a cell occupied by an object with a
    // hazard active in its current state (F5): neither this object's own cell
    // nor another hazardous object's cell is a legal operation cell.
    const hazardCells = new Set();
    for (const o of (world && world.objects) || [])
        if (hazardActive(o))
            for (const [x, y] of cellsOf(o))
                hazardCells.add(key([x, y]));
    return candidates.filter(c => inside(c) && free.has(key(c)) && (!object.blocks || !own.has(key(c))) && !hazardCells.has(key(c)));
}
export function placementOk(world, object, cells = cellsOf(object)) {
    const fail = (reason, status = 422) => ({
        ok: false, status, reason
    });
    if (object.placement === 'wall') {
        return {
            ok: inside([object.x, object.y]), status: inside([object.x, object.y]) ? 200 : 422,
            reason: inside([object.x, object.y]) ? null : 'invalid wall cell'
        };
    }
    if (!cells.length || cells.some(c => !inside(c)) || new Set(cells.map(key)).size !== cells.length)
        return fail('invalid footprint');
    // D1fix4: a hazard-active object is never placed on Nori's cell, even when
    // it does not block (blocking-only checks would let a hot gift land on her).
    if (world.nori && hazardActiveInState(object.card, object.state) &&
        cells.some(c => c[0] === world.nori.x && c[1] === world.nori.y))
        return fail('hazard on Nori');
    const others = (world.objects || []).filter(o => o.id !== object.id);
    const occupied = new Set(others.filter(o => o.blocks).flatMap(cellsOf).map(key));
    if (object.blocks && cells.some(c => occupied.has(key(c))))
        return fail('overlap');
    const candidate = {
        ...object, rotation: 0, footprint: cells.map(([x, y]) => [x - object.x, y - object.y])
    };
    const next = {
        ...world, objects: [...others, candidate]
    };
    const free = walkable(next);
    if (!free.length)
        return fail('room full', 409);
    const fs = new Set(free.map(key));
    const available = new Uint8Array(80);
    for (const [x, y] of free)
        available[y * 10 + x] = 1;
    const queue = [free[0][1] * 10 + free[0][0]];
    available[queue[0]] = 2;
    for (let i = 0; i < queue.length; i++) {
        const at = queue[i], x = at % 10;
        const neighbours = [x > 0 ? at - 1 : -1, x < 9 ? at + 1 : -1, at - 10, at + 10];
        for (const n of neighbours)
            if (n >= 0 && n < 80 && available[n] === 1) {
                available[n] = 2;
                queue.push(n);
            }
    }
    if (queue.length !== free.length)
        return fail('disconnected room');
    if (world.nori && !fs.has(key([world.nori.x, world.nori.y])))
        return fail('occupies Nori');
    for (const anchor of world.anchors || [[0, 7]])
        if (!fs.has(key(anchor)) && !adjacent(anchor).some(c => fs.has(key(c))))
            return fail('blocked anchor');
    for (const o of next.objects.filter(o => !o.status || o.status === 'placed')) {
        if (o.placement === 'wall')
            continue;
        if (!operationCells(o, undefined, next, fs).length)
            return fail('no operation cell');
    }
    return {
        ok: true, status: 200, reason: null
    };
}
export function applyEffects(objects, segments, t) {
    const result = objects.map(o => ({
        ...o
    }));
    for (const s of [...segments].sort((a, b) => a.end_at - b.end_at || a.id - b.id)) {
        if (s.end_at > t || s.cut_at != null || s.superseded_at != null)
            continue;
        const carried = result.find(o => o.id === s.target);
        if (carried && s.primitive === 'carry')
            carried.status = 'carried';
        if (carried && s.primitive === 'drop')
            carried.status = 'placed';
        for (const e of s.effects || []) {
            const o = result.find(o => o.id === (e.object_id || s.target));
            if (!o)
                continue;
            if (e.e === 'move_object') {
                o.x += e.dx || 0;
                o.y += e.dy || 0;
            }
            if (e.e === 'set_state') {
                o.state = e.state;
                if (e.footprint)
                    o.footprint = e.footprint;
                if (e.sprite)
                    o.sprite = e.sprite;
            }
            if (e.e === 'glow')
                o.glow = e.on;
        }
    }
    return result;
}
// Gregorian arithmetic and NOAA fractional-year equations; t is UTC milliseconds.
function solar(t) {
    const days = Math.floor(t / 86400000), z = days + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1, month = mp + (mp < 10 ? 3 : -9), year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const n = starts[month - 1] + day + (leap && month > 2 ? 1 : 0), hour = ((t % 86400000) + 86400000) % 86400000 / 3600000;
    const g = 2 * Math.PI / (leap ? 366 : 365) * (n - 1 + (hour - 12) / 24), r = Math.PI / 180;
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) -
        0.040849 * Math.sin(2 * g));
    const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
        0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const ha = (hour * 60 + eq + 4 * (-0.13)) / 4 - 180, lat = 51.5 * r;
    const altitude = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha * r)) / r;
    const azimuth = (Math.atan2(Math.sin(ha * r), Math.cos(ha * r) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) / r + 180 + 360) % 360;
    return {
        altitude, azimuth, morning: ha < 0
    };
}
export function lightAt(t, weather) {
    const s = solar(t), phase = s.altitude < -6 ? 'night' : s.altitude > 10 ? 'day' : s.morning ? 'morning' : 'evening';
    // A +/-15 minute sample yields a smooth 30 minute transition at boundaries.
    const daylight = u => Math.max(0, Math.min(1, (solar(u).altitude + 6) / 16));
    const intensity = (daylight(t - 900000) + 2 * daylight(t) + daylight(t + 900000)) / 4;
    return {
        ...s, phase, intensity: intensity * (1 - (weather?.cloud_pct || 0) / 150)
    };
}
export function sunPatchAt(t, weather) {
    const s = solar(t);
    if (s.altitude <= 3 || (weather?.cloud_pct || 0) >= 70 || (weather?.precip_mm || 0) > 0)
        return null;
    const x = 7 - Math.max(0, Math.min(4, (s.azimuth - 90) / 180 * 4)), y = 3;
    return {
        x, y, polygon: [[x, y], [x + 2, y], [x + 3, y + 2], [x + 1, y + 2]], brightness: Math.min(1, s.altitude / 45)
    };
}
export function sunCovers(t, cell, weather) {
    const p = sunPatchAt(t, weather);
    if (!p)
        return false;
    const dy = cell[1] - p.y, left = p.x + dy / 2;
    return dy >= 0 && dy <= 2 && cell[0] >= left && cell[0] <= left + 2;
}
