import type { RainDrop, SnowFlake, WeatherInput } from "./cam-weather.js";

export type { RainDrop, SnowFlake, WeatherInput };

export declare const WX_CONDITIONS: readonly string[];

export interface WxParams {
  wx: string | null;
  night: boolean;
}

export declare function parseWxParams(
  search: string | URLSearchParams | null | undefined,
): WxParams;

export interface WeatherRowLike extends WeatherInput {
  hour_utc?: number;
  condition?: string;
  cloud_pct?: number;
  precip_mm?: number;
  is_day?: 0 | 1 | boolean;
}

export declare function selectWeatherRow(
  rows: readonly WeatherRowLike[] | null | undefined,
  wx: string | null | undefined,
  night: boolean,
): WeatherRowLike | null;

export type SkyPhase = "day" | "dusk" | "night";
export declare function skyPhase(w: WeatherRowLike | null | undefined): SkyPhase;

export interface SunPatch {
  allowed: boolean;
  alpha: number;
  dx: number;
  dy: number;
  x?: number;
  y?: number;
  polygon?: number[][] | null;
  brightness?: number;
}

export declare function sunPatchPlaceholder(
  t: number,
  w: WeatherRowLike | null | undefined,
): SunPatch;

export interface WindowRectLike {
  x: number;
  y: number;
  w?: number;
  h?: number;
  width?: number;
  height?: number;
}

export interface CloudCluster {
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

export declare function cloudClusters(
  cloud: number,
  t: number,
  rect: WindowRectLike,
): CloudCluster[];

export interface StarPoint {
  x: number;
  y: number;
  alpha: number;
}

export declare function starPoints(
  t: number,
  rect: WindowRectLike,
  cloud: number,
): StarPoint[];

export interface GlassDrop {
  x: number;
  y: number;
  len: number;
  alpha: number;
}

export declare function glassDrops(
  w: WeatherInput | null | undefined,
  t: number,
  rect: WindowRectLike,
  n?: number,
): GlassDrop[];

export interface WindowView {
  sky: SkyPhase;
  skyColor: string;
  cloud: number;
  rain: number;
  snow: number;
  fog: number;
  fogAlpha: number;
  flash: number;
  tint: [number, number, number, number];
  tintCss: string;
  clouds: CloudCluster[];
  stars: StarPoint[];
  rainDrops: RainDrop[];
  glassDrops: GlassDrop[];
  snowFlakes: SnowFlake[];
  sunPatch: SunPatch;
  light: { altitude: number; azimuth: number; morning: boolean; phase: string; intensity: number };
  sunPatchAt: { x: number; y: number; polygon: number[][]; brightness: number } | null;
}

export declare function windowView(
  w: WeatherInput | null | undefined,
  t: number,
  rect: WindowRectLike,
): WindowView;
