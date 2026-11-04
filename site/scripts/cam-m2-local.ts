// cam-m2-local.ts: pre-registered M2 numbers for a real local Worker state.
//
// Reads the local miniflare D1 sqlite file AFTER the Worker is stopped,
// assembles BlindEvidence the same way scripts/blind-test.ts does, runs
// judge() from src/worker/cam/blind.ts, and prints the M2 summary:
// P(S0), P(S1), P(S1'), dT, dN, dM, dM/p_s1_prime and the verdict.
// The blind definition and thresholds are NOT reimplemented here; they live
// in blind.ts (buildCounterfactualNoMemoryState + evaluateM2Verdict).
//
// Usage:
//   npx tsx scripts/cam-m2-local.ts --db <sqlite> --object <object_id> \
//     --registration <reg.json> --out <report.json>
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeSegment, snapshot } from '../src/worker/cam/store.ts';
import { judge, type BlindEvidence, type BlindRegistration } from '../src/worker/cam/blind.ts';
import type { CamEvent, Cell, Experience } from '../src/worker/cam/types.ts';

function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[i + 1];
}

// Minimal D1-compatible facade over a file-backed node:sqlite handle.
// Reads only; batch() runs the statements in one transaction like D1.
function d1(db: DatabaseSync): D1Database {
  class Stmt {
    constructor(private sql: string, private params: unknown[] = []) {}
    bind(...p: unknown[]) { return new Stmt(this.sql, p); }
    exec() {
      const st = db.prepare(this.sql);
      if (st.columns().length) return { results: st.all(...(this.params as [])) as unknown[], meta: { changes: 0 } };
      const r = st.run(...(this.params as []));
      return { results: [] as unknown[], meta: { changes: Number(r.changes) } };
    }
    async all<T>() { return { results: this.exec().results as T[] }; }
    async first<T>() { return (this.exec().results[0] as T | undefined) ?? null; }
    async run() { return this.exec(); }
  }
  const facade = {
    prepare: (sql: string) => new Stmt(sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map(s => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  return facade as unknown as D1Database;
}

async function main(argv: string[]): Promise<number> {
  const dbPath = flag(argv, '--db');
  const objectId = flag(argv, '--object');
  const regPath = flag(argv, '--registration');
  const outPath = flag(argv, '--out');
  const reg = JSON.parse(readFileSync(regPath, 'utf8')) as BlindRegistration;
  const regSha = createHash('sha256').update(readFileSync(regPath)).digest('hex');

  const sql = new DatabaseSync(dbPath);
  const db = d1(sql);

  const cardRow = sql.prepare(
    "SELECT id, object_id, source, card FROM object_cards WHERE object_id=? AND source='spark_vision'",
  ).get(objectId) as { id: string; object_id: string; source: string; card: string } | undefined;

  const ixRows = sql.prepare(
    "SELECT id, object_id, card_id, source, spec, status, checks, gaps FROM interactions WHERE object_id=? AND source='compiled' ORDER BY id",
  ).all(objectId) as Record<string, unknown>[];
  const interactions = ixRows.map(r => ({
    id: String(r.id), object_id: String(r.object_id), card_id: String(r.card_id), source: String(r.source),
    spec: JSON.parse(String(r.spec)), status: String(r.status) as 'accepted' | 'degraded' | 'rejected',
    checks: JSON.parse(String(r.checks || '[]')), gaps: JSON.parse(String(r.gaps || '[]')),
  }));

  const ixIds = new Set(interactions.map(i => i.id));
  const allObjectSegments = (
    sql.prepare('SELECT * FROM segments WHERE superseded_at IS NULL ORDER BY start_at, id').all() as Record<string, unknown>[]
  ).map(decodeSegment).filter(s => s.target === objectId || (s.interaction != null && ixIds.has(s.interaction)));
  const segIdStrings = new Set(allObjectSegments.map(s => String(s.id)));

  const rawStates = sql.prepare(
    `SELECT rowid AS id, object_id, valid_from, x, y, z, footprint, rotation, status, state, sprite, cause
     FROM object_states WHERE object_id=? AND cause NOT IN ('seed') AND cause NOT LIKE 'gift:%' AND cause NOT LIKE 'unwrapped:%'
     ORDER BY valid_from, rowid`,
  ).all(objectId) as Record<string, unknown>[];
  const stateChanges = rawStates.map(r => ({
    id: Number(r.id), object_id: String(r.object_id), valid_from: Number(r.valid_from),
    x: Number(r.x), y: Number(r.y), z: Number(r.z), footprint: JSON.parse(String(r.footprint)) as Cell[],
    rotation: Number(r.rotation), status: String(r.status), state: String(r.state),
    sprite: String(r.sprite), cause: String(r.cause),
  }));

  const rawSounds = sql.prepare("SELECT id, at, type, actor, payload FROM events WHERE type='sound_played' ORDER BY at, id").all() as Record<string, unknown>[];
  const soundEvents: CamEvent[] = rawSounds
    .map(r => ({
      id: String(r.id), at: Number(r.at), type: String(r.type), actor: String(r.actor),
      payload: JSON.parse(String(r.payload || '{}')) as Record<string, unknown>,
    }))
    .filter(ev => {
      if ((ev.payload as Record<string, unknown>)?.target === objectId) return true;
      const parts = ev.id.split(':');
      return parts[0] === 'sound_played' && segIdStrings.has(parts[1]);
    });

  const rawExps = sql.prepare('SELECT * FROM experiences WHERE object_id=? ORDER BY at, id').all(objectId) as Record<string, unknown>[];
  const experiences: Experience[] = rawExps.map(r => ({
    id: String(r.id), at: Number(r.at), object_id: String(r.object_id), interaction_id: String(r.interaction_id),
    segment_ids: JSON.parse(String(r.segment_ids)), sensations: JSON.parse(String(r.sensations)),
    startle: Number(r.startle), appraisal: Number(r.appraisal), reaction: String(r.reaction),
    pref_deltas: JSON.parse(String(r.pref_deltas)), wariness_deltas: JSON.parse(String(r.wariness_deltas)),
    familiarity_delta: Number(r.familiarity_delta), world_version: Number(r.world_version),
  }));
  if (!experiences.length) throw new Error(`no experiences for ${objectId}`);

  const firstExp = experiences[0];
  const lastExpSeg = allObjectSegments.find(s => s.id === firstExp.segment_ids.at(-1));
  const positionAtExp: Cell = lastExpSeg?.path.at(-1) ? [...lastExpSeg.path.at(-1)!] : [2, 6];

  const snap = await snapshot(db, firstExp.at);
  const evidence: BlindEvidence = {
    object_id: objectId,
    card: cardRow ? { id: cardRow.id, object_id: cardRow.object_id, source: cardRow.source, card: JSON.parse(cardRow.card) } : null,
    interactions, segments: allObjectSegments, state_changes: stateChanges,
    sound_events: soundEvents, experiences,
    world_snapshot: {
      objects: snap.objects, interactions: snap.interactions, position: positionAtExp, state_after: snap.state,
    },
  };

  const report = judge(evidence, reg);
  const summary = {
    object_id: objectId, experience_id: firstExp.id, registration_sha256: regSha,
    registration: reg, m2: report.m2 ?? null,
    counterfactual: report.stages[5].counterfactual ?? null,
    stage_verdicts: report.stages.map(s => ({ stage: s.stage, name: s.name, verdict: s.verdict, reasons: s.reasons })),
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(summary.m2 ?? { error: 'no m2' }, null, 2) + '\n');
  for (const v of summary.stage_verdicts)
    process.stderr.write(`m2 stage ${v.stage} ${v.name}: ${v.verdict}\n`);
  process.stderr.write(report.m2 ? 'm2 evaluated\n' : 'm2 evaluation failed\n');
  sql.close();
  return report.m2 ? 0 : 2;
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => { process.stderr.write(`cam-m2-local failed: ${(err as Error).message}\n`); process.exit(1); },
);
