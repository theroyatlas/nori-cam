import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SENSATIONS } from '../public/cam-shared.js';
import {
  countWholeWord,
  judge,
  registration,
  type BlindEvidence,
  type BlindJudgeReport,
  type BlindRegistration,
  type StoredInteractionEvidence,
  type StoredObjectStateRow,
} from '../src/worker/cam/blind.ts';
import type { CamEvent, Cell, Experience } from '../src/worker/cam/types.ts';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BINARY_EXT = /\.(png|jpg|jpeg|webp|gif|ico|woff2?|ttf|eot|otf|wav|mp3|ogg|mp4|webm|pyc|sqlite|db)$/i;
const CATEGORIES = new Set([
  'furniture',
  'household',
  'toy',
  'instrument',
  'small_equipment',
  'plant',
  'food',
  'stationery',
  'clothing_accessory',
]);
const NAME_RE = /^[A-Za-z]+(?:[ -][A-Za-z]+){0,3}$/;
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let jsonHookInstalled = false;
function ensureJsonImportHook(): void {
  if (jsonHookInstalled) return;
  jsonHookInstalled = true;
  const mod = nodeModule as unknown as {
    registerHooks?: (hooks: {
      load?: (
        url: string,
        context: { importAttributes?: Record<string, string> },
        nextLoad: (url: string, context: unknown) => unknown,
      ) => unknown;
    }) => void;
  };
  if (typeof mod.registerHooks === 'function') {
    mod.registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith('file:') && url.endsWith('.json') && context.importAttributes?.type !== 'json') {
          return {
            format: 'json',
            shortCircuit: true,
            source: readFileSync(fileURLToPath(url), 'utf8'),
          };
        }
        return nextLoad(url, context);
      },
    });
  }
}

function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveWithExistingAncestor(targetPath: string): string {
  const abs = path.resolve(targetPath);
  const parts: string[] = [];
  let cursor = abs;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    parts.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return path.join(base, ...parts);
}

export function isInsideRepo(targetPath: string, repoRoot = REPO_ROOT): boolean {
  const repoReal = normalizePathForCompare(existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot);
  const targetReal = normalizePathForCompare(resolveWithExistingAncestor(targetPath));
  return targetReal === repoReal || targetReal.startsWith(repoReal + path.sep);
}

export async function runRegister(opts: {
  label: string;
  synonyms: string[];
  sensations: string[];
  outPath: string;
  repoRoot?: string;
}): Promise<{ sha256: string; outPath: string; registration: BlindRegistration }> {
  if (!opts.outPath) throw new Error('--out is required');
  if (isInsideRepo(opts.outPath, opts.repoRoot ?? REPO_ROOT)) {
    throw new Error('refusing to write registration file inside the repository');
  }
  const cleanedSensations = opts.sensations.map(s => s.trim().toLowerCase()).filter(Boolean);
  if (cleanedSensations.length === 0) {
    throw new Error('--sensations requires at least one sensation');
  }
  for (const s of cleanedSensations) {
    if (!(SENSATIONS as string[]).includes(s)) {
      throw new Error(`unknown sensation: ${s}`);
    }
  }
  const rec = await registration(opts.label, opts.synonyms, cleanedSensations);
  const absOut = path.resolve(opts.outPath);
  mkdirSync(path.dirname(absOut), { recursive: true });
  writeFileSync(absOut, rec.json + '\n', 'utf8');
  return { sha256: rec.sha256, outPath: absOut, registration: rec.registration };
}

export interface ScanFileResult {
  file: string;
  counts: number[];
  total: number;
}

export interface ScanSummary {
  termCount: number;
  files: ScanFileResult[];
  totalsByTerm: number[];
  totalMatches: number;
  exitCode: 0 | 1;
  formatted: string;
}

function collectScannableFiles(repoRoot: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const walk = (absPath: string) => {
    if (!existsSync(absPath)) return;
    const st = statSync(absPath);
    if (st.isDirectory()) {
      for (const entry of readdirSync(absPath).sort()) {
        if (entry === '__pycache__' || entry === 'node_modules' || entry === '.wrangler') continue;
        walk(path.join(absPath, entry));
      }
      return;
    }
    if (BINARY_EXT.test(absPath)) return;
    const key = normalizePathForCompare(absPath);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(absPath);
  };
  for (const rel of ['site/src', 'site/public', 'app/cam', 'site/public/cam/catalog.json']) {
    walk(path.join(repoRoot, rel));
  }
  return results.sort((a, b) =>
    path.relative(repoRoot, a).replaceAll('\\', '/').localeCompare(path.relative(repoRoot, b).replaceAll('\\', '/')),
  );
}

