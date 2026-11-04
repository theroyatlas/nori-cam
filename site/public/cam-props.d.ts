export declare const OUTLINE: string;
export declare function setPropLook(look: string): string;
export declare function propLook(): string;
export declare const PROP_KINDS: string[];
export interface PropObject { id?: string; kind?: string; sprite?: string; x: number; y: number; z?: number; rotation?: number; status?: string; glow?: boolean; [k: string]: unknown }
export interface PropEnv { t?: number; activeAction?: string | null; activeTargetId?: string | null; activePrimitive?: string | null }
export interface DepthEntry { id: string; kind: string; layer: string; x: number; y: number; depth: number }
export declare function kindOf(obj: PropObject | null | undefined): string;
export declare function hasDrawPath(kind: string): boolean;
export declare function isInvisibleProp(obj: PropObject | null | undefined): boolean;
export declare function isPropVisible(obj: PropObject | null | undefined): boolean;
export declare function propLayers(obj: PropObject): string[];
export declare function depthLayerOf(obj: PropObject, layer: string): string;
export declare function pruneFloatingFragments(data: Uint8ClampedArray | Uint8Array, w: number, h: number): number;
export declare function buildDepthItems(objects: readonly PropObject[], noriPose: { x: number; y: number; z?: number; part?: string | null; targetX?: number; targetY?: number } | null): DepthEntry[];
export declare function drawPropBack(ctx: CanvasRenderingContext2D, obj: PropObject, env?: PropEnv): boolean;
export declare function drawPropFront(ctx: CanvasRenderingContext2D, obj: PropObject, env?: PropEnv): boolean;
export declare function drawProp(ctx: CanvasRenderingContext2D, obj: PropObject, env?: PropEnv): boolean;
export declare function drawPropLayer(ctx: CanvasRenderingContext2D, obj: PropObject, layer: string, env?: PropEnv): boolean;
export declare function drawCarriedProp(ctx: CanvasRenderingContext2D, obj: PropObject, sx: number, sy: number, env?: PropEnv): boolean;
export declare function interpolateObjects(objects: readonly PropObject[], segments: readonly unknown[], t: number, snapshotAt?: number): PropObject[];
export declare function isGiftSpriteURL(url: unknown): boolean;
export declare function giftSpriteImage(url: unknown): { image: HTMLImageElement | null; state: string } | null;
export declare function giftPosition(obj: PropObject): { x: number; y: number; z: number };
export declare function giftAnchor(obj: PropObject): { sx: number; sy: number; x: number; y: number };
