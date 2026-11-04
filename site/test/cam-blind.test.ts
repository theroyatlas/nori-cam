import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import catalog from '../public/cam/catalog.json' with { type: 'json' };
import { loadRegistrationFile, runRegister, runReplay, runScan } from '../scripts/blind-test.ts';
import { simulate } from '../scripts/simulate.ts';
import {
  buildCounterfactualNoMemoryState,
  judge,
  registration,
  type BlindEvidence,
  type BlindRegistration,
  type M2Summary,
} from '../src/worker/cam/blind.ts';
import { RULES, assess, clamp, continuous, initialState, preference } from '../src/worker/cam/engine.ts';
import { candidateScores, choiceProbabilities, planNext } from '../src/worker/cam/plan.ts';
import type {
  CamObject,
  CatalogEntry,
  Experience,
  Interaction,
  ObjectCard,
  Segment,
  Sensation,
  Sensations,
} from '../src/worker/cam/types.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(SITE_DIR, '..');
const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures', 'blind');
const CLI_PATH = path.join(SITE_DIR, 'scripts', 'blind-test.ts');

const sha256Json = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function makeSyntheticCard(overrides: Partial<ObjectCard> = {}): ObjectCard {
  return {
    name: 'brass bell',
    category: 'instrument',
    size: 'S',
    height: 'low',
    tags: ['pressable', 'pushable'],
    sensations: { sound: 0.8, shelter: 0.2 },
    parts: [
      { kind: 'pressable', label: 'top button', side: 'front', height: 'low' },
      { kind: 'front', label: 'base rim', side: 'front', height: 'low' },
    ],
    states: ['default', 'lit'],
    space: {
      cm: { w: 20, d: 20, h: 15 },
      blocks: true,
      placement: 'floor',
      movable: { push: true, rotate: false, stack: false },
      state_cm: {},
    },
    affordances: [
      { verb: 'ring bell', effect_text: 'rings a clear tone', sensations: ['sound'] },
    ],
    beyond_executor: [],
    summary: 'Small desk bell.',
    ...overrides,
  };
}

