export declare const BASE_OUTLINE: string;
export declare const LOOKS: string[];
export declare const DEFAULT_LOOK: string;
export declare const PRODUCT_LOOK: string;
export declare function parseLook(value: unknown): string;
export declare function parseLookParams(search: { get(k: string): string | null } | string | null | undefined): { look: string; catReal: boolean; catMid: boolean };
export declare function mix(hexA: string, hexB: string, t: number): string;
export declare function shade(hex: string, f: number): string;
export declare function outlineFor(look: string, localFill: string, base?: string): string;
export declare const PALETTE_OVERRIDES: Record<string, Record<string, string>>;
export declare function paletteFor<T extends Record<string, string>>(look: string, basePAL: T): T;
export interface LookLight { day: number; night: number; dust: number; block: number }
export declare const LIGHT: Record<string, LookLight>;
export declare function lightFor(look: string): LookLight;
export interface LookDecorAnchor { id: string; wall: string; along0: number; along1: number; hBot: number; hTop: number }
export declare const EXTRA_DECOR: readonly LookDecorAnchor[];
export declare function extraDecorFor(look: string): readonly LookDecorAnchor[];
export declare const CAT_REAL_SCALE: number;
export declare const CAT_MID_SCALE: number;
export declare const CAT_DEFAULT_SCALE: number;
export declare function catScaleFor(catReal: boolean | 'mid', catMid?: boolean): number;
export declare function poolScaleFor(look: string): number;
export declare function dayWashFor(look: string): string | null;
export declare function patchColorFor(look: string): [number, number, number];
