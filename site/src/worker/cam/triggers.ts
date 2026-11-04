import { dispatchWorkflow, definiteDispatchFailure } from './dispatch.ts';
import { reserve, releaseBudget, reservationId, londonDay, type BudgetEnv } from './budget.ts';
import { parseUsd } from '../limits.ts';
export type TriggerEnv = BudgetEnv & {
  GH_DISPATCH_TOKEN?: string;
  CAM_BROWSE_EST_USD?: string;
  CAM_BROWSE_ENABLED?: string;
  CAM_REFLECT_ENABLED?: string;
  CAM_LOCAL_PIPELINE?: string;
};
export interface TriggerDeps { dispatch?: typeof dispatchWorkflow; fetch?: typeof fetch }
export async function dispatchStartedSegments(env: TriggerEnv, now: number, deps: TriggerDeps = {}) {
  const db = env.DB;
  const rows = await db.prepare(`SELECT id,trigger,trigger_claimed_at,trigger_status,debug FROM segments
    WHERE start_at<=? AND (end_at>? OR (primitive='sleep' AND cut_at=end_at AND
      json_extract(trigger,'$.kind')='reflect' AND json_extract(trigger,'$.planned_end_at')-start_at>=1800000))
    AND superseded_at IS NULL AND json_extract(trigger,'$.kind') IN ('browse','reflect')
    AND (json_extract(trigger,'$.kind')!='reflect' OR (primitive='sleep' AND
      (end_at-start_at>=1800000 OR (cut_at=end_at AND
       json_extract(trigger,'$.planned_end_at')-start_at>=1800000))))
    AND (trigger_claimed_at IS NULL OR (trigger_status='failed' AND COALESCE(json_extract(debug,'$.trigger_attempts'),0)<2))
    AND COALESCE(trigger_status,'') NOT IN ('uncertain','dispatched','disabled','budget_denied','daily_limit')
    ORDER BY start_at LIMIT 10`)
    .bind(now, now).all<{ id: number; trigger: string; trigger_claimed_at: number | null;
      trigger_status: string | null; debug: string | null }>();
  for (const s of rows.results) {
    const kind = JSON.parse(s.trigger).kind as 'browse' | 'reflect';
    const enabled = kind === 'browse' ? env.CAM_BROWSE_ENABLED === '1' : env.CAM_REFLECT_ENABLED === '1';
    const purpose = kind === 'browse' ? 'browse' : 'wonder';
    const retry = s.trigger_claimed_at !== null;
    const claimGuard = retry
      ? "trigger_status='failed' AND COALESCE(json_extract(debug,'$.trigger_attempts'),0)<2 AND trigger_claimed_at=?"
      : 'trigger_claimed_at IS NULL';
    const claimed = await db.prepare(`UPDATE segments SET trigger_claimed_at=?,trigger_status='claiming',
      debug=json_set(COALESCE(debug,'{}'),'$.trigger_attempts',COALESCE(json_extract(debug,'$.trigger_attempts'),0)+1)
      WHERE id=? AND start_at<=? AND (end_at>? OR (primitive='sleep' AND cut_at=end_at AND
       json_extract(trigger,'$.kind')='reflect' AND json_extract(trigger,'$.planned_end_at')-start_at>=1800000))
      AND superseded_at IS NULL
      AND ${claimGuard}`)
      .bind(now, s.id, now, now, ...(retry ? [s.trigger_claimed_at] : [])).run();
    if (!claimed.meta.changes) continue;
    const ref = `seg:${s.id}${retry ? ':retry' : ''}`;
    const status = async (value: string) => {
      await db.prepare('UPDATE segments SET trigger_status=? WHERE id=?').bind(value, s.id).run();
    };
    if (!enabled) {
      await status('disabled');
      await db.prepare(`INSERT OR IGNORE INTO events
        (id,insert_token,at,type,actor,payload,public,world_version,handled_version)
        SELECT ?, 'switch', ?, 'feature_disabled', 'system', ?, 0, version, version FROM world WHERE id=1`)
        .bind(`disabled:${s.id}`, now, JSON.stringify({ feature: kind, reason: 'switch_off' })).run();
      continue;
    }
    if (kind === 'reflect') {
      const claim = await db.prepare(`INSERT OR IGNORE INTO model_calls (id,at,purpose,model,ref,ok,cost_usd,summary)
        VALUES (?,?,'wonder','muse-wonder-1.0',?,0,0,'day_claim')`)
        .bind(`reflect-day:${londonDay(now)}`, now, `seg:${s.id}`).run();
      if (!claim.meta.changes) {
        await status('daily_limit');
        continue;
      }
    }
    const estimate = kind === 'browse' ? parseUsd(env.CAM_BROWSE_EST_USD, 0.30) : 0.10;
    if (!await reserve(env, purpose, ref, estimate, kind === 'browse' ? 2 : 1, now)) {
      await status('budget_denied');
      continue;
    }
    try {
      if (env.CAM_LOCAL_PIPELINE === '1') {
        await status('dispatched');
      } else {
        await (deps.dispatch || dispatchWorkflow)(env, 'nori-wake.yml',
          { reason: kind === 'browse' ? 'computer' : 'reflect', intent_id: `seg:${s.id}` }, deps.fetch);
        await status('dispatched');
      }
    } catch (error) {
      if (definiteDispatchFailure(error)) {
        await releaseBudget(db, reservationId(purpose, ref), now).run();
        if (kind === 'reflect') {
          await db.prepare('DELETE FROM model_calls WHERE id=?').bind(`reflect-day:${londonDay(now)}`).run();
        }
        await status('failed');
      } else {
        await status('uncertain');
      }
    }
  }
}
