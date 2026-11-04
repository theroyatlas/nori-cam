// cam-gift.js — "Give Nori a gift" panel for the cam page.
//
// Frontend only: this module talks to the existing Worker gift endpoints
// (POST /api/gift and POST /api/gift/photo) and never touches Worker code.
//
// Progress note: catalog gifts appear in /api/cam right away; photo gifts
// first land as a parcel, then the pipeline understands and draws them.
// The panel follows a photo gift through GET /api/gift/status/<gift_id>
// (processing -> ready/placed/failed) and stops polling on a terminal
// status, the next submission, the page hiding, or after four minutes.
//
// Pure helpers are exported for tests. DOM wiring runs only in a browser,
// only when the URL does not carry clean=1, and only via this module's own
// <script type="module" src="/cam-gift.js"> tag (never imported by cam.js).

export const GIFT_KINDS = ['cardboard_box', 'slipper', 'toy', 'cushion'];

export const GIFT_LABELS = {
  cardboard_box: 'Box',
  slipper: 'Slipper',
  toy: 'Toy',
  cushion: 'Cushion',
};

export const CATALOG_URL = '/api/gift';
export const PHOTO_URL = '/api/gift/photo';

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png'];

// Mirrors the Worker's identifier() rule: /^[A-Za-z0-9_-]{1,128}$/.
const IDEM_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidIdem(value) {
  return typeof value === 'string' && IDEM_RE.test(value);
}

// A fresh random identifier per submission. Same shape as the Worker's
// randomId(): 16 random bytes rendered as 32 hex chars.
export function newIdem() {
  const bytes = new Uint8Array(16);
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      throw new Error('no crypto');
    }
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One idem per submission key. Retries of the same submission reuse the
// idem (so a retry never creates a second gift); a reset starts a new one.
export function createIdemStore() {
  const pending = new Map();
  return {
    get(key) {
      let idem = pending.get(key);
      if (!isValidIdem(idem)) {
        idem = newIdem();
        pending.set(key, idem);
      }
      return idem;
    },
    reset(key) {
      pending.delete(key);
    },
  };
}

export function isCleanMode(search) {
  try {
    const params = typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      : search;
    return params != null && params.get('clean') === '1';
  } catch {
    return false;
  }
}

export function checkPhotoFile(file) {
  if (!file) return { ok: false, reason: 'missing' };
  if (!PHOTO_TYPES.includes(file.type)) return { ok: false, reason: 'type' };
  if (typeof file.size !== 'number' || file.size > PHOTO_MAX_BYTES) return { ok: false, reason: 'size' };
  return { ok: true, reason: null };
}

export function fileProblemText(reason) {
  if (reason === 'type') return 'Photos need to be JPEG or PNG.';
  if (reason === 'size') return 'That photo is over 5 MB — pick a smaller one.';
  return 'Choose a JPEG or PNG photo first.';
}

export function catalogRequest(kind, idem) {
  return {
    url: CATALOG_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalog_key: kind, idem }),
  };
}

export function photoRequestParts() {
  // The code travels in the X-Nori-Code header (set at send time), never
  // in this URL or in the multipart body.
  return { url: PHOTO_URL, method: 'POST' };
}

export function buildPhotoForm(file, idem) {
  const form = new FormData();
  form.set('file', file);
  form.set('idem', idem);
  return form;
}

// Short, friendly text for an HTTP status plus the Worker's error message.
export function friendlyError(status, workerError) {
  const err = typeof workerError === 'string' ? workerError : '';
  if (status === 429) {
    if (/one gift per|london day/i.test(err)) return 'One gift per day — try again tomorrow.';
    return 'Nori is swimming in gifts — try again later.';
  }
  switch (status) {
    case 401:
      return "That code didn't work — check it and try again.";
    case 409:
      if (err === 'no legal gift cell') return "Nori's room is full right now. Please try again later.";
      if (/already exists|idempotency/i.test(err)) return 'Already sent — watch the room.';
      return "Couldn't send that — try again.";
    case 413:
      return 'That photo is over 5 MB — pick a smaller one.';
    case 415:
      return 'Photos need to be JPEG or PNG.';
    case 503:
      return 'Photo gifts are off right now — try a catalog gift.';
    case 400:
      if (/catalog/i.test(err)) return 'Unknown gift — choose one from the shelf.';
      if (/identifier/i.test(err)) return 'Something went wrong — reopen the panel and try again.';
      return 'Nori could not take that — try again.';
    default:
      break;
  }
  if (status >= 500) return 'Nori is napping (server hiccup) — try again.';
  return "Couldn't send that — try again.";
}

