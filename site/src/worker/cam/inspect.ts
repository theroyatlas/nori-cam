import { json } from '../headers.ts';
import { bearer, codeRole, visitorHash } from './auth.ts';
import type { GiftEnv } from './gifts.ts';
import { InputError } from './facts.ts';
import { enrichObject } from './heights.ts';
import { decodeObject, decodeSegment, snapshot } from './store.ts';
import { parseUsd, takeRate } from '../limits.ts';
type Row = Record<string, unknown>;
const REPLAY_OBJECT_STATES_CAP = 5000;
const inspectRateMax = (env: GiftEnv) => parseUsd((env as GiftEnv & { CAM_INSPECT_RATE_10MIN?: string }).CAM_INSPECT_RATE_10MIN, 60);
async function takeInspectRate(req: Request, env: GiftEnv, now: number) {
    const ready = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_salt'").first();
    if (!ready) return { ok: true, count: 0, retryAfterSec: 1 };
    const hash = await visitorHash(req, env, now);
    return takeRate(env.DB, `inspect:${hash}`, 1, inspectRateMax(env), now);
}
const parse = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
export const publicSegment = (r: Row) => {
    const s = decodeSegment(r);
    return {
        id: s.id, start_at: s.start_at, end_at: s.end_at, action: s.action, primitive: s.primitive,
        pose: s.pose, facing: s.facing, path: s.path, z: s.z, z_from: s.z_from, z_to: s.z_to, target: s.target, part: s.part,
        carrying: s.carrying, interaction: s.interaction, effects: s.effects, cut_at: s.cut_at, settled_at: s.settled_at,
        ...(r.debug && parse(r.debug).pages ? { pages: parse(r.debug).pages } : {})
    };
};
const publicObject = (r: Row) => {
    const o = decodeObject(r);
    return {
        id: o.id, kind: o.kind, x: o.x, y: o.y, z: o.z, footprint: o.footprint, rotation: o.rotation,
        blocks: o.blocks, placement: o.placement, status: o.status, state: o.state, sprite: o.sprite,
        size: o.size, tags: o.tags, levels: enrichObject(o).levels, parts: o.origin?.type === 'prefab' ? o.card.parts : [],
        wall_side: enrichObject(o).wall_side, card: { name: o.card.name, summary: o.card.summary }
    };
};
const nouns = new Map(Object.entries({
    cardboard_box: 'cardboard box', slipper: 'slipper', bed: 'bed', computer_desk: 'computer desk',
    drawing_wall: 'drawing wall', water_bowl: 'water bowl', food_bowl: 'food bowl', toy: 'yarn ball',
    cushion: 'cushion', 'env:sun': 'patch of sunlight', cat_tree: 'cat tree', wall_shelf: 'wall shelf', furniture: 'piece of furniture',
    container: 'container', textile: 'soft furnishing', environment: 'patch of light',
}));
const sentences: Record<string, string> = {
    gift_arrived: 'A visitor left a {object} by the door.', gift_unwrapped: 'She opened her gift.',
    gift_failed: 'A gift could not be opened.', object_placed: 'A {object} found a place in the room.',
    object_moved: 'The {object} moved to a new place.', object_removed: 'The {object} left the room.',
    object_stored: 'The {object} was put away.', object_state_changed: 'The {object} changed its shape.',
    slept: 'She curled up on the {object}.', woke: 'She woke up.', hid: 'She curled up in the {object}.',
    carried: 'She carried the {object} across the room.', played: 'She played with the {object}.',
    looked_out: 'She watched the view from the {object}.', used_computer: 'She spent time at her computer.',
    browse_result: 'She made a drawing after exploring.', drawing_pinned: 'She pinned a drawing on the wall.',
    intent_accepted: 'She decided to try something.', intent_rejected: 'She considered another idea.',
    intent_expired: 'She let an earlier idea go.', intent_done: 'She finished following an idea.',
    wonder_reflection: 'She reflected on her day.', searched_missing: 'She searched for a familiar {object}.',
    safe_fallback: 'She paused while the room grew quiet.', catchup: 'Her quiet routine caught up with the day.',
    object_understood: 'She discovered what the {object} was like.',
    interaction_compiled: 'She found a way to explore the {object}.',
    interaction_rejected: 'She left an unfamiliar possibility alone.', capability_gap: 'She found something beyond her reach.',
    interaction_done: 'She finished exploring the {object}.', interaction_interrupted: 'Her exploration was interrupted.',
    sound_played: 'The {object} made a sound.', experience_settled: 'She grew more familiar with the {object}.',
    budget_denied: 'She saved an idea for another day.', wish_created: 'She wished for something new.',
    wish_matched: 'A gift answered her wish.', wish_expired: 'She let a wish fade.',
    climbed: 'She climbed to the top of the {object}.', climbed_down: 'She climbed down toward the floor.',
    climbed_mid: 'She climbed onto the middle platform of the {object}.',
    pushed: 'She pushed the {object} across the floor.', physics_rejected: 'The {object} stayed where it was.',
    weather_startle: 'A rumble outside caught her attention.', sleep_deferred: 'She slept through a quiet change.',
    feature_disabled: 'She rested from her explorations.', spark_result: 'A new possibility caught her attention.',
};
// Only fixed vocabulary values enter prose; database text is never copied.
export function sentence(type: string, object?: {
    kind?: string;
    category?: string;
}) {
    const noun = nouns.get(object?.kind || '') || nouns.get(object?.category || '') || 'gift';
    const text = Object.hasOwn(sentences, type) ? sentences[type] : 'She spent a quiet moment in her room.';
    return text.replaceAll('{object}', noun);
}
async function eventProse(db: D1Database, events: Row[]) {
    const objects = await db.prepare('SELECT o.id,o.kind,c.card FROM objects o JOIN object_cards c ON c.id=o.card_id').all<Row>();
    const vocabulary = new Map(objects.results.map(o => [
        String(o.id),
        { kind: String(o.kind), category: String(parse(o.card)?.category || '') }
    ]));
    return events.map(e => {
        const payload = parse(e.payload || '{}');
        return sentence(String(e.type), vocabulary.get(String(payload.target || payload.object_id || '')));
    });
}
function limit(url: URL) {
    const n = Number(url.searchParams.get('limit') ?? 50);
    if (!Number.isInteger(n) || n < 1 || n > 200)
        throw new InputError(400, 'invalid limit');
    return n;
}
// Remove private keys recursively, including JSON serialized inside raw model/context fields.
export function judgeSafe(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(judgeSafe);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value)
            .filter(([k]) => !/visitor|giver|hash|source_url|source_key|photo_source|source_image|code|token/i.test(k))
            .map(([k, v]) => [k, judgeSafe(v)]));
    if (typeof value === 'string') {
        try {
            return JSON.stringify(judgeSafe(JSON.parse(value)));
        }
        catch { /* Plain prose. */ }
        return value.replace(/visitor:[^\s"<>]+/gi, '[private]')
            .replace(/https?:\/\/[^\s"<>]+/gi, '[private]')
            .replace(/giftsrc-[A-Za-z0-9_-]+/g, '[private]').replace(/\b[a-f0-9]{64}\b/gi, '[private]');
    }
    return value;
}
export async function brainContext(env: GiftEnv, now: number) {
    const s = await snapshot(env.DB, now);
    const rows = await env.DB.prepare(`SELECT id,at,type,payload,public FROM events
    WHERE at>=? AND at<=? ORDER BY at DESC,id LIMIT 500`)
        .bind(now - 48 * 3600000, now).all<Row>();
    const context = {
        now, events: rows.results.map(r => ({
            id: String(r.id), at: r.at, type: r.type, public: r.public, payload: judgeSafe(parse(r.payload))
        })),
        preferences: s.state.prefs, objects: s.objects.filter(o => o.status === 'placed').map(o => ({
            id: o.id, kind: o.kind, tags: o.tags, sensations: o.card.sensations,
            size: o.size, origin_type: o.origin?.type, prop_poses: o.card.prop_poses || []
        })),
        interactions: s.interactions.map(i => ({ id: i.id, object_id: i.object_id })), missing: s.state.missing
    };
    const bytes = () => new TextEncoder().encode(JSON.stringify(context)).byteLength;
    for (const items of [context.events, context.interactions, context.objects, context.missing]) {
        while (bytes() > 48 * 1024 && items.length)
            items.pop();
    }
    return context;
}
export async function inspectRoute(req: Request, env: GiftEnv, now: number): Promise<Response> {
    try {
        if (req.method !== 'GET')
            return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
        const url = new URL(req.url);
        const inspectLimited = url.pathname === '/api/record' || url.pathname === '/api/replay'
            || url.pathname.startsWith('/api/interaction/');
        if (inspectLimited) {
            const rate = await takeInspectRate(req, env, now);
            if (!rate.ok)
                return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retryAfterSec) });
        }
        const db = env.DB;
        if (url.pathname === '/api/brain/context') {
            if (!bearer(req, env))
                throw new InputError(401, 'unauthorized');
            const context = await brainContext(env, now);
            // Persist the exact event membership returned, so later validation cannot cite unseen events.
            let id = url.searchParams.get('intent_id');
            if (!id) {
                const dispatched = await db.prepare(`SELECT id FROM segments WHERE trigger_status='dispatched'
          AND json_extract(trigger,'$.kind')='reflect' ORDER BY trigger_claimed_at DESC LIMIT 1`).first<Row>();
                if (dispatched)
                    id = `seg:${dispatched.id}`;
            }
            if (id) {
                const result = await db.prepare(`UPDATE segments SET debug=json_set(COALESCE(debug,'{}'),
          '$.context_event_ids',json(?)) WHERE 'seg:' || id=? AND trigger_status='dispatched'
          AND json_extract(trigger,'$.kind')='reflect'`)
                    .bind(JSON.stringify(context.events.map(e => e.id)), id).run();
                if (!result.meta.changes)
                    throw new InputError(409, 'reflection not dispatched');
            }
            return json(context);
        }
        if (url.pathname === '/api/replay') {
            const to = Number(url.searchParams.get('to') ?? now);
            const from = Number(url.searchParams.get('from') ?? to - 3600000);
            if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to > now || from >= to || to - from > 72 * 3600000) {
                throw new InputError(400, 'invalid replay range');
            }
            const [segments, events, objects, states, weather] = await db.batch<Row>([
                db.prepare(`SELECT * FROM segments WHERE start_at<? AND end_at>? AND superseded_at IS NULL
          ORDER BY start_at,id LIMIT 201`).bind(to, from),
                db.prepare('SELECT id,at,type,payload FROM events WHERE public=1 AND at>=? AND at<? ORDER BY at,id LIMIT 501')
                    .bind(from, to),
                db.prepare(`SELECT o.id,o.kind,o.blocks,o.placement,o.size,o.tags,o.origin,c.card,
          h.x,h.y,h.z,h.footprint,h.rotation,h.status,h.state,h.sprite
          FROM objects o JOIN object_cards c ON c.id=o.card_id JOIN object_states h ON h.object_id=o.id
          WHERE h.valid_from<=? AND (h.valid_to>? OR h.valid_to IS NULL) ORDER BY o.id`).bind(from, from),
                db.prepare(`SELECT * FROM object_states WHERE valid_from>=? AND valid_from<? ORDER BY valid_from,id LIMIT ?`)
                    .bind(from, to, REPLAY_OBJECT_STATES_CAP + 1),
                db.prepare('SELECT * FROM weather WHERE hour_utc>=? AND hour_utc<? ORDER BY hour_utc')
                    .bind(Math.floor(from / 3600000) * 3600000, to),
            ]);
            return json({
                from, to, objects: objects.results.map(publicObject), segments: segments.results.slice(0, 200).map(publicSegment),
                events: (await eventProse(db, events.results.slice(0, 500))).map((text, i) => ({
                    id: events.results[i].id, at: events.results[i].at, type: events.results[i].type, sentence: text
                })),
                object_states: states.results.slice(0, REPLAY_OBJECT_STATES_CAP)
                    .map(r => ({ ...r, footprint: parse(r.footprint) })), weather: weather.results,
                truncated: segments.results.length > 200 || events.results.length > 500
                    || states.results.length > REPLAY_OBJECT_STATES_CAP
            });
        }
        const debug = url.searchParams.get('debug') === '1';
        const role = debug ? await codeRole(req, env, now) : null;
        if (debug && !role)
            throw new InputError(401, 'code required');
        if (url.pathname === '/api/record') {
            const events = await db.prepare(`SELECT * FROM events ${debug ? '' : 'WHERE public=1'} ORDER BY at DESC,id LIMIT ?`)
                .bind(limit(url)).all<Row>();
            const prose = await eventProse(db, events.results.filter(e => e.public === 1));
            if (!debug)
                return json({ record: prose });
            const [world, intents, costs, segments, gifts, cards, objects] = await db.batch<Row>([
                db.prepare('SELECT state_json FROM world WHERE id=1'),
                db.prepare('SELECT * FROM intents ORDER BY created_at DESC LIMIT 200'),
                db.prepare('SELECT * FROM model_calls ORDER BY at DESC LIMIT 200'),
                db.prepare('SELECT id,debug FROM segments ORDER BY start_at DESC LIMIT 200'),
                db.prepare('SELECT * FROM gifts ORDER BY created_at DESC LIMIT 200'),
                db.prepare('SELECT * FROM object_cards ORDER BY created_at DESC LIMIT 200'),
                db.prepare('SELECT * FROM objects ORDER BY created_at DESC LIMIT 200'),
            ]);
            const data = {
                record: prose, events: events.results, state: parse(world.results[0].state_json),
                intents: intents.results, model_costs: costs.results, candidates: segments.results, gifts: gifts.results,
                object_cards: cards.results, objects: objects.results
            };
            return json(role === 'owner' ? data : judgeSafe(data));
        }
        const id = decodeURIComponent(url.pathname.slice('/api/interaction/'.length));
        const ix = await db.prepare('SELECT * FROM interactions WHERE id=?').bind(id).first<Row>();
        if (!ix)
            throw new InputError(404, 'interaction not found');
        const [cards, segments, changes, experiences, sounds] = await db.batch<Row>([
            db.prepare('SELECT * FROM object_cards WHERE id=?').bind(ix.card_id),
            db.prepare('SELECT * FROM segments WHERE interaction=? AND superseded_at IS NULL ORDER BY start_at,id').bind(id),
            db.prepare(`SELECT * FROM object_states WHERE object_id=? AND cause IN
        (SELECT CAST(id AS TEXT) FROM segments WHERE interaction=?) ORDER BY valid_from,id`).bind(ix.object_id, id),
            db.prepare('SELECT * FROM experiences WHERE interaction_id=? ORDER BY at,id').bind(id),
            db.prepare(`SELECT * FROM events WHERE type='sound_played' AND public=1
        AND (json_extract(payload,'$.interaction_id')=? OR id IN
          (SELECT e.id FROM events e JOIN segments s ON s.interaction=?
            AND e.id LIKE 'sound_played:' || s.id || ':%')) ORDER BY at,id`).bind(id, id),
        ]);
        const card = parse(cards.results[0]?.card) as Row | undefined;
        const safeCard = card ? Object.fromEntries(Object.entries(card).filter(([k]) => k !== 'beyond_executor')) : null;
        const data = {
            id, object_id: ix.object_id, object_card: safeCard, specs: [{ spec: parse(ix.spec), source: ix.source }],
            validator_results: { status: ix.status, checks: parse(ix.checks), gaps: parse(ix.gaps || '[]') },
            executed_segments: segments.results.filter(s => Number(s.start_at) <= now).map(publicSegment),
            planned_segments: segments.results.filter(s => Number(s.start_at) > now).map(publicSegment),
            state_changes: changes.results, sound_events: sounds.results,
            experiences: experiences.results.map(e => ({ id: e.id, at: e.at, reaction: e.reaction })),
            ...(debug ? {
                debug: {
                    cards: cards.results, interaction: ix, segments: segments.results,
                    experiences: experiences.results
                }
            } : {})
        };
        return json(role === 'owner' ? data : judgeSafe(data));
    }
    catch (e) {
        if (e instanceof InputError)
            return json({ error: e.message }, e.status);
        if (e instanceof URIError)
            return json({ error: 'invalid interaction id' }, 400);
        throw e;
    }
}
