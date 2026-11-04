// Minimal in-memory D1 stand-in on node:sqlite so the API tests run offline and without workerd.
// (The real D1 binding is exercised separately with `wrangler dev --local`; see DEPLOY.md.)
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Param = string | number | null;

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: Param[] = []) {}
  bind(...p: Param[]) { return new Stmt(this.db, this.sql, p); }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true }; }
  async first<T>() { return ((this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null); }
  async run() { const r = this.db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: Number(r.changes) } }; }
}

export function makeDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  return { db, d1: { prepare: (sql: string) => new Stmt(db, sql) } as unknown as D1Database };
}
