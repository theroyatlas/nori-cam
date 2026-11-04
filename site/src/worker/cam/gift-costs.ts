import { writerGuard, InputError } from './facts.ts';

export interface PipelineStep {
  step: string;
  model: string;
  ok: boolean;
  ms: number;
  seconds: number;
  cost_usd: number;
  cost_basis: string;
  note?: string;
}
const steps = ['fetch_source', 'understand', 'box', 'redraw', 'pixelize', 'upload', 'ingest'];
const bases = ['local', 'estimate', 'configured_per_image', 'usage'];
export function pipelineSteps(raw: unknown): PipelineStep[] {
  if (!Array.isArray(raw) || raw.length > 16) throw new InputError(400, 'invalid pipeline');
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !steps.includes(item.step) || typeof item.model !== 'string' ||
      item.model.length > 128 || typeof item.ok !== 'boolean' || typeof item.cost_basis !== 'string' ||
      item.cost_basis.length > 64 || !['ms', 'seconds', 'cost_usd'].every(k => typeof item[k] === 'number' &&
        Number.isFinite(item[k]) && item[k] >= 0) || (item.note != null &&
        (typeof item.note !== 'string' || item.note.length > 256))) throw new InputError(400, 'invalid pipeline step');
    if (Object.keys(item).some(k => !['step', 'model', 'ok', 'ms', 'seconds', 'cost_usd', 'cost_basis', 'note'].includes(k))) {
      throw new InputError(400, 'unknown pipeline field');
    }
  }
  return raw as PipelineStep[];
}
export function costNote(pipeline: PipelineStep[]): string {
  const kinds = [...new Set(pipeline.map(p => p.cost_basis))];
  return JSON.stringify({ source: 'pipeline_report', cost_basis: kinds,
    provider_billed_verified: false, unknown_basis: kinds.some(k => !bases.includes(k)) });
}
export function modelCallWrites(db: D1Database, id: string, pipeline: PipelineStep[], now: number, token: string) {
  const purposes: Record<string, string> = { understand: 'gift_vision', box: 'gift_sam', redraw: 'gift_image' };
  return pipeline.flatMap((p, i) => {
    if (!purposes[p.step]) return [];
    return [db.prepare(`INSERT OR IGNORE INTO model_calls (id,at,purpose,model,ref,ok,cost_usd,latency_ms,summary)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${writerGuard}`)
      .bind(`gift:${id}:${i}`, now, purposes[p.step], p.model, id, Number(p.ok), p.cost_usd, p.ms,
        JSON.stringify({ cost_basis: p.cost_basis, provider_billed_verified: false }), token)];
  });
}
