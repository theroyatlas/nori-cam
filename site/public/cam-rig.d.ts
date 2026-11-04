// Types for cam-rig.js (B3 cutout rig, spec 19 E2).
export declare const RIG_GOOD_POSES: string[];
export declare const GOOD_POSES: string[];
export declare function isRigPose(pose: string): boolean;
export declare function hashSegId(id: number): number;
export interface SizeLike { w: number; h: number }
export declare function mapPoint(point: [number, number], source: SizeLike, target: SizeLike): [number, number];
export declare function mapPolygon(polygon: [number, number][], source: SizeLike, target: SizeLike): [number, number][];
export declare function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean;
export interface RigPart { name: string; polygon: [number, number][]; pivot: [number, number]; z: number; limits?: { rot_deg_max: number; dx_max: number; dy_max: number } }
export declare function sortedParts(rigEntry: unknown): RigPart[];
export declare function alphaOn(v: number): number;
export interface EarMotion { dx: number; dy: number; flatten: number; rotDeg: number; active: boolean }
export interface RigMotion {
  enabled: boolean; tailAngleDeg: number; tailRotDeg: number; tailMaxDeg: number; tailPeriodMs: number;
  earL: EarMotion; earR: EarMotion; ear: string | null; earPeriodMs?: number;
  headBobPx: number; headDy: number; headRotDeg: number;
}
export declare function rigMotion(pose: string, t: number, segId: number, rigEntry?: unknown, opts?: { alert?: boolean; action?: string } | string): RigMotion;
export default rigMotion;
