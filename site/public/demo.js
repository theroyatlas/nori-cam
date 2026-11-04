/* Nori memory demo. Edits and options live in this browser only (localStorage) and travel with every request. */
(function () {
  'use strict';
  const { esc, link, getJson } = window.Nori;
  const $ = (id) => document.getElementById(id);
  const DEFAULTS = ['Explore kaleidoscope patterns', 'Explore coral reef structures', 'Explore bioluminescence',
    'Explore murmuration', 'Explore fungi', 'Explore moss textures'];
  const KEY_EDITS = 'nori-edits-v1';
  const KEY_OPTS = 'nori-options-v1';
  let events = [];
  let byId = {};
  let edits = load(KEY_EDITS, {});

  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
  }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode: edits then last until reload */ } }

  function shuffled(list) {
    const a = list.slice();
    const buf = new Uint32Array(a.length);
    crypto.getRandomValues(buf);
    for (let i = a.length - 1; i > 0; i--) { const j = buf[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const currentOptions = () => Array.from($('options').querySelectorAll('input')).map((i) => i.value.trim());
  function renderOptions(list) {
    $('options').innerHTML = list.map((v, i) =>
      `<li><input name="o${i}" aria-label="Option ${i + 1}" value="${esc(v)}" maxlength="80" required></li>`).join('');
  }
  const stateOf = (id) => (edits[id] === 'delete' ? 'deleted' : edits[id] === 'neutralize' ? 'neutralized' : 'original');

  // ---- experiences -----------------------------------------------------------------------------------------
  function feelingText(e) {
    const st = stateOf(e.id);
    if (st === 'deleted') return { text: '(removed from what Nori remembers)', cls: '' };
    if (st === 'neutralized') return { text: 'I felt neither pleased nor displeased afterward.', cls: '' };
    return { text: e.scripted_feeling, cls: e.valence === 'positive' ? 'pos' : '' };
  }
  function renderExperiences() {
    const gone = events.filter((e) => stateOf(e.id) === 'deleted').length;
    $('exp-count').textContent = `${events.length - gone} remembered, ${gone} forgotten`;
    $('exp-list').innerHTML = events.map((e) => {
      const st = stateOf(e.id);
      const f = feelingText(e);
      const badge = st === 'deleted' ? '<span class="pill gone">forgotten</span>' : st === 'neutralized' ? '<span class="pill">made neutral</span>' : '';
      return `<li class="exp state-${st}" id="exp-${esc(e.id)}">
        <div class="exp-head"><span class="eid">${esc(e.id)}</span><span class="exp-title">${esc(e.title)}</span>${badge}</div>
        <div class="feel ${f.cls}">Feeling <span class="pill scripted">scripted</span> ${esc(f.text)}</div>
        <details class="excerpt"><summary>Source excerpt</summary>
          <p>${esc(e.excerpt)}</p>
          <p class="attr">${esc(e.attribution)}<br>Licence: ${link(e.license_url, e.license)} &middot; Source: ${link(e.source_url)}</p>
        </details>
        <div class="acts">
          <button type="button" data-op="delete" data-id="${esc(e.id)}" ${st === 'deleted' ? 'disabled' : ''}>Forget this</button>
          <button type="button" data-op="neutralize" data-id="${esc(e.id)}" ${st !== 'original' ? 'disabled' : ''}>It wasn&rsquo;t that good</button>
          <button type="button" data-op="restore" data-id="${esc(e.id)}" ${st === 'original' ? 'disabled' : ''}>Restore</button>
        </div></li>`;
    }).join('');
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-op]');
    if (b) {
      const id = b.dataset.id;
      if (b.dataset.op === 'restore') delete edits[id]; else edits[id] = b.dataset.op;
      save(KEY_EDITS, edits);
      renderExperiences();
      $('result').innerHTML = '';
      setStatus('Memory edited. Ask again to see what changes.');
      const next = document.querySelector(`#exp-${CSS.escape(id)} button:not([disabled])`);
      if (next) next.focus();
      return;
    }
    const goto = ev.target.closest('a[data-goto]');
    if (goto) {
      ev.preventDefault();
      const t = $('exp-' + goto.dataset.goto);
      if (t) { const d = t.querySelector('details'); if (d) d.open = true; t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
  });

  // ---- answers -----------------------------------------------------------------------------------------------
  function citeHTML(c) {
    const gone = !c.visible_in_context;
    const src = c.excerpt ? `<blockquote>${esc(c.excerpt)}</blockquote>
      <div class="attr">${esc(c.attribution)}<br>Licence: ${link(c.license_url, c.license)} &middot; Source: ${link(c.source_url)}</div>` : '<div class="attr">No such experience.</div>';
    return `<li class="cite ${gone ? 'out' : ''}"><details ${gone ? 'open' : ''}><summary><span class="eid">${esc(c.event_id)}</span> ${esc(c.title || 'unknown')}
      ${gone ? '<span class="pill gone">not in Nori&rsquo;s memory now</span>' : ''}</summary>${src}</details></li>`;
  }
  function answerHTML(r, label, cls) {
    if (!r.valid) {
      return `<div class="answer ${cls || ''}"><h3>${esc(label)}</h3><p class="err">The model did not return a usable choice this time. Ask again.</p></div>`;
    }
    const cites = r.citations.length ? `<ul class="cite-list">${r.citations.map(citeHTML).join('')}</ul>` : '<p class="hint">Nori cited no experience for this choice.</p>';
    const warn = r.citations_visible ? '' : '<p class="hint err">Some cited experiences are not in the memory used for this answer.</p>';
    return `<div class="answer ${cls || ''}"><h3>${esc(label)}</h3>
      <div class="choice">${esc(r.choice_text)}</div>
      <div class="reason">${esc(r.reason)}</div>
      <h3>Experiences it cited</h3>${cites}${warn}
      <p class="hint">${r.context_event_ids.length} experiences in memory${r.cached ? ' &middot; saved answer from the last 24 hours' : ''}. The reason is written by the model.</p></div>`;
  }
  function setStatus(msg, bad) { $('status').innerHTML = msg ? `<span class="${bad ? 'err' : 'hint'}">${esc(msg)}</span>` : ''; }
  function busy(on) { ['ask-btn', 'compare-btn', 'shuffle-btn'].forEach((id) => { $(id).disabled = on; }); }

  async function call(path) {
    const options = currentOptions();
    save(KEY_OPTS, options);
    busy(true); setStatus('Nori is thinking…'); $('examples').innerHTML = '';
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options, edits }) });
      let j = {};
      try { j = await res.json(); } catch (e) { /* non-JSON error page */ }
      if (!res.ok) { await failed(res.status, j); return null; }
      setStatus('');
      return j;
    } catch (e) {
      setStatus('Could not reach the server. Check your connection and try again.', true);
      return null;
    } finally { busy(false); }
  }
  async function failed(status, j) {
    $('result').innerHTML = '';
    setStatus(j.message || 'Something went wrong. Please try again.', true);
    if (status === 429 || status === 503) await showExamples();
  }
  async function showExamples() {
    try {
      const d = await getJson('/data/demo-examples.json');
      const mock = d.mock ? `<div class="notice"><strong>Placeholder examples.</strong> ${esc(d.note || '')}</div>` : '';
      $('examples').innerHTML = `<h3>Pre-recorded examples</h3>${mock}` + d.examples.map((ex) => {
        const mk = (r, label, cls) => answerHTML(Object.assign({ valid: true, citations_visible: true, context_event_ids: [], cached: false }, r,
          { citations: (r.event_ids || []).map((id) => Object.assign({ event_id: id, visible_in_context: true }, pick(id))) }), label, cls);
        return `<div class="card"><p><strong>${esc(ex.title)}</strong></p><div class="compare">${mk(ex.current, 'With edits: ' + ex.edits_note)}${mk(ex.original, 'Original memory', 'orig')}</div></div>`;
      }).join('');
    } catch (e) { /* no examples file: the message above is enough */ }
  }
  function pick(id) {
    const e = byId[id];
    return e ? { title: e.title, excerpt: e.excerpt, source_url: e.source_url, license: e.license, license_url: e.license_url, attribution: e.attribution } : {};
  }

  $('ask-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const j = await call('/api/decide');
    if (j) { $('result').innerHTML = answerHTML(j, 'Nori chooses'); $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
  $('compare-btn').addEventListener('click', async () => {
    const j = await call('/api/compare');
    if (j) {
      $('result').innerHTML = `<div class="compare">${answerHTML(j.current, 'Current memory (your edits)')}${answerHTML(j.original, 'Original memory (no edits)', 'orig')}</div>
        <p class="hint">Same options, same order, asked twice. The model can answer differently from one ask to the next, so read a single pair as an example, not a measurement.</p>`;
      $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  $('shuffle-btn').addEventListener('click', () => { renderOptions(shuffled(currentOptions())); setStatus('Options shuffled.'); });
  $('reset-btn').addEventListener('click', () => { renderOptions(shuffled(DEFAULTS)); setStatus('Default options, shuffled.'); });

  const saved = load(KEY_OPTS, null);
  renderOptions(shuffled(Array.isArray(saved) && saved.length === 6 && saved.every((s) => typeof s === 'string') ? saved : DEFAULTS));
  getJson('/data/demo-events.json').then((d) => {
    events = d.events; byId = {}; events.forEach((e) => { byId[e.id] = e; });
    Object.keys(edits).forEach((id) => { if (!byId[id]) delete edits[id]; });
    renderExperiences();
  }).catch(() => { $('exp-list').innerHTML = '<li class="err">Could not load the experiences. Reload the page.</li>'; });
})();
