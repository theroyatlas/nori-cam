export declare const POLL_MS: number;
export declare const MIN_POLL_MS: number;
export declare const PRE_END_LEAD_MS: number;
export declare const PRUNE_AFTER_MS: number;
export declare const BACKOFF_BASE_MS: number;
export declare const BACKOFF_MAX_MS: number;
export declare const CLOCK_SAMPLE_WINDOW: number;

export declare function computeOffset(serverNow: number, sentAt: number, receivedAt: number): number;
export declare function rttOf(sentAt: number, receivedAt: number): number;

export interface ClockSample { serverNow: number; sentAt: number; receivedAt: number; rtt: number; offset: number }
export declare function bestSample(samples: readonly ClockSample[] | null | undefined): ClockSample | null;

export declare class ClockSync {
  samples: ClockSample[];
  addSample(serverNow: number, sentAt: number, receivedAt: number): number;
  get best(): ClockSample | null;
  get offset(): number;
  now(perfNowMs: number): number;
}

export declare function createClockSource(): { perfNow: () => number; wallNow: () => number };
export declare function wallNowMs(): number;

export interface LiveMode { mode: "fixture" | "live"; fixture: string | null }
export declare function parseMode(search: string | URLSearchParams | null | undefined): LiveMode;
export declare function isFixtureMode(search: string | URLSearchParams | null | undefined): boolean;

export declare function backoffDelayMs(failures: number): number;
export declare function nextPollDelayMs(opts?: { nowServer?: number; timelineUntil?: number | null; failures?: number }): number;

export interface SegmentLike {
  id: number; start_at: number; end_at: number;
  action?: string; pose?: string; primitive?: string | null; facing?: number;
  path?: number[][]; target?: string | null; part?: string | null;
  effects?: unknown[] | null; cut_at?: number | null; [k: string]: unknown;
}
export declare function effectiveEnd(seg: SegmentLike | null | undefined): number;
export declare function pruneSegments(segments: readonly SegmentLike[], nowServer: number): SegmentLike[];
export declare function mergeSegments(existing: readonly SegmentLike[] | null | undefined, incoming: readonly SegmentLike[] | null | undefined, nowServer?: number): SegmentLike[];
export declare function firstLoadPose(objects: readonly { kind?: string; x: number; y: number; z?: number }[] | null | undefined, grid?: { w?: number; h?: number } | null): { x: number; y: number; z: number; pose: string; facing: number };
export declare function holdPoseName(pose: string | null | undefined): string;
export declare function heldPose(segments: readonly SegmentLike[], t: number, poseAtFn?: ((segs: SegmentLike[], t: number) => unknown) | null): unknown;

export interface CamApiResponse {
  server_now: number; engine_version?: string; world_version?: number;
  timeline_until: number; objects: unknown[]; segments: SegmentLike[]; weather: unknown;
  room?: { grid?: { w: number; h: number }; window?: string } | null;
  [k: string]: unknown;
}

export interface LiveTimelineOptions {
  fetchFn?: typeof fetch;
  perfNow?: () => number;
  wallNow?: () => number;
  url?: string;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  onUpdate?: ((src: LiveTimeline) => void) | null;
}

export declare class LiveTimeline {
  constructor(options?: LiveTimelineOptions);
  fetchFn: typeof fetch;
  perfNow: () => number;
  wallNow: () => number;
  url: string;
  clockSync: ClockSync;
  etag: string | null;
  segments: SegmentLike[];
  objectsAt: number;
  objects: unknown[];
  weather: unknown;
  room: { grid?: { w: number; h: number }; window?: string } | null;
  timelineUntil: number | null;
  serverNowValue: number | null;
  worldVersion: number | null;
  engineVersion: string | null;
  failures: number;
  lastStatus: number | null;
  nowServer(): number;
  get offset(): number;
  shouldShowReconnect(): boolean;
  nextPollDelayMs(): number;
  fetchOnce(fromMs?: number): Promise<{ status: number; notModified: boolean; body?: CamApiResponse }>;
  confirmSegmentEnd(segmentOrId: SegmentLike | number): Promise<boolean>;
  effectsAllowedAt(t: number): SegmentLike[];
  poseAtLive(t: number, poseAtFn?: ((segs: SegmentLike[], t: number) => unknown) | null): unknown;
  start(): void;
  stop(): void;
}

export declare function createLiveSource(options?: LiveTimelineOptions): LiveTimeline;
export declare function createLiveTimeline(options?: LiveTimelineOptions): LiveTimeline;