export function loadRegistrationFile(filePath: string): BlindRegistration {
  const parsed = JSON.parse(readFileSync(path.resolve(filePath), 'utf8')) as Partial<BlindRegistration>;
  if (
    !parsed ||
    typeof parsed.label !== 'string' ||
    !Array.isArray(parsed.synonyms) ||
    !Array.isArray(parsed.expected_sensations)
  ) {
    throw new Error('invalid registration JSON');
  }
  return {
    label: parsed.label.trim().toLowerCase(),
    synonyms: parsed.synonyms.map(s => String(s).trim().toLowerCase()).filter(Boolean),
    expected_sensations: parsed.expected_sensations.map(s => String(s).trim().toLowerCase()).filter(Boolean),
  };
}

export function runScan(opts: { registration: BlindRegistration; repoRoot?: string }): ScanSummary {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const terms: string[] = [];
  for (const t of [opts.registration.label, ...opts.registration.synonyms]) {
    const clean = t.trim().toLowerCase();
    if (clean && !terms.includes(clean)) terms.push(clean);
  }
  if (terms.length === 0) throw new Error('registration has no terms to scan');

  const absFiles = collectScannableFiles(repoRoot);
  const totalsByTerm = Array<number>(terms.length).fill(0);
  const files: ScanFileResult[] = [];
  const lines: string[] = [];

  for (const absFile of absFiles) {
    const rel = path.relative(repoRoot, absFile).replaceAll('\\', '/');
    const text = readFileSync(absFile, 'utf8');
    const counts = terms.map((term, idx) => {
      const c = countWholeWord(text, term);
      totalsByTerm[idx] += c;
      return c;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    files.push({ file: rel, counts, total });
    const perTerm = counts.map((c, idx) => `term #${idx + 1}=${c}`).join(', ');
    lines.push(`${rel}: ${perTerm}`);
  }

  const totalMatches = totalsByTerm.reduce((a, b) => a + b, 0);
  const summaryTerms = totalsByTerm.map((c, idx) => `term #${idx + 1}=${c}`).join(', ');
  lines.push(`TOTAL (${files.length} files): total=${totalMatches} (${summaryTerms})`);

  return {
    termCount: terms.length,
    files,
    totalsByTerm,
    totalMatches,
    exitCode: totalMatches > 0 ? 1 : 0,
    formatted: lines.join('\n'),
  };
}
export interface UnderstandRawOutput {
  name: string;
  category: string;
  contract_version: string;
  initial_state: string;
  content_safety: { ok: boolean; reason: string };
  identifiable_person_present: boolean;
  size: 'S' | 'M' | 'L';
  object_card: unknown;
  interactions: unknown[];
}

export interface ReplayOutput {
  photo_sha256: string;
  registration_sha256: string;
  gift_id: string;
  object_id: string;
  simulated_hours_limit: number;
  settled_at_offset_ms: number | null;
  ingest_status: number;
  report: BlindJudgeReport;
  markdown: string;
}

export function formatReplayMarkdown(report: BlindJudgeReport): string {
  const header = [
    '| Stage | Name | Verdict | Evidence IDs | Notes |',
    '|---|---|---|---|---|',
  ];
  const rows = report.stages.map(s => {
    const ids = s.evidence_ids.length ? s.evidence_ids.join(', ') : '-';
    const notes = s.reasons.join('; ').replaceAll('|', '\\|');
    return `| ${s.stage} | ${s.name} | ${s.verdict} | ${ids} | ${notes} |`;
  });
  if (report.m2) {
    const m2 = report.m2;
    const s6 = report.stages[5];
    const ids = s6.evidence_ids.length ? s6.evidence_ids.join(', ') : '-';
    const rel = m2.dM_over_p_s1_prime != null ? m2.dM_over_p_s1_prime.toFixed(6) : 'n/a';
    const peerRel =
      m2.same_sensation.dM_over_p_s1_prime != null
        ? m2.same_sensation.dM_over_p_s1_prime.toFixed(6)
        : 'n/a';
    const rS1 = `S1(obj=${m2.replay_24h.s1.object_contacts},peer=${m2.replay_24h.s1.peer_contacts},first=${m2.replay_24h.s1.first_return_offset_ms ?? 'none'})`;
    const rS1p = `S1'(obj=${m2.replay_24h.s1_prime.object_contacts},peer=${m2.replay_24h.s1_prime.peer_contacts},first=${m2.replay_24h.s1_prime.first_return_offset_ms ?? 'none'})`;
    const note = `stage6=${s6.verdict}, m2=${m2.verdict}; appraisal=${m2.appraisal.toFixed(4)} (main=${m2.main_sensation ?? 'none'}): P(S0)=${m2.p_s0.toFixed(6)}, P(S1)=${m2.p_s1.toFixed(6)}, P(S1')=${m2.p_s1_prime.toFixed(6)}, dT=${m2.dT.toFixed(6)}, dN=${m2.dN.toFixed(6)}, dM=${m2.dM.toFixed(6)}, dM/P(S1')=${rel}; same-main-sensation P(S0)=${m2.same_sensation.p_s0.toFixed(6)}, P(S1)=${m2.same_sensation.p_s1.toFixed(6)}, P(S1')=${m2.same_sensation.p_s1_prime.toFixed(6)}, dT=${m2.same_sensation.dT.toFixed(6)}, dN=${m2.same_sensation.dN.toFixed(6)}, dM=${m2.same_sensation.dM.toFixed(6)}, dM/P(S1')=${peerRel}; 24h replay: ${rS1} vs ${rS1p}`;
    rows.push(`| M2 | memory_effect | ${m2.verdict} | ${ids} | ${note} |`);
  }
  return [...header, ...rows].join('\n');
}

function withSeededCrypto<T>(seed: string, fn: () => Promise<T>): Promise<T> {
  const cryptoObj = globalThis.crypto;
  const origGetRandomValues = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cryptoObj), 'getRandomValues')
    || Object.getOwnPropertyDescriptor(cryptoObj, 'getRandomValues');
  const origRandomUUID = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cryptoObj), 'randomUUID')
    || Object.getOwnPropertyDescriptor(cryptoObj, 'randomUUID');

  let counter = 0;
  let pool = Buffer.alloc(0);
  let offset = 0;
  const nextBytes = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      if (offset >= pool.length) {
        pool = createHash('sha256').update(`${seed}:${counter++}`).digest();
        offset = 0;
      }
      const take = Math.min(n - written, pool.length - offset);
      out.set(pool.subarray(offset, offset + take), written);
      offset += take;
      written += take;
    }
    return out;
  };

  const seededGetRandomValues = <A extends ArrayBufferView>(array: A): A => {
    const bytes = nextBytes(array.byteLength);
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  };
  const seededRandomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    const b = nextBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };

  Object.defineProperty(cryptoObj, 'getRandomValues', {
    value: seededGetRandomValues,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(cryptoObj, 'randomUUID', {
    value: seededRandomUUID,
    configurable: true,
    writable: true,
  });

  return fn().finally(() => {
    if (origGetRandomValues) {
      delete (cryptoObj as unknown as Record<string, unknown>).getRandomValues;
    }
    if (origRandomUUID) {
      delete (cryptoObj as unknown as Record<string, unknown>).randomUUID;
    }
  });
}

function buildGiftReadyPayload(raw: Record<string, unknown>, giftId: string): Record<string, unknown> {
  if (raw.type === 'gift_ready') {
    return {
      ...raw,
      gift_id: giftId,
      sprite: `/media/gift-${giftId}.png`,
    };
  }
  const u = raw as unknown as UnderstandRawOutput;
  if (u.contract_version !== 'cam-d1fix-2') {
    throw new Error('raw output uses a legacy contract (contract_version must be cam-d1fix-2)');
  }
  if (!u.content_safety || u.content_safety.ok !== true) {
    throw new Error('raw output failed content safety gate (content_safety.ok must be true)');
  }
  if (u.identifiable_person_present !== false) {
    throw new Error('raw output refused by the product person rule (identifiable_person_present must be false)');
  }
  if (!CATEGORIES.has(u.category) || !['S', 'M', 'L'].includes(u.size)) {
    throw new Error(`raw output has disallowed category (${String(u.category)}) or size (${String(u.size)})`);
  }
  if (typeof u.name !== 'string' || !NAME_RE.test(u.name)) {
    throw new Error(`raw output has invalid name: ${String(u.name)}`);
  }
  const card = u.object_card as Record<string, unknown> | undefined;
  if (!card || typeof card !== 'object' || 'prop_poses' in card) {
    throw new Error('raw output has missing or prefab-only object_card');
  }
  if (!Array.isArray((card as { hazards?: unknown }).hazards)) {
    throw new Error('raw output object_card must declare a hazards list');
  }
  if (card.name !== u.name || card.size !== u.size || card.category !== u.category) {
    throw new Error('raw output top-level name/size/category inconsistent with object_card');
  }
  const states = (card as { states?: unknown }).states;
  if (typeof u.initial_state !== 'string' || !Array.isArray(states) || !states.includes(u.initial_state)) {
    throw new Error('raw output initial_state must be one of object_card.states');
  }
  if (!Array.isArray(u.interactions) || u.interactions.length > 3) {
    throw new Error('raw output interactions must be an array of at most 3 candidates');
  }
  return {
    type: 'gift_ready',
    gift_id: giftId,
    name: u.name,
    initial_state: u.initial_state,
    size: u.size,
    sprite: `/media/gift-${giftId}.png`,
    object_card: u.object_card,
    contract_version: 'cam-d1fix-2',
    content_safety: u.content_safety,
    identifiable_person_present: false,
    interactions: u.interactions,
    pipeline: [
      { step: 'fetch_source', model: 'local', ok: true, seconds: 0, ms: 0, cost_usd: 0, cost_basis: 'local' },
      { step: 'understand', model: 'muse-spark-1.3', ok: true, seconds: 0, ms: 0, cost_usd: 0, cost_basis: 'estimate' },
      {
        step: 'box',
        model: 'sam-box-not-configured',
        ok: false,
        seconds: 0,
        ms: 0,
        cost_usd: 0,
        cost_basis: 'not_called',
        note: 'no crop; box unavailable',
      },
      {
        step: 'redraw',
        model: 'muse-image-1.0',
        ok: true,
        seconds: 0,
        ms: 0,
        cost_usd: 0,
        cost_basis: 'configured_per_image',
      },
      { step: 'pixelize', model: 'local', ok: true, seconds: 0, ms: 0, cost_usd: 0, cost_basis: 'local' },
      { step: 'upload', model: 'local', ok: true, seconds: 0, ms: 0, cost_usd: 0, cost_basis: 'local' },
    ],
    cost_usd: 0,
  };
}

export async function runReplay(opts: {
  raw: Record<string, unknown>;
  photoSha: string;
  registration: BlindRegistration;
  hours?: number;
}): Promise<ReplayOutput> {
  ensureJsonImportHook();
  const [{ database, NOW }, { ingestGift, photoGift }, { advance }, { decodeSegment, snapshot }] = await Promise.all([
    import('./cam-test-db.ts'),
    import('../src/worker/cam/gifts.ts'),
    import('../src/worker/cam/timeline.ts'),
    import('../src/worker/cam/store.ts'),
  ]);

  const photoSha = opts.photoSha.trim().toLowerCase();
  if (!/^[0-9a-f]{4,128}$/.test(photoSha)) {
    throw new Error('--photo-sha must be a hex string');
  }
  const hours = opts.hours ?? 24;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
    throw new Error('--hours must be between 0 and 720');
  }

  const regRecord = await registration(
    opts.registration.label,
    opts.registration.synonyms,
    opts.registration.expected_sensations,
  );

  return withSeededCrypto(`blind-replay:${photoSha}`, async () => {
    const T0 = NOW;
    const seedEpoch = T0 - 86400000;
    const { sql, db, env: baseEnv } = database(T0, true);
    sql.prepare('UPDATE world SET updated_at=?').run(T0);
    sql.prepare('UPDATE object_cards SET created_at=?').run(seedEpoch);
    sql.prepare('UPDATE objects SET created_at=?').run(seedEpoch);
    sql.prepare('UPDATE object_states SET valid_from=?').run(seedEpoch);
    sql.prepare('UPDATE interactions SET created_at=?').run(seedEpoch);

    const mediaStore = new Map<string, Uint8Array>();
    const media = {
      async get(key: string, type?: string) {
        const val = mediaStore.get(key);
        if (!val) return null;
        if (type === 'arrayBuffer') {
          return val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength);
        }
        return new TextDecoder().decode(val);
      },
      async put(key: string, value: ArrayBuffer | Uint8Array | string) {
        if (typeof value === 'string') mediaStore.set(key, new TextEncoder().encode(value));
        else if (value instanceof Uint8Array) mediaStore.set(key, new Uint8Array(value));
        else mediaStore.set(key, new Uint8Array(value));
      },
      async delete(key: string) {
        mediaStore.delete(key);
      },
    };

    const ownerCodeHash = createHash('sha256').update('offline-owner').digest('hex');
    const env = {
      ...baseEnv,
      MEDIA: media as unknown as KVNamespace,
      OWNER_CODE_SHA256: ownerCodeHash,
      MEDIA_UPLOAD_TOKEN: 'offline-ingest-token',
      GH_DISPATCH_TOKEN: 'offline-token',
      GH_REPO: 'offline/repo',
    };

    const form = new FormData();
    form.set('idem', `blind_${photoSha.slice(0, 32)}`);
    form.set('file', new File([ONE_BY_ONE_PNG], 'gift.png', { type: 'image/png' }));
    const photoReq = new Request('https://nori.local/api/gift/photo', {
      method: 'POST',
      headers: { 'X-Nori-Code': 'offline-owner' },
      body: form,
    });
    const fakeFetch: typeof fetch = async () => new Response(null, { status: 204 });
    const photoRes = await photoGift(photoReq, env, { fetch: fakeFetch }, T0);
    if (photoRes.status !== 200 && photoRes.status !== 202) {
      throw new Error(`photoGift failed with status ${photoRes.status}: ${await photoRes.text()}`);
    }
    const { gift_id: giftId } = (await photoRes.json()) as { gift_id: string };
    const objectId = `o_${giftId}`;

    await media.put(`gift-${giftId}.png`, ONE_BY_ONE_PNG);

    const unwrapAt = T0 + 1000;
    let ingestStatus = 400;
    try {
      const ingestPayload = buildGiftReadyPayload(opts.raw, giftId);
      const ingestReq = new Request('https://nori.local/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer offline-ingest-token',
        },
        body: JSON.stringify(ingestPayload),
      });
      const ingestRes = await ingestGift(ingestReq, env, unwrapAt);
      ingestStatus = ingestRes.status;
    } catch {
      ingestStatus = 400;
    }

    const snapAtUnwrap = await snapshot(db, unwrapAt);
    const objectsAtStart = structuredClone(snapAtUnwrap.objects);

    const deadline = unwrapAt + Math.round(hours * 3600000);
    let t = unwrapAt;
    const maxLoops = Math.ceil(hours * 60) + 600;
    let settledAt: number | null = null;

    if (ingestStatus === 200) {
      for (let loop = 0; loop < maxLoops; loop++) {
        const expRow = sql
          .prepare('SELECT at FROM experiences WHERE object_id=? ORDER BY at LIMIT 1')
          .get(objectId) as { at: number } | undefined;
        if (expRow) {
          settledAt = Number(expRow.at);
          break;
        }

        const compiledRunnable = (
          sql
            .prepare(
              "SELECT id FROM interactions WHERE object_id=? AND source='compiled' AND status IN ('accepted','degraded')",
            )
            .all(objectId) as { id: string }[]
        ).map(r => r.id);
        if (compiledRunnable.length === 0) break;
        const runnableSet = new Set(compiledRunnable);

        const unsettled = sql
          .prepare(
            'SELECT id, start_at, end_at, interaction FROM segments WHERE settled_at IS NULL AND superseded_at IS NULL ORDER BY end_at, id',
          )
          .all() as { id: number; start_at: number; end_at: number; interaction: string | null }[];

        const targetSegs = unsettled.filter(
          s => s.interaction != null && runnableSet.has(s.interaction) && Number(s.end_at) <= deadline,
        );

        if (targetSegs.length > 0) {
          const targetEnd = Number(targetSegs.at(-1)!.end_at);
          const beforeOrAt = unsettled.filter(s => Number(s.end_at) <= targetEnd);
          const nextT = beforeOrAt.length > 25 ? Number(beforeOrAt[24].end_at) : targetEnd;
          t = Math.max(t, nextT);
          await advance(env, t, 'cron');
          continue;
        }

        if (t >= deadline) break;
        const stepTarget = Math.min(deadline, t + 5 * 60000);
        const dueByStep = unsettled.filter(s => Number(s.end_at) <= stepTarget);
        const nextT = dueByStep.length > 25 ? Math.max(t + 1, Number(dueByStep[24].end_at)) : stepTarget;
        t = nextT;
        await advance(env, t, 'cron');
      }
    }

    const cardRow = sql
      .prepare("SELECT id, object_id, source, card FROM object_cards WHERE object_id=? AND source='spark_vision'")
      .get(objectId) as { id: string; object_id: string; source: string; card: string } | undefined;

    const ixRows = sql
      .prepare(
        "SELECT id, object_id, card_id, source, spec, status, checks, gaps FROM interactions WHERE object_id=? AND source='compiled' ORDER BY id",
      )
      .all(objectId) as Record<string, unknown>[];

    const interactions: StoredInteractionEvidence[] = ixRows.map(r => ({
      id: String(r.id),
      object_id: String(r.object_id),
      card_id: String(r.card_id),
      source: String(r.source),
      spec: JSON.parse(String(r.spec)),
      status: String(r.status) as 'accepted' | 'degraded' | 'rejected',
      checks: JSON.parse(String(r.checks || '[]')),
      gaps: JSON.parse(String(r.gaps || '[]')),
    }));

    const ixIds = new Set(interactions.map(i => i.id));
    const allObjectSegments = (
      sql
        .prepare('SELECT * FROM segments WHERE superseded_at IS NULL ORDER BY start_at, id')
        .all() as Record<string, unknown>[]
    )
      .map(decodeSegment)
      .filter(s => s.target === objectId || (s.interaction != null && ixIds.has(s.interaction)));

    const segIdStrings = new Set(allObjectSegments.map(s => String(s.id)));

    const rawStates = sql
      .prepare(
        `SELECT rowid AS id, object_id, valid_from, x, y, z, footprint, rotation, status, state, sprite, cause
         FROM object_states
         WHERE object_id=? AND cause NOT IN ('seed') AND cause NOT LIKE 'gift:%' AND cause NOT LIKE 'unwrapped:%'
         ORDER BY valid_from, rowid`,
      )
      .all(objectId) as Record<string, unknown>[];

    const stateChanges: StoredObjectStateRow[] = rawStates.map(r => ({
      id: Number(r.id),
      object_id: String(r.object_id),
      valid_from: Number(r.valid_from),
      x: Number(r.x),
      y: Number(r.y),
      z: Number(r.z),
      footprint: JSON.parse(String(r.footprint)) as Cell[],
      rotation: Number(r.rotation),
      status: String(r.status),
      state: String(r.state),
      sprite: String(r.sprite),
      cause: String(r.cause),
    }));

    const rawSounds = sql
      .prepare("SELECT id, at, type, actor, payload FROM events WHERE type='sound_played' ORDER BY at, id")
      .all() as Record<string, unknown>[];

    const soundEvents: CamEvent[] = rawSounds
      .map(r => ({
        id: String(r.id),
        at: Number(r.at),
        type: String(r.type),
        actor: String(r.actor),
        payload: JSON.parse(String(r.payload || '{}')) as Record<string, unknown>,
      }))
      .filter(ev => {
        if (ev.payload?.target === objectId) return true;
        const parts = ev.id.split(':');
        return parts[0] === 'sound_played' && segIdStrings.has(parts[1]);
      });

    const rawExps = sql
      .prepare('SELECT * FROM experiences WHERE object_id=? ORDER BY at, id')
      .all(objectId) as Record<string, unknown>[];

    const experiences: Experience[] = rawExps.map(r => ({
      id: String(r.id),
      at: Number(r.at),
      object_id: String(r.object_id),
      interaction_id: String(r.interaction_id),
      segment_ids: JSON.parse(String(r.segment_ids)),
      sensations: JSON.parse(String(r.sensations)),
      startle: Number(r.startle),
      appraisal: Number(r.appraisal),
      reaction: String(r.reaction),
      pref_deltas: JSON.parse(String(r.pref_deltas)),
      wariness_deltas: JSON.parse(String(r.wariness_deltas)),
      familiarity_delta: Number(r.familiarity_delta),
      world_version: Number(r.world_version),
    }));

    const snapFinal = await snapshot(db, settledAt ?? t);
    const firstExp = experiences[0];
    const lastExpSeg = firstExp
      ? allObjectSegments.find(s => s.id === firstExp.segment_ids.at(-1))
      : undefined;
    const positionAtExp: Cell = lastExpSeg?.path.at(-1) ? [...lastExpSeg.path.at(-1)!] : [2, 6];

    const evidence: BlindEvidence = {
      object_id: objectId,
      card: cardRow
        ? {
            id: cardRow.id,
            object_id: cardRow.object_id,
            source: cardRow.source,
            card: JSON.parse(cardRow.card),
          }
        : null,
      interactions,
      segments: allObjectSegments,
      state_changes: stateChanges,
      sound_events: soundEvents,
      experiences,
      objects_at_start: objectsAtStart,
      world_snapshot: {
        objects: snapFinal.objects,
        interactions: snapFinal.interactions,
        position: positionAtExp,
        state_after: snapFinal.state,
      },
    };

    const report = judge(evidence, regRecord.registration);
    const markdown = formatReplayMarkdown(report);
    return {
      photo_sha256: photoSha,
      registration_sha256: regRecord.sha256,
      gift_id: giftId,
      object_id: objectId,
      simulated_hours_limit: hours,
      settled_at_offset_ms: settledAt != null ? settledAt - unwrapAt : null,
      ingest_status: ingestStatus,
      report,
      markdown,
    };
  });
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function cli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === 'register') {
    const label = getFlag(rest, '--label');
    const synonymsArg = getFlag(rest, '--synonyms') ?? '';
    const sensationsArg = getFlag(rest, '--sensations') ?? '';
    const outPath = getFlag(rest, '--out');
    if (!label || !outPath || !sensationsArg) {
      process.stderr.write(
        'Usage: blind-test.ts register --label <text> --synonyms a,b,c --sensations s1,s2 --out <file outside repo>\n',
      );
      return 2;
    }
    const result = await runRegister({
      label,
      synonyms: synonymsArg.split(','),
      sensations: sensationsArg.split(','),
      outPath,
    });
    process.stdout.write(result.sha256 + '\n');
    return 0;
  }

  if (sub === 'scan') {
    const regFile = getFlag(rest, '--registration');
    if (!regFile) {
      process.stderr.write('Usage: blind-test.ts scan --registration <file>\n');
      return 2;
    }
    const reg = loadRegistrationFile(regFile);
    const summary = runScan({ registration: reg });
    process.stdout.write(summary.formatted + '\n');
    return summary.exitCode;
  }

  if (sub === 'replay') {
    if (!process.execArgv.includes('--experimental-transform-types')) {
      const child = spawnSync(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-transform-types',
          ...process.execArgv,
          fileURLToPath(import.meta.url),
          ...argv,
        ],
        { stdio: 'inherit' },
      );
      return child.status ?? 1;
    }
    const rawFile = getFlag(rest, '--raw');
    const photoSha = getFlag(rest, '--photo-sha');
    const regFile = getFlag(rest, '--registration');
    const hoursArg = getFlag(rest, '--hours');
    if (!rawFile || !photoSha || !regFile) {
      process.stderr.write(
        'Usage: blind-test.ts replay --raw <raw.json> --photo-sha <hex> --registration <file> [--hours 24]\n',
      );
      return 2;
    }
    const raw = JSON.parse(readFileSync(path.resolve(rawFile), 'utf8')) as Record<string, unknown>;
    const reg = loadRegistrationFile(regFile);
    const hours = hoursArg != null ? Number(hoursArg) : 24;
    const origLog = console.log;
    console.log = () => {};
    let result: ReplayOutput;
    try {
      result = await runReplay({ raw, photoSha, registration: reg, hours });
    } finally {
      console.log = origLog;
    }
    process.stdout.write(
      JSON.stringify(
        {
          photo_sha256: result.photo_sha256,
          registration_sha256: result.registration_sha256,
          gift_id: result.gift_id,
          object_id: result.object_id,
          simulated_hours_limit: result.simulated_hours_limit,
          settled_at_offset_ms: result.settled_at_offset_ms,
          ingest_status: result.ingest_status,
          report: result.report,
        },
        null,
        2,
      ) +
        '\n\n' +
        result.markdown +
        '\n',
    );
    return 0;
  }

  process.stderr.write('Subcommands: register | scan | replay\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(err => {
      process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
      process.exitCode = 1;
    });
}
