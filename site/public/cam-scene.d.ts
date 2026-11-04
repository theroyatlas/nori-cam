import type { PropObject } from './cam-props.js';

export declare const OUTLINE: string;
export declare const LOGICAL_W: number;
export declare const LOGICAL_H: number;
export declare const PAL: Record<string, string>;
export declare const WINDOW: { x0: number; x1: number; hBot: number; hTop: number };
export declare function windowRect(project: typeof import('./cam-shared.js').project): { x: number; y: number; w: number; h: number };
export declare const DECOR_FLOOR_CELLS: readonly [number, number][];
export declare const DECOR: readonly { id: string; wall: string; along0: number; along1: number; hBot: number; hTop: number }[];
export declare function decorTouchesFloorCell(gx: number, gy: number): boolean;
export declare function decorRects(project: typeof import('./cam-shared.js').project, wallH?: number, look?: string): { id: string; wall: string; x: number; y: number; w: number; h: number }[];
export declare function drawWindowDressing(ctx: CanvasRenderingContext2D, pane: { quad: number[][]; wpt: (x: number, h: number) => number[] }, project: typeof import('./cam-shared.js').project): void;
export declare function drawSceneDynamic(ctx: CanvasRenderingContext2D, opts: {
  project: typeof import('./cam-shared.js').project;
  gridW: number;
  gridH: number;
  view: { light?: { phase: string }; sky?: string; stars?: readonly unknown[]; sunPatch?: { allowed: boolean; polygon?: [number, number][] | null } } | null;
  pane: { quad: number[][]; rect: { x: number; y: number; w: number; h: number }; wpt: (x: number, h: number) => number[] } | null;
  t: number;
  wallH: number;
  roomOff?: { x: number; y: number };
  look?: string;
}): void;
export declare function drawClockHands(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number): void;
export declare function nightAmbientRect(roomOff?: { x: number; y: number }): { x: number; y: number; w: number; h: number };
export declare function lampGlowCentres(project: typeof import('./cam-shared.js').project, pane: { rect: { x: number; y: number; w: number; h: number } } | null): { id: string; x: number; y: number; r: number }[];
export declare function drawPropContactShadows(
  ctx: CanvasRenderingContext2D,
  objects: readonly PropObject[],
  project: typeof import('./cam-shared.js').project,
  isPropVisible: (obj: PropObject | null | undefined) => boolean,
  kindOf: (obj: PropObject | null | undefined) => string,
): void;
export declare function drawForegroundPlant(ctx: CanvasRenderingContext2D, project: typeof import('./cam-shared.js').project, gridH: number): void;
export declare function createSceneStaticCache(options: {
  logicalW: number;
  logicalH: number;
  wallH: number;
  project?: typeof import('./cam-shared.js').project;
  createCanvas: (w: number, h: number) => HTMLCanvasElement | { width: number; height: number; getContext(type: '2d'): CanvasRenderingContext2D | null };
}): {
  ensure(gridW: number, gridH: number, roomOff: { x: number; y: number }, debug: boolean, pane: unknown, look?: string): unknown;
  blit(ctx: CanvasRenderingContext2D, gridW: number, gridH: number, roomOff: { x: number; y: number }, debug: boolean, pane: unknown, look?: string): unknown;
  readonly buildCount: number;
  readonly key: string;
};
export declare function nightGlowWarmth(view: { light?: { phase: string } } | null): number;
export declare function setSceneLook(look: string): string;
export declare function sceneLook(): string;

export type NightSpriteLight = {
  ambient: { rgb: readonly [number, number, number]; a: number };
  gain: readonly [number, number, number];
  flash: { rgb: readonly [number, number, number]; a: number } | null;
};
/** Night light for Nori's sprite; null unless view.sky is 'night'. */
export declare function nightSpriteLight(
  view: { sky?: string; flash?: number } | null,
  project: typeof import('./cam-shared.js').project,
  pane: { rect: { x: number; y: number; w: number; h: number } } | null,
  footX: number,
  footY: number,
  flashWash?: number,
): NightSpriteLight | null;
/** Applies a night light to RGBA bytes in place; alpha is never written. */
export declare function applyNightSpriteLight<T extends Uint8ClampedArray | number[]>(data: T, light: NightSpriteLight): T;

export declare function drawPlankFloor(ctx: CanvasRenderingContext2D, project: typeof import("./cam-shared.js").project, gridW: number, gridH: number, debug: boolean): void;

export declare function supportShadow(pose: {x:number;y:number;z?:number;primitive?:string|null}, objects: readonly PropObject[]): {sx:number;sy:number;z:number};