function makeMinimalPassingEvidence(opts: {
  primitive?: 'touch' | 'hold_pose';
  effectKind?: 'sound' | 'move';
  appraisalBias?: 'positive' | 'negative';
} = {}): { evidence: BlindEvidence; reg: BlindRegistration } {
  const primitive = opts.primitive ?? 'hold_pose';
  const effectKind = opts.effectKind ?? 'move';
  const positive = (opts.appraisalBias ?? 'positive') === 'positive';

  const sensations: Sensations = positive ? { shelter: 0.9 } : { sound: 1, motion: 1 };
  const card = makeSyntheticCard({ sensations });
  const reg: BlindRegistration = {
    label: 'brass bell',
    synonyms: ['bell', 'chime'],
    expected_sensations: positive ? ['shelter'] : ['motion', 'sound'],
  };

  const objectId = 'o_synth_bell';
  const ixId = 'compiled:synth:0';
  const t0 = Date.UTC(2026, 10, 2, 12);

  const baseState = initialState(t0);
  if (positive) {
    // Already-familiar object where positive appraisal raises habit & preference without novelty drop dominating.
    baseState.novelty[objectId] = 0;
    baseState.familiarity[objectId] = 0.2;
    baseState.nori.curiosity = 0.8;
    baseState.nori.security = 0.9;
    baseState.nori.energy = 0.9;
    baseState.prefs.shelter = 0.8;
  } else {
    baseState.novelty[objectId] = 0;
    baseState.familiarity[objectId] = 0.95;
    baseState.nori.curiosity = 0.1;
    baseState.nori.security = 0.1;
    baseState.nori.energy = 0.2;
    baseState.prefs.sound = 0.1;
    baseState.prefs.motion = 0.1;
  }

  const targetObject: CamObject = {
    id: objectId,
    kind: 'instrument',
    x: 2,
    y: 4,
    z: 0,
    footprint: [[0, 0]],
    rotation: 0,
    blocks: true,
    placement: 'floor',
    status: 'placed',
    state: 'default',
    size: 'S',
    tags: card.tags,
    sprite: '/media/gift-synth.png',
    card_id: `card:${objectId}`,
    origin: { type: 'photo_gift', gift_id: 'synth' },
    card,
  };

  const spec = {
    verb: 'inspect_bell',
    sensations,
    steps: [
      { p: 'move_to', part: 'front' },
      primitive === 'touch'
        ? {
            p: 'touch',
            part: 'pressable',
            pose: 'wave',
            ms: 1000,
            effects:
              effectKind === 'sound'
                ? [{ e: 'emit_sound', pattern: 'single', at_ms: 200 }]
                : [{ e: 'move_object', dx: 0, dy: -1 }],
          }
        : {
            p: 'hold_pose',
            pose: 'sit',
            ms: 1000,
            effects:
              effectKind === 'sound'
                ? [{ e: 'emit_sound', pattern: 'single', at_ms: 200 }]
                : [{ e: 'move_object', dx: 0, dy: -1 }],
          },
    ],
    end_state: null,
    cooldown_min: 10,
  };

  // Keep Stage 2 schema-clean by putting contact effects on touch when testing schema, or move_object on push/touch.
  const schemaCleanSpec = {
    verb: 'tap_bell',
    sensations,
    steps: [
      { p: 'move_to', part: 'front' },
      {
        p: 'touch',
        part: 'pressable',
        pose: 'wave',
        ms: 1000,
        effects:
          effectKind === 'sound'
            ? [{ e: 'emit_sound', pattern: 'single', at_ms: 200 }]
            : [{ e: 'move_object', dx: 0, dy: -1 }],
      },
    ],
    end_state: null,
    cooldown_min: 10,
  };

  const seg1: Segment = {
    id: 100,
    start_at: t0,
    end_at: t0 + 667,
    action: 'walk',
    primitive: 'move_to',
    pose: 'walk',
    facing: 1,
    path: [
      [2, 6],
      [2, 5],
    ],
    z: 0,
    target: objectId,
    part: 'front',
    carrying: null,
    interaction: ixId,
    effects: [],
    source: `interaction:${ixId}`,
    world_version: 2,
    cut_at: null,
    settled_at: t0 + 667,
    superseded_at: null,
    trigger: null,
  };

  const seg2Effects =
    effectKind === 'sound'
      ? [{ e: 'emit_sound', pattern: 'single', at_ms: 200 }]
      : [{ e: 'move_object', dx: 0, dy: -1 }];

  const seg2: Segment = {
    id: 101,
    start_at: t0 + 667,
    end_at: t0 + 1667,
    action: 'interact',
    primitive,
    pose: 'sit',
    facing: 1,
    path: [[2, 5]],
    z: 0,
    target: objectId,
    part: primitive === 'touch' ? 'pressable' : 'front',
    carrying: null,
    interaction: ixId,
    effects: seg2Effects,
    source: `interaction:${ixId}`,
    world_version: 2,
    cut_at: null,
    settled_at: t0 + 1667,
    superseded_at: null,
    trigger: null,
  };

  const computedAssess = assess(baseState, objectId, sensations, ixId, 199);
  const seg3: Segment = {
    id: 199,
    start_at: t0 + 1667,
    end_at: t0 + 3167,
    action: 'react',
    primitive: 'hold_pose',
    pose: 'look_up',
    facing: 1,
    path: [[2, 5]],
    z: 0,
    target: objectId,
    part: null,
    carrying: null,
    interaction: ixId,
    effects: [],
    source: `interaction:${ixId}`,
    world_version: 2,
    cut_at: null,
    settled_at: t0 + 3167,
    superseded_at: null,
    trigger: null,
    completion: {
      last: true,
      segment_ids: [100, 101, 199],
      sensations,
      input: structuredClone(baseState),
      assessment: computedAssess,
      cell: [2, 5],
      start_at: t0 + 667,
      end_at: t0 + 1667,
    },
  };

  let preExp = structuredClone(baseState);
  for (const s of [seg1, seg2, seg3]) {
    preExp = continuous(preExp, s.start_at, s.end_at, s.action);
    preExp.nori.z = s.z;
  }
  const postExp = structuredClone(preExp);
  const prefDeltas: Sensations = {};
  const warinessDeltas: Sensations = {};
  for (const [k, w] of Object.entries(sensations)) {
    const key = k as Sensation;
    prefDeltas[key] = preference(
      postExp,
      key,
      RULES.prefRate * (w || 0) * Math.tanh(2 * computedAssess.appraisal),
      seg3.end_at,
    );
    const oldW = postExp.wariness[key];
    postExp.wariness[key] = clamp(oldW + 0.15 * computedAssess.startle);
    warinessDeltas[key] = postExp.wariness[key] - oldW;
  }
  const oldFam = postExp.familiarity[objectId] || 0;
  postExp.familiarity[objectId] = clamp(oldFam + 0.1);
  const famDelta = postExp.familiarity[objectId] - oldFam;
  postExp.novelty[objectId] = (postExp.novelty[objectId] ?? 1) * 0.5;
  postExp.habits[ixId] = {
    n: 1,
    good: computedAssess.appraisal > 0 ? 1 : 0,
    last_at: seg3.end_at,
  };

  const exp: Experience = {
    id: `exp:${ixId}:199`,
    at: seg3.end_at,
    object_id: objectId,
    interaction_id: ixId,
    segment_ids: [100, 101, 199],
    sensations,
    startle: computedAssess.startle,
    appraisal: computedAssess.appraisal,
    reaction: computedAssess.reaction,
    pref_deltas: prefDeltas,
    wariness_deltas: warinessDeltas,
    familiarity_delta: famDelta,
    world_version: 2,
  };

  const afterObject =
    effectKind === 'move' ? { ...targetObject, y: targetObject.y - 1 } : { ...targetObject };
  const ixForPlan: Interaction = { id: ixId, object_id: objectId, spec: schemaCleanSpec };

  const evidence: BlindEvidence = {
    object_id: objectId,
    card: {
      id: `card:${objectId}`,
      object_id: objectId,
      source: 'spark_vision',
      card,
    },
    interactions: [
      {
        id: ixId,
        object_id: objectId,
        card_id: `card:${objectId}`,
        source: 'compiled',
        spec: primitive === 'touch' ? schemaCleanSpec : { ...schemaCleanSpec, steps: [schemaCleanSpec.steps[0], { p: 'hold_pose', pose: 'sit', ms: 1000 }] },
        status: 'accepted',
        checks: [{ check: 'schema', ok: true, reason: null }],
        gaps: [],
      },
    ],
    segments: [seg1, seg2, seg3],
    state_changes:
      effectKind === 'move'
        ? [
            {
              id: 1,
              object_id: objectId,
              valid_from: seg2.end_at,
              x: afterObject.x,
              y: afterObject.y,
              z: 0,
              footprint: [[0, 0]],
              rotation: 0,
              status: 'placed',
              state: 'default',
              sprite: afterObject.sprite,
              cause: String(seg2.id),
            },
          ]
        : [],
    sound_events:
      effectKind === 'sound'
        ? [
            {
              id: `sound_played:${seg2.id}:0`,
              at: seg2.start_at + 200,
              type: 'sound_played',
              actor: 'nori',
              payload: { pattern: 'single', target: objectId },
            },
          ]
        : [],
    experiences: [exp],
    objects_at_start: [targetObject],
    world_snapshot: {
      objects: [afterObject],
      interactions: [ixForPlan],
      position: [2, 5],
      state_before: preExp,
      state_after: postExp,
    },
  };

  void spec;
  return { evidence, reg };
}
describe('blind object registration and source scan', () => {
  it('produces stable canonical JSON and sha256 regardless of whitespace, casing or ordering', async () => {
    const a = await registration(
      '  Toy Piano  ',
      ['Piano', ' MINI piano ', 'musical keyboard', 'piano'],
      ['Sound ', ' MOTION ', 'sound'],
    );
    const b = await registration(
      'toy piano',
      ['musical keyboard', 'piano', 'mini piano'],
      ['motion', 'sound'],
    );
    expect(a.json).toBe(
      '{"label":"toy piano","synonyms":["mini piano","musical keyboard","piano"],"expected_sensations":["motion","sound"]}',
    );
    expect(a.sha256).toBe('0eb126f640bfad5f25a180c5515918793035d04c2fb99b401f5aa4474608802e');
    expect(b.json).toBe(a.json);
    expect(b.sha256).toBe(a.sha256);
  });

  it('register writes canonical JSON outside the repo, prints only sha256, and refuses paths inside the repo', async () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'nori-blind-reg-'));
    const outFile = path.join(outsideDir, 'reg.json');
    const result = await runRegister({
      label: 'Toy Piano',
      synonyms: ['piano', 'mini piano', 'musical keyboard'],
      sensations: ['sound', 'motion'],
      outPath: outFile,
    });
    expect(result.sha256).toBe('0eb126f640bfad5f25a180c5515918793035d04c2fb99b401f5aa4474608802e');
    expect(readFileSync(outFile, 'utf8').trim()).toBe(
      '{"label":"toy piano","synonyms":["mini piano","musical keyboard","piano"],"expected_sensations":["motion","sound"]}',
    );

    await expect(
      runRegister({
        label: 'Toy Piano',
        synonyms: ['piano'],
        sensations: ['sound'],
        outPath: path.join(REPO_ROOT, 'site', 'forbidden-reg.json'),
      }),
    ).rejects.toThrow(/inside the repository/i);

    const cliOut = path.join(outsideDir, 'cli-reg.json');
    const cliRun = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        'register',
        '--label',
        'Toy Piano',
        '--synonyms',
        'piano,mini piano,musical keyboard',
        '--sensations',
        'sound,motion',
        '--out',
        cliOut,
      ],
      { encoding: 'utf8' },
    );
    expect(cliRun.status).toBe(0);
    expect(cliRun.stdout.trim()).toBe('0eb126f640bfad5f25a180c5515918793035d04c2fb99b401f5aa4474608802e');

    const cliForbidden = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        'register',
        '--label',
        'Toy Piano',
        '--synonyms',
        'piano',
        '--sensations',
        'sound',
        '--out',
        path.join(REPO_ROOT, 'docs', 'forbidden-reg.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(cliForbidden.status).not.toBe(0);
  });

  it('scan counts whole-word case-insensitive matches, redacts terms, and returns exit codes 0 vs 1', () => {
    const pianoReg = loadRegistrationFile(path.join(FIXTURE_DIR, 'toy-piano.registration.json'));
    const pianoScan = runScan({ registration: pianoReg });
    expect(pianoScan.files.some(f => f.file === 'site/src/worker/cam/blind.ts')).toBe(true);
    expect(pianoScan.files.some(f => f.file === 'site/public/cam/catalog.json')).toBe(true);
    expect(pianoScan.totalMatches).toBe(0);
    expect(pianoScan.exitCode).toBe(0);
    expect(pianoScan.formatted).not.toMatch(/piano/i);

    const posterReg = loadRegistrationFile(path.join(FIXTURE_DIR, 'wall-poster.registration.json'));
    const posterScan = runScan({ registration: posterReg });
    expect(posterScan.totalMatches).toBe(0);
    expect(posterScan.exitCode).toBe(0);
    expect(posterScan.formatted).not.toMatch(/poster/i);

    const boxReg = loadRegistrationFile(path.join(FIXTURE_DIR, 'cardboard-box.registration.json'));
    const boxScan = runScan({ registration: boxReg });
    expect(boxScan.totalMatches).toBeGreaterThan(0);
    expect(boxScan.exitCode).toBe(1);
    expect(boxScan.formatted).toContain('term #1=');
    expect(boxScan.formatted).toContain('term #2=');
    expect(boxScan.formatted).not.toMatch(/\bcardboard\b|\bcarton\b/i);

    // Controlled synthetic repo root verifying whole-word boundaries (doorbell/belle must not match bell).
    const fakeRepo = mkdtempSync(path.join(os.tmpdir(), 'nori-blind-scan-'));
    mkdirSync(path.join(fakeRepo, 'site', 'src'), { recursive: true });
    mkdirSync(path.join(fakeRepo, 'site', 'public', 'cam'), { recursive: true });
    mkdirSync(path.join(fakeRepo, 'app', 'cam'), { recursive: true });
    writeFileSync(path.join(fakeRepo, 'site', 'src', 'a.ts'), 'const doorbell = "belle"; const x = "BELL"; const y = bell_jar;', 'utf8');
    writeFileSync(path.join(fakeRepo, 'site', 'public', 'cam', 'catalog.json'), '{"entries":[]}', 'utf8');
    writeFileSync(path.join(fakeRepo, 'app', 'cam', 'b.py'), '# brass-bell here\n', 'utf8');

    const synthScan = runScan({
      registration: { label: 'brass bell', synonyms: ['bell', 'chime'], expected_sensations: ['sound'] },
      repoRoot: fakeRepo,
    });
    expect(synthScan.exitCode).toBe(1);
    expect(synthScan.totalsByTerm).toEqual([1, 3, 0]);
    expect(synthScan.formatted).not.toMatch(/brass|bell|chime/i);
  });
});

