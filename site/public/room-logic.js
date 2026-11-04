/* Pure room helpers: ESM (vitest) and global NoriRoomLogic (browser module). */
'use strict';

const MEDIA_RE = /^\/media\/[A-Za-z0-9_.-]+\.(png|jpg|jpeg|webp)$/i;

export const ACTIVITY_LAYOUT = {
  sleeping: { sprite: 'sleep-pillow', left: 18, bottom: 8, width: 20 },
  reading: { sprite: 'laptop', left: 72, bottom: 5, width: 18 },
  browsing: { sprite: 'browse', left: 72, bottom: 5, width: 20 },
  watching: { sprite: 'watching', left: 72, bottom: 5, width: 18 },
  drawing: { sprite: 'sketch', left: 38, bottom: 10, width: 16 },
  posting: { sprite: 'phone-send', left: 45, bottom: 12, width: 14 },
  thinking: { sprite: 'ponder', left: 22, bottom: 10, width: 14 },
};

export const NORI_CLICK_SPRITES = ['wave', 'giggle', 'stretch', 'look-up', 'jump', 'sit'];
export const SLEEP_CLICK_SPRITE = 'sleepy';

export const CORK_PIN_SLOTS = [
  { left: 85.5, top: 16 },
  { left: 91, top: 16 },
  { left: 85.5, top: 28 },
  { left: 91, top: 28 },
];

export const DESKTOP_HOTSPOTS = {
  folder: { left: 6.25, top: 3.33, width: 5.94, height: 9.44, href: '/journal', label: 'Journal folder' },
  gear: { left: 6.125, top: 17.56, width: 5.75, height: 9.67, href: '/privacy', label: 'Settings' },
  document: { left: 6.25, top: 32.22, width: 5.31, height: 10.56, href: '/demo', label: 'Documents' },
  fish: { left: 15.625, top: 21.67, width: 21.25, height: 30, kind: 'fish', label: 'Latest drawing' },
  sticky: { left: 40.3125, top: 29.44, width: 20.3125, height: 32.22, kind: 'sticky', label: 'Last wake steps' },
  list: { left: 64.0625, top: 36.67, width: 21.5625, height: 33.89, kind: 'list', label: 'Latest post' },
  trash: { left: 88.125, top: 2.78, width: 5.3125, height: 10.56, kind: 'owner', label: 'Roommate corner' },
};

export function activityLayout(activity) {
  const key = activity && ACTIVITY_LAYOUT[activity] ? activity : 'sleeping';
  return { ...ACTIVITY_LAYOUT[key], activity: key };
}

export function backgroundForHour(hour) {
  const h = Number(hour);
  if (h >= 6 && h < 18) return 'day';
  return 'night';
}

export function safeMediaUrl(url) {
  const u = String(url || '').trim();
  return MEDIA_RE.test(u) ? u : '';
}

export function formatEditAction(op) {
  if (op === 'delete') return 'removed';
  if (op === 'neutralize') return 'set to neutral';
  if (op === 'restore') return 'restored';
  return String(op || 'changed');
}

export function formatEditLine(edit) {
  const op = edit && edit.op;
  return {
    action: formatEditAction(op),
    title: op === 'delete' ? '(removed — title not shown)' : String((edit && edit.title) || ''),
    told: edit && edit.told_at ? String(edit.told_at) : "Nori hasn't woken up since",
    event_id: String((edit && edit.event_id) || ''),
    ts: String((edit && edit.ts) || ''),
  };
}

export function unavailableDefaults() {
  return {
    available: false,
    activity: 'sleeping',
    banner: "Nori's live data is not available right now.",
  };
}

export function formatWakeStep(step) {
  const label = String((step && step.label) || 'Step');
  const title = step && step.title;
  let text = title ? `${label}: ${title}` : label;
  if (step && step.ok === false) text += " (couldn't)";
  return text;
}

export function activitySummary(activity) {
  const map = {
    sleeping: 'Nori is sleeping on the cushion.',
    reading: 'Nori is reading at the desk.',
    browsing: 'Nori is browsing at the desk.',
    watching: 'Nori is watching something at the desk.',
    drawing: 'Nori is sketching on the floor.',
    posting: 'Nori is sending a post from its phone.',
    thinking: 'Nori is thinking quietly.',
  };
  return map[activity] || map.sleeping;
}

export function moodBubbleSprite(valence, rand) {
  if (valence === 'positive') return rand < 0.5 ? 'love' : 'sparkle';
  if (valence === 'negative') return 'meh';
  return null;
}

export function pickClickSprite(isSleeping, index) {
  if (isSleeping) return SLEEP_CLICK_SPRITE;
  const i = Math.abs(Number(index) || 0) % NORI_CLICK_SPRITES.length;
  return NORI_CLICK_SPRITES[i];
}

export function formatLocalDateTime(iso, date) {
  if (!iso) return '';
  const d = date instanceof Date ? date : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) {
    return d.toISOString();
  }
}

export function spriteUrl(name) {
  return `/room/sprites/nori-${name}.png`;
}

export function roomBackgroundUrl(part) {
  return `/room/bg-${part}.jpg`;
}

const RECEIPT_RE = /^p\d+$/;

export function receiptHref(receipt) {
  const r = receipt == null ? '' : String(receipt);
  return RECEIPT_RE.test(r) ? '/posts#' + r : null;
}

export function projectStatusLabel(status) {
  if (status === 'active') return 'working on it';
  if (status === 'done') return 'finished';
  if (status === 'dropped') return 'set aside';
  return 'unknown';
}

export function projectsView(room) {
  const empty = { active: [], finished: [] };
  if (!room || typeof room !== 'object') return empty;
  const projects = room.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return empty;
  const rawActive = projects.active;
  const rawFinished = projects.finished;
  const active = Array.isArray(rawActive)
    ? rawActive.map((p) => {
        if (!p || typeof p !== 'object') return p;
        const steps = Array.isArray(p.steps) ? p.steps.slice().reverse() : [];
        return { ...p, steps };
      })
    : [];
  const finished = Array.isArray(rawFinished) ? rawFinished.slice() : [];
  return { active, finished };
}

const api = {
  ACTIVITY_LAYOUT,
  NORI_CLICK_SPRITES,
  SLEEP_CLICK_SPRITE,
  CORK_PIN_SLOTS,
  DESKTOP_HOTSPOTS,
  activityLayout,
  backgroundForHour,
  safeMediaUrl,
  formatEditAction,
  formatEditLine,
  unavailableDefaults,
  formatWakeStep,
  activitySummary,
  moodBubbleSprite,
  pickClickSprite,
  formatLocalDateTime,
  spriteUrl,
  roomBackgroundUrl,
  receiptHref,
  projectStatusLabel,
  projectsView,
};

export default api;

if (typeof globalThis !== 'undefined') {
  globalThis.NoriRoomLogic = api;
}
