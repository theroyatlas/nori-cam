import type { Snapshot } from './facts.ts';

export const ACTIONS = ['approach', 'sniff', 'lie_on', 'hide_in', 'carry', 'sit_on', 'look_out',
  'play', 'sleep_at', 'search', 'ignore', 'try_interaction'] as const;
export interface SparkIntent {
  action: typeof ACTIONS[number];
  object_id?: string;
  destination_id?: string;
  interaction_id?: string;
  window_minutes: number;
  reason_tag: string;
  summary: string;
}
export interface ActiveIntent extends SparkIntent { id: string; expires_at: number }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && [...v].length <= max;
function check(raw: unknown, snap: Snapshot, maxWindow: number): string | null {
  if (!record(raw)) return 'intent_object_required';
  const common = ['action', 'window_minutes', 'reason_tag', 'summary'];
  const keys = raw.action === 'try_interaction' ? ['interaction_id'] :
    raw.action === 'carry' ? ['object_id', 'destination_id'] : ['object_id'];
  if (Object.keys(raw).some(k => ![...common, ...keys].includes(k))) return 'extra_intent_key';
  if (!ACTIONS.includes(raw.action as SparkIntent['action'])) return 'unknown_action';
  if (typeof raw.window_minutes !== 'number' || !Number.isFinite(raw.window_minutes) ||
    raw.window_minutes < 10 || raw.window_minutes > maxWindow) return 'window_bounds';
  if (!text(raw.summary, 160) || !text(raw.reason_tag, 160)) return 'invalid_text';
  if (raw.action === 'try_interaction') {
    const ix = snap.interactions.find(i => i.id === raw.interaction_id);
    return ix && snap.objects.some(o => o.id === ix.object_id && o.status === 'placed') ? null : 'interaction_not_accepted';
  }
  if (raw.action === 'search') return snap.state.missing.some(m => m.object_id === raw.object_id) ? null : 'not_missing';
  const o = snap.objects.find(o => o.id === raw.object_id && o.status === 'placed');
  if (!o) return 'object_not_placed';
  if (raw.action === 'hide_in' && (!o.tags.includes('enclosed') ||
    o.origin?.type !== 'prefab' || !(o.card.prop_poses || []).includes('box'))) return 'hide_requires_prefab_box';
  if (raw.action === 'carry') {
    if (o.size !== 'S' || !o.tags.includes('portable')) return 'carry_requires_portable_small';
    const dest = snap.objects.find(d => d.id === raw.destination_id && d.status === 'placed' && d.id !== o.id);
    if (!dest || !(dest.tags.includes('enclosed') || dest.tags.includes('soft') || dest.kind === 'bed')) {
      return 'invalid_destination';
    }
  }
  if (raw.action === 'look_out' && !o.tags.includes('viewpoint')) return 'requires_viewpoint';
  if (raw.action === 'sit_on' && !o.tags.includes('high_place')) return 'requires_high_place';
  if (raw.action === 'lie_on' && !o.tags.includes('soft') && !o.tags.includes('high_place')) return 'requires_rest_surface';
  return null;
}
export function validateSparkIntents(raw: unknown, snap: Snapshot, _now: number) {
  const accepted: { index: number; intent: SparkIntent }[] = [];
  const rejected: { index: number; reason: string }[] = [];
  if (!record(raw) || Object.keys(raw).some(k => k !== 'intents') || !Array.isArray(raw.intents)) {
    return { accepted, rejected: [{ index: -1, reason: 'invalid_spark_envelope' }] };
  }
  if (raw.intents.length > 3) return { accepted, rejected: [{ index: -1, reason: 'too_many_intents' }] };
  raw.intents.forEach((v, index) => {
    const reason = check(v, snap, 720);
    if (reason) rejected.push({ index, reason });
    else accepted.push({ index, intent: v as SparkIntent });
  });
  return { accepted, rejected };
}
export function validateWonderResult(raw: unknown, snap: Snapshot, _now: number, contextEventIds: string[] = []) {
  const errors: string[] = [];
  if (!record(raw) || Object.keys(raw).sort().join(',') !== 'habit_candidate,reflection,tomorrow') {
    return { valid: false, errors: ['invalid_wonder_envelope'] };
  }
  const r = raw.reflection;
  if (!record(r) || Object.keys(r).sort().join(',') !== 'event_ids,summary' || !text(r.summary, 400) ||
    !Array.isArray(r.event_ids) || r.event_ids.some(id => typeof id !== 'string' || !contextEventIds.includes(id))) {
    errors.push('invalid_reflection');
  }
  const reason = check(raw.tomorrow, snap, 1440);
  if (reason) errors.push(reason);
  if (raw.habit_candidate !== null && (typeof raw.habit_candidate !== 'string' || !['soft', 'shelter', 'height', 'view_far', 'sound', 'motion', 'light', 'warm']
    .includes(raw.habit_candidate))) errors.push('invalid_habit_candidate');
  return { valid: !errors.length, errors };
}
