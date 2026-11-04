import { enrichObject, decodeHeight } from './heights.ts';
import type { CamObject, CamEvent, Experience, Interaction, Segment, WorldState } from './types.ts';
import type { WeatherRow } from './weather.ts';
export interface WorldRow {
    id: number;
    version: number;
    writer: string;
    engine_version: string;
    timeline_until: number;
    state_json: string;
    updated_at: number;
    pending_events?: number;
    cloud_pending?: number;
}
type Row = Record<string, unknown>;
const encode = JSON.stringify;
const decode = <T>(value: unknown): T => JSON.parse(String(value));
export function readWorld(db: D1Database, now = Date.now()) {
    return db.prepare(`SELECT world.*, EXISTS(SELECT 1 FROM events e WHERE e.handled_version IS NULL AND NOT EXISTS
      (SELECT 1 FROM events d WHERE d.id='sleep-defer:' || e.id || ':' || world.version)) AS pending_events,
    (EXISTS(SELECT 1 FROM events e WHERE e.type IN ('gift_arrived','gift_unwrapped','woke') AND e.at>=?
      AND NOT EXISTS(SELECT 1 FROM model_calls m WHERE m.id='spark:' || e.id))
      OR EXISTS(SELECT 1 FROM intents WHERE status='active' AND expires_at<=?)
      OR EXISTS(SELECT 1 FROM segments WHERE start_at<=? AND end_at>? AND superseded_at IS NULL
        AND json_extract(trigger,'$.kind') IN ('browse','reflect') AND (trigger_claimed_at IS NULL OR
          (trigger_status='failed' AND COALESCE(json_extract(debug,'$.trigger_attempts'),0)<2)))) AS cloud_pending
    FROM world WHERE id=1`).bind(now - 86400000, now, now, now).first<WorldRow>();
}
export function objectsQuery(db: D1Database) {
    return db.prepare('SELECT o.*, c.card FROM objects o JOIN object_cards c ON c.id = o.card_id ORDER BY o.id');
}
export function decodeObject(r: Row): CamObject {
    return enrichObject({
        ...r, blocks: !!r.blocks, tags: decode(r.tags), footprint: decode(r.footprint), origin: decode(r.origin),
        card: decode(r.card)
    } as unknown as CamObject);
}
export function decodeSegment(r: Row): Segment {
    return decodeHeight({
        ...r, path: decode(r.path), effects: decode(r.effects || '[]'), trigger: r.trigger ? decode(r.trigger) : null,
        completion: r.completion ? decode(r.completion) : undefined
    } as unknown as Segment);
}
export function unsettledQuery(db: D1Database) {
    return db.prepare('SELECT * FROM segments WHERE settled_at IS NULL AND superseded_at IS NULL ORDER BY end_at, id');
}
export function interactionsQuery(db: D1Database) {
    return db.prepare("SELECT id, object_id, spec FROM interactions WHERE status IN ('accepted', 'degraded') ORDER BY id");
}
export function weatherQuery(db: D1Database, now = Date.now()) {
    return db.prepare('SELECT * FROM weather WHERE hour_utc >= ? ORDER BY hour_utc').bind(now - 4 * 3600000);
}
// A batch is also an atomic read snapshot: no mixed-version geometry/segments.
export async function snapshot(db: D1Database, now = Date.now()) {
    const [w, o, s, i, weather, last] = await db.batch<Row>([
        db.prepare(`SELECT *, (SELECT json_group_array(json_object('id',id,'accepted',accepted,'expires_at',expires_at))
        FROM intents WHERE status='active' AND expires_at>?) AS active_intents FROM world WHERE id=1`).bind(now),
        objectsQuery(db), unsettledQuery(db), interactionsQuery(db), weatherQuery(db, now),
        db.prepare('SELECT * FROM segments WHERE superseded_at IS NULL ORDER BY end_at DESC, id DESC LIMIT 1'),
    ]);
    const world = w.results[0] as unknown as WorldRow | undefined;
    if (!world)
        throw new Error('cam_not_seeded');
    const interactions = i.results.map(r => {
        const { action, ...spec } = decode<Interaction['spec'] & {
            action?: string;
        }>(r.spec);
        return { id: String(r.id), object_id: String(r.object_id), action, spec };
    });
    return {
        world, state: decode<WorldState>(world.state_json), objects: o.results.map(decodeObject),
        segments: s.results.map(decodeSegment), interactions, weather: weather.results as unknown as WeatherRow[],
        intents: decode<Record<string, unknown>[]>(w.results[0].active_intents).map(r => ({
            ...decode<import('./spark-validate.ts').ActiveIntent>(r.accepted),
            id: String(r.id), expires_at: Number(r.expires_at)
        })),
        last: last.results[0] ? decodeSegment(last.results[0]) : undefined,
    };
}
export function claimWorld(db: D1Database, world: WorldRow, token: string, state: WorldState, until: number, now: number) {
    return db.prepare(`UPDATE world
      SET version = version + 1, writer = ?, state_json = ?, timeline_until = ?, updated_at = ?
      WHERE id = 1
      AND version = ?`)
        .bind(token, encode(state), until, now, world.version);
}
const guard = '(SELECT writer FROM world WHERE id = 1) = ?';
export function insertSegment(db: D1Database, s: Segment, token: string) {
    const columns = [
        'id', 'start_at', 'end_at', 'action', 'primitive', 'pose', 'facing', 'path', 'z', 'target', 'part', 'carrying', 'interaction',
        'effects', 'source', 'world_version', 'cut_at', 'settled_at', 'superseded_at', 'trigger', 'completion'
    ] as const;
    const json = new Set(['path', 'effects', 'trigger', 'completion']);
    return db.prepare(`INSERT INTO segments (${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE ${guard}`)
        .bind(...columns.map(k => s[k] == null ? null : json.has(k) ? encode(s[k]) : s[k]), token);
}
export function insertEvent(db: D1Database, e: CamEvent, version: number, token: string, segmentId?: number, isPublic = 1) {
    return db.prepare(`INSERT OR IGNORE INTO events (id, insert_token, at, type, actor, payload, public, world_version, handled_version)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?,
      ? WHERE ${guard}${segmentId == null ? '' : ' AND EXISTS (SELECT 1 FROM segments WHERE id = ? AND settled_at IS NULL)'}`)
        .bind(e.id, token, e.at, e.type, e.actor, encode(e.payload), isPublic, version, version, token,
          ...(segmentId == null ? [] : [segmentId]));
}
export function insertExperience(db: D1Database, e: Experience, token: string, segmentId: number) {
    const keys = Object.keys(e) as (keyof Experience)[];
    return db.prepare(`INSERT OR IGNORE INTO experiences (${keys.join(',')})
    SELECT ${keys.map(() => '?').join(',')} WHERE ${guard}
    AND EXISTS (SELECT 1 FROM segments WHERE id = ? AND settled_at IS NULL)`)
        .bind(...keys.map(k => typeof e[k] === 'object' ? encode(e[k]) : e[k]), token, segmentId);
}
export function markSettled(db: D1Database, s: Segment, token: string) {
    return db.prepare(`UPDATE segments SET settled_at = ? WHERE id = ? AND settled_at IS NULL AND ${guard}`)
        .bind(s.settled_at, s.id, token);
}
export function persistObject(db: D1Database, o: CamObject, s: Segment, token: string) {
    const g = `${guard} AND EXISTS (SELECT 1 FROM segments WHERE id = ? AND settled_at IS NULL)`;
    return [
        db.prepare(`UPDATE objects SET x=?, y=?, z=?, footprint=?, rotation=?, status=?, state=?, sprite=? WHERE id=? AND ${g}`)
            .bind(o.x, o.y, o.z, encode(o.footprint), o.rotation, o.status, o.state, o.sprite, o.id, token, s.id),
        db.prepare(`UPDATE object_states SET valid_to=? WHERE object_id=? AND valid_to IS NULL AND ${g}`).bind(s.end_at, o.id, token, s.id),
        db.prepare(`INSERT INTO object_states (object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${g}`)
            .bind(o.id, s.end_at, o.x, o.y, o.z, encode(o.footprint), o.rotation, o.status, o.state, o.sprite, String(s.id), token, s.id),
    ];
}
export async function readPublic(db: D1Database, from: number, now = Date.now()) {
    const [w, o, s, weather] = await db.batch<Row>([
        db.prepare('SELECT * FROM world WHERE id=1'), objectsQuery(db),
        db.prepare('SELECT * FROM segments WHERE superseded_at IS NULL AND end_at > ? ORDER BY start_at, id LIMIT 200').bind(from),
        weatherQuery(db, now)
    ]);
    return {
        world: w.results[0] as unknown as WorldRow, objects: o.results.map(decodeObject), segments: s.results.map(decodeSegment),
        weather: weather.results as unknown as WeatherRow[]
    };
}
export function supersedeUnsettled(db: D1Database, now: number, token: string) {
    return db.prepare(`UPDATE segments SET superseded_at = ?
    WHERE settled_at IS NULL AND superseded_at IS NULL AND ${guard}`).bind(now, token);
}
