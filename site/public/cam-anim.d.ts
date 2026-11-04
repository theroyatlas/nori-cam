// Types for cam-anim.js (B1 procedural life layer, spec section 19 E1).
// "eyes" rectangles in cam/manifest.json are [x, y, w, h] in native sprite
// pixels (origin top-left), found by scanning for near-black eye clusters
// (max RGB < 70) and confirming on an 8x enlargement. Empty = eyes closed
// in the source art, so the pose never blinks.

export interface SegmentLike {
  id: number;
  start_at: number;
  end_at: number;
  action: string;
  primitive?: string | null;
  pose: string;
  facing: number;
  path: number[][];
  z?: number;
  target?: string | null;
  part?: string | null;
}

export interface ManifestEntry {
  file: string;
  w: number;
  h: number;
  body_h: number;
  foot: [number, number];
  native_facing: number;
  fallback: string;
  generic: boolean;
  eyes?: [number, number, number, number][];
}

export type Manifest = Record<string, ManifestEntry>;

export interface Overlay {
  type: string;
  dx: number;
  dy: number;
  size?: number;
  scale?: number;
  alpha: number;
  index?: number;
  objectId?: string | null;
}

export interface ObjectFx {
  shearX: number;
  dy: number;
  flap: number;
}

export interface PawTip {
  /** Front edge of the paw in native sprite pixels (origin top-left). */
  x: number;
  /** Mean centre row of the front-most opaque column, in native pixels. */
  y: number;
}

/** B8b: while Nori pushes the slipper she is drawn in the stretch pose. dx is a whole-pixel shift. */
export interface PushDraw {
  pose: 'stretch';
  facing: 1 | -1;
  dx: number;
}

export interface AnimState {
  scaleX: number;
  scaleY: number;
  dx: number;
  dy: number;
  rot: number;
  blink: number;
  shadowScale: number;
  overlays: Overlay[];
  objectFx: Record<string, ObjectFx>;
  /** B8b: null outside the push contact window. */
  push: PushDraw | null;
}

export declare function animState(
  segments: SegmentLike[],
  t: number,
  manifest: Manifest,
  paws?: Partial<Record<'stretch', PawTip>> | null,
): AnimState;

export declare function frontPawTip(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  nativeFacing: number,
): PawTip | null;

export declare function pushDraw(
  segments: SegmentLike[],
  t: number,
  manifest: Manifest,
  paws?: Partial<Record<'stretch', PawTip>> | null,
): PushDraw | null;

export default animState;
