import { snapshot } from './store.ts';
import type { CamEvent, CamObject } from './types.ts';

export const writerGuard = '(SELECT writer FROM world WHERE id=1)=?';
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
export class InputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function eventWrite(db: D1Database, event: CamEvent, token: string, publicFlag = 1) {
  return db.prepare(`INSERT OR IGNORE INTO events
    (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
    SELECT ?,?,?,?,?,?,?,version,NULL FROM world WHERE id=1 AND writer=?`)
    .bind(event.id, token, event.at, event.type, event.actor, JSON.stringify(event.payload), publicFlag, token);
}
export function history(db: D1Database, o: CamObject, cause: string, now: number, token: string) {
  return [
    db.prepare(`UPDATE object_states SET valid_to=? WHERE object_id=? AND valid_to IS NULL AND ${writerGuard}`)
      .bind(now, o.id, token),
    db.prepare(`INSERT INTO object_states (object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${writerGuard}`)
      .bind(o.id, now, o.x, o.y, o.z, JSON.stringify(o.footprint), o.rotation, o.status, o.state, o.sprite, cause, token),
  ];
}
export function objectWrite(db: D1Database, o: CamObject, cardId: string, cause: string, now: number, token: string) {
  const values = [o.id, o.kind, JSON.stringify(o.tags), o.size, o.x, o.y, o.z, JSON.stringify(o.footprint),
    o.rotation, Number(o.blocks), o.placement, o.status, o.state, o.sprite, cardId, JSON.stringify(o.origin), now];
  return [
    db.prepare(`INSERT INTO objects
      (id,kind,tags,size,x,y,z,footprint,rotation,blocks,placement,status,state,sprite,card_id,origin,created_at)
      SELECT ${values.map(() => '?').join(',')} WHERE ${writerGuard}
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,tags=excluded.tags,size=excluded.size,x=excluded.x,y=excluded.y,
      z=excluded.z,footprint=excluded.footprint,blocks=excluded.blocks,placement=excluded.placement,status=excluded.status,
      state=excluded.state,sprite=excluded.sprite,card_id=excluded.card_id,removed_at=CASE WHEN excluded.status='removed'
      THEN excluded.created_at ELSE NULL END`).bind(...values, token),
    ...history(db, o, cause, now, token),
  ];
}
export function cardWrite(db: D1Database, o: CamObject, cardId: string, now: number, token: string, source = 'prefab') {
  return db.prepare(`INSERT INTO object_cards (id,object_id,created_at,source,raw,card,errors)
    SELECT ?,?,?,?,?,?,'[]' WHERE ${writerGuard}
    ON CONFLICT(id) DO UPDATE SET raw=excluded.raw,card=excluded.card,source=excluded.source`)
    .bind(cardId, o.id, now, source, JSON.stringify(o.card), JSON.stringify(o.card), token);
}
const HANDLED_ON_INSERT = new Set(['reflection', 'budget_denied']);
// The event token gates the version bump; the version predicate also protects geometry decisions.
// Losing attempts insert nothing. Facts remain pending until the separate planner CAS handles them.
export async function writeFact(
  db: D1Database, event: CamEvent, now: number,
  build: (snap: Snapshot, token: string) => D1PreparedStatement[] | Promise<D1PreparedStatement[]>,
): Promise<boolean> {
  const markHandled = HANDLED_ON_INSERT.has(event.type);
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await snapshot(db, now);
    const existing = await db.prepare('SELECT id FROM events WHERE id=?').bind(event.id).first();
    if (existing) return false;
    const token = crypto.randomUUID();
    const writes = await build(snap, token);
    const handledSql = markHandled ? 'version+1' : 'NULL';
    const result = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO events
        (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
        SELECT ?,?,?,?,?,?,1,version+1,${handledSql} FROM world WHERE id=1 AND version=?`)
        .bind(event.id, token, event.at, event.type, event.actor, JSON.stringify(event.payload), snap.world.version),
      db.prepare(`UPDATE world SET version=version+1,writer=?,updated_at=? WHERE id=1 AND version=?
        AND EXISTS (SELECT 1 FROM events WHERE id=? AND insert_token=?)`)
        .bind(token, now, snap.world.version, event.id, token),
      ...writes,
    ]);
    if (result[1].meta.changes) return true;
  }
  throw new InputError(503, 'world busy; retry');
}