describe('blind object judge rules per stage (1..6)', () => {
  it('Stage 1 (understanding): passes valid matching card and fails invalid card, non-whole-word term, or sensation mismatch', () => {
    const { evidence, reg } = makeMinimalPassingEvidence();
    expect(judge(evidence, reg).stages[0].verdict).toBe('pass');

    // Missing card
    expect(judge({ ...evidence, card: null }, reg).stages[0].verdict).toBe('fail');

    // validateCard error: non-prefab card illegally declaring prop_poses
    const badCard = { ...makeSyntheticCard(), prop_poses: ['box'] };
    expect(
      judge({ ...evidence, card: { ...evidence.card!, card: badCard } }, reg).stages[0].verdict,
    ).toBe('fail');

    // Substring-only match ("bell" inside "doorbell", affordance verb "press") must fail whole-word rule
    const substringCard = makeSyntheticCard({
      name: 'doorbell',
      sensations: reg.expected_sensations.includes('shelter') ? { shelter: 0.8 } : { sound: 0.8 },
      affordances: [{ verb: 'press button', effect_text: 'rings', sensations: ['sound'] }],
    });
    expect(
      judge({ ...evidence, card: { ...evidence.card!, card: substringCard } }, reg).stages[0].verdict,
    ).toBe('fail');

    // Affordance verb whole-word match passes even if card.name uses an unregistered word
    const affordanceMatchCard = makeSyntheticCard({
      name: 'desk ringer',
      sensations: { shelter: 0.8 },
      affordances: [{ verb: 'tap chime gently', effect_text: 'rings', sensations: ['shelter'] }],
    });
    expect(
      judge({ ...evidence, card: { ...evidence.card!, card: affordanceMatchCard } }, reg).stages[0].verdict,
    ).toBe('pass');

    // Disjoint sensations fail
    const wrongSensationCard = makeSyntheticCard({ sensations: { warm: 0.7 } });
    expect(
      judge({ ...evidence, card: { ...evidence.card!, card: wrongSensationCard } }, reg).stages[0].verdict,
    ).toBe('fail');
  });

  it('Stage 2 (spec_generation): passes valid EXECUTOR/card-part spec and fails schema errors, unknown primitives or missing card parts', () => {
    const { evidence, reg } = makeMinimalPassingEvidence();
    expect(judge(evidence, reg).stages[1].verdict).toBe('pass');

    // Schema injection error
    const injected = structuredClone(evidence);
    (injected.interactions[0].spec as Record<string, unknown>).injected = true;
    expect(judge(injected, reg).stages[1].verdict).toBe('fail');

    // Non-EXECUTOR primitive
    const badPrim = structuredClone(evidence);
    (badPrim.interactions[0].spec as { steps: unknown[] }).steps = [{ p: 'teleport', part: 'front' }];
    expect(judge(badPrim, reg).stages[1].verdict).toBe('fail');

    // Valid schema part ('viewport') that does not exist on card.parts
    const badPart = structuredClone(evidence);
    (badPart.interactions[0].spec as { steps: unknown[] }).steps = [
      { p: 'move_to', part: 'viewport' },
      { p: 'wait', ms: 1000 },
    ];
    expect(judge(badPart, reg).stages[1].verdict).toBe('fail');
  });

  it('Stage 3 (checker): maps accepted -> pass, degraded -> degraded_pass with gaps, and all rejected -> fail', () => {
    const { evidence, reg } = makeMinimalPassingEvidence();
    expect(judge(evidence, reg).stages[2].verdict).toBe('pass');

    const degraded = structuredClone(evidence);
    degraded.interactions[0].status = 'degraded';
    degraded.interactions[0].gaps = [{ primitive: 'look_through', reason: 'look_through unavailable; face + look-up' }];
    const s3Degraded = judge(degraded, reg).stages[2];
    expect(s3Degraded.verdict).toBe('degraded_pass');
    expect(s3Degraded.gaps).toEqual([
      {
        interaction_id: degraded.interactions[0].id,
        primitive: 'look_through',
        reason: 'look_through unavailable; face + look-up',
      },
    ]);
    expect(s3Degraded.reasons.join(' ')).toContain('look_through unavailable');

    const rejected = structuredClone(evidence);
    rejected.interactions[0].status = 'rejected';
    rejected.interactions[0].checks = [{ check: '1.push', ok: false, reason: 'illegal push' }];
    expect(judge(rejected, reg).stages[2].verdict).toBe('fail');
  });

  it('Stage 4 (animation_execution): passes non-contact execution, returns manager_check with midpoints for touch/push, and fails cut/cell/pose violations', () => {
    const nonContact = makeMinimalPassingEvidence({ primitive: 'hold_pose', effectKind: 'move' });
    const s4Pass = judge(nonContact.evidence, nonContact.reg).stages[3];
    expect(s4Pass.verdict).toBe('pass');
    expect(s4Pass.midpoints_ms).toBeUndefined();

    const withTouch = makeMinimalPassingEvidence({ primitive: 'touch', effectKind: 'sound' });
    const s4Check = judge(withTouch.evidence, withTouch.reg).stages[3];
    expect(s4Check.verdict).toBe('manager_check');
    const touchSeg = withTouch.evidence.segments[1];
    expect(s4Check.midpoints_ms).toEqual([Math.floor((touchSeg.start_at + touchSeg.end_at) / 2)]);

    // Cut segment fails
    const cutEv = structuredClone(nonContact.evidence);
    for (const s of cutEv.segments) s.cut_at = s.end_at - 100;
    expect(judge(cutEv, nonContact.reg).stages[3].verdict).toBe('fail');

    // Planned cell mismatch fails
    const wrongCell = structuredClone(nonContact.evidence);
    wrongCell.segments[0].path = [
      [2, 6],
      [4, 6],
    ];
    wrongCell.segments[1].path = [[4, 6]];
    wrongCell.segments[2].path = [[4, 6]];
    expect(judge(wrongCell, nonContact.reg).stages[3].verdict).toBe('fail');

    // Disallowed pose for primitive ('sleepy' on move_to) fails
    const wrongPose = structuredClone(nonContact.evidence);
    wrongPose.segments[0].pose = 'sleepy';
    expect(judge(wrongPose, nonContact.reg).stages[3].verdict).toBe('fail');
  });

  it('Stage 5 (world_change): verifies sound_played and persistent object_states + applyEffects diff, and fails missing/out-of-window/no-op effects', () => {
    const moveCase = makeMinimalPassingEvidence({ primitive: 'hold_pose', effectKind: 'move' });
    expect(judge(moveCase.evidence, moveCase.reg).stages[4].verdict).toBe('pass');

    const soundCase = makeMinimalPassingEvidence({ primitive: 'touch', effectKind: 'sound' });
    expect(judge(soundCase.evidence, soundCase.reg).stages[4].verdict).toBe('pass');

    // Sound event outside segment time window fails
    const lateSound = structuredClone(soundCase.evidence);
    lateSound.sound_events[0].at = lateSound.segments[1].end_at + 1;
    expect(judge(lateSound, soundCase.reg).stages[4].verdict).toBe('fail');

    // Missing object_states row for move_object fails
    const missingRow = structuredClone(moveCase.evidence);
    missingRow.state_changes = [];
    expect(judge(missingRow, moveCase.reg).stages[4].verdict).toBe('fail');

    // Zero-delta persistent effect (set_state back to identical default state) fails applyEffects diff check
    const noDiff = structuredClone(moveCase.evidence);
    noDiff.segments[1].effects = [{ e: 'set_state', state: 'default' }];
    expect(judge(noDiff, moveCase.reg).stages[4].verdict).toBe('fail');

    // Zero executed effects fails
    const noEffects = structuredClone(moveCase.evidence);
    noEffects.segments[1].effects = [];
    noEffects.state_changes = [];
    expect(judge(noEffects, moveCase.reg).stages[4].verdict).toBe('fail');
  });

  it('Stage 6 (experience): passes both positive and negative appraisal counterfactuals and fails missing row, assess tampering, formula mismatch or wrong counterfactual direction', () => {
    const pos = makeMinimalPassingEvidence({ appraisalBias: 'positive' });
    const posS6 = judge(pos.evidence, pos.reg).stages[5];
    expect(posS6.verdict).toBe('pass');
    expect(posS6.counterfactual!.appraisal).toBeGreaterThan(0);
    expect(posS6.counterfactual!.self_after).toBeGreaterThan(posS6.counterfactual!.self_before);

    const neg = makeMinimalPassingEvidence({ appraisalBias: 'negative', primitive: 'touch', effectKind: 'sound' });
    const negS6 = judge(neg.evidence, neg.reg).stages[5];
    expect(negS6.verdict).toBe('pass');
    expect(negS6.counterfactual!.appraisal).toBeLessThan(0);
    expect(negS6.counterfactual!.self_after).toBeLessThan(negS6.counterfactual!.self_before);

    // Missing experience row fails
    const noExp = structuredClone(pos.evidence);
    noExp.experiences = [];
    expect(judge(noExp, pos.reg).stages[5].verdict).toBe('fail');

    // Tampered stored appraisal fails recomputation check
    const badAssess = structuredClone(pos.evidence);
    badAssess.experiences[0].appraisal = clamp(badAssess.experiences[0].appraisal + 0.1, -1, 1);
    expect(judge(badAssess, pos.reg).stages[5].verdict).toBe('fail');

    // Tampered stored pref_deltas fails formula check
    const badDelta = structuredClone(pos.evidence);
    badDelta.experiences[0].pref_deltas = { shelter: 0.05 };
    expect(judge(badDelta, pos.reg).stages[5].verdict).toBe('fail');

    // Unstored habit in state_after fails storage check
    const unstoredHabit = structuredClone(pos.evidence);
    delete unstoredHabit.world_snapshot!.state_after.habits[pos.evidence.interactions[0].id];
    expect(judge(unstoredHabit, pos.reg).stages[5].verdict).toBe('fail');

    // Counterfactual shift opposite to positive appraisal (novelty drop 1 -> 0.5 with no peer object) fails
    const novelDrop = makeMinimalPassingEvidence({ appraisalBias: 'positive' });
    novelDrop.evidence.segments[2].completion!.input.novelty[novelDrop.evidence.object_id] = 1;
    // Rebuild consistent experience from novelty=1 input
    const cSeg = novelDrop.evidence.segments[2];
    const cInput = cSeg.completion!.input;
    const newA = assess(
      cInput,
      novelDrop.evidence.object_id,
      cSeg.completion!.sensations,
      novelDrop.evidence.interactions[0].id,
      cSeg.id,
    );
    let pre = structuredClone(cInput);
    for (const s of novelDrop.evidence.segments) {
      pre = continuous(pre, s.start_at, s.end_at, s.action);
      pre.nori.z = s.z;
    }
    const post = structuredClone(pre);
    const pd: Sensations = {};
    const wd: Sensations = {};
    for (const [k, w] of Object.entries(cSeg.completion!.sensations)) {
      const key = k as Sensation;
      pd[key] = preference(post, key, RULES.prefRate * (w || 0) * Math.tanh(2 * newA.appraisal), cSeg.end_at);
      const ow = post.wariness[key];
      post.wariness[key] = clamp(ow + 0.15 * newA.startle);
      wd[key] = post.wariness[key] - ow;
    }
    const ofam = post.familiarity[novelDrop.evidence.object_id] || 0;
    post.familiarity[novelDrop.evidence.object_id] = clamp(ofam + 0.1);
    post.novelty[novelDrop.evidence.object_id] = 0.5;
    post.habits[novelDrop.evidence.interactions[0].id] = {
      n: 1,
      good: newA.appraisal > 0 ? 1 : 0,
      last_at: cSeg.end_at,
    };
    novelDrop.evidence.experiences[0] = {
      ...novelDrop.evidence.experiences[0],
      ...newA,
      pref_deltas: pd,
      wariness_deltas: wd,
      familiarity_delta: post.familiarity[novelDrop.evidence.object_id] - ofam,
    };
    novelDrop.evidence.world_snapshot!.state_before = pre;
    novelDrop.evidence.world_snapshot!.state_after = post;
    const dropS6 = judge(novelDrop.evidence, novelDrop.reg).stages[5];
    expect(dropS6.verdict).toBe('fail');
    expect(dropS6.reasons.join(' ')).toContain('counterfactual probability shift mismatch');
  });
});

