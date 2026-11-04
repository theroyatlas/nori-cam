declare const api: {
  ACTIVITY_LAYOUT: Record<string, { sprite: string; left: number; bottom: number; width: number }>;
  NORI_CLICK_SPRITES: string[];
  SLEEP_CLICK_SPRITE: string;
  CORK_PIN_SLOTS: { left: number; top: number }[];
  DESKTOP_HOTSPOTS: Record<
    string,
    { left: number; top: number; width: number; height: number; href?: string; label: string; kind?: string }
  >;
  activityLayout: (activity: string) => { sprite: string; left: number; bottom: number; width: number; activity: string };
  backgroundForHour: (hour: number) => 'day' | 'night';
  safeMediaUrl: (url: string) => string;
  formatEditAction: (op: string) => string;
  formatEditLine: (edit: {
    ts?: string;
    op?: string;
    event_id?: string;
    title?: string | null;
    told_at?: string | null;
  }) => { action: string; title: string; told: string; event_id: string; ts: string };
  unavailableDefaults: () => { available: boolean; activity: string; banner: string };
  formatWakeStep: (step: { label?: string; title?: string | null; ok?: boolean }) => string;
  activitySummary: (activity: string) => string;
  moodBubbleSprite: (valence: string, rand: number) => string | null;
  pickClickSprite: (isSleeping: boolean, index: number) => string;
  formatLocalDateTime: (iso: string, date?: Date) => string;
  spriteUrl: (name: string) => string;
  roomBackgroundUrl: (part: string) => string;
  receiptHref: (receipt: string | null | undefined) => string | null;
  projectStatusLabel: (status: string) => string;
  projectsView: (room: unknown) => {
    active: unknown[];
    finished: unknown[];
  };
};

export default api;
export function activityLayout(activity: string): ReturnType<typeof api.activityLayout>;
export function backgroundForHour(hour: number): 'day' | 'night';
export function safeMediaUrl(url: string): string;
export function formatEditLine(edit: Parameters<typeof api.formatEditLine>[0]): ReturnType<typeof api.formatEditLine>;
export function unavailableDefaults(): ReturnType<typeof api.unavailableDefaults>;
export function formatWakeStep(step: Parameters<typeof api.formatWakeStep>[0]): string;
export function receiptHref(receipt: string | null | undefined): string | null;
export function projectStatusLabel(status: string): string;
export function projectsView(room: unknown): ReturnType<typeof api.projectsView>;
