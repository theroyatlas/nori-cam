// cam-live.js — live timeline source for Nori Cam (spec 3.7, 3.8).
// Pure helpers are exported for tests; network and clocks are injected.
// This module is the only renderer module that may read the wall clock:
// the clock source below uses Date.now() plus performance.now(). Drawing
// modules receive server time from here and never read a clock themselves.

export const POLL_MS = 60_000;
export const MIN_POLL_MS = 10_000;
export const PRE_END_LEAD_MS = 5 * 60_000;
export const PRUNE_AFTER_MS = 10 * 60_000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
export const CLOCK_SAMPLE_WINDOW = 5;

export function computeOffset(serverNow, sentAt, receivedAt) {
  return serverNow - (sentAt + receivedAt) / 2;
}

export function rttOf(sentAt, receivedAt) {
  return Math.max(0, receivedAt - sentAt);
}

// Keep the lowest-RTT sample of the last few (spec 3.7 smoothing).
export function bestSample(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let best = samples[0];
  for (const s of samples) if (s.rtt < best.rtt) best = s;
  return best;
}

export class ClockSync {
  constructor() { this.samples = []; }
  addSample(serverNow, sentAt, receivedAt) {
    if (![serverNow, sentAt, receivedAt].every(Number.isFinite)) return this.offset;
    const sample = {
      serverNow, sentAt, receivedAt,
      rtt: rttOf(sentAt, receivedAt),
      offset: computeOffset(serverNow, sentAt, receivedAt),
    };
    this.samples.push(sample);
    if (this.samples.length > CLOCK_SAMPLE_WINDOW) {
      this.samples = this.samples.slice(-CLOCK_SAMPLE_WINDOW);
    }
    return this.offset;
  }
  get best() { return bestSample(this.samples); }
  get offset() { const b = this.best; return b ? b.offset : 0; }
  now(perfNowMs) { return perfNowMs + this.offset; }
}

// The single wall-clock source. Date lives only here.
export function createClockSource() {
  return {
    perfNow: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    wallNow: () => Date.now(),
  };
}
export function wallNowMs() { return Date.now(); }

export function parseMode(search) {
  let p;
  if (typeof search === 'string') p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  else if (search && typeof search.get === 'function') p = search;
  else p = new URLSearchParams();
  const fixture = p.get('fixture');
  return fixture ? { mode: 'fixture', fixture } : { mode: 'live', fixture: null };
}
export function isFixtureMode(search) { return parseMode(search).mode === 'fixture'; }

export function backoffDelayMs(failures) {
  if (!(failures > 0)) return POLL_MS;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (Math.floor(failures) - 1));
}

export function nextPollDelayMs({ nowServer = 0, timelineUntil = null, failures = 0 } = {}) {
  if (failures > 0) return backoffDelayMs(failures);
  if (timelineUntil != null && Number.isFinite(timelineUntil)) {
    const atPreEnd = timelineUntil - PRE_END_LEAD_MS - nowServer;
    return Math.max(MIN_POLL_MS, Math.min(POLL_MS, atPreEnd));
  }
  return POLL_MS;
}

export function effectiveEnd(seg) {
  if (!seg) return 0;
  return seg.cut_at != null ? Math.min(seg.end_at, seg.cut_at) : seg.end_at;
}

export function pruneSegments(segments, nowServer) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start_at - b.start_at || a.id - b.id);
  const kept = sorted.filter((s) => effectiveEnd(s) >= nowServer - PRUNE_AFTER_MS);
  if (kept.length) return kept;
  return [sorted[sorted.length - 1]];
}

// Merge by id: later fetch wins, cut_at is honoured, old segments pruned.
export function mergeSegments(existing, incoming, nowServer = 0) {
  const byId = new Map();
  for (const s of existing || []) if (s && s.id != null) byId.set(s.id, s);
  for (const s of incoming || []) if (s && s.id != null) byId.set(s.id, s);
  return pruneSegments([...byId.values()], nowServer);
}

