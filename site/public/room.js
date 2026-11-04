/* Home page: Nori's room scene, Right now card, Roommate's corner. */
import * as L from '/room-logic.js';

const { esc, getData } = window.Nori;

/** @type {{ room: any, owner: any, available: boolean, clickIndex: number, clickTimer: number|null, moodTimer: number|null, lastFocus: HTMLElement|null, overlay: HTMLElement|null }} */
const state = {
  room: null,
  owner: null,
  available: true,
  clickIndex: 0,
  clickTimer: null,
  moodTimer: null,
  lastFocus: null,
  overlay: null,
};

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function localHour() {
  return new Date().getHours();
}

function bgPart() {
  return L.backgroundForHour(localHour());
}

function currentActivity() {
  if (!state.available || !state.room) return 'sleeping';
  return state.room.activity || 'sleeping';
}

function layout() {
  return L.activityLayout(currentActivity());
}

function drawings() {
  if (!state.room || !Array.isArray(state.room.drawings)) return [];
  return state.room.drawings.slice(0, 12);
}

function closeOverlay() {
  if (state.overlay) {
    state.overlay.remove();
    state.overlay = null;
  }
  document.body.classList.remove('room-overlay-open');
  document.removeEventListener('keydown', onOverlayKey);
  const back = state.lastFocus;
  state.lastFocus = null;
  if (back && typeof back.focus === 'function') back.focus();
}

function onOverlayKey(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeOverlay();
  }
}

// The site's CSP (style-src 'self') ignores style="..." in markup, so positions travel as data-pos and are set through
// the CSSOM, which the CSP allows.
function applyPos(container) {
  container.querySelectorAll('[data-pos]').forEach((el) => {
    el.getAttribute('data-pos').split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    });
  });
}

function openOverlay(className, title, innerHtml, trigger) {
  closeOverlay();
  state.lastFocus = trigger || null;
  const el = document.createElement('div');
  el.className = 'room-overlay ' + className;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', title);
  el.innerHTML =
    '<div class="room-overlay-backdrop" data-close="1"></div>' +
    '<div class="room-overlay-panel">' +
    '<header class="room-overlay-head">' +
    '<h2 class="room-overlay-title">' +
    esc(title) +
    '</h2>' +
    '<button type="button" class="room-overlay-close" aria-label="Close">×</button>' +
    '</header>' +
    '<div class="room-overlay-body">' +
    innerHtml +
    '</div></div>';
  document.body.appendChild(el);
  applyPos(el);
  state.overlay = el;
  document.body.classList.add('room-overlay-open');
  document.addEventListener('keydown', onOverlayKey);
  el.querySelector('.room-overlay-close')?.addEventListener('click', closeOverlay);
  el.querySelector('[data-close="1"]')?.addEventListener('click', closeOverlay);
  /** @type {HTMLElement|null} */
  const closeBtn = el.querySelector('.room-overlay-close');
  closeBtn?.focus();
}

function renderCorkPins() {
  const list = drawings().slice(0, 4);
  if (!list.length) return '';
  return list
    .map((d, i) => {
      const slot = L.CORK_PIN_SLOTS[i] || L.CORK_PIN_SLOTS[0];
      const src = L.safeMediaUrl(d.image);
      if (!src) return '';
      return (
        '<img class="room-cork-pin pixel" src="' +
        esc(src) +
        '" alt="" width="48" height="48" data-pos="left:' +
        slot.left +
        '%;top:' +
        slot.top +
        '%" />'
      );
    })
    .join('');
}

function renderNoriSprite() {
  const lay = layout();
  const breathe = prefersReducedMotion() ? '' : ' room-breathe';
  return (
    '<img class="room-nori-sprite pixel' +
    breathe +
    '" src="' +
    esc(L.spriteUrl(lay.sprite)) +
    '" alt="" />'
  );
}

