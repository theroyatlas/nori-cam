import { writeFact, writerGuard } from './facts.ts';
import { reservationId, type BudgetEnv } from './budget.ts';
export async function expirePhotoGifts(env: BudgetEnv, now: number) {
  const rows = await env.DB.prepare(`SELECT id,giver,object_id FROM gifts
    WHERE kind='photo' AND status='processing' AND created_at<=? LIMIT 20`)
    .bind(now - 20 * 60000).all<{ id: string; giver: string; object_id: string }>();
  for (const gift of rows.results) await writeFact(env.DB, { id: `gift-terminal:${gift.id}`, at: now,
    type: 'gift_failed', actor: 'system', payload: { gift_id: gift.id, object_id: gift.object_id, step: 'timeout' } },
  now, (_snap, token) => [
    env.DB.prepare(`UPDATE gifts SET status='failed',pipeline=?,updated_at=?
      WHERE id=? AND status='processing' AND ${writerGuard}`)
      .bind(JSON.stringify([{ step: 'timeout', ok: false, note: '20_minute_timeout' }]), now, gift.id, token),
    env.DB.prepare(`UPDATE budget_ledger SET status='settled',actual_usd=est_usd,settled_at=?,note='gift_timeout'
      WHERE id=? AND status='reserved' AND ${writerGuard}`)
      .bind(now, reservationId(`${gift.giver}_photo`, gift.id), token),
  ]);
}
