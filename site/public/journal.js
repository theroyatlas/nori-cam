/* Exploration journal: read-only view of /data/journal.json. Every value is escaped; links are http(s) only. */
(function () {
  'use strict';
  const { esc, safeUrl, link, getData } = window.Nori;
  const TOOL = {
    read_wikipedia: 'Read Wikipedia', open_page: 'Opened a page', news_headlines: 'Scanned headlines', tech_links: 'Scanned Hacker News',
    find_videos: 'Looked for videos', watch_video: 'Watched a video', look_at_image: 'Looked at an image', web_search: 'Searched the web',
    record_feeling: 'Felt something'
  };

  function because(list) {
    if (!list || !list.length) return '<div class="because">Because: <em>pure curiosity, no earlier experience</em></div>';
    return '<div class="because">Because: ' + list.map((b) => {
      if (b.removed_by_roommate) {
        return `<span class="eid">${esc(b.event_id)}</span> <span class="attr">Removed from Nori&rsquo;s memory by her roommate</span>`;
      }
      return b.known
        ? `<a class="eid" href="#ev-${esc(b.event_id)}" title="${esc(b.title)}">${esc(b.event_id)}</a> <span class="attr">${esc(b.title)}</span>`
        : `<span class="eid">${esc(b.event_id)}</span> <span class="attr">(not in this journal)</span>`;
    }).join(' &middot; ') + '</div>';
  }

  function source(e) {
    if (!e) return '';
    const items = (e.items || []).length
      ? '<ul class="items">' + e.items.map((i) => `<li>${link(i.url || i.mp4_url, i.title)} <span class="attr">${esc(i.domain || i.nasa_id || '')} ${esc(i.date || '')}</span></li>`).join('') + '</ul>' : '';
    const cites = (e.citations || []).length
      ? '<ul class="items">' + e.citations.map((c) => `<li>${link(c.url, c.title)}</li>`).join('') + '</ul>' : '';
    const note = e.model_note ? `<div class="attr">Nori said before searching: &ldquo;${esc(e.model_note)}&rdquo;</div>` : '';
    return `<div class="source"><div class="title">${esc(e.title)}</div>
      ${e.excerpt && !items ? `<div class="excerpt-text">${esc(e.excerpt)}</div>` : ''}${items}${cites}${note}
      <div class="attr">${e.url ? link(e.url) + ' &middot; ' : ''}${esc(e.attribution)} &middot; ${esc(e.license)} &middot; saved ${esc(e.retrieved_at)}</div></div>`;
  }

  // the ORIGINAL image (no copy) with the SAM boxes drawn over it; boxes are in source pixels of image_size
  function pictured(e) {
    if (!e || e.type !== 'image' || !e.url) return '';
    const sz = e.image_size, boxes = e.boxes || [];
    const svg = sz && boxes.length
      ? `<svg class="boxes" viewBox="0 0 ${esc(sz.w)} ${esc(sz.h)}" preserveAspectRatio="none" aria-hidden="true">` + boxes.map((b) =>
        `<rect x="${esc(b.x1)}" y="${esc(b.y1)}" width="${esc(b.x2 - b.x1)}" height="${esc(b.y2 - b.y1)}"/>`).join('') + '</svg>' : '';
    const said = e.noticed ? `Nori noticed: <b>${esc(e.noticed)}</b>` : '';
    const how = boxes.length ? ` &middot; ${boxes.length} box(es) by ${esc(e.sam_model || 'SAM')} (model output, not Nori&rsquo;s judgement)`
      : (e.noticed ? ' &middot; no box (segmentation unavailable or no match)' : '');
    return `<div class="pictured"><div class="overlay"><img src="${safeUrl(e.url)}" alt="${esc(e.title)}" loading="lazy" referrerpolicy="no-referrer">${svg}</div>
      <div class="attr">${said}${how}</div></div>`;
  }

  function narration(e) {
    if (!e || !e.transcript) return '';
    return `<div class="attr">Narration heard (${esc(e.transcript_model || 'Voice Transcribe')}, from ${esc(e.transcript_source)}, ${esc(e.audio_seconds)} s):
      <span class="excerpt-text">${esc(e.transcript)}</span></div>`;
  }

  function feeling(f) {
    if (!f) return '';
    return `<div class="attr">Feeling <span class="pill model">model-generated</span>: <b>${esc(f.valence)}</b> (intensity ${esc(f.intensity)}) &mdash; ${esc(f.reason)}</div>`;
  }

  function entryHTML(e) {
    const label = TOOL[e.tool] || e.tool;
    const status = e.status === 'ok' ? '' : `<span class="pill gone">${esc(e.status)}${e.reason ? ': ' + esc(e.reason) : ''}</span>`;
    const anchor = e.event && e.action !== 'feel' && !e.removed_by_roommate ? ` id="ev-${esc(e.event_id)}"` : '';
    const eid = e.event_id ? `<a class="eid" href="#ev-${esc(e.event_id)}">${esc(e.event_id)}</a>` : '';
    const what = e.query ? `<div class="attr">Query: <b>${esc(e.query)}</b></div>` : (e.url && !e.event ? `<div class="attr">${esc(e.url)}</div>` : '');
    const ref = e.event_ref ? (e.removed_by_roommate
      ? `<div class="attr">Removed from Nori&rsquo;s memory by her roommate</div>`
      : `<div class="attr">About <a class="eid" href="#ev-${esc(e.event_ref.id)}">${esc(e.event_ref.id)}</a> ${esc(e.event_ref.title)}</div>`) : '';
    const media = e.media_link ? `<div class="attr">Original ${esc((e.event && e.event.type) || "link")}: ${link(e.media_link)} (link only, not copied)</div>` : '';
    const main = e.removed_by_roommate && e.action !== 'feel'
      ? '<p class="attr">Removed from Nori&rsquo;s memory by her roommate</p>'
      : `${what}${ref}${source(e.event)}${pictured(e.event)}${narration(e.event)}${media}${feeling(e.feeling)}`;
    return `<article class="entry ${esc(e.status)}"${anchor}>
      <div class="entry-head"><b>${esc(label)}</b> ${eid} ${status}<span class="attr">${esc(e.ts)} &middot; tick ${esc(e.tick_id)}</span></div>
      ${e.why ? `<div class="why">Why: &ldquo;${esc(e.why)}&rdquo;</div>` : ''}
      ${e.action === 'feel' ? '' : because(e.because)}
      ${main}
      ${e.cost_usd ? `<div class="attr">est. cost $${esc(e.cost_usd)}</div>` : ''}</article>`;
  }

  getData('journal.json').then((j) => {
    document.getElementById('summary').textContent =
      `${j.summary.entries} entries · ${j.summary.ticks.length} run(s) · est. model cost $${j.summary.cost_usd}`;
    document.getElementById('entries').innerHTML = j.entries.length
      ? j.entries.map(entryHTML).join('')
      : '<p class="hint">Nothing recorded yet.</p>';
    if (location.hash) { try { const t = document.querySelector(location.hash); if (t) t.scrollIntoView(); } catch (e) { /* bad hash */ } }
  }).catch(() => {
    document.getElementById('summary').textContent = 'The journal has not been published yet.';
  });
})();