export function firstLoadPose(objects, grid) {
  const w = grid && Number.isFinite(grid.w) ? grid.w : 10;
  const h = grid && Number.isFinite(grid.h) ? grid.h : 8;
  const bed = (objects || []).find((o) => o && (o.kind === 'bed' || o.kind === 'cushion'));
  if (bed) return { x: bed.x, y: bed.y, z: bed.z || 0, pose: 'sleepy', facing: 1 };
  return { x: Math.floor(w / 2), y: Math.floor(h / 2), z: 0, pose: 'sleepy', facing: 1 };
}

export function holdPoseName(pose) {
  if (pose === 'alert_loaf' || pose === 'alert-loaf') return 'alert_loaf';
  if (pose === 'sleepy') return 'sleepy';
  return 'sit';
}

// Pose past the end of the timeline: last position, sit/loaf, never vanish.
export function heldPose(segments, t, poseAtFn) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const sorted = [...segments].sort((a, b) => a.start_at - b.start_at || a.id - b.id);
  const last = sorted[sorted.length - 1];
  const probe = Math.min(t, Math.max(last.start_at, effectiveEnd(last) - 1));
  const base = poseAtFn ? poseAtFn(sorted, probe) : null;
  if (!base) return null;
  return { ...base, pose: holdPoseName(base.pose), held: true };
}

export class LiveTimeline {
  constructor(options = {}) {
    this.fetchFn = options.fetchFn || ((...a) => fetch(...a));
    const clock = createClockSource();
    this.perfNow = options.perfNow || clock.perfNow;
    this.wallNow = options.wallNow || clock.wallNow;
    this.url = options.url || '/api/cam';
    this.clockSync = new ClockSync();
    this.etag = null;
    this.segments = [];
    this.objects = [];
    this.objectsAt = -Infinity;
    this.weather = null;
    this.room = null;
    this.timelineUntil = null;
    this.serverNowValue = null;
    this.worldVersion = null;
    this.engineVersion = null;
    this.failures = 0;
    this.lastStatus = null;
    this._timer = null;
    this._stopped = true;
    this._confirmed = new Set();
    this._confirming = new Map();
    this.setTimeoutFn = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn || ((id) => clearTimeout(id));
    this.onUpdate = options.onUpdate || null;
  }

  nowServer() {
    if (this.clockSync.best) return this.clockSync.now(this.perfNow());
    return this.wallNow();
  }
  get offset() { return this.clockSync.offset; }
  shouldShowReconnect() { return this.failures >= 2; }
  nextPollDelayMs() {
    return nextPollDelayMs({ nowServer: this.nowServer(), timelineUntil: this.timelineUntil, failures: this.failures });
  }

  _recordServerNow(serverNow, sent, received) {
    if (Number.isFinite(serverNow)) {
      this.serverNowValue = serverNow;
      this.clockSync.addSample(serverNow, sent, received);
    }
  }

  async fetchOnce(fromMs) {
    const from = fromMs != null && Number.isFinite(fromMs) ? Math.floor(fromMs) : Math.floor(this.nowServer());
    const url = `${this.url}?from=${from}`;
    const headers = {};
    if (this.etag) headers['If-None-Match'] = this.etag;
    const sent = this.perfNow();
    let res;
    try {
      res = await this.fetchFn(url, { headers });
    } catch (e) {
      this.failures += 1;
      throw e;
    }
    const received = this.perfNow();
    if (res.status === 304) {
      const headerNow = res.headers && typeof res.headers.get === 'function'
        ? Number(res.headers.get('X-Server-Now') ?? res.headers.get('x-server-now')) : NaN;
      this._recordServerNow(headerNow, sent, received);
      const et = res.headers && res.headers.get ? (res.headers.get('ETag') || res.headers.get('etag')) : null;
      if (et) this.etag = et;
      this.failures = 0;
      this.lastStatus = 304;
      if (this.onUpdate) this.onUpdate(this);
      return { status: 304, notModified: true };
    }
    if (!res.ok) {
      this.failures += 1;
      const err = new Error(`cam ${res.status}`);
      err.status = res.status;
      throw err;
    }
    let body;
    try { body = await res.json(); } catch (e) { this.failures += 1; throw e; }
    this._recordServerNow(body && body.server_now, sent, received);
    const et = res.headers && typeof res.headers.get === 'function'
      ? (res.headers.get('ETag') || res.headers.get('etag')) : null;
    if (et) this.etag = et;
    if (body) {
      if (Array.isArray(body.objects)) { this.objects = body.objects; this.objectsAt = body.server_now ?? -Infinity; }
      if (body.room !== undefined) this.room = body.room;
      if (body.weather !== undefined) this.weather = body.weather;
      if (body.timeline_until != null) this.timelineUntil = body.timeline_until;
      if (body.world_version != null) this.worldVersion = body.world_version;
      if (body.engine_version != null) this.engineVersion = body.engine_version;
      if (Array.isArray(body.segments)) {
        this.segments = mergeSegments(this.segments, body.segments, this.nowServer());
      }
    }
    this.failures = 0;
    this.lastStatus = 200;
    if (this.onUpdate) this.onUpdate(this);
    return { status: 200, notModified: false, body };
  }