describe('blind object fixtures end to end and replay determinism', () => {
  it('positive control (cardboard-box): passes stages 1,2,3,5,6 and requests manager_check screenshot on stage 4 push', async () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'cardboard-box.raw.json'), 'utf8'));
    const reg = loadRegistrationFile(path.join(FIXTURE_DIR, 'cardboard-box.registration.json'));
    const replay = await runReplay({
      raw,
      photoSha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990001',
      registration: reg,
    });
    expect(replay.ingest_status).toBe(200);
    expect(replay.report.stages.map(s => s.verdict)).toEqual([
      'pass',
      'pass',
      'pass',
      'manager_check',
      'pass',
      'pass',
    ]);
    expect(replay.report.stages[3].midpoints_ms?.length).toBe(1);
    expect(replay.report.stages[4].evidence_ids[0]).toMatch(/^object_states:/);
    expect(replay.report.stages[5].counterfactual?.same_sensation_after).toBeGreaterThan(
      replay.report.stages[5].counterfactual?.same_sensation_before ?? 0,
    );

    // Also verify the catalog prefab cardboard_box card and specs through stages 1..3 of the same judge
    const entries = catalog.entries as unknown as CatalogEntry[];
    const prefabBox = entries.find(e => e.object.id === 'o_cardboard_box')!;
    const prefabReport = judge(
      {
        object_id: prefabBox.object.id,
        card: {
          id: 'card:o_cardboard_box',
          object_id: prefabBox.object.id,
          source: 'prefab',
          card: prefabBox.object.card,
        },
        interactions: prefabBox.interactions.map(ix => ({
          id: ix.id,
          object_id: ix.object_id,
          card_id: 'card:o_cardboard_box',
          source: 'prefab',
          spec: ix.spec,
          status: 'accepted',
          checks: [],
          gaps: [],
        })),
        segments: [],
        state_changes: [],
        sound_events: [],
        experiences: [],
      },
      reg,
    );
    expect(prefabReport.stages.slice(0, 3).map(s => s.verdict)).toEqual(['pass', 'pass', 'pass']);
  });

  it('negative control (wall-poster): checker rejects push and emit_sound; replay records zero sound events and zero displacement', async () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'wall-poster.raw.json'), 'utf8'));
    const reg = loadRegistrationFile(path.join(FIXTURE_DIR, 'wall-poster.registration.json'));
    const replay = await runReplay({
      raw,
      photoSha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990002',
      registration: reg,
    });
    expect(replay.ingest_status).toBe(200);
    expect(replay.report.stages.map(s => s.verdict)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'fail',
      'pass',
    ]);
    const s3Notes = replay.report.stages[2].reasons.join(' ');
    expect(s3Notes).toContain('1.push');
    expect(s3Notes).toContain('1.sound');
    const s5Notes = replay.report.stages[4].reasons.join(' ');
    expect(s5Notes).toContain('0 sound_played events');
    expect(s5Notes).toContain('0 post-unwrap object_states rows');
    expect(replay.report.stages[4].evidence_ids).toEqual([]);
  });

  it('showcase (toy-piano): passes stages 1,2,3,5, flags stage 4 touch midpoint, and honestly surfaces stage 6 counterfactual finding', async () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'toy-piano.raw.json'), 'utf8'));
    const reg = loadRegistrationFile(path.join(FIXTURE_DIR, 'toy-piano.registration.json'));
    const replay = await runReplay({
      raw,
      photoSha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990003',
      registration: reg,
    });
    expect(replay.ingest_status).toBe(200);
    expect(replay.report.stages.map(s => s.verdict)).toEqual([
      'pass',
      'pass',
      'pass',
      'manager_check',
      'pass',
      'fail',
    ]);
    expect(replay.report.stages[3].midpoints_ms).toEqual([1793620808600]);
    expect(replay.report.stages[4].evidence_ids).toEqual(['sound_played:6000000003:0']);
    const cf = replay.report.stages[5].counterfactual!;
    expect(cf.main_sensation).toBe('sound');
    expect(cf.appraisal).toBeGreaterThan(0);
    expect(cf.self_after).toBeLessThan(cf.self_before);
    expect(cf.same_sensation_before).toBe(0);
    expect(cf.same_sensation_after).toBe(0);
  });

  it('replay is byte-identical across repeated runs on the same input', async () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'cardboard-box.raw.json'), 'utf8'));
    const reg = loadRegistrationFile(path.join(FIXTURE_DIR, 'cardboard-box.registration.json'));
    const first = await runReplay({
      raw,
      photoSha: 'bbbb1111cccc2222dddd3333eeee4444ffff555566667777888899990000abcd',
      registration: reg,
    });
    const second = await runReplay({
      raw,
      photoSha: 'bbbb1111cccc2222dddd3333eeee4444ffff555566667777888899990000abcd',
      registration: reg,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.markdown).toBe(first.markdown);
  });
});