function renderScene() {
  const bg = L.roomBackgroundUrl(bgPart());
  const lay = layout();
  return (
    '<section class="room-block" aria-labelledby="room-heading">' +
    '<h2 id="room-heading" class="sr">Nori&rsquo;s room</h2>' +
    '<div class="room-scene" id="room-scene">' +
    '<img class="room-bg pixel" src="' +
    esc(bg) +
    '" alt="" width="1600" height="900" />' +
    renderCorkPins() +
    '<div class="room-nori-wrap" data-pos="left:' +
    lay.left +
    '%;bottom:' +
    lay.bottom +
    '%;width:' +
    lay.width +
    '%">' +
    '<span class="room-mood-bubble" id="room-mood-bubble" hidden></span>' +
    renderNoriSprite() +
    '</div>' +
    '<button type="button" class="room-hotspot room-hotspot-window" data-pos="left:3%;top:2%;width:18%;height:64%" aria-label="Window — when Nori wakes next"></button>' +
    '<button type="button" class="room-hotspot room-hotspot-cork" data-pos="left:84%;top:14%;width:13%;height:33%" aria-label="Corkboard — Nori\'s drawings"></button>' +
    '<button type="button" class="room-hotspot room-hotspot-laptop" data-pos="left:75%;top:55%;width:10%;height:11%" aria-label="Laptop — Nori\'s screen"></button>' +
    '<button type="button" class="room-hotspot room-hotspot-nori" data-pos="left:' +
    (lay.left - 2) +
    '%;bottom:' +
    (lay.bottom - 2) +
    '%;width:' +
    (lay.width + 4) +
    '%;height:22%" aria-label="Nori — tap for a reaction"></button>' +
    '</div>' +
    '<p class="hint room-look">Nori&rsquo;s look was drawn by the author with ChatGPT image generation. The room and Nori&rsquo;s own pictures are drawn by Meta muse-image-1.0.</p>' +
    '</section>'
  );
}

function renderRightNow() {
  const unavail = L.unavailableDefaults();
  if (!state.available) {
    return (
      '<section class="card room-right-now" aria-labelledby="right-now-heading">' +
      '<h2 id="right-now-heading">Right now</h2>' +
      '<p>' +
      esc(unavail.banner) +
      '</p></section>'
    );
  }
  const room = state.room;
  const mood = room.mood || {};
  const post = room.latest_post || {};
  const counts = room.counts || {};
  const steps = (room.last_wake && room.last_wake.steps) || [];
  const stepItems = steps.map((s) => '<li>' + esc(L.formatWakeStep(s)) + '</li>').join('');
  const receipt = post.receipt
    ? '<a href="/posts#' + esc(post.receipt) + '">' + esc(post.receipt) + '</a>'
    : esc('(none)');
  const postBit =
    post.text != null && post.text !== ''
      ? '<p><strong>Latest post:</strong> ' + esc(post.text) + '</p><p><strong>Receipt:</strong> ' + receipt + '</p>'
      : '<p><strong>Latest post:</strong> ' + esc('(none)') + '</p>';
  return (
    '<section class="card room-right-now" aria-labelledby="right-now-heading">' +
    '<h2 id="right-now-heading">Right now</h2>' +
    '<p>' +
    esc(L.activitySummary(room.activity)) +
    '</p>' +
    (steps.length
      ? '<h3>Last wake</h3><ol class="room-steps">' + stepItems + '</ol>'
      : '<p class="hint">No wake steps recorded yet.</p>') +
    '<p><strong>Mood</strong> <span class="pill model">model-generated</span>: ' +
    esc(mood.valence || 'unknown') +
    (mood.intensity != null ? ' (' + esc(mood.intensity) + ')' : '') +
    '</p>' +
    postBit +
    '<p class="hint"><strong>Counts:</strong> ' +
    esc(counts.experiences ?? 0) +
    ' experiences · ' +
    esc(counts.posts ?? 0) +
    ' posts · ' +
    esc(counts.drawings ?? 0) +
    ' drawings · ' +
    esc(counts.wakes ?? 0) +
    ' wakes</p>' +
    '</section>'
  );
}

