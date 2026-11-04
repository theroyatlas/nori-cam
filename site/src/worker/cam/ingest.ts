import { json } from '../headers.ts';
import { parseUsd } from '../limits.ts';
import { mediaType } from '../media.ts';
import { advance } from './timeline.ts';
import { InputError, writeFact, eventWrite, objectWrite, cardWrite, writerGuard } from './facts.ts';
import { validateWonderResult, type SparkIntent } from './spark-validate.ts';
import { bestEffortReplan } from './replan.ts';
import { canDrawingSequence } from './drawing-plan.ts';
import { poseAt } from '../../../public/cam-shared.js';
import { snapshot } from './store.ts';
import type { GiftEnv } from './gifts.ts';
import type { CamObject, Sensation } from './types.ts';

type Row = Record<string, unknown>;
export async function ingestCloud(body: Row, env: GiftEnv, now: number): Promise<Response> {
  const db = env.DB;
  const type = String(body.type);
  const ref = body.intent_id;
  if (typeof ref !== 'string' || !/^seg:\d+$/.test(ref)) throw new InputError(400, 'invalid intent_id');
  const key = `ingest:${ref}:${type}`;
  if (await db.prepare('SELECT id FROM events WHERE id=?').bind(key).first()) return json({ ok: true, duplicate: true });
  const seg = await db.prepare('SELECT * FROM segments WHERE id=?').bind(Number(ref.slice(4))).first<Row>();
  const kind = type === 'browse_result' ? 'browse' : 'reflect';
  if (!seg || JSON.parse(String(seg.trigger || '{}')).kind !== kind) throw new InputError(409, 'trigger not found');
  const purpose = kind === 'browse' ? 'browse' : 'wonder';
  const reservations = await db.prepare(`SELECT id FROM budget_ledger WHERE id IN (?,?)
    AND status!='released' ORDER BY created_at DESC,id DESC LIMIT 1`)
    .bind(`res:${purpose}:${ref}`, `res:${purpose}:${ref}:retry`).all<{ id: string }>();
  if (!reservations.results.length) throw new InputError(409, 'reservation not found');
  const cost = body.cost_usd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new InputError(400, 'invalid cost');
  const maxCost = kind === 'browse'
    ? parseUsd(env.CAM_BROWSE_MAX_USD, 1)
    : parseUsd(env.CAM_WONDER_MAX_USD, 0.5);
  if (cost > maxCost) throw new InputError(400, 'cost above cap');
  let pages: Row[] = [];
  let drawing: string | undefined;
  if (kind === 'browse') {
    if (!Array.isArray(body.pages) || body.pages.length > 10) throw new InputError(400, 'invalid pages');
    pages = body.pages.map(p => {
      if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'read_at,title,url') {
        throw new InputError(400, 'invalid page');
      }
      const row = p as Row;
      let url: URL;
      try { url = new URL(String(row.url)); } catch { throw new InputError(400, 'invalid page URL'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        typeof row.url !== 'string' || row.url.length > 2048 || typeof row.title !== 'string' || row.title.length > 300 ||
        typeof row.read_at !== 'number' || !Number.isSafeInteger(row.read_at) || row.read_at < 0 || row.read_at > now) {
        throw new InputError(400, 'invalid page');
      }
      return { url: row.url, title: row.title, read_at: row.read_at };
    });
    drawing = typeof body.drawing === 'string' ? body.drawing : undefined;
    if (!drawing?.startsWith('/media/') || !mediaType(drawing.slice(7))) throw new InputError(400, 'invalid drawing');
    const layout = await snapshot(db, now);
    const active = layout.segments.filter(s => s.start_at <= now && s.end_at > now);
    const pose = poseAt(active, now) || poseAt(layout.last ? [layout.last] : [], now) || { x: 2, y: 6 };
    if (!canDrawingSequence(layout.objects, [pose.x, pose.y])) {
      throw new InputError(409, 'drawing route unavailable');
    }
    if (!await env.MEDIA.get(drawing.slice(7), 'arrayBuffer')) {
      return json({ error: 'drawing not available' }, 409, { 'Retry-After': '5' });
    }
  }
  await advance(env, now, 'read');
  const event = { id: key, at: now, type: kind === 'reflect' ? 'reflection' : type, actor: 'brain', payload: {} };
  const committed = await writeFact(db, event, now, (snap, token) => {
    const writes: D1PreparedStatement[] = [];
    if (kind === 'browse') {
      const wall = snap.objects.find(o => o.kind === 'drawing_wall' && o.status === 'placed');
      if (!wall) throw new InputError(409, 'drawing wall unavailable');
      const id = `drawing:${ref}`;
      const object: CamObject = { ...structuredClone(wall), id, kind: 'drawing', status: 'placed', placement: 'wall',
        blocks: false, footprint: [[0, 0]], sprite: drawing!, card_id: `card:${id}`, tags: [], size: 'S',
        origin: { type: 'drawing' }, card: { ...structuredClone(wall.card), name: 'drawing', summary: 'A drawing from her exploration.',
          size: 'S', tags: [], sensations: {}, beyond_executor: [], affordances: [], prop_poses: [],
          space: { ...structuredClone(wall.card.space), blocks: false, placement: 'wall' } } };
      const old = snap.objects.filter(o => o.kind === 'drawing' && o.status === 'placed');
      // Creation time, rather than lexical ids, determines which drawing leaves the wall.
      const order = old.sort((a, b) => Number((a as unknown as Row).created_at) - Number((b as unknown as Row).created_at));
      for (const previous of order.slice(0, Math.max(0, old.length - 2))) {
        writes.push(...objectWrite(db, { ...previous, status: 'stored' }, previous.card_id!, key, now, token));
      }
      writes.push(cardWrite(db, object, object.card_id!, now, token, 'browse'),
        ...objectWrite(db, object, object.card_id!, key, now, token));
      writes.push(db.prepare(`UPDATE segments SET debug=json_set(COALESCE(debug,'{}'),'$.pages',json(?),
        '$.drawing',?) WHERE id=? AND ${writerGuard}`).bind(JSON.stringify(pages), drawing, seg.id, token));
      writes.push(db.prepare(`UPDATE events SET payload=? WHERE id=? AND ${writerGuard}`)
        .bind(JSON.stringify({ object_id: id, pages, drawing }), key, token));
    } else {
      const contextIds = JSON.parse(String(seg.debug || '{}')).context_event_ids;
      if (!Array.isArray(contextIds)) throw new InputError(409, 'fetch brain context with intent_id first');
      const checked = validateWonderResult(body.result, snap, now, contextIds);
      if (!checked.valid) throw new InputError(400, checked.errors.join(','));
      const result = body.result as { reflection: Row; tomorrow: SparkIntent; habit_candidate: Sensation | null };
      writes.push(db.prepare(`UPDATE events SET public=0,payload=? WHERE id=? AND ${writerGuard}`)
        .bind(JSON.stringify({ reflection: result.reflection, habit_candidate: result.habit_candidate }), key, token));
      const intentId = `intent:wonder:${ref}:0`;
      writes.push(db.prepare(`INSERT INTO intents
        (id,created_at,source,model,trigger_event,raw,accepted,rejected,status,expires_at)
        SELECT ?,?,'wonder','muse-wonder-1.0',?,?,?,NULL,'active',? WHERE ${writerGuard}`)
        .bind(intentId, now, key, JSON.stringify(body.result), JSON.stringify(result.tomorrow),
          now + result.tomorrow.window_minutes * 60000, token));
      writes.push(eventWrite(db, { id: intentId, at: now, type: 'intent_accepted', actor: 'brain',
        payload: { intent_id: intentId } }, token));
      if (result.habit_candidate) {
        const state = { ...snap.state, exploration: { sensation: result.habit_candidate, expires_at: now + 86400000 } };
        writes.push(db.prepare(`UPDATE world SET state_json=? WHERE id=1 AND ${writerGuard}`)
          .bind(JSON.stringify(state), token));
      }
    }
    // A late cloud report may settle over an earlier no_report timeout row; real spend beats the estimate.
    writes.push(db.prepare(`UPDATE budget_ledger SET status='settled',actual_usd=?,settled_at=?,note='cloud_report'
      WHERE id=? AND ${writerGuard}`).bind(cost, now, reservations.results[0].id, token));
    writes.push(db.prepare(`INSERT OR IGNORE INTO model_calls (id,at,purpose,model,ref,ok,cost_usd,summary)
      SELECT ?,?,?,?,?,1,?,'cloud_report' WHERE ${writerGuard}`)
      .bind(key, now, purpose, kind === 'browse' ? 'cloud-browse' : 'muse-wonder-1.0', ref, cost, token));
    return writes;
  });
  if (committed) await bestEffortReplan(db, now);
  return json({ ok: true, duplicate: !committed });
}

