export declare const WEATHER_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)";

export type WeatherConditionName =
  | "clear"
  | "cloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunder";

export interface ThunderStartleEvent {
  at_ms: number;
  kind: "thunder";
}

export interface WeatherInput {
  hour_utc?: number;
  condition?: WeatherConditionName | string;
  temp_c?: number | null;
  cloud_pct?: number;
  precip_mm?: number;
  wind_kph?: number;
  is_day?: 0 | 1 | boolean;
  source?: string;
  startleEvents?: ThunderStartleEvent[];
  effects?: {
    cozyBoost?: number;
    sunPatchAllowed?: boolean;
    startleEvents?: ThunderStartleEvent[];
  };
}

export interface WeatherVisual {
  sky: "day" | "night";
  cloud: number;
  rain: number;
  snow: number;
  fog: number;
  flash: number;
  tint: [number, number, number, number];
}

export type WindowRect =
  | { x: number; y: number; w: number; h: number; width?: number; height?: number }
  | { x: number; y: number; width: number; height: number; w?: number; h?: number };

export interface RainDrop {
  x: number;
  y: number;
  len: number;
  alpha: number;
}

export interface SnowFlake {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

export declare function thunderStartleEvents(hourUtc: number): ThunderStartleEvent[];
export declare function weatherVisual(w: WeatherInput | null | undefined, t: number): WeatherVisual;
export declare function rainDrops(
  w: WeatherInput | null | undefined,
  t: number,
  rect: WindowRect,
  n?: number,
): RainDrop[];
export declare function snowFlakes(
  w: WeatherInput | null | undefined,
  t: number,
  rect: WindowRect,
  n?: number,
): SnowFlake[];