  // Spec 3.8: confirm cut_at is still empty before a segment's effects show.
  // A failed refetch applies the effects as planned (returns true).
  async confirmSegmentEnd(segmentOrId) {
    const id = segmentOrId && typeof segmentOrId === 'object' ? segmentOrId.id : segmentOrId;
    if (this._confirmed.has(id)) {
      const seg = this.segments.find((s) => s.id === id);
      return !seg || seg.cut_at == null;
    }
    if (this._confirming.has(id)) return this._confirming.get(id);
    const p = (async () => {
      try { await this.fetchOnce(); } catch (e) { this._confirmed.add(id); return true; }
      const seg = this.segments.find((s) => s.id === id);
      const ok = !seg || seg.cut_at == null;
      this._confirmed.add(id);
      return ok;
    })();
    this._confirming.set(id, p);
    try { return await p; } finally { this._confirming.delete(id); }
  }

  // Effects that may be shown at time t: ended segments confirmed uncut.
  effectsAllowedAt(t) {
    return this.segments.filter((s) => effectiveEnd(s) <= t);
  }

  poseAtLive(t, poseAtFn) {
    if (!this.segments.length) return null;
    if (this.timelineUntil != null && t > this.timelineUntil) return heldPose(this.segments, t, poseAtFn);
    const sorted = [...this.segments].sort((a, b) => a.start_at - b.start_at);
    const lastEnd = effectiveEnd(sorted[sorted.length - 1]);
    if (t > lastEnd) return heldPose(this.segments, t, poseAtFn);
    return poseAtFn ? poseAtFn(this.segments, t) : null;
  }

  _scheduleNext() {
    if (this._stopped) return;
    const delay = this.nextPollDelayMs();
    this._timer = this.setTimeoutFn(() => { void this._pollLoop(); }, delay);
  }
  async _pollLoop() {
    if (this._stopped) return;
    // Confirm any segment ending within the next poll window (3.8).
    const now = this.nowServer();
    for (const s of this.segments) {
      const end = effectiveEnd(s);
      if (end > now && end - now < 2_000 && Array.isArray(s.effects) && s.effects.length) {
        void this.confirmSegmentEnd(s);
      }
    }
    try { await this.fetchOnce(); } catch (e) { /* keep playing; backoff via failures */ }
    this._scheduleNext();
  }
  start() {
    if (!this._stopped) return;
    this._stopped = false;
    // cam.js loads the first snapshot before starting the loop. Respect its
    // poll window instead of issuing a second request immediately on load.
    if (this.lastStatus != null) {
      this._scheduleNext();
      return;
    }
    void (async () => {
      try { await this.fetchOnce(); } catch (e) { /* backoff schedule below */ }
      this._scheduleNext();
    })();
  }
  stop() {
    this._stopped = true;
    if (this._timer != null) this.clearTimeoutFn(this._timer);
    this._timer = null;
  }
}

export function createLiveSource(options) { return new LiveTimeline(options); }
export function createLiveTimeline(options) { return new LiveTimeline(options); }