function renderOwnerInner() {
  const owner = state.owner || { note: '', edits: [], messages: {} };
  const edits = Array.isArray(owner.edits) ? owner.edits : [];
  const editRows = edits
    .map((e) => {
      const line = L.formatEditLine(e);
      const toldText =
        line.told === "Nori hasn't woken up since" ? line.told : L.formatLocalDateTime(line.told);
      return (
        '<li><time datetime="' +
        esc(line.ts) +
        '">' +
        esc(L.formatLocalDateTime(line.ts)) +
        '</time>: ' +
        esc(line.action) +
        ' · ' +
        esc(line.event_id) +
        ' · ' +
        esc(line.title) +
        ' · <span class="hint">' +
        esc(toldText) +
        '</span></li>'
      );
    })
    .join('');
  const msg = owner.messages || {};
  return (
    '<p>' +
    esc(owner.note || '') +
    '</p>' +
    (edits.length ? '<h3>Memory edits</h3><ul class="room-edits">' + editRows + '</ul>' : '<p class="hint">No edits listed.</p>') +
    '<p class="hint">Private messages: ' +
    esc(msg.from_roommate ?? 0) +
    ' from roommate, ' +
    esc(msg.to_roommate ?? 0) +
    ' to roommate (counts only).</p>'
  );
}

function renderProjectStep(step) {
  const at = step && step.at ? L.formatLocalDateTime(step.at) : '';
  const text = step && step.text != null ? String(step.text) : '';
  const href = L.receiptHref(step && step.post_receipt);
  const linkBit = href
    ? ' <a href="' + esc(href) + '">post ' + esc(String(step.post_receipt)) + '</a>'
    : '';
  return (
    '<li><time datetime="' +
    esc(String((step && step.at) || '')) +
    '">' +
    esc(at) +
    '</time>: ' +
    esc(text) +
    linkBit +
    '</li>'
  );
}

function renderActiveProject(p) {
  const status = L.projectStatusLabel(p.status || 'active');
  const started = p.started_at ? L.formatLocalDateTime(p.started_at) : '';
  const steps = Array.isArray(p.steps) ? p.steps : [];
  const stepList = steps.length
    ? '<ol class="room-project-steps">' + steps.map(renderProjectStep).join('') + '</ol>'
    : '<p class="hint">No steps logged yet.</p>';
  return (
    '<article class="room-project">' +
    '<h3>' +
    esc(p.title || 'Untitled project') +
    '</h3>' +
    (p.plan ? '<p>' + esc(p.plan) + '</p>' : '') +
    '<p class="hint"><span class="pill">' +
    esc(status) +
    '</span>' +
    (started ? ' · Started ' + esc(started) : '') +
    '</p>' +
    stepList +
    '</article>'
  );
}

function renderFinishedProject(p) {
  const status = L.projectStatusLabel(p.status || 'unknown');
  const outcome = p.outcome != null && p.outcome !== '' ? '<p>' + esc(String(p.outcome)) + '</p>' : '';
  return (
    '<article class="room-project room-project-finished">' +
    '<h3>' +
    esc(p.title || 'Untitled project') +
    '</h3>' +
    '<p class="hint"><span class="pill">' +
    esc(status) +
    '</span></p>' +
    outcome +
    '</article>'
  );
}

function renderProjects() {
  if (!state.available) return '';
  const { active, finished } = L.projectsView(state.room);
  if (!active.length && !finished.length) {
    return (
      '<section class="card room-projects" aria-labelledby="projects-heading">' +
      '<h2 id="projects-heading">What Nori is working on</h2>' +
      '<p class="hint">Nori hasn&rsquo;t started a project yet. Projects are things she picks herself and keeps going across wakes.</p>' +
      '</section>'
    );
  }
  const activeHtml = active.length
    ? '<div class="room-project-list">' + active.map(renderActiveProject).join('') + '</div>'
    : '<p class="hint">No active projects right now.</p>';
  const finishedHtml = finished.length
    ? '<details class="room-project-finished-wrap"><summary>Finished and set-aside projects (' +
      esc(String(finished.length)) +
      ')</summary>' +
      finished.map(renderFinishedProject).join('') +
      '</details>'
    : '';
  return (
    '<section class="card room-projects" aria-labelledby="projects-heading">' +
    '<h2 id="projects-heading">What Nori is working on</h2>' +
    activeHtml +
    finishedHtml +
    '</section>'
  );
}

function renderRoommate() {
  return (
    '<section class="card room-roommate" aria-labelledby="roommate-heading">' +
    '<h2 id="roommate-heading">Roommate&rsquo;s corner</h2>' +
    renderOwnerInner() +
    '</section>'
  );
}

