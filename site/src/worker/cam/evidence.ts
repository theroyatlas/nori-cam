import { intentTemplates } from './intent-plan.ts';
import { validate } from './validate.ts';
import { writerGuard, type Snapshot } from './facts.ts';
import type { Segment } from './types.ts';

// Save generated specs when planned, before intents expire or room geometry changes.
export function templateEvidence(db: D1Database, snap: Snapshot, segments: Segment[], token: string) {
  const writes: D1PreparedStatement[] = [];
  const ids = new Set(segments.map(s => s.interaction).filter(id => id?.startsWith('template:')));
  for (const id of ids) {
    const segment = segments.find(s => s.interaction === id)!;
    const ix = intentTemplates(snap.intents, snap.objects, snap.interactions, segment.start_at).find(i => i.id === id);
    const object = ix && snap.objects.find(o => o.id === ix.object_id);
    if (!ix || !object?.card_id) continue;
    const result = validate({ objects: snap.objects }, object, ix.spec, segment.path[0]);
    writes.push(db.prepare(`INSERT OR IGNORE INTO interactions
      (id,object_id,card_id,created_at,source,spec,status,checks,gaps)
      SELECT ?,?,?,?,'intent_template',?,?,?,? WHERE ${writerGuard}`)
      .bind(ix.id, object.id, object.card_id, segment.start_at, JSON.stringify({ ...ix.spec, action: ix.action }),
        result.status, JSON.stringify(result.checks), JSON.stringify(result.gaps), token));
  }
  return writes;
}
