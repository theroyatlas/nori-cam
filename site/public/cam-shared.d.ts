export declare const TILE_W: number;
export declare const TILE_H: number;
export declare const ORIGIN_X: number;
export declare const ORIGIN_Y: number;
export declare const POSES: string[];
export interface Projected {
    sx: number;
    sy: number;
    x: number;
    y: number;
}
export declare function project(x: number, y: number, z?: number): Projected;
export interface SegmentLike {
    z_from?: number;
    z_to?: number;
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
    carrying?: string | null;
    effects?: unknown;
    cut_at?: number | null;
}
export interface PoseAtResult {
    x: number;
    y: number;
    z: number;
    pose: string;
    facing: number;
    segmentId: number;
    action: string;
    primitive: string | null;
    target: string | null;
    part: string | null;
    hop: number;
    distance: number;
}
export declare function poseAt(segments: SegmentLike[], t: number): PoseAtResult | null;
export interface DepthItem {
    z?: number;
    x: number;
    y: number;
    layer?: string | null;
    depthLayer?: string | null;
    part?: string | null;
    targetX?: number;
    targetY?: number;
    targetPos?: {
        x: number;
        y: number;
    };
}
export declare function depthKey(item: DepthItem): number;
import type { CamObject, GeometryWorld, Cell, Segment, Weather } from '../src/worker/cam/types.ts';
export declare const TAGS: string[], SENSATIONS: import('../src/worker/cam/types.ts').Sensation[], PARTS: string[],
  ACTIONS: string[], GENERIC_POSES: string[], EFFECTS: string[], PRIMITIVES: string[], EVENT_TYPES: string[];
export declare const EXECUTOR: Readonly<Record<string, {
    poses: string[];
    min_ms: number;
    max_ms: number;
    speeds?: Record<string, number>;
}>>;
export declare function hazardActiveInState(card: { states?: string[]; hazards?: { states?: string[] }[] } | undefined | null, state: string): boolean;
export declare function cellsOf(object: CamObject): Cell[];
export declare function walkable(world: GeometryWorld): Cell[];
export declare function bfsPath(world: GeometryWorld, from: Cell, to: Cell): Cell[] | null;
export declare function operationCells(object: CamObject, part: string | undefined, world: GeometryWorld): Cell[];
export declare function placementOk(world: GeometryWorld, object: CamObject, cells?: Cell[]): {
    ok: boolean;
    status: number;
    reason: string | null;
};
export declare function applyEffects(objects: CamObject[], segments: Segment[], t: number): CamObject[];
export declare function lightAt(t: number, weather?: Weather): {
    altitude: number;
    azimuth: number;
    morning: boolean;
    phase: string;
    intensity: number;
};
export declare function sunPatchAt(t: number, weather?: Weather): {
    x: number;
    y: number;
    polygon: Cell[];
    brightness: number;
} | null;
export declare function sunCovers(t: number, cell: Cell, weather?: Weather): boolean;