describe('M2 counterfactual (fixed novelty, no memory) and fixture snapshots', () => {
  it("S1' differs from S1 only in the pre-registered memory fields and keeps novelty equal to S1", () => {
    const s0 = initialState(Date.UTC(2026, 10, 2, 12));
    s0.familiarity = { o_cardboard_box: 0.2, o_toy: 0 };
    s0.novelty = { o_cardboard_box: 0.5, o_toy: 1 };
    s0.habits = { 'ix:existing': { n: 2, good: 1, last_at: 1000 } };
    s0.prefs.sound = 0.5;
    s0.prefs.shelter = 0.52;
    s0.pref_day = '2026-11-02';
    s0.pref_deltas = { shelter: 0.02 };
    s0.wariness.sound = 0.01;

    const s1 = structuredClone(s0);
    // Memory fields changed by experience in S1:
    s1.familiarity.o_toy = 0.1;
    s1.habits['compiled:toy:0'] = { n: 1, good: 1, last_at: 2000 };
    s1.prefs.sound = 0.50025;
    s1.pref_day = '2026-11-02';
    s1.pref_deltas = { shelter: 0.02, sound: 0.00025 };
    s1.wariness.sound = 0.0235;
    // Non-memory fields in S1 (must stay as in S1):
    s1.novelty.o_toy = 0.5;
    s1.nori.energy = 0.61;
    s1.nori.curiosity = 0.74;
    s1.nori.security = 0.68;
    s1.nori.z = 1;
    s1.missing = [{ object_id: 'o_missing', kind: 'toy', x: 1, y: 2, familiarity: 0.3, since: 1500 }];
    s1.settled_through = 2000;
    s1.exploration = { sensation: 'sound', expires_at: 9000 };
    s1.settled_ids = [100, 101, 199];
    s1.interrupted_ids = [50];

    const s1Prime = buildCounterfactualNoMemoryState(s0, s1);

    const preregMemoryFields = new Set([
      'familiarity',
      'habits',
      'prefs',
      'pref_deltas',
      'pref_day',
      'wariness',
    ]);
    const allKeys = new Set([...Object.keys(s0), ...Object.keys(s1), ...Object.keys(s1Prime)]);
    const differingFromS1: string[] = [];

    for (const key of allKeys) {
      const k = key as keyof typeof s1;
      if (JSON.stringify(s1Prime[k]) !== JSON.stringify(s1[k])) {
        differingFromS1.push(key);
      }
      if (preregMemoryFields.has(key)) {
        expect(s1Prime[k]).toEqual(s0[k]);
      } else {
        expect(s1Prime[k]).toEqual(s1[k]);
      }
    }

    expect(differingFromS1.every(k => preregMemoryFields.has(k))).toBe(true);
    expect(differingFromS1.sort()).toEqual(
      ['familiarity', 'habits', 'pref_deltas', 'prefs', 'wariness'].sort(),
    );
    expect(s1Prime.novelty).toEqual(s1.novelty);
    expect(s1Prime.novelty.o_toy).toBe(s1.novelty.o_toy);
    expect(s1Prime.novelty.o_toy).not.toBe(s0.novelty.o_toy);

    // Also verify when S0 has undefined pref_deltas / pref_day and S1 defines them:
    const s0NoPrefMeta = initialState(Date.UTC(2026, 10, 2, 12));
    s0NoPrefMeta.novelty.o_toy = 1;
    const s1WithPrefMeta = structuredClone(s0NoPrefMeta);
    s1WithPrefMeta.novelty.o_toy = 0.5;
    s1WithPrefMeta.familiarity.o_toy = 0.1;
    s1WithPrefMeta.pref_day = '2026-11-02';
    s1WithPrefMeta.pref_deltas = { sound: 0.0002 };
    const s1PrimeClean = buildCounterfactualNoMemoryState(s0NoPrefMeta, s1WithPrefMeta);
    expect(s1PrimeClean.pref_day).toBeUndefined();
    expect(s1PrimeClean.pref_deltas).toBeUndefined();
    expect(s1PrimeClean.novelty).toEqual(s1WithPrefMeta.novelty);
  });

  it('M2 numbers on the three fixtures are deterministic and match 1e-9 snapshots', async () => {
    const assertM2Snapshot = (
      actual: M2Summary,
      expected: {
        eval_at: number;
        appraisal: number;
        main_sensation: Sensation | null;
        p_s0: number;
        p_s1: number;
        p_s1_prime: number;
        dT: number;
        dN: number;
        dM: number;
        dM_over_p_s1_prime: number | null;
        same_sensation: {
          main_sensation: Sensation | null;
          p_s0: number;
          p_s1: number;
          p_s1_prime: number;
          dT: number;
          dN: number;
          dM: number;
          dM_over_p_s1_prime: number | null;
        };
        replay_24h: M2Summary['replay_24h'];
      },
    ) => {
      expect(actual.eval_at).toBe(expected.eval_at);
      expect(actual.main_sensation).toBe(expected.main_sensation);
      expect(actual.appraisal).toBeCloseTo(expected.appraisal, 9);
      expect(actual.p_s0).toBeCloseTo(expected.p_s0, 9);
      expect(actual.p_s1).toBeCloseTo(expected.p_s1, 9);
      expect(actual.p_s1_prime).toBeCloseTo(expected.p_s1_prime, 9);
      expect(actual.dT).toBeCloseTo(expected.dT, 9);
      expect(actual.dN).toBeCloseTo(expected.dN, 9);
      expect(actual.dM).toBeCloseTo(expected.dM, 9);
      if (expected.dM_over_p_s1_prime === null) {
        expect(actual.dM_over_p_s1_prime).toBeNull();
      } else {
        expect(actual.dM_over_p_s1_prime).toBeCloseTo(expected.dM_over_p_s1_prime, 9);
      }

      expect(actual.same_sensation.main_sensation).toBe(expected.same_sensation.main_sensation);
      expect(actual.same_sensation.p_s0).toBeCloseTo(expected.same_sensation.p_s0, 9);
      expect(actual.same_sensation.p_s1).toBeCloseTo(expected.same_sensation.p_s1, 9);
      expect(actual.same_sensation.p_s1_prime).toBeCloseTo(expected.same_sensation.p_s1_prime, 9);
      expect(actual.same_sensation.dT).toBeCloseTo(expected.same_sensation.dT, 9);
      expect(actual.same_sensation.dN).toBeCloseTo(expected.same_sensation.dN, 9);
      expect(actual.same_sensation.dM).toBeCloseTo(expected.same_sensation.dM, 9);
      if (expected.same_sensation.dM_over_p_s1_prime === null) {
        expect(actual.same_sensation.dM_over_p_s1_prime).toBeNull();
      } else {
        expect(actual.same_sensation.dM_over_p_s1_prime).toBeCloseTo(
          expected.same_sensation.dM_over_p_s1_prime,
          9,
        );
      }

      expect(actual.replay_24h).toEqual(expected.replay_24h);
    };

    const cases = [
      {
        name: 'cardboard-box',
        photoSha: 'aaaa111122223333444455556666777788889999000011112222333399990001',
        expected: {
          eval_at: 1793621711500,
          appraisal: 0.2773423236272736,
          main_sensation: 'shelter' as Sensation,
          p_s0: 0.07834964636947034,
          p_s1: 0.05062410663501476,
          p_s1_prime: 0.021917303083229145,
          dT: -0.02772553973445558,
          dN: -0.05643234328624119,
          dM: 0.028706803551785613,
          dM_over_p_s1_prime: 1.309778098280336,
          same_sensation: {
            main_sensation: 'shelter' as Sensation,
            p_s0: 0.03912169321056387,
            p_s1: 0.040308945452365096,
            p_s1_prime: 0.04151710141770115,
            dT: 0.0011872522418012246,
            dN: 0.002395408207137281,
            dM: -0.0012081559653360566,
            dM_over_p_s1_prime: -0.02910020025677779,
          },
          replay_24h: {
            s1: {
              object_contacts: 5,
              peer_contacts: 8,
              first_return_at: 1793621778501,
              first_return_offset_ms: 67001,
            },
            s1_prime: {
              object_contacts: 1,
              peer_contacts: 5,
              first_return_at: 1793621778501,
              first_return_offset_ms: 67001,
            }
          },
        },
      },
      {
        name: 'wall-poster',
        photoSha: 'aaaa111122223333444455556666777788889999000011112222333399990002',
        expected: {
          eval_at: 1793621712000,
          appraisal: 0.7192081852600964,
          main_sensation: 'light' as Sensation,
          p_s0: 0.08910004802057443,
          p_s1: 0.057803383328095655,
          p_s1_prime: 0.025135763869906055,
          dT: -0.03129666469247878,
          dN: -0.06396428415066838,
          dM: 0.0326676194581896,
          dM_over_p_s1_prime: 1.299646974218321,
          same_sensation: {
            main_sensation: 'light' as Sensation,
            p_s0: 0.05815391524318076,
            p_s1: 0.06015566605532996,
            p_s1_prime: 0.062237539960698265,
            dT: 0.0020017508121491986,
            dN: 0.004083624717517505,
            dM: -0.002081873905368306,
            dM_over_p_s1_prime: -0.03345045300124277,
          },
          replay_24h: {
            s1: {
              object_contacts: 1,
              peer_contacts: 1,
              first_return_at: 1793623973044,
              first_return_offset_ms: 2261044,
            },
            s1_prime: {
              object_contacts: 2,
              peer_contacts: 2,
              first_return_at: 1793623973044,
              first_return_offset_ms: 2261044,
            }
          },
        },
      },
      {
        name: 'toy-piano',
        photoSha: 'aaaa111122223333444455556666777788889999000011112222333399990003',
        expected: {
          eval_at: 1793621711700,
          appraisal: 0.06006528535480343,
          main_sensation: 'sound' as Sensation,
          p_s0: 0.08640635197600227,
          p_s1: 0.05417132877570221,
          p_s1_prime: 0.024324214034722888,
          dT: -0.03223502320030006,
          dN: -0.06208213794127938,
          dM: 0.02984711474097932,
          dM_over_p_s1_prime: 1.2270536140807047,
          same_sensation: {
            main_sensation: 'sound' as Sensation,
            p_s0: 0,
            p_s1: 0,
            p_s1_prime: 0,
            dT: 0,
            dN: 0,
            dM: 0,
            dM_over_p_s1_prime: null,
          },
          replay_24h: {
            s1: {
              object_contacts: 2,
              peer_contacts: 0,
              first_return_at: 1793624028242,
              first_return_offset_ms: 2316542,
            },
            s1_prime: {
              object_contacts: 0,
              peer_contacts: 0,
              first_return_at: null,
              first_return_offset_ms: null,
            }
          },
        },
      },
    ];

    for (const c of cases) {
      const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${c.name}.raw.json`), 'utf8'));
      const reg = loadRegistrationFile(path.join(FIXTURE_DIR, `${c.name}.registration.json`));
      const run1 = await runReplay({ raw, photoSha: c.photoSha, registration: reg });
      const run2 = await runReplay({ raw, photoSha: c.photoSha, registration: reg });
      expect(run1.report.m2).toBeDefined();
      expect(JSON.stringify(run2.report.m2)).toBe(JSON.stringify(run1.report.m2));
      expect(run2.report.m2!.verdict).toBe(run1.report.m2!.verdict);
      assertM2Snapshot(run1.report.m2!, c.expected);
    }
  });
});

describe('plan.ts refactor determinism hashes', () => {
  it('choiceProbabilities matches temperature softmax without random noise', () => {
    expect(choiceProbabilities([])).toEqual([]);
    const probs = choiceProbabilities([1.0, 1.3, 1.6]);
    const shifted = choiceProbabilities([11.0, 11.3, 11.6]);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    probs.forEach((p, idx) => expect(p).toBeCloseTo(shifted[idx], 12));
    expect(probs[2] / probs[1]).toBeCloseTo(Math.exp(0.3 / RULES.temperature), 12);
  });

  it('preserves exact pre-refactor hashes for simulate(72, 1), simulate(72, 7) and planNext fixtures', () => {
    const sim1 = simulate(72, 1);
    const sim7 = simulate(72, 7);
    expect(sim1.determinism_hash).toBe('5f5c6e1c3e009c08446ed3922547805411a76609c67b5b1ce10f6bfaa06bda34');
    expect(sha256Json(sim1)).toBe('94a52b6bd064d503ba2ffc2e2166e4c6076a51b3db474bb1161676c2ecdd5223');
    expect(sim7.determinism_hash).toBe('ec3fc8fc65ba2394742475f6551a7521977f93e06c92d8bfcef1bd661f20fbde');
    expect(sha256Json(sim7)).toBe('01696982fc0e1312d690ef31297a88b1d768e44dc834829c96597b1b635745fc');

    const entries = catalog.entries as unknown as CatalogEntry[];
    const mkInput = () => ({
      state: initialState(),
      objects: entries.map(e => e.object),
      interactions: entries.flatMap(e => e.interactions),
      position: [2, 6] as [number, number],
      start_at: 0,
      world_version: 1,
    });
    const planFixtures: Segment[][] = [];
    for (const start of [0, 12 * 3600000, 18 * 3600000]) {
      for (const world_version of [1, 2, 7]) {
        const i = mkInput();
        i.start_at = start;
        i.state.settled_through = start;
        i.world_version = world_version;
        expect(candidateScores(i, start).length).toBeGreaterThan(0);
        planFixtures.push(planNext(i));
      }
    }
    planFixtures.push(planNext({ ...mkInput(), reaction: { event_id: 'e1', pose: 'startled' } }));
    const carryIx = entries[1].interactions.find(i => i.action === 'carry')!;
    planFixtures.push(planNext({ ...mkInput(), interactions: [carryIx] }));
    planFixtures.push(planNext({ ...mkInput(), interactions: [entries[0].interactions[1]] }));

    expect(sha256Json(planFixtures)).toBe('1aa2686914b7a052571916518c521790b67e41bb23048b0b4908b4db0f3d9480');
  });
});