function openWindowPanel(btn) {
  const room = state.room || {};
  const nextAt = room.next_wake_at;
  const nextLine = nextAt
    ? 'Nori wakes again at ' + esc(L.formatLocalDateTime(nextAt))
    : 'Nori has no scheduled wake time yet.';
  const reason = room.next_wake_reason ? '<p>' + esc(room.next_wake_reason) + '</p>' : '';
  const lastStart = room.last_wake && room.last_wake.started_at;
  const lastLine = lastStart
    ? '<p class="hint">Last wake started ' + esc(L.formatLocalDateTime(lastStart)) + '.</p>'
    : '';
  openOverlay('room-window-panel', 'Window', '<p>' + nextLine + '</p>' + reason + lastLine, btn);
}

function openCorkLightbox(btn) {
  const list = drawings();
  const items = list.length
    ? list
        .map((d) => {
          const src = L.safeMediaUrl(d.image);
          const img = src
            ? '<img class="room-lightbox-img" src="' + esc(src) + '" alt="' + esc(d.caption || 'Drawing') + '" />'
            : '';
          const prompt = d.prompt
            ? '<details><summary>Prompt</summary><p>' + esc(d.prompt) + '</p></details>'
            : '';
          return (
            '<article class="room-lightbox-item">' +
            img +
            '<p><strong>' +
            esc(d.caption || 'Drawing') +
            '</strong></p><p class="hint">' +
            esc(L.formatLocalDateTime(d.at)) +
            '</p>' +
            prompt +
            '</article>'
          );
        })
        .join('')
    : '<p class="hint">No drawings pinned yet.</p>';
  openOverlay('room-lightbox', 'Corkboard', items, btn);
}

function desktopPanelInner() {
  const room = state.room || {};
  const steps = (room.last_wake && room.last_wake.steps) || [];
  const sticky = steps.length
    ? '<ul class="room-desktop-list">' + steps.map((s) => '<li>' + esc(L.formatWakeStep(s)) + '</li>').join('') + '</ul>'
    : '<p class="hint">No steps from the last wake.</p>';
  const dr = drawings()[0];
  const fishSrc = dr && L.safeMediaUrl(dr.image) ? L.safeMediaUrl(dr.image) : '/room/react.jpg';
  const fishAlt = dr && dr.caption ? dr.caption : 'Nori surprised at the laptop';
  const post = room.latest_post || {};
  const receipt = post.receipt;
  const postLink = receipt ? '/posts#' + encodeURIComponent(String(receipt)) : '/posts';
  const listInner =
    post.text != null && post.text !== ''
      ? '<p class="room-desktop-post">' +
        esc(post.text) +
        '</p>' +
        (post.image && L.safeMediaUrl(post.image)
          ? '<img class="post-img pixel" src="' + esc(L.safeMediaUrl(post.image)) + '" alt="" />'
          : '') +
        '<p><a href="' +
        esc(postLink) +
        '">' +
        esc(receipt ? 'Open post ' + receipt : 'All posts') +
        '</a></p>'
      : '<p class="hint">No post yet.</p>';
  let hotspots = '';
  Object.keys(L.DESKTOP_HOTSPOTS).forEach((key) => {
    const h = L.DESKTOP_HOTSPOTS[key];
    const style = 'left:' + h.left + '%;top:' + h.top + '%;width:' + h.width + '%;height:' + h.height + '%';
    if (h.href) {
      hotspots +=
        '<a class="room-desktop-hotspot" href="' +
        esc(h.href) +
        '" data-pos="' +
        style +
        '" aria-label="' +
        esc(h.label) +
        '"><span class="sr">' +
        esc(h.label) +
        '</span></a>';
    } else if (h.kind === 'owner') {
      hotspots +=
        '<button type="button" class="room-desktop-hotspot" data-owner="1" data-pos="' +
        style +
        '" aria-label="' +
        esc(h.label) +
        '"><span class="sr">' +
        esc(h.label) +
        '</span></button>';
    } else {
      hotspots +=
        '<button type="button" class="room-desktop-hotspot" data-pane="' +
        esc(key) +
        '" data-pos="' +
        style +
        '" aria-label="' +
        esc(h.label) +
        '"><span class="sr">' +
        esc(h.label) +
        '</span></button>';
    }
  });
  return (
    '<div class="room-desktop-wrap">' +
    '<div class="room-desktop-stage">' +
    '<img class="room-desktop-bg pixel" src="/room/desktop.jpg" alt="" width="1600" height="900" />' +
    hotspots +
    '</div>' +
    '<div class="room-desktop-pane" id="room-desktop-pane" hidden>' +
    '<div data-pane-body="fish" hidden><h3>Latest drawing</h3><img class="room-desktop-fish pixel" src="' +
    esc(fishSrc) +
    '" alt="' +
    esc(fishAlt) +
    '" /></div>' +
    '<div data-pane-body="sticky" hidden><h3>Last wake</h3>' +
    sticky +
    '</div>' +
    '<div data-pane-body="list" hidden><h3>Latest post</h3>' +
    listInner +
    '</div></div></div>'
  );
}

