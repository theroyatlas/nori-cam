import interactionSchema from '../../../public/cam/schema/interaction-spec.json' with { type: 'json' };
import { EXECUTOR, SENSATIONS, applyEffects, operationCells, poseAt } from '../../../public/cam-shared.js';
import { sha256Hex } from '../limits.ts';
import { RULES, assess, clamp, continuous, preference, wakeResponse } from './engine.ts';
import { accessObject } from './heights.ts';
import { candidateScores, choiceProbabilities, planNext, renderPose } from './plan.ts';
import { settle } from './settle.ts';
import type { ActiveIntent } from './spark-validate.ts';
import type {
  CamEvent,
  CamObject,
  Cell,
  Experience,
  Interaction,
  InteractionSpec,
  ObjectCard,
  Segment,
  Sensation,
  Sensations,
  Step,
  Weather,
  WorldState,
} from './types.ts';
import { schemaErrors, validateCard } from './validate.ts';
import { normalizePlacement } from './placement.ts';

export interface BlindRegistration {
  label: string;
  synonyms: string[];
  expected_sensations: string[];
}

export interface BlindRegistrationRecord {
  registration: BlindRegistration;
  json: string;
  sha256: string;
}

export type StageVerdictStatus = 'pass' | 'degraded_pass' | 'fail' | 'manager_check';

export type StageName =
  | 'understanding'
  | 'spec_generation'
  | 'checker'
  | 'animation_execution'
  | 'world_change'
  | 'experience';

export interface CapabilityGapRecord {
  interaction_id: string;
  primitive: string;
  reason: string;
}

export interface CounterfactualSummary {
  eval_at: number;
  appraisal: number;
  main_sensation: Sensation | null;
  self_before: number;
  self_after: number;
  same_sensation_before: number;
  same_sensation_after: number;
}

export interface StageVerdict {
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  name: StageName;
  verdict: StageVerdictStatus;
  reasons: string[];
  evidence_ids: string[];
  midpoints_ms?: number[];
  gaps?: CapabilityGapRecord[];
  counterfactual?: CounterfactualSummary;
}

export type M2VerdictStatus = 'pass' | 'fail' | 'not judged' | 'not evaluable';

export interface M2Effects {
  p_s0: number;
  p_s1: number;
  p_s1_prime: number;
  dT: number;
  dN: number;
  dM: number;
  dM_over_p_s1_prime: number | null;
}

export interface M2ReplayRun {
  object_contacts: number;
  peer_contacts: number;
  first_return_at: number | null;
  first_return_offset_ms: number | null;
}

export interface M2Summary extends M2Effects {
  eval_at: number;
  appraisal: number;
  main_sensation: Sensation | null;
  verdict: M2VerdictStatus;
  same_sensation: M2Effects & {
    main_sensation: Sensation | null;
  };
  replay_24h: {
    s1: M2ReplayRun;
    s1_prime: M2ReplayRun;
  };
}

export interface BlindJudgeReport {
  object_id: string;
  stages: [StageVerdict, StageVerdict, StageVerdict, StageVerdict, StageVerdict, StageVerdict];
  m2?: M2Summary;
}

export interface StoredCardEvidence {
  id: string;
  object_id: string;
  source: string;
  card: unknown;
}

export interface StoredInteractionEvidence {
  id: string;
  object_id: string;
  card_id: string;
  source: string;
  raw_spec?: unknown;
  spec: unknown;
  status: 'accepted' | 'degraded' | 'rejected';
  checks: { check: string; ok: boolean; reason: string | null }[];
  gaps: { primitive: string; reason: string }[];
}

export interface StoredObjectStateRow {
  id?: number | string;
  object_id: string;
  valid_from: number;
  x: number;
  y: number;
  z: number;
  footprint: Cell[];
  rotation: number;
  status: string;
  state: string;
  sprite: string;
  cause: string;
}

export interface BlindWorldSnapshot {
  objects: CamObject[];
  interactions: Interaction[];
  position: Cell;
  state_before?: WorldState;
  state_after: WorldState;
  weather?: Weather;
  intents?: ActiveIntent[];
}

export interface BlindEvidence {
  object_id: string;
  card: StoredCardEvidence | null;
  interactions: StoredInteractionEvidence[];
  segments: (Segment & { planned_cell?: Cell })[];
  state_changes: StoredObjectStateRow[];
  sound_events: CamEvent[];
  experiences: Experience[];
  objects_at_start?: CamObject[];
  world_snapshot?: BlindWorldSnapshot;
}

const EPS = 1e-9;
const PROB_EPS = 1e-12;
const cleanTerm = (value: string) => value.trim().toLowerCase();

export function wholeWordRegex(term: string): RegExp {
  const normalized = cleanTerm(term);
  if (!normalized) throw new Error('empty search term');
  const escaped = normalized
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s_-]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
}

export function countWholeWord(haystack: string, term: string): number {
  if (!haystack) return 0;
  const matches = haystack.match(wholeWordRegex(term));
  return matches ? matches.length : 0;
}

export function containsWholeWord(haystack: string, term: string): boolean {
  return countWholeWord(haystack, term) > 0;
}

