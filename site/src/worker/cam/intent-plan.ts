import { operationCells, bfsPath, placementOk, cellsOf } from '../../../public/cam-shared.js';
import type { CamObject, Interaction, Step, Cell } from './types.ts';
import type { ActiveIntent } from './spark-validate.ts';

export function matchesIntent(intent: ActiveIntent, ix: Interaction) {
  if (intent.action === 'try_interaction') return intent.interaction_id === ix.id;
  if (intent.object_id !== ix.object_id) return false;
  if (intent.action === 'ignore') return true;
  if (intent.action === 'sleep_at') return ix.action === 'sleep' || ix.action === 'sleep_at';
  if (intent.action === 'search') return ix.action === 'search_missing';
  if (intent.action === 'carry' && intent.destination_id) return ix.id === `template:${intent.id}`;
  return ix.action === intent.action;
}
export function intentBonus(intents: ActiveIntent[], ix: Interaction, now: number) {
  return intents.filter(i => i.expires_at > now && matchesIntent(i, ix))
    .reduce((sum, i) => sum + (i.action === 'ignore' ? -1 : 1), 0);
}
export function intentTemplates(intents: ActiveIntent[], objects: CamObject[], interactions: Interaction[], now: number) {
  const result: Interaction[] = [];
  for (const i of intents.filter(i => i.expires_at > now)) {
    if (['ignore', 'try_interaction'].includes(i.action)) continue;
    if (interactions.some(ix => matchesIntent(i, ix))) continue;
    const o = objects.find(o => o.id === i.object_id && o.status === 'placed');
    if (!o && i.action !== 'search') continue;
    const target = o || objects.find(o => o.id === i.object_id);
    if (!target) continue;
    const first = target.card.parts.find(p => p.kind === 'front')?.kind || target.card.parts[0]?.kind;
    const approach: Step = (target.card.hazards || []).length
      ? { p: 'move_to', approach: 'front' } : { p: 'move_to', ...(first ? { part: first } : {}) };
    // Safety contract fields carried over when a template derives from an
    // existing interaction (F2). Only defined fields are kept: an explicit
    // undefined would fail the InteractionSpec schema's closed shape.
    const keep: { contact?: string; target_part?: string | null; allowed_states?: string[] } = {};
    let steps: Step[];
    switch (i.action) {
      case 'search': steps = [approach, { p: 'hold_pose', pose: 'sneak', ms: 1500 },
        { p: 'hold_pose', pose: 'question', ms: 1500 }];
        break;
      case 'approach': steps = [approach, { p: 'face' }, { p: 'wait', ms: 1500 }];
        break;
      case 'sniff': steps = [approach, { p: 'face' }, { p: 'hold_pose', pose: 'look-up', ms: 3000 }];
        break;
      case 'hide_in': steps = [{ p: 'move_to', part: 'inside' }, { p: 'hold_pose', pose: 'box', ms: 300000 }];
        break;
      case 'carry': {
        const dest = objects.find(o => o.id === i.destination_id && o.status === 'placed');
        const world = { objects };
        const pickup = operationCells(target, approach.approach || approach.part, world)[0];
        // Preserve the destination's operation cell; putting a blocking gift in its doorway is illegal.
        const drops: Cell[] = dest ? cellsOf(dest).flatMap(([x, y]) =>
          [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as Cell[]) : [];
        const route = drops.flatMap(drop => {
          const neighbours: Cell[] = [[drop[0] - 1, drop[1]], [drop[0] + 1, drop[1]],
            [drop[0], drop[1] - 1], [drop[0], drop[1] + 1]];
          return neighbours.filter(at => pickup && bfsPath(world, pickup, at) &&
            placementOk({ objects, nori: { x: at[0], y: at[1] } }, { ...target, x: drop[0], y: drop[1] }).ok)
            .map(at => ({ at, drop }));
        })[0];
        if (!route) continue;
        steps = [approach, { p: 'carry', at: route.at }, { p: 'drop', at: route.drop }];
        break;
      }
      case 'lie_on':
      case 'sit_on':
      case 'sleep_at':
        steps = [approach];
        if (target.tags.includes('high_place')) steps.push({ p: 'climb', part: 'top' });
        steps.push(i.action === 'sleep_at' ? { p: 'sleep' } :
          { p: 'hold_pose', pose: i.action === 'lie_on' ? 'alert-loaf' : 'sit', ms: 300000 });
        break;
      case 'look_out': steps = [approach, { p: 'hold_pose', pose: 'back', ms: 300000 }];
        break;
      case 'play': {
        const existing = interactions.find(ix => ix.object_id === target.id &&
          ((ix.spec.sensations.motion || 0) > 0 || (ix.spec.sensations.sound || 0) > 0));
        if (existing) {
          steps = structuredClone(existing.spec.steps);
          if (existing.spec.contact !== undefined) keep.contact = existing.spec.contact;
          if (existing.spec.target_part !== undefined) keep.target_part = existing.spec.target_part;
          if (existing.spec.allowed_states !== undefined)
            keep.allowed_states = [...existing.spec.allowed_states];
        } else {
          // Pre-D1fix3 behaviour: touch the front part when declared, else the first.
          // Hazardous targets stay gated by validate() at pick time.
          const first = target.card.parts.find(p => p.kind === 'front')?.kind || target.card.parts[0]?.kind;
          steps = [approach, { p: 'touch', ...(first ? { part: first } : {}), effects: [{ e: 'wobble', amp: 1 }] }];
          keep.contact = 'touch';
          if (first) keep.target_part = first;
        }
        break;
      }
      default: continue;
    }
    result.push({ id: `template:${i.id}`, object_id: target.id, action: i.action === 'search' ? 'search_missing' : i.action,
      spec: { verb: i.action, sensations: target.card.sensations, steps, end_state: null, cooldown_min: 10, ...keep } });
  }
  return result;
}
