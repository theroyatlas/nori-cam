// Types for cam-gift.js (C2 "Give Nori a gift" panel, frontend only).

export declare const GIFT_KINDS: string[];
export declare const GIFT_LABELS: Record<string, string>;
export declare const CATALOG_URL: string;
export declare const PHOTO_URL: string;
export declare const PHOTO_MAX_BYTES: number;
export declare const PHOTO_TYPES: string[];

export declare function isValidIdem(value: unknown): boolean;
export declare function newIdem(): string;

export interface IdemStore {
  get(key: string): string;
  reset(key: string): void;
}
export declare function createIdemStore(): IdemStore;

export declare function isCleanMode(search: string | URLSearchParams | null | undefined): boolean;

export interface PhotoFileLike {
  type?: string;
  size?: number;
}
export interface PhotoCheck {
  ok: boolean;
  reason: 'missing' | 'type' | 'size' | null;
}
export declare function checkPhotoFile(file: PhotoFileLike | null | undefined): PhotoCheck;
export declare function fileProblemText(reason: PhotoCheck['reason'] | string): string;

export interface CatalogRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
export declare function catalogRequest(kind: string, idem: string): CatalogRequest;

export interface PhotoRequestParts {
  url: string;
  method: string;
}
export declare function photoRequestParts(): PhotoRequestParts;
export declare function buildPhotoForm(file: Blob, idem: string): FormData;

export declare function friendlyError(status: number, workerError?: unknown): string;
export declare function sentText(photo: boolean): string;

export interface GiftResult {
  ok: boolean;
  status: number;
  giftId: string | null;
  giftStatus: string | null;
  message: string;
}
export declare function interpretGiftResponse(res: Response, photo: boolean): Promise<GiftResult>;
export declare function postCatalogGift(
  kind: string,
  idem: string,
  fetchFn?: typeof fetch,
): Promise<GiftResult>;
export declare function postPhotoGift(
  file: Blob,
  idem: string,
  code: string,
  fetchFn?: typeof fetch,
): Promise<GiftResult>;

export declare const STATUS_URL_PREFIX: string;
export declare const STATUS_POLL_MS: number;
export declare const STATUS_POLL_MAX_MS: number;
export declare const STATUS_WORKING_TEXT: string;
export declare const STATUS_TIMEOUT_TEXT: string;
export declare function giftStatusUrl(giftId: string): string;
export declare function isGiftSpriteUrl(value: unknown): boolean;
export declare function failedGiftText(reason: unknown): string;
export declare function giftProgressText(status: unknown, name: unknown, reason: unknown): string;

export interface GiftStatusBody {
  gift_id: string;
  status: string;
  name: string | null;
  sprite: string | null;
  reason: string | null;
  updated_at: number;
}
export interface GiftStatusPoll {
  start(): void;
  stop(): void;
  readonly stopped: boolean;
}
export declare function createGiftStatusPoll(options: {
  giftId: string;
  fetchFn?: typeof fetch;
  onUpdate: (body: GiftStatusBody | null, done: boolean) => void;
  intervalMs?: number;
  maxMs?: number;
  nowFn?: () => number;
}): GiftStatusPoll;

export interface GiftPanel {
  open(): void;
  close(): void;
  panel: HTMLElement;
  openBtn: HTMLButtonElement;
}
export declare function initGiftPanel(host?: Document): GiftPanel | null;
