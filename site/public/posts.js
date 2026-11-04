/* Posts list: /data/posts.json. Each card links to /posts/<id> ("Why Nori posted this"). */
(function () {
  'use strict';
  const { esc, getData } = window.Nori;
  const card = (p) => {
    const status = p.is_draft ? '<span class="pill scripted">draft, not posted</span>' : (p.status === 'published' ? '<span class="pill moss">published</span>' : `<span class="pill">${esc(p.status)}</span>`);
    const receipt = p.receipt ? `<span class="pill attr" id="${esc(p.receipt)}">receipt ${esc(p.receipt)}</span> ` : '';
    const projectPill = p.project
      ? `<span class="pill attr">project: ${p.project.title != null ? esc(p.project.title) : '(closed)'}</span> `
      : '';
    const evTitles = p.events.map((e) => (e.removed_by_roommate ? "Removed from Nori's memory by her roommate" : esc(e.title))).join(', ');
    return `<article class="card">
      <div class="entry-head">${status} ${receipt}${projectPill}<span class="attr">${esc(p.ts)}${p.language ? ' &middot; ' + esc(p.language) : ''}</span></div>
      ${p.image ? `<img class="post-img" src="${esc(p.image)}" alt="Picture made for this post" loading="lazy">` : ''}
      <p class="post-text">${esc(p.text)}</p>
      <p class="attr">Based on ${p.events.length} experience${p.events.length === 1 ? '' : 's'}: ${evTitles || 'none'}</p>
      <a href="/posts/${encodeURIComponent(p.post_id)}${p.receipt ? '#' + encodeURIComponent(p.receipt) : ''}">Why Nori posted this &rarr;</a></article>`;
  };
  getData('posts.json').then((d) => {
    document.getElementById('summary').textContent = `${d.posts.length} post${d.posts.length === 1 ? '' : 's'}`;
    document.getElementById('posts').innerHTML = d.posts.length ? d.posts.map(card).join('') : '<p class="hint">No posts yet.</p>';
  }).catch(() => { document.getElementById('summary').textContent = 'Posts have not been published yet.'; });
})();
