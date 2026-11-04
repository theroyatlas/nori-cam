import { ingestCloud } from './ingest.ts';
import catalog from '../../../public/cam/catalog.json' with { type: 'json' };
import { cellsOf, placementOk, poseAt, hazardActiveInState, operationCells } from '../../../public/cam-shared.js';
import { descent } from './heights.ts';
import { normalizePlacement, placementFrom } from './placement.ts';
import { json, withSecurity } from '../headers.ts';
import { parseUsd } from '../limits.ts';
import type { Deps, Env } from '../api.ts';
import { bearer, codeRole, visitorHash, type CodeEnv } from './auth.ts';
import {
  reserve, releaseBudget, reservationId, settleBudget, expireReservations, londonDay, type BudgetEnv,
} from './budget.ts';
import { dispatchWorkflow, definiteDispatchFailure } from './dispatch.ts';
import { cardWrite, eventWrite, objectWrite, writeFact, writerGuard, InputError, type Snapshot } from './facts.ts';
import { advance } from './timeline.ts';
import { bestEffortReplan } from './replan.ts';
import { workerNow } from './clock.ts';
import { validate, validateCard, hazardCardErrors, fallbackSpec, CONTRACT_VERSION } from './validate.ts';
import { pipelineSteps, costNote, modelCallWrites, type PipelineStep } from './gift-costs.ts';
import type { CamObject, CatalogEntry, Cell, ObjectCard, InteractionSpec } from './types.ts';

export type GiftEnv = Env & CodeEnv & BudgetEnv & {
  CAM_VISITOR_GIFTS_DAILY?: string;
  CAM_PHOTO_MAX_USD?: string;
  CAM_SPARK_EST_USD?: string;
  CAM_SPARK_DAILY_USD?: string;
  CAM_BROWSE_EST_USD?: string;
  CAM_BROWSE_MAX_USD?: string;
  CAM_WONDER_MAX_USD?: string;
  CAM_SPARK_ENABLED?: string;
  CAM_BROWSE_ENABLED?: string;
  CAM_REFLECT_ENABLED?: string;
  CAM_LOCAL_PIPELINE?: string;
};
interface Gift {
  id: string;
  idem: string;
  giver: string;
  kind: string;
  status: string;
  object_id: string;
  created_at: number;
}
const entries = catalog.entries as unknown as CatalogEntry[];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const GIFT_KINDS = ['cardboard_box', 'slipper', 'toy', 'cushion'];
const CATEGORIES = ['furniture', 'household', 'toy', 'instrument', 'small_equipment',
  'plant', 'food', 'stationery', 'clothing_accessory'];
const PHOTO_MAX = 5 * 1024 * 1024;
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const sourceKey = (id: string) => `giftsrc-${id}`;
const giftByIdem = (db: D1Database, idem: string, giver?: string) => (giver
  ? db.prepare('SELECT * FROM gifts WHERE idem=? AND giver=?').bind(idem, giver)
  : db.prepare('SELECT * FROM gifts WHERE idem=?').bind(idem)).first<Gift>();