export async function registration(
  label: string,
  synonyms: readonly string[],
  expectedSensations: readonly string[],
): Promise<BlindRegistrationRecord> {
  const normalizedLabel = cleanTerm(label);
  if (!normalizedLabel) throw new Error('registration label required');
  const normalizedSynonyms = [...new Set(synonyms.map(cleanTerm).filter(Boolean))].sort();
  const normalizedSensations = [...new Set(expectedSensations.map(cleanTerm).filter(Boolean))].sort();
  const record: BlindRegistration = {
    label: normalizedLabel,
    synonyms: normalizedSynonyms,
    expected_sensations: normalizedSensations,
  };
  const json = JSON.stringify(record);
  const sha256 = await sha256Hex(json);
  return { registration: record, json, sha256 };
}

export function mainSensation(sensations: Sensations | undefined): Sensation | null {
  if (!sensations) return null;
  let best: Sensation | null = null;
  let bestWeight = 0;
  for (const key of SENSATIONS as Sensation[]) {
    const w = sensations[key];
    if (typeof w === 'number' && w > bestWeight) {
      bestWeight = w;
      best = key;
    }
  }
  return best;
}

function stripPrefabAction(raw: unknown, source: string): unknown {
  if (source !== 'prefab' || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const copy = { ...(raw as Record<string, unknown>) };
  delete copy.action;
  return copy;
}

function insideGrid(cell: unknown): cell is Cell {
  return (
    Array.isArray(cell) &&
    cell.length === 2 &&
    Number.isInteger(cell[0]) &&
    Number.isInteger(cell[1]) &&
    cell[0] >= 0 &&
    cell[0] < 10 &&
    cell[1] >= 0 &&
    cell[1] < 8
  );
}

function sameCell(a: Cell, b: Cell): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function reconstructPreExperienceState(
  completionInput: WorldState,
  runSegments: Segment[],
  card: ObjectCard | null,
): WorldState {
  let state = structuredClone(completionInput);
  for (const s of runSegments) {
    const wasAsleep = state.nori.asleep;
    const prev = structuredClone(state);
    state = continuous(state, s.start_at, s.end_at, s.action);
    state.nori.z = s.z_to ?? s.z;
    if (wasAsleep && s.action !== 'sleep') {
      wakeResponse(prev, s.source, s.start_at, s.world_version, true);
      state.nori.security = prev.nori.security;
    }
    if (s.action === 'sleep') {
      const hours = (s.end_at - s.start_at) / 3600000;
      state.nori.security = clamp(state.nori.security + 0.05);
      if (hours >= 1 / 3 && card) {
        for (const k of Object.keys(card.sensations)) {
          preference(state, k as Sensation, RULES.prefRate, s.end_at);
        }
        state.familiarity[s.target || ''] = clamp((state.familiarity[s.target || ''] || 0) + 0.05);
      }
    }
    if (s.action === 'hide_in' && s.primitive === 'hold_pose') {
      preference(state, 'shelter', RULES.prefRate, s.end_at);
      state.nori.security = clamp(state.nori.security + 0.1);
    }
  }
  return state;
}

function equalNumberMap(
  actual: Sensations | undefined,
  expected: Sensations,
  keys: readonly string[],
): boolean {
  if (!actual) return keys.length === 0;
  if (Object.keys(actual).length !== keys.length) return false;
  for (const k of keys) {
    const a = actual[k as Sensation];
    const b = expected[k as Sensation];
    if (typeof a !== 'number' || typeof b !== 'number' || Math.abs(a - b) > EPS) return false;
  }
  return true;
}
export function buildCounterfactualNoMemoryState(s0: WorldState, s1: WorldState): WorldState {
  const s1Prime = structuredClone(s1);
  s1Prime.familiarity = structuredClone(s0.familiarity);
  s1Prime.habits = structuredClone(s0.habits);
  s1Prime.prefs = structuredClone(s0.prefs);
  if ('pref_deltas' in s0 && s0.pref_deltas !== undefined) {
    s1Prime.pref_deltas = structuredClone(s0.pref_deltas);
  } else {
    delete s1Prime.pref_deltas;
  }
  if ('pref_day' in s0 && s0.pref_day !== undefined) {
    s1Prime.pref_day = s0.pref_day;
  } else {
    delete s1Prime.pref_day;
  }
  s1Prime.wariness = structuredClone(s0.wariness);
  return s1Prime;
}

export function evaluateM2Verdict(
  appraisal: number,
  pS1Prime: number,
  dM: number,
): M2VerdictStatus {
  if (pS1Prime === 0) return 'not evaluable';
  if (appraisal > 0.1) {
    return dM > 0 && dM / pS1Prime >= 0.1 ? 'pass' : 'fail';
  }
  if (appraisal < -0.1) {
    return dM < 0 && Math.abs(dM) / pS1Prime >= 0.1 ? 'pass' : 'fail';
  }
  return 'not judged';
}

export function replay24hFromState(
  initialState: WorldState,
  basePlanInput: {
    objects: CamObject[];
    interactions: Interaction[];
    start_at: number;
    world_version: number;
    position: Cell;
    weather?: Weather;
    intents?: ActiveIntent[];
  },
  objectId: string,
  peerIds: ReadonlySet<string>,
  hours = 24,
): M2ReplayRun {
  const evalAt = basePlanInput.start_at;
  const end = evalAt + hours * 3600000;
  let state = structuredClone(initialState);
  state.settled_through = evalAt;
  let objects = structuredClone(basePlanInput.objects);
  let position: Cell = [...basePlanInput.position];
  let at = evalAt;
  let objectContacts = 0;
  let peerContacts = 0;
  let firstReturnAt: number | null = null;
  let firstReturnOffsetMs: number | null = null;

  while (at < end) {
    const next = planNext({
      ...basePlanInput,
      state,
      objects,
      position,
      start_at: at,
    });
    if (next.length === 0) break;
    for (let s of next) {
      if (s.start_at >= end) break;
      if (s.end_at > end) {
        s = { ...s, end_at: end, cut_at: end };
      }
      const result = settle(state, s, objects, s.end_at, basePlanInput.weather);
      if (result.error) {
        throw new Error(`M2 24h replay settle error: ${JSON.stringify(result.error)}`);
      }
      state = result.state;
      objects = result.objects;
      for (const e of result.experiences) {
        if (e.object_id === objectId) {
          objectContacts++;
          if (firstReturnAt === null) {
            firstReturnAt = e.at;
            firstReturnOffsetMs = e.at - evalAt;
          }
        } else if (peerIds.has(e.object_id)) {
          peerContacts++;
        }
      }
      position = s.path.at(-1)!;
      at = s.end_at;
    }
  }

  return {
    object_contacts: objectContacts,
    peer_contacts: peerContacts,
    first_return_at: firstReturnAt,
    first_return_offset_ms: firstReturnOffsetMs,
  };
}

export function judge(evidence: BlindEvidence, reg: BlindRegistration): BlindJudgeReport {
  const registeredTerms = [...new Set([reg.label, ...reg.synonyms].map(cleanTerm).filter(Boolean))];
  const expectedSensations = [...new Set(reg.expected_sensations.map(cleanTerm).filter(Boolean))];

  // Stage 1: Understanding
  const s1Reasons: string[] = [];
  const s1Ids: string[] = evidence.card ? [evidence.card.id] : [];
  const isPrefab = evidence.card?.source === 'prefab';
  let validCard: ObjectCard | null = null;
  let s1Verdict: StageVerdictStatus = 'fail';

  if (!evidence.card || !evidence.card.card || typeof evidence.card.card !== 'object') {
    s1Reasons.push('object card missing');
  } else {
    const cardErrors = validateCard(evidence.card.card, isPrefab);
    if (cardErrors.length > 0) {
      s1Reasons.push(`validateCard failed: ${cardErrors.join('; ')}`);
    } else {
      validCard = evidence.card.card as ObjectCard;
    }

    const candidateCard = evidence.card.card as Partial<ObjectCard>;
    const surfaces: string[] = [];
    if (typeof candidateCard.name === 'string') surfaces.push(candidateCard.name);
    if (Array.isArray(candidateCard.affordances)) {
      for (const aff of candidateCard.affordances) {
        if (aff && typeof aff.verb === 'string') surfaces.push(aff.verb);
      }
    }
    const matchedTerm = registeredTerms.some(term => surfaces.some(text => containsWholeWord(text, term)));
    if (!matchedTerm) {
      s1Reasons.push('card name and affordance verbs do not match any registered term as a whole word');
    }

    const cardSensations = (candidateCard.sensations || {}) as Record<string, unknown>;
    const overlap = expectedSensations.filter(
      key => typeof cardSensations[key] === 'number' && (cardSensations[key] as number) > 0,
    );
    if (overlap.length === 0) {
      s1Reasons.push('card sensations do not overlap expected_sensations');
    }

    if (validCard && matchedTerm && overlap.length > 0) {
      s1Verdict = 'pass';
      s1Reasons.push(`card validated; sensations overlap: ${overlap.join(', ')}`);
    }
  }

  const stage1: StageVerdict = {
    stage: 1,
    name: 'understanding',
    verdict: s1Verdict,
    reasons: s1Reasons,
    evidence_ids: s1Ids,
  };

  // Stage 2: Spec generation
  const s2Reasons: string[] = [];
  const s2Ids: string[] = [];
  let s2Verdict: StageVerdictStatus = 'fail';
  const cardParts = new Set((validCard?.parts || []).map(p => p.kind));

  if (!validCard) {
    s2Reasons.push('cannot verify spec parts without a valid object card');
  } else if (evidence.interactions.length === 0) {
    s2Reasons.push('no interaction specs present');
  } else {
    for (const ix of evidence.interactions) {
      const candidate = stripPrefabAction(ix.raw_spec ?? ix.spec, ix.source);
      const errs = schemaErrors(candidate, interactionSchema as Parameters<typeof schemaErrors>[1]);
      if (errs.length > 0) {
        s2Reasons.push(`${ix.id}: schema errors (${errs.join('; ')})`);
        continue;
      }
      const spec = candidate as InteractionSpec;
      const badPrimitives = spec.steps
        .map(step => step.p)
        .filter(p => !Object.hasOwn(EXECUTOR, p));
      if (badPrimitives.length > 0) {
        s2Reasons.push(`${ix.id}: non-EXECUTOR primitives (${badPrimitives.join(', ')})`);
        continue;
      }
      const badParts = spec.steps
        .filter((step): step is Step & { part: string } => typeof step.part === 'string')
        .map(step => step.part)
        .filter(part => !cardParts.has(part));
      if (badParts.length > 0) {
        s2Reasons.push(`${ix.id}: references parts absent from card (${badParts.join(', ')})`);
        continue;
      }
      s2Ids.push(ix.id);
    }
    if (s2Ids.length > 0) {
      s2Verdict = 'pass';
      s2Reasons.unshift(`${s2Ids.length} spec(s) passed schema, EXECUTOR primitive and card part checks`);
    }
  }

  const stage2: StageVerdict = {
    stage: 2,
    name: 'spec_generation',
    verdict: s2Verdict,
    reasons: s2Reasons,
    evidence_ids: s2Ids,
  };

  // Stage 3: Checker
  const s3Reasons: string[] = [];
  const s3Ids: string[] = [];
  const s3Gaps: CapabilityGapRecord[] = [];
  let s3Verdict: StageVerdictStatus = 'fail';

  const acceptedIxs = evidence.interactions.filter(ix => ix.status === 'accepted');
  const degradedIxs = evidence.interactions.filter(ix => ix.status === 'degraded');
  const rejectedIxs = evidence.interactions.filter(ix => ix.status === 'rejected');

  for (const ix of degradedIxs) {
    for (const g of ix.gaps || []) {
      s3Gaps.push({ interaction_id: ix.id, primitive: g.primitive, reason: g.reason });
    }
  }

  if (acceptedIxs.length > 0) {
    s3Verdict = 'pass';
    s3Ids.push(...acceptedIxs.map(ix => ix.id));
    s3Reasons.push(`accepted: ${acceptedIxs.map(ix => ix.id).join(', ')}`);
    if (degradedIxs.length > 0) {
      s3Reasons.push(`degraded alternatives: ${degradedIxs.map(ix => ix.id).join(', ')}`);
    }
    if (rejectedIxs.length > 0) {
      const details = rejectedIxs.map(ix => {
        const failed = (ix.checks || []).filter(c => !c.ok).map(c => c.check).join(',');
        return `${ix.id}${failed ? ` (${failed})` : ''}`;
      });
      s3Reasons.push(`rejected candidates: ${details.join('; ')}`);
    }
  } else if (degradedIxs.length > 0) {
    s3Verdict = 'degraded_pass';
    s3Ids.push(...degradedIxs.map(ix => ix.id));
    if (s3Gaps.length > 0) {
      for (const g of s3Gaps) {
        s3Reasons.push(`capability gap [${g.interaction_id}] ${g.primitive}: ${g.reason}`);
      }
    } else {
      s3Reasons.push(`degraded: ${degradedIxs.map(ix => ix.id).join(', ')}`);
    }
  } else {
    s3Ids.push(...rejectedIxs.map(ix => ix.id));
    if (evidence.interactions.length === 0) {
      s3Reasons.push('no interaction candidates checked');
    } else {
      for (const ix of rejectedIxs) {
        const failed = (ix.checks || [])
          .filter(c => !c.ok)
          .map(c => `${c.check}${c.reason ? `: ${c.reason}` : ''}`)
          .join(', ');
        s3Reasons.push(`rejected ${ix.id}${failed ? ` (${failed})` : ''}`);
      }
    }
  }

  const stage3: StageVerdict = {
    stage: 3,
    name: 'checker',
    verdict: s3Verdict,
    reasons: s3Reasons,
    evidence_ids: s3Ids,
    ...(s3Gaps.length > 0 ? { gaps: s3Gaps } : {}),
  };
  // Stage 4: Animation execution
  const runnableIxIds = new Set([...acceptedIxs, ...degradedIxs].map(ix => ix.id));
  const settledUncut = evidence.segments
    .filter(
      s =>
        s.interaction != null &&
        runnableIxIds.has(s.interaction) &&
        s.superseded_at == null &&
        s.settled_at != null &&
        s.cut_at == null,
    )
    .sort((a, b) => a.start_at - b.start_at || a.id - b.id);

  let executedRun: (Segment & { planned_cell?: Cell })[] = [];
  const byId = new Map(settledUncut.map(s => [s.id, s]));
  const completionCandidate = settledUncut.find(
    s =>
      s.completion?.last &&
      Array.isArray(s.completion.segment_ids) &&
      s.completion.segment_ids.length > 0 &&
      s.completion.segment_ids.every(id => byId.has(id)),
  );
  if (completionCandidate?.completion) {
    executedRun = completionCandidate.completion.segment_ids.map(id => byId.get(id)!);
  } else if (settledUncut.length > 0) {
    const firstIx = settledUncut[0].interaction;
    executedRun = settledUncut.filter(s => s.interaction === firstIx);
  }

  const s4Reasons: string[] = [];
  const s4Ids = executedRun.map(s => String(s.id));
  const midpoints: number[] = [];
  let s4Verdict: StageVerdictStatus = 'fail';

  if (runnableIxIds.size === 0) {
    s4Reasons.push('no accepted or degraded interaction available to execute');
  } else if (executedRun.length === 0) {
    s4Reasons.push('no settled uncut interaction segment found');
  } else {
    let machineOk = true;
    const propPoses = isPrefab && Array.isArray(validCard?.prop_poses) ? validCard!.prop_poses! : [];
    const runStartAt = executedRun[0].start_at;
    const priorStateRow = [...evidence.state_changes]
      .filter(r => r.object_id === evidence.object_id && r.valid_from <= runStartAt && r.cause !== String(executedRun[0].id))
      .sort((a, b) => a.valid_from - b.valid_from)
      .at(-1);
    const objectsAtRunStart = evidence.objects_at_start?.map(o =>
      o.id === evidence.object_id && priorStateRow
        ? {
            ...o,
            x: priorStateRow.x,
            y: priorStateRow.y,
            z: priorStateRow.z,
            footprint: priorStateRow.footprint,
            rotation: priorStateRow.rotation,
            status: priorStateRow.status,
            state: priorStateRow.state,
            sprite: priorStateRow.sprite,
          }
        : o,
    );
    const targetObjStart = objectsAtRunStart?.find(o => o.id === evidence.object_id);

    for (let idx = 0; idx < executedRun.length; idx++) {
      const seg = executedRun[idx];
      const cap = EXECUTOR[seg.primitive as keyof typeof EXECUTOR];
      if (!cap) {
        machineOk = false;
        s4Reasons.push(`segment ${seg.id}: unsupported primitive ${seg.primitive}`);
        continue;
      }

      const rawAllowed = [
        ...cap.poses,
        ...(seg.primitive === 'hold_pose' || seg.primitive === 'sleep' ? propPoses : []),
      ];
      const poseAllowed =
        rawAllowed.includes(seg.pose) || rawAllowed.some(allowed => renderPose(allowed) === seg.pose);
      if (!poseAllowed) {
        machineOk = false;
        s4Reasons.push(`segment ${seg.id}: pose ${seg.pose} not allowed for primitive ${seg.primitive}`);
      }

      if (!Array.isArray(seg.path) || seg.path.length === 0 || !seg.path.every(insideGrid)) {
        machineOk = false;
        s4Reasons.push(`segment ${seg.id}: invalid or empty path`);
        continue;
      }

      if (idx > 0) {
        const prevEnd = executedRun[idx - 1].path.at(-1)!;
        if (!sameCell(seg.path[0], prevEnd)) {
          machineOk = false;
          s4Reasons.push(
            `segment ${seg.id}: path start [${seg.path[0]}] discontinuities previous end [${prevEnd}]`,
          );
        }
      }

      const endCell = seg.path.at(-1)!;
      if (seg.planned_cell && !sameCell(endCell, seg.planned_cell)) {
        machineOk = false;
        s4Reasons.push(
          `segment ${seg.id}: end cell [${endCell}] does not equal planned cell [${seg.planned_cell}]`,
        );
      }

      const mid = Math.floor((seg.start_at + seg.end_at) / 2);
      if (!['move_to', 'carry', 'climb'].includes(seg.primitive)) {
        if (!seg.path.every(c => sameCell(c, seg.path[0]))) {
          machineOk = false;
          s4Reasons.push(`segment ${seg.id}: stationary primitive ${seg.primitive} moved across cells`);
        }
        const sampled = poseAt([seg], mid);
        if (!sampled || !sameCell([Math.round(sampled.x), Math.round(sampled.y)], endCell)) {
          machineOk = false;
          s4Reasons.push(`segment ${seg.id}: midpoint position does not match planned cell [${endCell}]`);
        }
      } else {
        const atEnd = poseAt([seg], seg.end_at);
        if (!atEnd || !sameCell([Math.round(atEnd.x), Math.round(atEnd.y)], endCell)) {
          machineOk = false;
          s4Reasons.push(`segment ${seg.id}: end position does not match planned cell [${endCell}]`);
        }
        if (
          seg.primitive === 'move_to' &&
          seg.action !== 'react' &&
          targetObjStart &&
          objectsAtRunStart &&
          executedRun[idx + 1]?.primitive !== 'move_to'
        ) {
          const access = accessObject(targetObjStart, objectsAtRunStart) || targetObjStart;
          const legalOpCells = operationCells(access, seg.part || undefined, {
            objects: objectsAtRunStart,
          });
          if (legalOpCells.length > 0 && !legalOpCells.some((c: Cell) => sameCell(c, endCell))) {
            machineOk = false;
            s4Reasons.push(
              `segment ${seg.id}: move_to destination [${endCell}] is not a legal operation cell for part ${seg.part ?? 'default'}`,
            );
          }
        }
      }

      if (seg.primitive === 'touch' || seg.primitive === 'push') {
        midpoints.push(mid);
      }
    }

    if (machineOk) {
      if (midpoints.length > 0) {
        s4Verdict = 'manager_check';
        s4Reasons.push(
          `settled ${executedRun.length} uncut segment(s); paw-anchor screenshot check required at midpoint(s): ${midpoints.join(', ')}`,
        );
      } else {
        s4Verdict = 'pass';
        s4Reasons.push(`settled ${executedRun.length} uncut segment(s) with valid planned cells and poses`);
      }
    }
  }

  const stage4: StageVerdict = {
    stage: 4,
    name: 'animation_execution',
    verdict: s4Verdict,
    reasons: s4Reasons,
    evidence_ids: s4Ids,
    ...(midpoints.length > 0 ? { midpoints_ms: midpoints } : {}),
  };
  // Stage 5: World change
  const s5Reasons: string[] = [];
  const s5Ids: string[] = [];
  let s5Verdict: StageVerdictStatus = 'fail';

  if (executedRun.length === 0) {
    s5Reasons.push('no settled uncut interaction segments to produce world change');
  } else {
    let ok = true;
    let recordedEffectCount = 0;
    const usedSoundIds = new Set<string>();
    const usedStateRowIndexes = new Set<number>();

    const fallbackBaseObject: CamObject = {
      id: evidence.object_id,
      kind: validCard?.category || 'toy',
      x: 0,
      y: 0,
      z: 0,
      footprint: [[0, 0]],
      rotation: 0,
      blocks: validCard?.space.blocks ?? true,
      placement: normalizePlacement(validCard?.space.placement),
      status: 'placed',
      state: 'default',
      size: validCard?.size || 'M',
      tags: validCard?.tags || [],
      sprite: '',
      card: (validCard || {}) as ObjectCard,
    };
    const baseObjects =
      evidence.objects_at_start && evidence.objects_at_start.some(o => o.id === evidence.object_id)
        ? evidence.objects_at_start
        : [fallbackBaseObject];

    for (const seg of executedRun) {
      for (const eff of seg.effects || []) {
        if (eff.e === 'physics_rejected') {
          ok = false;
          s5Reasons.push(`segment ${seg.id}: physics_rejected (${eff.reason || 'blocked'})`);
        }
      }

      const soundEffects = (seg.effects || []).filter(e => e.e === 'emit_sound');
      for (const eff of soundEffects) {
        recordedEffectCount++;
        const match = evidence.sound_events.find(
          ev =>
            !usedSoundIds.has(ev.id) &&
            ev.type === 'sound_played' &&
            ev.at >= seg.start_at &&
            ev.at <= seg.end_at &&
            (ev.payload?.target == null || ev.payload.target === evidence.object_id) &&
            (eff.pattern == null || ev.payload?.pattern == null || ev.payload.pattern === eff.pattern),
        );
        if (!match) {
          ok = false;
          s5Reasons.push(
            `segment ${seg.id}: missing sound_played event within [${seg.start_at}, ${seg.end_at}]`,
          );
        } else {
          usedSoundIds.add(match.id);
          s5Ids.push(match.id);
        }
      }

      const hasPersistentEffect =
        seg.primitive === 'carry' ||
        seg.primitive === 'drop' ||
        (seg.effects || []).some(
          e =>
            (e.e === 'move_object' && ((e.dx || 0) !== 0 || (e.dy || 0) !== 0)) ||
            e.e === 'set_state' ||
            e.e === 'glow',
        );

      if (hasPersistentEffect) {
        recordedEffectCount++;
        const rowIdx = evidence.state_changes.findIndex(
          (row, idx) =>
            !usedStateRowIndexes.has(idx) &&
            row.object_id === evidence.object_id &&
            row.cause === String(seg.id) &&
            row.valid_from >= seg.start_at &&
            row.valid_from <= seg.end_at,
        );
        if (rowIdx < 0) {
          ok = false;
          s5Reasons.push(
            `segment ${seg.id}: missing object_states row with cause=${seg.id} within [${seg.start_at}, ${seg.end_at}]`,
          );
        } else {
          usedStateRowIndexes.add(rowIdx);
          const row = evidence.state_changes[rowIdx];
          s5Ids.push(row.id != null ? `object_states:${row.id}` : `object_states:${row.cause}@${row.valid_from}`);
        }

        const beforeObj = applyEffects(baseObjects, executedRun, seg.start_at - 1).find(
          (o: CamObject) => o.id === evidence.object_id,
        );
        const afterObj = applyEffects(baseObjects, executedRun, seg.end_at).find(
          (o: CamObject) => o.id === evidence.object_id,
        );
        if (JSON.stringify(beforeObj) === JSON.stringify(afterObj)) {
          ok = false;
          s5Reasons.push(`segment ${seg.id}: persistent effect did not change applyEffects result`);
        }
      }
    }

    if (recordedEffectCount === 0) {
      ok = false;
      s5Reasons.push(
        `no D1-recorded world-change effects executed (${evidence.sound_events.length} sound_played events, ${evidence.state_changes.length} post-unwrap object_states rows)`,
      );
    }

    if (ok && recordedEffectCount > 0) {
      s5Verdict = 'pass';
      s5Reasons.push(`verified ${recordedEffectCount} executed world-change effect(s) in D1`);
    }
  }

  const stage5: StageVerdict = {
    stage: 5,
    name: 'world_change',
    verdict: s5Verdict,
    reasons: s5Reasons,
    evidence_ids: s5Ids,
  };

  // Stage 6: Experience
  const s6Reasons: string[] = [];
  const s6Ids: string[] = [];
  let s6Verdict: StageVerdictStatus = 'fail';
  let counterfactualSummary: CounterfactualSummary | undefined;
  let m2Summary: M2Summary | undefined;

  const exp =
    evidence.experiences.find(
      e => e.object_id === evidence.object_id && runnableIxIds.has(e.interaction_id),
    ) || evidence.experiences.find(e => e.object_id === evidence.object_id);

  if (!exp) {
    s6Reasons.push('no experiences row found for object');
  } else {
    s6Ids.push(exp.id);
    const completionSegId = exp.segment_ids.at(-1);
    const completionSeg = evidence.segments.find(s => s.id === completionSegId);
    if (!completionSeg?.completion?.input) {
      s6Reasons.push(`missing completion input on segment ${String(completionSegId)}`);
    } else {
      const recomputed = assess(
        completionSeg.completion.input,
        exp.object_id,
        exp.sensations,
        exp.interaction_id,
        completionSeg.id,
      );
      const assessMatches =
        Math.abs(recomputed.startle - exp.startle) <= EPS &&
        Math.abs(recomputed.appraisal - exp.appraisal) <= EPS &&
        recomputed.reaction === exp.reaction;
      if (!assessMatches) {
        s6Reasons.push(
          `recomputed assess (${recomputed.startle}, ${recomputed.appraisal}, ${recomputed.reaction}) != stored (${exp.startle}, ${exp.appraisal}, ${exp.reaction})`,
        );
      }

      const segById = new Map(evidence.segments.map(s => [s.id, s]));
      const expRunSegments = exp.segment_ids
        .map(id => segById.get(id))
        .filter((s): s is Segment => !!s);

      const preExpState = evidence.world_snapshot?.state_before
        ? structuredClone(evidence.world_snapshot.state_before)
        : reconstructPreExperienceState(completionSeg.completion.input, expRunSegments, validCard);

      const formulaState = structuredClone(preExpState);
      const expectedPrefDeltas: Sensations = {};
      const expectedWarinessDeltas: Sensations = {};
      const sensationKeys = Object.keys(exp.sensations);
      for (const [k, w] of Object.entries(exp.sensations)) {
        const key = k as Sensation;
        expectedPrefDeltas[key] = preference(
          formulaState,
          key,
          RULES.prefRate * (w || 0) * Math.tanh(2 * recomputed.appraisal),
          exp.at,
        );
        const oldW = formulaState.wariness[key];
        formulaState.wariness[key] = clamp(oldW + 0.15 * recomputed.startle);
        expectedWarinessDeltas[key] = formulaState.wariness[key] - oldW;
      }
      const oldFam = formulaState.familiarity[exp.object_id] || 0;
      formulaState.familiarity[exp.object_id] = clamp(oldFam + 0.1);
      const expectedFamDelta = formulaState.familiarity[exp.object_id] - oldFam;
      formulaState.novelty[exp.object_id] = (formulaState.novelty[exp.object_id] ?? 1) * 0.5;
      const oldHabit = formulaState.habits[exp.interaction_id] ?? { n: 0, good: 0, last_at: 0 };
      const expectedHabit = {
        n: oldHabit.n + 1,
        good: oldHabit.good + (recomputed.appraisal > 0 ? 1 : 0),
        last_at: exp.at,
      };
      formulaState.habits[exp.interaction_id] = expectedHabit;

      const deltasMatch =
        equalNumberMap(exp.pref_deltas, expectedPrefDeltas, sensationKeys) &&
        equalNumberMap(exp.wariness_deltas, expectedWarinessDeltas, sensationKeys) &&
        Math.abs(exp.familiarity_delta - expectedFamDelta) <= EPS;
      if (!deltasMatch) {
        s6Reasons.push('stored experience deltas do not match engine preference/wariness/familiarity formulas');
      }

      const snap = evidence.world_snapshot;
      let storedMatches = false;
      if (!snap) {
        s6Reasons.push('missing world_snapshot for stored-state and counterfactual checks');
      } else {
        const storedAfter = snap.state_after;
        const storedHabit = storedAfter.habits?.[exp.interaction_id];
        if (!storedHabit) {
          s6Reasons.push(`habit for ${exp.interaction_id} not stored in world state`);
        } else if (storedAfter.settled_through === exp.at) {
          const prefsStoredOk = sensationKeys.every(
            k => Math.abs(storedAfter.prefs[k as Sensation] - formulaState.prefs[k as Sensation]) <= EPS,
          );
          const warinessStoredOk = sensationKeys.every(
            k => Math.abs(storedAfter.wariness[k as Sensation] - formulaState.wariness[k as Sensation]) <= EPS,
          );
          const famStoredOk =
            Math.abs(
              (storedAfter.familiarity[exp.object_id] || 0) - formulaState.familiarity[exp.object_id],
            ) <= EPS;
          const habitStoredOk =
            storedHabit.n === expectedHabit.n &&
            storedHabit.good === expectedHabit.good &&
            storedHabit.last_at === expectedHabit.last_at;
          storedMatches = prefsStoredOk && warinessStoredOk && famStoredOk && habitStoredOk;
          if (!storedMatches) {
            s6Reasons.push('world state_after does not match formula-updated prefs/wariness/familiarity/habits');
          }
        } else {
          storedMatches =
            storedHabit.n >= expectedHabit.n &&
            storedHabit.good >= expectedHabit.good &&
            storedHabit.last_at >= expectedHabit.last_at &&
            (storedAfter.familiarity[exp.object_id] || 0) + EPS >= formulaState.familiarity[exp.object_id];
          if (!storedMatches) {
            s6Reasons.push('world state_after missing expected post-experience habit or familiarity');
          }
        }

        const stateWithout = preExpState;
        const stateWith = storedAfter.settled_through === exp.at ? storedAfter : formulaState;
        const cooldownMs = Math.max(
          0,
          ...snap.interactions
            .filter(i => i.object_id === exp.object_id)
            .map(i => (i.spec.cooldown_min || 0) * 60000),
        );
        const evalAt = exp.at + cooldownMs;
        const basePlanInput = {
          objects: snap.objects,
          interactions: snap.interactions,
          start_at: evalAt,
          world_version: exp.world_version,
          position: snap.position,
          weather: snap.weather,
          intents: snap.intents,
        };
        const candsBefore = candidateScores({ ...basePlanInput, state: stateWithout }, evalAt);
        const candsAfter = candidateScores({ ...basePlanInput, state: stateWith }, evalAt);
        const probsBefore = candsBefore.length
          ? choiceProbabilities([...candsBefore.map(c => c.score), 1.3])
          : [];
        const probsAfter = candsAfter.length
          ? choiceProbabilities([...candsAfter.map(c => c.score), 1.3])
          : [];

        const targetObj = snap.objects.find(o => o.id === exp.object_id);
        const targetMain = mainSensation(targetObj?.card?.sensations || validCard?.sensations || exp.sensations);
        const peerIds = new Set(
          targetMain
            ? snap.objects
                .filter(
                  o =>
                    o.id !== exp.object_id &&
                    o.status === 'placed' &&
                    mainSensation(o.card?.sensations) === targetMain,
                )
                .map(o => o.id)
            : [],
        );

        const sumFor = (
          cands: ReturnType<typeof candidateScores>,
          probs: number[],
          predicate: (objectId: string) => boolean,
        ) =>
          cands.reduce((acc, c, idx) => (predicate(c.object.id) ? acc + (probs[idx] || 0) : acc), 0);

        const selfBefore = sumFor(candsBefore, probsBefore, id => id === exp.object_id);
        const selfAfter = sumFor(candsAfter, probsAfter, id => id === exp.object_id);
        const sameBefore = sumFor(candsBefore, probsBefore, id => peerIds.has(id));
        const sameAfter = sumFor(candsAfter, probsAfter, id => peerIds.has(id));

        const peerDeltas = [...peerIds].map(
          peerId =>
            sumFor(candsAfter, probsAfter, id => id === peerId) -
            sumFor(candsBefore, probsBefore, id => id === peerId),
        );
        const selfDelta = selfAfter - selfBefore;
        const sameDelta = sameAfter - sameBefore;
        const sign = Math.sign(exp.appraisal);
        const counterfactualOk =
          sign > 0
            ? selfDelta > PROB_EPS || peerDeltas.some(d => d > PROB_EPS) || sameDelta > PROB_EPS
            : sign < 0
              ? selfDelta < -PROB_EPS || peerDeltas.some(d => d < -PROB_EPS) || sameDelta < -PROB_EPS
              : Math.abs(selfDelta) <= PROB_EPS && Math.abs(sameDelta) <= PROB_EPS;

        counterfactualSummary = {
          eval_at: evalAt,
          appraisal: exp.appraisal,
          main_sensation: targetMain,
          self_before: selfBefore,
          self_after: selfAfter,
          same_sensation_before: sameBefore,
          same_sensation_after: sameAfter,
        };

        if (!counterfactualOk) {
          s6Reasons.push(
            `counterfactual probability shift mismatch for appraisal=${exp.appraisal.toFixed(4)} (main=${targetMain ?? 'none'}): self ${selfBefore.toFixed(6)} -> ${selfAfter.toFixed(6)} (delta=${selfDelta.toFixed(6)}), same-main-sensation ${sameBefore.toFixed(6)} -> ${sameAfter.toFixed(6)} (delta=${sameDelta.toFixed(6)})`,
          );
        }

        if (assessMatches && deltasMatch && storedMatches && counterfactualOk) {
          s6Verdict = 'pass';
          s6Reasons.push(
            `experience verified; counterfactual shift consistent with appraisal=${exp.appraisal.toFixed(4)} (self delta=${selfDelta.toFixed(6)}, same-main-sensation delta=${sameDelta.toFixed(6)})`,
          );
        }

        const stateNoMemory = buildCounterfactualNoMemoryState(stateWithout, stateWith);
        const candsNoMemory = candidateScores({ ...basePlanInput, state: stateNoMemory }, evalAt);
        const probsNoMemory = candsNoMemory.length
          ? choiceProbabilities([...candsNoMemory.map(c => c.score), 1.3])
          : [];
        const selfNoMemory = sumFor(candsNoMemory, probsNoMemory, id => id === exp.object_id);
        const sameNoMemory = sumFor(candsNoMemory, probsNoMemory, id => peerIds.has(id));

        const selfDT = selfAfter - selfBefore;
        const selfDN = selfNoMemory - selfBefore;
        const selfDM = selfAfter - selfNoMemory;
        const selfDMRel = selfNoMemory > 0 ? selfDM / selfNoMemory : null;

        const sameDT = sameAfter - sameBefore;
        const sameDN = sameNoMemory - sameBefore;
        const sameDM = sameAfter - sameNoMemory;
        const sameDMRel = sameNoMemory > 0 ? sameDM / sameNoMemory : null;

        m2Summary = {
          eval_at: evalAt,
          appraisal: exp.appraisal,
          main_sensation: targetMain,
          p_s0: selfBefore,
          p_s1: selfAfter,
          p_s1_prime: selfNoMemory,
          dT: selfDT,
          dN: selfDN,
          dM: selfDM,
          dM_over_p_s1_prime: selfDMRel,
          verdict: evaluateM2Verdict(exp.appraisal, selfNoMemory, selfDM),
          same_sensation: {
            main_sensation: targetMain,
            p_s0: sameBefore,
            p_s1: sameAfter,
            p_s1_prime: sameNoMemory,
            dT: sameDT,
            dN: sameDN,
            dM: sameDM,
            dM_over_p_s1_prime: sameDMRel,
          },
          replay_24h: {
            s1: replay24hFromState(stateWith, basePlanInput, exp.object_id, peerIds),
            s1_prime: replay24hFromState(stateNoMemory, basePlanInput, exp.object_id, peerIds),
          },
        };
      }
    }
  }

  const stage6: StageVerdict = {
    stage: 6,
    name: 'experience',
    verdict: s6Verdict,
    reasons: s6Reasons,
    evidence_ids: s6Ids,
    ...(counterfactualSummary ? { counterfactual: counterfactualSummary } : {}),
  };

  return {
    object_id: evidence.object_id,
    stages: [stage1, stage2, stage3, stage4, stage5, stage6],
    ...(m2Summary ? { m2: m2Summary } : {}),
  };
}