export function sentText(photo) {
  if (photo) return 'Photo sent — watch the room while Nori unwraps it.';
  return 'Sent — watch the room, Nori will explore it.';
}

export async function interpretGiftResponse(res, photo) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) {
    return {
      ok: true,
      status: res.status,
      giftId: body && typeof body.gift_id === 'string' ? body.gift_id : null,
      giftStatus: body && typeof body.status === 'string' ? body.status : null,
      message: sentText(photo),
    };
  }
  const err = body && typeof body.error === 'string' ? body.error : '';
  return { ok: false, status: res.status, giftId: null, giftStatus: null, message: friendlyError(res.status, err) };
}

export async function postCatalogGift(kind, idem, fetchFn) {
  const send = fetchFn || globalThis.fetch;
  const req = catalogRequest(kind, idem);
  let res;
  try {
    res = await send(req.url, { method: req.method, headers: req.headers, body: req.body });
  } catch {
    return { ok: false, status: 0, giftId: null, giftStatus: null, message: 'No connection — try again.' };
  }
  return interpretGiftResponse(res, false);
}

export async function postPhotoGift(file, idem, code, fetchFn) {
  const send = fetchFn || globalThis.fetch;
  const req = photoRequestParts();
  const form = buildPhotoForm(file, idem);
  let res;
  try {
    res = await send(req.url, { method: req.method, headers: { 'X-Nori-Code': code }, body: form });
  } catch {
    return { ok: false, status: 0, giftId: null, giftStatus: null, message: 'No connection — try again.' };
  }
  return interpretGiftResponse(res, true);
}

// --- Photo-gift progress (GET /api/gift/status/<gift_id>) ---

export const STATUS_URL_PREFIX = '/api/gift/status/';
export const STATUS_POLL_MS = 3000;
export const STATUS_POLL_MAX_MS = 4 * 60 * 1000;

export const STATUS_WORKING_TEXT = 'Nori is looking at your photo...';
export const STATUS_TIMEOUT_TEXT = 'Still working - keep watching the room.';

export function giftStatusUrl(giftId) {
  return `${STATUS_URL_PREFIX}${giftId}`;
}