const giftById = (db: D1Database, id: string) => db.prepare('SELECT * FROM gifts WHERE id=?').bind(id).first<Gift>();
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new InputError(400, 'invalid identifier');
  return value;
}
async function boundedBody(req: Request, max: number): Promise<Uint8Array> {
  if (Number(req.headers.get('Content-Length')) > max) throw new InputError(413, 'payload too large');
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new InputError(413, 'payload too large');
      }
      chunks.push(part.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await boundedBody(req, 128 * 1024)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, 'invalid JSON');
  }
}
// Nori's integer cell for placement checks, or undefined while she is inside another placed blocking object.
// Her cell is not walkable there, and overlap checks already keep blocking candidates off it.
// The object being placed is skipped so a move cannot hide its own old footprint.
function noriForPlacement(snap: Snapshot, now: number, objectId: string): { x: number; y: number } | undefined {
  const pose = poseAt(snap.segments, now) || { x: 2, y: 6 };
  // Mid-walk poses are fractional; placement keys are integer cells.
  const x = Math.round(pose.x);
  const y = Math.round(pose.y);
  const covered = snap.objects.some(o => o.id !== objectId && o.blocks &&
    cellsOf(o).some(([cx, cy]) => cx === x && cy === y));
  return covered ? undefined : { x, y };
}
// Compile from the same legal floor access the planner will use. In-flight
// climbs/carries finish before replan cuts them; their interpolated/rounded
// midpoint may lie inside a blocker and is not a valid BFS starting cell.
export function giftCompilationPosition(snap: Pick<Snapshot, 'segments' | 'state'>, objects: CamObject[], now: number): Cell {
  const pose = poseAt(snap.segments, now) || { x: 2, y: 6, z: snap.state.nori.z || 0 };
  const active = snap.segments.find(s => s.start_at <= now && s.end_at > now && ['climb','carry'].includes(s.primitive));
  let position: Cell = active?.path.at(-1) ? [...active.path.at(-1)!] : [Math.round(pose.x), Math.round(pose.y)];
  const z = active ? active.z_to ?? active.z : pose.z;
  const down = descent(objects, position, z || 0);
  if (down.length) position = down.at(-1)!.cell;
  const containing = objects.find(o => o.blocks && cellsOf(o).some(c => c[0] === position[0] && c[1] === position[1]));
  if (!down.length && containing && (containing.tags.includes('enclosed') || containing.tags.includes('high_place'))) {
    const exit = operationCells(containing, undefined, { objects, nori: { x: position[0], y: position[1] } })[0];
    if (exit) position = exit;
  }
  return position;
}
function nearDoor(snap: Snapshot, object: CamObject, now: number): CamObject {
  const nori = noriForPlacement(snap, now, object.id);
  const cells = Array.from({ length: 80 }, (_, i) => [i % 10, Math.floor(i / 10)] as Cell)
    .sort((a, b) => (a[0] + Math.abs(a[1] - 7)) - (b[0] + Math.abs(b[1] - 7)));
  for (const [x, y] of cells) {
    const candidate = { ...object, x, y };
    if (placementOk({ objects: snap.objects, nori }, candidate).ok) return candidate;
  }
  throw new InputError(409, 'no legal gift cell');
}
function interactionWrites(db: D1Database, o: CamObject, now: number, token: string) {
  // Copied props get generic behavior, never the original prefab's poses or interaction steps.
  const interactions: { spec: InteractionSpec }[] = [{ spec: {
    verb: 'approach', sensations: o.card.sensations, steps: [{ p: 'move_to', part: 'front' }, { p: 'wait', ms: 1500 }],
    end_state: null, cooldown_min: 10,
  } }];
  return interactions.map((ix, i) => {
    const raw = structuredClone(ix.spec);
    return db.prepare(`INSERT INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks,gaps)
      SELECT ?,?,?,?,'prefab',?,'accepted','[]','[]' WHERE ${writerGuard}`)
      .bind(`ix:${o.id}:${i}`, o.id, `card:${o.id}`, now, JSON.stringify(raw), token);
  });
}
async function visitorLimits(env: GiftEnv, giver: string, now: number) {
  const day = londonDay(now);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  const start = londonDay(midnight - 3600000) === day ? midnight - 3600000 : midnight;
  const end = londonDay(midnight + 23 * 3600000) === day ? midnight + 86400000 : midnight + 23 * 3600000;
  const counts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN giver=? THEN 1 ELSE 0 END) visitor, COUNT(*) total
    FROM gifts WHERE kind LIKE 'catalog:%' AND created_at>=? AND created_at<?`)
    .bind(giver, start, end).first<{ visitor: number; total: number }>();
  if ((counts?.visitor || 0) >= 1) throw new InputError(429, 'one gift per visitor per London day');
  if ((counts?.total || 0) >= parseUsd(env.CAM_VISITOR_GIFTS_DAILY, 40)) {
    throw new InputError(429, 'daily visitor gift cap reached');
  }
}
async function createGift(
  env: GiftEnv, idem: string, id: string, giver: string, entry: CatalogEntry, photo: boolean, now: number,
) {
  if (!photo) await visitorLimits(env, giver, now);
  await advance(env, now, 'read');
  const arrival = { id: `gift:${idem}`, at: now, type: 'gift_arrived', actor: giver.split(':')[0],
    payload: { gift_id: id, object_id: `o_${id}`, stored_id: null as string | null } };
  await writeFact(env.DB, arrival, now, async (snap, token) => {
    arrival.payload.stored_id = null;
    const existing = await giftByIdem(env.DB, idem, giver);
    if (existing) throw new InputError(409, 'gift already exists; retry');
    if (!photo) await visitorLimits(env, giver, now);
    const writes: D1PreparedStatement[] = [];
    const visitorObjects = snap.objects.filter(o => o.status === 'placed' &&
      (o.origin?.type === 'gift' || o.origin?.type === 'photo_gift'));
    const storeLeastFamiliar = (reason: 'visitor_room_cap' | 'room_full') => {
      const least = visitorObjects.sort((a, b) => (snap.state.familiarity[a.id] || 0) -
        (snap.state.familiarity[b.id] || 0) || a.id.localeCompare(b.id))[0];
      const stored = { ...least, status: 'stored' };
      arrival.payload.stored_id = least.id;
      writes.push(...objectWrite(env.DB, stored, `card:${least.id}`, `gift:${idem}`, now, token));
      writes.push(eventWrite(env.DB, { id: `stored:${id}`, at: now, type: 'object_stored', actor: 'nori',
        payload: { object_id: least.id, reason } }, token));
      snap.objects = snap.objects.map(o => o.id === least.id ? stored : o);
    };
    if (visitorObjects.length >= 6) storeLeastFamiliar('visitor_room_cap');
    const object = structuredClone(entry.object);
    object.id = `o_${id}`;
    object.status = 'placed';
    object.origin = { type: photo ? 'photo_gift' : 'gift', gift_id: id };
    delete object.card.prop_poses;
    let placed: CamObject;
    try {
      placed = nearDoor(snap, object, now);
    } catch (error) {
      if (!(error instanceof InputError) || error.status !== 409 || error.message !== 'no legal gift cell' ||
        arrival.payload.stored_id !== null || visitorObjects.length === 0) throw error;
      storeLeastFamiliar('room_full');
      // All writes are still only staged: if this one retry fails, nothing is stored.
      placed = nearDoor(snap, object, now);
    }
    const state = structuredClone(snap.state);
    state.novelty[placed.id] = 1;
    state.familiarity[placed.id] = 0;
    writes.push(env.DB.prepare(`UPDATE world SET state_json=? WHERE id=1 AND ${writerGuard}`)
      .bind(JSON.stringify(state), token));
    writes.push(cardWrite(env.DB, placed, `card:${placed.id}`, now, token));
    writes.push(...objectWrite(env.DB, placed, `card:${placed.id}`, `gift:${idem}`, now, token));
    writes.push(...interactionWrites(env.DB, placed, now, token));
    writes.push(env.DB.prepare(`INSERT INTO gifts (id,idem,insert_token,giver,kind,status,object_id,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${writerGuard}`)
      .bind(id, idem, token, giver, photo ? 'photo' : `catalog:${entry.object.kind}`,
        photo ? 'processing' : 'placed', placed.id, now, now, token));
    if (!photo) {
      writes.push(env.DB.prepare(`INSERT INTO rate_hits (ip_hash,bucket,n) SELECT ?,?,1 WHERE ${writerGuard}
        ON CONFLICT(ip_hash,bucket) DO UPDATE SET n=n+1`).bind(`gift:${giver}`, Math.floor(now / 86400000), token));
    }
    return writes;
  });
  await bestEffortReplan(env.DB, now);
}
export async function catalogGift(req: Request, env: GiftEnv, now: number) {
  const body = await readJson(req);
  const idem = identifier(body.idem);
  const giver = `visitor:${await visitorHash(req, env, now)}`;
  const existing = await giftByIdem(env.DB, idem, giver);
  if (existing) return json({ gift_id: existing.id, status: existing.status });
  const entry = entries.find(e => e.object.kind === body.catalog_key);
  if (!entry || !GIFT_KINDS.includes(entry.object.kind)) {
    throw new InputError(400, 'unknown catalog key');
  }
  const id = randomId();
  await createGift(env, idem, id, giver, entry, false, now);
  const result = await giftByIdem(env.DB, idem, giver);
  return json({ gift_id: result!.id, status: result!.status });
}
export async function photoGift(req: Request, env: GiftEnv, deps: Deps, now: number) {
  if (!env.JUDGE_CODE_SHA256 && !env.OWNER_CODE_SHA256) throw new InputError(503, 'photo gifts not enabled');
  const role = await codeRole(req, env, now);
  if (!role) throw new InputError(401, 'invalid code');
  await expireReservations(env.DB, now);
  let form: FormData;
  try {
    const bytes = await boundedBody(req, PHOTO_MAX + 16384);
    form = await new Response(bytes.buffer as ArrayBuffer, {
      headers: { 'Content-Type': req.headers.get('Content-Type') || '' },
    }).formData();
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, 'invalid multipart form');
  }
  const idem = identifier(form.get('idem'));
  const prior = await giftByIdem(env.DB, idem, role);
  if (prior) return json({ gift_id: prior.id, status: prior.status });
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new InputError(400, 'file required');
  if (file.size > PHOTO_MAX) throw new InputError(413, 'payload too large');
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new InputError(415, 'jpeg or png required');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if ((file.type === 'image/png' && !png) || (file.type === 'image/jpeg' && !jpeg)) {
    throw new InputError(415, 'image signature does not match');
  }
  const id = randomId();
  const purpose = `${role}_photo`;
  const reservation = reservationId(purpose, id);
  const cap = parseUsd(role === 'owner' ? env.CAM_OWNER_PHOTO_CAP : env.CAM_JUDGE_PHOTO_CAP, 10);
  if (!await reserve(env, purpose, id, parseUsd(env.CAM_PHOTO_EST_USD, 0.08), cap, now)) {
    throw new InputError(429, 'photo budget exhausted');
  }
  let created = false;
  try {
    await env.MEDIA.put(sourceKey(id), bytes, { expirationTtl: 3600, metadata: { contentType: file.type } });
    const box = structuredClone(entries.find(e => e.object.kind === 'cardboard_box')!);
    box.object.kind = 'parcel';
    await createGift(env, idem, id, role, box, true, now);
    const gift = await giftByIdem(env.DB, idem);
    created = gift?.id === id;
    if (!created) {
      await env.MEDIA.delete(sourceKey(id));
      await releaseBudget(env.DB, reservation, now).run();
      return json({ gift_id: gift!.id, status: gift!.status });
    }
  } catch (error) {
    // A fact may already be committed; only clean up an intake that did not commit.
    if (!await giftById(env.DB, id)) {
      await env.MEDIA.delete(sourceKey(id));
      await releaseBudget(env.DB, reservation, now).run();
    }
    throw error;
  }
  try {
    if (env.CAM_LOCAL_PIPELINE === '1') {
      // Local e2e runner invokes the Python pipeline; GitHub dispatch is skipped.
    } else {
      await dispatchWorkflow(env, 'nori-gift.yml', { gift_id: id }, deps.fetch);
    }
  } catch (error) {
    if (definiteDispatchFailure(error)) {
      const gift = await giftById(env.DB, id);
      if (gift) await failGift(env, gift, 'dispatch', [], 0, now, true);
      throw new InputError(502, 'photo dispatch failed');
    }
    // The request may have been accepted. Keep its reservation until ingest or the 20-minute timeout.
    return json({ gift_id: id, status: 'processing' });
  }
  return json({ gift_id: id, status: 'processing' });
}
// Public photo-gift progress. Read-only: the id is an unguessable 32-hex
// random value, so no auth. Returns only the fields the gift panel needs;
// never the giver, idem, insert token, costs, pipeline internals, photo
// data or any code.
const STATUS_ID = /^[0-9a-f]{32}$/;
function publicReason(step: string | null): string {
  switch (step) {
    case 'timeout':
      return 'timeout';
    case 'understand':
      return 'content_refused';
    case 'box':
    case 'redraw':
    case 'pixelize':
      return 'draw_failed';
    default:
      return 'unavailable';
  }
}
function failedPipelineStep(pipeline: unknown): string | null {
  if (!Array.isArray(pipeline)) return null;
  for (const entry of pipeline) {
    if (entry && typeof entry === 'object' && (entry as { ok?: unknown }).ok === false &&
      typeof (entry as { step?: unknown }).step === 'string') {
      return (entry as { step: string }).step;
    }
  }
  return null;
}
export async function giftStatus(req: Request, env: GiftEnv, id: string) {
  void req;
  if (!STATUS_ID.test(id)) return json({ error: 'not_found' }, 404);
  const gift = await env.DB.prepare(
    'SELECT id,status,object_id,pipeline,updated_at FROM gifts WHERE id=?').bind(id)
    .first<{ id: string; status: string; object_id: string; pipeline: string | null; updated_at: number }>();
  if (!gift) return json({ error: 'not_found' }, 404);
  let name: string | null = null;
  let sprite: string | null = null;
  if (gift.status === 'ready' || gift.status === 'placed') {
    const object = await env.DB.prepare('SELECT sprite FROM objects WHERE id=?').bind(gift.object_id)
      .first<{ sprite: string }>();
    if (object && typeof object.sprite === 'string' && object.sprite.startsWith('/media/')) {
      sprite = object.sprite;
    }
    const card = await env.DB.prepare(`SELECT card FROM object_cards WHERE object_id=?
      ORDER BY created_at DESC LIMIT 1`).bind(gift.object_id).first<{ card: string }>();
    if (card && typeof card.card === 'string') {
      try {
        const parsed: unknown = JSON.parse(card.card);
        if (parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string') {
          name = (parsed as { name: string }).name;
        }
      } catch {
        // Corrupt card row: leave the name null rather than failing the status read.
      }
    }
  }
  let reason: string | null = null;
  if (gift.status === 'failed') {
    let step: string | null = null;
    const terminal = await env.DB.prepare('SELECT payload FROM events WHERE id=?')
      .bind(`gift-terminal:${gift.id}`).first<{ payload: string }>();
    if (terminal && typeof terminal.payload === 'string') {
      try {
        const payload: unknown = JSON.parse(terminal.payload);
        if (payload && typeof payload === 'object' && typeof (payload as { step?: unknown }).step === 'string') {
          step = (payload as { step: string }).step;
        }
      } catch {
        // Fall through to the pipeline below.
      }
    }
    if (!step && typeof gift.pipeline === 'string' && gift.pipeline) {
      try {
        step = failedPipelineStep(JSON.parse(gift.pipeline));
      } catch {
        // Keep the step null; the reason below still yields a public code.
      }
    }
    reason = publicReason(step);
  }
  return json({ gift_id: gift.id, status: gift.status, name, sprite, reason, updated_at: gift.updated_at });
}
export async function giftSource(req: Request, env: GiftEnv, id: string) {
  if (!bearer(req, env)) throw new InputError(401, 'unauthorized');
  identifier(id);
  const gift = await giftById(env.DB, id);
  if (!gift || gift.status !== 'processing') throw new InputError(404, 'not found');
  const source = await env.MEDIA.getWithMetadata<{ contentType: string }>(sourceKey(id), 'arrayBuffer');
  if (!source.value) return json({ error: 'source pending' }, 409, { 'Retry-After': '5' });
  return withSecurity(new Response(source.value, { headers: {
    'Content-Type': source.metadata?.contentType || 'application/octet-stream', 'Cache-Control': 'no-store',
  } }));
}
function terminalWrites(db: D1Database, gift: Gift, status: string, pipeline: unknown[], now: number, token: string) {
  return db.prepare(`UPDATE gifts SET status=?,pipeline=?,updated_at=? WHERE id=? AND status='processing' AND ${writerGuard}`)
    .bind(status, JSON.stringify(pipeline), now, gift.id, token);
}
function terminalGuard(token: string) {
  // Token is generated locally, never derived from request data.
  return `(SELECT writer FROM world WHERE id=1)='${token}'`;
}
async function failGift(
  env: GiftEnv, gift: Gift, step: string, pipeline: PipelineStep[], cost: number, now: number, release = false,
) {
  await advance(env, now, 'read');
  await writeFact(env.DB, { id: `gift-terminal:${gift.id}`, at: now, type: 'gift_failed', actor: 'system',
    payload: { gift_id: gift.id, object_id: gift.object_id, step } }, now, (snap, token) => {
    const object = snap.objects.find(o => o.id === gift.object_id)!;
    const box = { ...object, kind: 'cardboard_box' };
    const ledger = reservationId(`${gift.giver}_photo`, gift.id);
    return [terminalWrites(env.DB, gift, 'failed', pipeline, now, token),
      ...modelCallWrites(env.DB, gift.id, pipeline, now, token),
      ...objectWrite(env.DB, box, `card:${box.id}`, `failed:${gift.id}`, now, token),
      release ? env.DB.prepare(`UPDATE budget_ledger SET status='released',settled_at=?,note='dispatch_failed'
        WHERE id=? AND status='reserved' AND ${writerGuard}`).bind(now, ledger, token)
        : settleBudget(env.DB, ledger, cost, now, costNote(pipeline), terminalGuard(token))];
  });
  await env.MEDIA.delete(sourceKey(gift.id));
  await bestEffortReplan(env.DB, now);
}
export async function ingestGift(req: Request, env: GiftEnv, now: number) {
  if (!bearer(req, env)) throw new InputError(401, 'unauthorized');
  const body = await readJson(req);
  if (['browse_result', 'wonder_result'].includes(String(body.type))) return ingestCloud(body, env, now);
  if (!['gift_ready', 'gift_failed'].includes(String(body.type))) throw new InputError(400, 'unsupported ingest type');
  const id = identifier(body.gift_id);
  const gift = await giftById(env.DB, id);
  if (!gift || gift.kind !== 'photo') throw new InputError(404, 'gift not found');
  if (gift.status !== 'processing') {
    await env.MEDIA.delete(sourceKey(id));
    return json({ gift_id: id, status: gift.status });
  }
  const cost = body.cost_usd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new InputError(400, 'invalid cost');
  const pipeline = pipelineSteps(body.pipeline);
  if (cost > parseUsd(env.CAM_PHOTO_MAX_USD, 0.50) ||
    Math.abs(cost - pipeline.reduce((sum, step) => sum + step.cost_usd, 0)) > 0.001 + Number.EPSILON) {
    throw new InputError(400, 'inconsistent or excessive cost');
  }
  if (body.type === 'gift_failed') {
    if (!['fetch_source', 'understand', 'box', 'redraw', 'pixelize', 'upload', 'ingest'].includes(String(body.step))) {
      throw new InputError(400, 'invalid failed step');
    }
    await failGift(env, gift, String(body.step), pipeline, cost, now);
  } else {
    if (body.contract_version !== CONTRACT_VERSION) throw new InputError(422, 'unsupported contract version');
    // A mixed contract is a contract violation whatever the values: refuse
    // any envelope (or nested card) carrying a legacy safety field.
    for (const holder of [body, body.object_card])
      if (holder && typeof holder === 'object' && ('safe' in holder || 'person_present' in holder))
        throw new InputError(422, 'legacy safety field');
    const safety = body.content_safety as { ok?: unknown; reason?: unknown } | undefined;
    if (!safety || safety.ok !== true || typeof safety.reason !== 'string' || !safety.reason.length)
      throw new InputError(422, 'content safety refusal');
    if (body.identifiable_person_present !== false) throw new InputError(422, 'product person rule');
    const errors = [...validateCard(body.object_card), ...hazardCardErrors(body.object_card)];
    if (errors.length) throw new InputError(422, 'invalid ObjectCard');
    const card = body.object_card as ObjectCard;
    if (!/^[A-Za-z]+(?:[ -][A-Za-z]+){0,3}$/.test(card.name) || !CATEGORIES.includes(card.category)) {
      throw new InputError(422, 'invalid gift name or category');
    }
    if (typeof body.initial_state !== 'string' || !card.states.includes(body.initial_state))
      throw new InputError(422, 'initial state must be a card state');
    if (body.name !== card.name || body.size !== card.size || body.sprite !== `/media/gift-${id}.png`) {
      throw new InputError(422, 'gift envelope does not match card or sprite');
    }
    if (!Array.isArray(body.interactions) || body.interactions.length > 3) throw new InputError(422, 'invalid candidates');
    const candidates = body.interactions;
    if (!await env.MEDIA.get(`gift-${id}.png`, 'arrayBuffer')) {
      return json({ error: 'sprite pending' }, 409, { 'Retry-After': '5' });
    }
    await advance(env, now, 'read');
    await writeFact(env.DB, { id: `gift-terminal:${id}`, at: now, type: 'gift_unwrapped', actor: 'system',
      payload: { gift_id: id, object_id: gift.object_id } }, now, (snap, token) => {
      const parcel = snap.objects.find(o => o.id === gift.object_id)!;
      const w = Math.max(1, Math.round(card.space.cm.w / 40));
      const h = Math.max(1, Math.round(card.space.cm.d / 40));
      // D1fix7: the executor supports only 'floor' and 'wall'; any other
      // card placement ('surface', 'table', missing, unknown) becomes 'floor'
      // on the object. The stored card keeps what Spark said.
      const placement_from = placementFrom(card.space.placement);
      let object: CamObject = { ...parcel, kind: card.category, card, tags: card.tags, size: card.size,
        blocks: card.space.blocks, placement: normalizePlacement(card.space.placement), sprite: String(body.sprite),
        state: String(body.initial_state),
        footprint: Array.from({ length: w * h }, (_, i) => [i % w, Math.floor(i / w)] as Cell) };
      const pose = poseAt(snap.segments, now) || { x: 2, y: 6 };
      const nori = noriForPlacement(snap, now, object.id);
      // Try the original anchor first, then the closest legal real footprint.
      const cells = Array.from({ length: 80 }, (_, i) => [i % 10, Math.floor(i / 10)] as Cell)
        .sort((a, b) => (Math.abs(a[0] - parcel.x) + Math.abs(a[1] - parcel.y)) -
          (Math.abs(b[0] - parcel.x) + Math.abs(b[1] - parcel.y)));
      // D1fix4 (P1-a): placementOk refuses a hazard-active object on Nori's
      // cell, so the search picks another legal cell for a hot gift on its own.
      const hazardous = hazardActiveInState(card, object.state);
      const legal = cells.map(([x, y]) => ({ ...object, x, y })).find(candidate =>
        placementOk({ objects: snap.objects, nori }, candidate).ok);
      const parcelBlocked = hazardous && !placementOk({ objects: snap.objects, nori },
        { ...object, x: parcel.x, y: parcel.y }).ok;
      if (legal) object = legal;
      else if (hazardous) {
        // No safe cell exists while she stands there: keep the gift stored
        // instead of placing a hazard on her; the event below records it.
        object = { ...object, status: 'stored', footprint: [[0, 0]], x: parcel.x, y: parcel.y };
      }
      else object = { ...object, footprint: [[0, 0]], x: parcel.x, y: parcel.y };
      const writes: D1PreparedStatement[] = [terminalWrites(env.DB, gift, 'ready', pipeline, now, token),
        ...modelCallWrites(env.DB, gift.id, pipeline, now, token),
        cardWrite(env.DB, object, `card:${object.id}`, now, token, 'spark_vision'),
        ...objectWrite(env.DB, object, `card:${object.id}`, `unwrapped:${id}`, now, token),
        env.DB.prepare(`UPDATE interactions SET status='rejected' WHERE object_id=? AND ${writerGuard}`)
          .bind(object.id, token),
        settleBudget(env.DB, reservationId(`${gift.giver}_photo`, id), cost, now,
          costNote(pipeline), terminalGuard(token)),
        eventWrite(env.DB, { id: `understood:${id}`, at: now, type: 'object_understood', actor: 'system',
          payload: { object_id: object.id, contract_version: CONTRACT_VERSION,
            ...(placement_from ? { placement_from } : {}) } }, token)];
      if (legal && parcelBlocked) writes.push(eventWrite(env.DB, { id: `placed-off-nori:${id}`, at: now,
        type: 'safe_fallback', actor: 'system', payload: { object_id: object.id, x: legal.x, y: legal.y,
          reason: 'hazard keeps gift off Nori' } }, token));
      if (!legal && hazardous) writes.push(eventWrite(env.DB, { id: `stored-off-nori:${id}`, at: now,
        type: 'object_stored', actor: 'system', payload: { object_id: object.id,
          reason: 'no safe cell: hazard keeps gift off Nori' } }, token));
      const state = structuredClone(snap.state);
      state.novelty[object.id] = 1;
      writes.push(env.DB.prepare(`UPDATE world SET state_json=? WHERE id=1 AND ${writerGuard}`)
        .bind(JSON.stringify(state), token));
      let usable = 0;
      const compilationObjects = snap.objects.map(o => o.id === object.id ? object : o);
      const compilationPosition = giftCompilationPosition(snap, compilationObjects, now);
      candidates.forEach((candidate, i) => {
        const result = validate({ objects: compilationObjects }, object, candidate, compilationPosition);
        if (result.status !== 'rejected') usable++;
        writes.push(env.DB.prepare(`INSERT INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks,gaps)
          SELECT ?,?,?,?,'compiled',?,?,?,? WHERE ${writerGuard}`)
          .bind(`compiled:${id}:${i}`, object.id, `card:${object.id}`, now, JSON.stringify(result.spec || candidate),
            result.status, JSON.stringify(result.checks), JSON.stringify(result.gaps), token));
        writes.push(eventWrite(env.DB, { id: `compiled:${id}:${i}`, at: now,
          type: result.status === 'rejected' ? 'interaction_rejected' : 'interaction_compiled', actor: 'system',
          payload: { object_id: object.id, interaction_id: `compiled:${id}:${i}` } }, token));
        if (result.gaps.length) writes.push(eventWrite(env.DB, { id: `gap:${id}:${i}`, at: now,
          type: 'capability_gap', actor: 'system', payload: { object_id: object.id, gaps: result.gaps } }, token));
      });
      if (!usable) {
        // The fallback tries every approach side in turn (F6): an object at
        // the room edge may be unreachable from its front but legal from
        // another side. The first side that validates is recorded as before.
        let checked = validate({ objects: compilationObjects }, object, fallbackSpec(), compilationPosition);
        if (checked.status === 'rejected' || !checked.spec)
          for (const side of ['back', 'left', 'right', 'top']) {
            checked = validate({ objects: compilationObjects }, object, fallbackSpec(side), compilationPosition);
            if (checked.status !== 'rejected' && checked.spec) break;
          }
        if (checked.status !== 'rejected' && checked.spec) {
          writes.push(env.DB.prepare(`INSERT INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks,gaps)
            SELECT ?,?,?,?,'fallback',?,?,?,? WHERE ${writerGuard}`)
            .bind(`fallback:${id}:0`, object.id, `card:${object.id}`, now, JSON.stringify(checked.spec),
              checked.status, JSON.stringify(checked.checks), JSON.stringify(checked.gaps), token));
          writes.push(eventWrite(env.DB, { id: `fallback:${id}:0`, at: now,
            type: 'interaction_compiled', actor: 'system',
            payload: { object_id: object.id, interaction_id: `fallback:${id}:0`, fallback: true } }, token));
        } else {
          // No approach side is legal: record an explicit, visible
          // no-safe-interaction outcome instead of silence (F6).
          writes.push(env.DB.prepare(`INSERT INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks,gaps)
            SELECT ?,?,?,?,'fallback',?,?,?,? WHERE ${writerGuard}`)
            .bind(`fallback:${id}:0`, object.id, `card:${object.id}`, now, JSON.stringify(fallbackSpec()),
              'rejected', JSON.stringify(checked.checks), JSON.stringify(checked.gaps), token));
          writes.push(eventWrite(env.DB, { id: `fallback:${id}:0`, at: now,
            type: 'interaction_rejected', actor: 'system',
            payload: { object_id: object.id, interaction_id: `fallback:${id}:0`, fallback: true,
              reason: 'no safe interaction: fallback unreachable from every side' } }, token));
        }
      }
      if (card.beyond_executor.length) writes.push(eventWrite(env.DB, { id: `gap:${id}:card`, at: now,
        type: 'capability_gap', actor: 'system', payload: { object_id: object.id, gaps: card.beyond_executor } }, token, 0));
      return writes;
    });
    await env.MEDIA.delete(sourceKey(id));
    await bestEffortReplan(env.DB, now);
  }
  const terminal = await giftById(env.DB, id);
  return json({ gift_id: id, status: terminal!.status });
}
export async function ownerObject(req: Request, env: GiftEnv, now: number) {
  const role = await codeRole(req, env, now);
  if (role !== 'owner') throw new InputError(role === 'judge' ? 403 : 401, 'owner code required');
  const body = await readJson(req);
  const id = identifier(body.id);
  const idem = identifier(body.idem);
  if (body.op !== 'move' && body.op !== 'remove') throw new InputError(400, 'invalid operation');
  const replayed = async () => {
    const priorEvent = await env.DB.prepare('SELECT payload,type FROM events WHERE id=?')
      .bind(`owner:${idem}`).first<{ payload: string; type: string }>();
    if (!priorEvent) return false;
    const payload = JSON.parse(priorEvent.payload);
    if (payload.object_id !== id || priorEvent.type !== (body.op === 'move' ? 'object_moved' : 'object_removed') ||
      (body.op === 'move' && (payload.x !== body.x || payload.y !== body.y))) {
      throw new InputError(409, 'idempotency target differs');
    }
    return true;
  };
  if (await replayed()) return json({ ok: true });
  await advance(env, now, 'read');
  const committed = await writeFact(env.DB, { id: `owner:${idem}`, at: now, actor: 'owner',
    type: body.op === 'move' ? 'object_moved' : 'object_removed',
    payload: { object_id: id, ...(body.op === 'move' ? { x: body.x, y: body.y } : {}) } }, now, (snap, token) => {
    const prior = snap.objects.find(o => o.id === id && o.status === 'placed');
    if (!prior) throw new InputError(404, 'object not placed');
    if (!prior.card_id) throw new InputError(503, 'object card unavailable');
    const object = { ...prior };
    if (body.op === 'remove') object.status = 'removed';
    else {
      if (!Number.isInteger(body.x) || !Number.isInteger(body.y)) throw new InputError(400, 'integer coordinates required');
      object.x = Number(body.x);
      object.y = Number(body.y);
      const nori = noriForPlacement(snap, now, id);
      if (!placementOk({ objects: snap.objects, nori }, object).ok) {
        throw new InputError(422, 'illegal placement');
      }
    }
    const state = structuredClone(snap.state);
    if (body.op === 'remove') state.missing.push({ object_id: id, kind: prior.kind, x: prior.x, y: prior.y,
      familiarity: state.familiarity[id] || 0, since: now });
    return [...objectWrite(env.DB, object, prior.card_id, `owner:${idem}`, now, token),
      env.DB.prepare(`UPDATE world SET state_json=? WHERE id=1 AND ${writerGuard}`).bind(JSON.stringify(state), token)];
  });
  if (!committed) await replayed();
  await bestEffortReplan(env.DB, now);
  return json({ ok: true });
}
export async function giftRoute(req: Request, env: GiftEnv, deps: Deps): Promise<Response> {
  const now = (deps.now || (() => workerNow(env)))();
  const path = new URL(req.url).pathname;
  try {
    const source = path.startsWith('/api/gift/source/');
    const statusPath = path.startsWith('/api/gift/status/');
    if (source || statusPath) {
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    } else if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if ((path === '/api/gift' || path === '/api/owner/object') &&
      req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new InputError(415, 'application/json required');
    }
    if (statusPath) return await giftStatus(req, env, path.slice('/api/gift/status/'.length));
    if (source) return await giftSource(req, env, path.slice('/api/gift/source/'.length));
    if (path === '/api/gift') return await catalogGift(req, env, now);
    if (path === '/api/gift/photo') return await photoGift(req, env, deps, now);
    if (path === '/api/ingest') return await ingestGift(req, env, now);
    return await ownerObject(req, env, now);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    console.error('cam_gift_error', error instanceof Error ? error.name : 'UnknownError',
      error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'gift operation unavailable' }, 500);
  }
}
