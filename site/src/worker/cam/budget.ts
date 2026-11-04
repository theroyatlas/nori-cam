import { parseUsd } from '../limits.ts';

export interface BudgetEnv {
  DB: D1Database;
  CAM_DAILY_USD?: string;
  CAM_PHOTO_EST_USD?: string;
  CAM_JUDGE_PHOTO_CAP?: string;
  CAM_OWNER_PHOTO_CAP?: string;
}
export function londonDay(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-');
}
export const reservationId = (purpose: string, ref: string) => `res:${purpose}:${ref}`;

export function reserveStatement(env: BudgetEnv, purpose: string, ref: string, estimate: number, cap: number, now: number) {
  return env.DB.prepare(`INSERT OR IGNORE INTO budget_ledger (id,day,purpose,status,est_usd,created_at)
    SELECT ?,?,?,'reserved',?,? WHERE
    (SELECT COALESCE(SUM(CASE status WHEN 'settled' THEN actual_usd ELSE est_usd END),0)
      FROM budget_ledger WHERE day=? AND status!='released') + ? <= ?
    AND (SELECT COUNT(*) FROM budget_ledger WHERE day=? AND purpose=? AND status!='released') < ?`)
    .bind(reservationId(purpose, ref), londonDay(now), purpose, estimate, now,
      londonDay(now), estimate, parseUsd(env.CAM_DAILY_USD, 3), londonDay(now), purpose, cap);
}
export async function reserve(env: BudgetEnv, purpose: string, ref: string, estimate: number, cap: number, now: number) {
  if (!Number.isFinite(estimate) || estimate < 0) throw new Error('invalid_estimate');
  const result = await reserveStatement(env, purpose, ref, estimate, cap, now).run();
  return result.meta.changes === 1;
}
export function settleBudget(db: D1Database, id: string, actual: number, now: number, note: string, guard = '1=1') {
  if (!Number.isFinite(actual) || actual < 0) throw new Error('invalid_cost');
  return db.prepare(`UPDATE budget_ledger SET status='settled',actual_usd=?,settled_at=?,note=?
    WHERE id=? AND status='reserved' AND ${guard}`).bind(actual, now, note, id);
}
export function releaseBudget(db: D1Database, id: string, now: number) {
  return db.prepare(`UPDATE budget_ledger SET status='released',settled_at=?,note='dispatch_failed'
    WHERE id=? AND status='reserved'`).bind(now, id);
}
export async function expireReservations(db: D1Database, now: number) {
  await db.prepare(`UPDATE budget_ledger SET status='settled',actual_usd=est_usd,settled_at=?,note='no_report'
    WHERE status='reserved' AND created_at <= ?`).bind(now, now - 7200000).run();
}