// Only a same-origin /media/ PNG is ever shown as a gift sprite.
// Anything else (remote URLs, other paths or file types) is ignored.
export function isGiftSpriteUrl(value) {
  return typeof value === 'string' && /^\/media\/[^/\\?#]+\.png$/.test(value);
}

// One friendly line per public failure reason code from the status endpoint.
export function failedGiftText(reason) {
  switch (reason) {
    case 'content_refused':
      return 'Nori had to pass on that photo — try one without people in it.';
    case 'draw_failed':
      return "Nori couldn't draw that photo — try a clearer one.";
    case 'timeout':
      return 'Nori ran out of time on that photo — try sending it again.';
    default:
      return "That photo didn't work out — try sending it again.";
  }
}

export function giftProgressText(status, name, reason) {
  switch (status) {
    case 'ready':
    case 'placed':
      return typeof name === 'string' && name ? `${name} is in the room!` : 'Your gift is in the room!';
    case 'failed':
      return failedGiftText(reason);
    default:
      return STATUS_WORKING_TEXT;
  }
}

// Polls the status endpoint until the gift reaches a terminal status
// (ready, placed or failed), the deadline passes, or stop() is called
// (the panel's next submission, or the page hiding). onUpdate receives
// (body, done); body is null only when the deadline passed first.
export function createGiftStatusPoll({ giftId, fetchFn, onUpdate, intervalMs, maxMs, nowFn }) {
  const send = fetchFn || globalThis.fetch;
  const every = intervalMs ?? STATUS_POLL_MS;
  const span = maxMs ?? STATUS_POLL_MAX_MS;
  const clock = nowFn || (() => Date.now());
  const url = giftStatusUrl(giftId);
  let stopped = true;
  let timerId = null;
  let deadline = 0;
  async function pollOnce() {
    if (stopped) return;
    let body = null;
    try {
      const res = await send(url);
      if (res.ok) body = await res.json();
    } catch {
      body = null;
    }
    if (stopped) return;
    if (body && typeof body === 'object' && typeof body.status === 'string') {
      const terminal = body.status === 'ready' || body.status === 'placed' || body.status === 'failed';
      onUpdate(body, terminal);
      if (terminal) {
        stop();
        return;
      }
    }
    if (clock() >= deadline) {
      onUpdate(null, true);
      stop();
      return;
    }
    timerId = setTimeout(pollOnce, every);
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    deadline = clock() + span;
    void pollOnce();
  }
  function stop() {
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }
  return { start, stop, get stopped() { return stopped; } };
}

// --- DOM wiring (browser only; not exercised by tests) ---

const CODE_SESSION_KEY = 'nori-gift-code';

function loadCode() {
  try {
    return sessionStorage.getItem(CODE_SESSION_KEY) || '';
  } catch {
    return '';
  }
}

function saveCode(code) {
  try {
    if (code) sessionStorage.setItem(CODE_SESSION_KEY, code);
    else sessionStorage.removeItem(CODE_SESSION_KEY);
  } catch {
    // Private mode etc: the in-memory copy below still works for the visit.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function initGiftPanel(host) {
  const doc = host || document;
  if (isCleanMode(new URLSearchParams(window.location.search))) return null;
  if (doc.getElementById('nori-gift-open')) return null;

  const idems = createIdemStore();
  let photoCode = loadCode();
  let previewUrl = null;
  let busy = false;
  let statusPoll = null;

  const openBtn = el('button', 'nori-gift-open', 'Give Nori a gift');
  openBtn.id = 'nori-gift-open';
  openBtn.type = 'button';
  openBtn.setAttribute('aria-haspopup', 'dialog');
  openBtn.setAttribute('aria-expanded', 'false');
  openBtn.setAttribute('aria-controls', 'nori-gift-panel');

  const panel = el('section', 'nori-gift-panel');
  panel.id = 'nori-gift-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'nori-gift-title');
  panel.hidden = true;

  const head = el('div', 'nori-gift-head');
  const title = el('h2', 'nori-gift-title', 'Give Nori a gift');
  title.id = 'nori-gift-title';
  const closeBtn = el('button', 'nori-gift-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close gift panel');
  head.append(title, closeBtn);

  const hint = el('p', 'nori-gift-hint', 'Leave one gift a day. Nori decides when to investigate.');
  const grid = el('div', 'nori-gift-grid');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Catalog gifts');
  const kindButtons = GIFT_KINDS.map((kind) => {
    const btn = el('button', 'nori-gift-kind', GIFT_LABELS[kind]);
    btn.type = 'button';
    btn.dataset.kind = kind;
    grid.append(btn);
    return btn;
  });

  const codeLabel = el('label', 'nori-gift-label', 'Code (for photo gifts)');
  const codeInput = el('input', 'nori-gift-input');
  codeInput.type = 'password';
  codeInput.autocomplete = 'off';
  codeInput.value = photoCode;
  codeLabel.append(codeInput);

  const fileLabel = el('label', 'nori-gift-label', 'Your photo (JPEG/PNG, max 5 MB)');
  const fileInput = el('input', 'nori-gift-input');
  fileInput.type = 'file';
  fileInput.accept = PHOTO_TYPES.join(',');
  fileLabel.append(fileInput);

  const preview = el('img', 'nori-gift-preview');
  preview.alt = 'Preview of your photo gift';
  preview.hidden = true;

  const sendBtn = el('button', 'nori-gift-send', 'Send photo');
  sendBtn.type = 'button';

  const statusSprite = el('img', 'nori-gift-status-sprite');
  statusSprite.alt = '';
  statusSprite.hidden = true;
  const statusLine = el('p', 'nori-gift-status');
  statusLine.setAttribute('aria-live', 'polite');
  statusLine.setAttribute('role', 'status');

  const photoSection = el('details', 'nori-gift-photo');
  const photoSummary = el('summary', '', 'Photo gifts · owner / judge');
  photoSection.append(photoSummary, codeLabel, fileLabel, preview, sendBtn);
  panel.append(head, hint, grid, photoSection, statusLine, statusSprite);
  doc.body.append(openBtn, panel);

  const senders = [...kindButtons, sendBtn];
  function setBusy(value) {
    busy = value;
    for (const btn of senders) btn.disabled = value;
  }
  function setStatus(text) {
    statusLine.textContent = text;
  }
  function stopStatusPoll() {
    if (statusPoll) {
      statusPoll.stop();
      statusPoll = null;
    }
  }
  function hideStatusSprite() {
    statusSprite.hidden = true;
    statusSprite.removeAttribute('src');
    statusSprite.alt = '';
  }
  function showStatusBody(body) {
    if (!body) {
      setStatus(STATUS_TIMEOUT_TEXT);
      return;
    }
    setStatus(giftProgressText(body.status, body.name, body.reason));
    if(body.status==='ready'||body.status==='placed') signalWorldChange();
    if ((body.status === 'ready' || body.status === 'placed') && isGiftSpriteUrl(body.sprite)) {
      statusSprite.src = body.sprite;
      statusSprite.alt = typeof body.name === 'string' && body.name ? body.name : "Nori's new gift";
      statusSprite.hidden = false;
    } else {
      hideStatusSprite();
    }
  }
  function signalWorldChange(){
    const view=doc.defaultView;
    if(view?.Event) view.dispatchEvent(new view.Event('nori-world-changed'));
  }
  function revokePreview() {
    // previewUrl is a token for the latest FileReader; clearing it drops late results.
    previewUrl = null;
    preview.hidden = true;
    preview.removeAttribute('src');
  }

  function open() {
    panel.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
    (kindButtons[0] || closeBtn).focus();
  }
  function close() {
    panel.hidden = true;
    openBtn.setAttribute('aria-expanded', 'false');
    revokePreview();
    openBtn.focus();
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) stopStatusPoll();
  });
  openBtn.addEventListener('click', () => {
    if (panel.hidden) open();
    else close();
  });
  closeBtn.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  codeInput.addEventListener('input', () => {
    photoCode = codeInput.value;
    saveCode(photoCode);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    revokePreview();
    if (!file) return;
    const check = checkPhotoFile(file);
    if (!check.ok) {
      setStatus(fileProblemText(check.reason));
      return;
    }
    // A new file is a new submission: retrying it must not reuse the old one.
    idems.reset('photo');
    // The page CSP allows img-src data: but not blob:, so preview through a data URL (file is <= 5 MB).
    const token = {};
    previewUrl = token;
    const reader = new FileReader();
    reader.onload = () => {
      if (previewUrl !== token || typeof reader.result !== 'string') return;
      preview.src = reader.result;
      preview.hidden = false;
    };
    reader.readAsDataURL(file);
    setStatus('');
  });

  for (const btn of kindButtons) {
    btn.addEventListener('click', async () => {
      if (busy) return;
      stopStatusPoll();
      hideStatusSprite();
      const kind = btn.dataset.kind;
      const idem = idems.get(`catalog:${kind}`);
      setBusy(true);
      setStatus('Sending…');
      const result = await postCatalogGift(kind, idem);
      setBusy(false);
      setStatus(result.message);
      if (result.ok) { idems.reset(`catalog:${kind}`);signalWorldChange(); }
    });
  }

  sendBtn.addEventListener('click', async () => {
    if (busy) return;
    const file = fileInput.files && fileInput.files[0];
    const check = checkPhotoFile(file);
    if (!check.ok) {
      setStatus(fileProblemText(check.reason));
      return;
    }
    if (!photoCode) {
      setStatus('Enter your code first.');
      codeInput.focus();
      return;
    }
    stopStatusPoll();
    hideStatusSprite();
    const idem = idems.get('photo');
    setBusy(true);
    setStatus('Sending…');
    const result = await postPhotoGift(file, idem, photoCode);
    setBusy(false);
    setStatus(result.message);
    if (result.ok) {
      idems.reset('photo');
      revokePreview();
      fileInput.value = '';
      if (result.giftId) {
        setStatus(STATUS_WORKING_TEXT);
        statusPoll = createGiftStatusPoll({
          giftId: result.giftId,
          onUpdate: (body, done) => {
            showStatusBody(body);
            if (done) statusPoll = null;
          },
        });
        statusPoll.start();
      }
    }
  });

  return { open, close, panel, openBtn };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (!isCleanMode(window.location.search) && !new URLSearchParams(window.location.search).has('replayFrom')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initGiftPanel(document));
    } else {
      initGiftPanel(document);
    }
  }
}