function openDesktop(btn) {
  openOverlay('room-desktop-overlay', "Nori's screen", desktopPanelInner(), btn);
  const root = state.overlay;
  if (!root) return;
  const pane = root.querySelector('#room-desktop-pane');
  root.querySelectorAll('[data-pane]').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.getAttribute('data-pane');
      if (!pane || !key) return;
      pane.hidden = false;
      pane.querySelectorAll('[data-pane-body]').forEach((el) => {
        el.hidden = el.getAttribute('data-pane-body') !== key;
      });
    });
  });
  root.querySelector('[data-owner="1"]')?.addEventListener('click', (ev) => {
    openOwnerPanel(ev.currentTarget);
  });
}

function openOwnerPanel(btn) {
  openOverlay('room-owner-overlay', "Roommate's corner", renderOwnerInner(), btn);
}

function setNoriSprite(name) {
  const img = document.querySelector('.room-nori-sprite');
  if (!img) return;
  img.setAttribute('src', L.spriteUrl(name));
}

function onNoriClick(btn) {
  const sleeping = currentActivity() === 'sleeping';
  const sprite = L.pickClickSprite(sleeping, state.clickIndex++);
  setNoriSprite(sprite);
  if (state.clickTimer) window.clearTimeout(state.clickTimer);
  state.clickTimer = window.setTimeout(() => {
    setNoriSprite(layout().sprite);
    state.clickTimer = null;
  }, 2000);
  if (btn) btn.blur();
}

function showMoodBubble() {
  if (prefersReducedMotion() || !state.available || !state.room) return;
  const mood = state.room.mood || {};
  const sprite = L.moodBubbleSprite(mood.valence, Math.random());
  const bubble = document.getElementById('room-mood-bubble');
  if (!bubble || !sprite) {
    if (bubble) bubble.hidden = true;
    return;
  }
  bubble.hidden = false;
  bubble.innerHTML = '<img class="pixel" src="' + esc(L.spriteUrl(sprite)) + '" alt="" />';
  window.setTimeout(() => {
    bubble.hidden = true;
    bubble.innerHTML = '';
  }, 2500);
}

function startAmbient() {
  if (state.moodTimer) window.clearInterval(state.moodTimer);
  state.moodTimer = window.setInterval(() => {
    if (Math.random() < 0.35) showMoodBubble();
  }, 12000);
}

function bindScene(root) {
  root.querySelector('.room-hotspot-window')?.addEventListener('click', (ev) => {
    openWindowPanel(ev.currentTarget);
  });
  root.querySelector('.room-hotspot-cork')?.addEventListener('click', (ev) => {
    openCorkLightbox(ev.currentTarget);
  });
  root.querySelector('.room-hotspot-laptop')?.addEventListener('click', (ev) => {
    openDesktop(ev.currentTarget);
  });
  root.querySelector('.room-hotspot-nori')?.addEventListener('click', (ev) => {
    onNoriClick(ev.currentTarget);
  });
}

function renderAll(root) {
  root.innerHTML = renderScene() + renderRightNow() + renderProjects() + renderRoommate();
  applyPos(root);
  bindScene(root);
  if (!prefersReducedMotion()) startAmbient();
}

async function init() {
  const root = document.getElementById('nori-room-root');
  if (!root) return;
  try {
    const [room, owner] = await Promise.all([getData('room.json'), getData('owner.json')]);
    state.room = room;
    state.owner = owner;
    state.available = true;
  } catch (e) {
    state.available = false;
    state.room = null;
    state.owner = { note: '', edits: [], messages: { from_roommate: 0, to_roommate: 0 } };
  }
  renderAll(root);
  root.setAttribute('aria-busy', 'false');
}

init();
