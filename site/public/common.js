/* Shared helpers. Plain JS, no dependencies. Every value that reaches the page goes through esc(); links are http(s) only. */
(function () {
  'use strict';
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // The saved post data still carries a few Chinese licence notes; the site is English-only, so show them in English.
  const EN = [
    ['© 各原網站；僅存查詢與引用清單', '© the original sites; only the query and the citation list are kept'],
    ['NASA / Wikimedia 媒體（逐筆核對授權）；僅存連結與模型描述', 'NASA / Wikimedia media (licence checked per item); only links and model descriptions are kept'],
    ['© 原網站，僅存節錄（browser）', '© the original site; excerpt only (browser)'],
    ['© 原網站，僅存節錄', '© the original site; excerpt only'],
  ];
  const en = (s) => EN.reduce((t, [zh, e]) => t.split(zh).join(e), s);
  const esc = (s) => en(String(s == null ? '' : s)).replace(/[&<>"']/g, (c) => ESC[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
  const link = (u, label) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${esc(label || u)}</a>`;
  async function getJson(path) {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function getData(name) {
    try {
      return await getJson('/data/live/' + name);
    } catch (e) {
      return getJson('/data/' + name);
    }
  }
  // highlight the current page in the nav
  document.querySelectorAll('.nav a').forEach((a) => {
    const here = location.pathname.replace(/\/$/, '') || '/';
    const to = a.getAttribute('href');
    if (to === here || (to !== '/' && here.startsWith(to + '/'))) a.setAttribute('aria-current', 'page');
  });
  // avatar: keep the drawn placeholder until /media/avatar.png really exists
  document.querySelectorAll('.avatar img').forEach((img) => {
    const ok = () => img.parentElement.classList.add('has-img');
    img.addEventListener('load', ok);
    img.addEventListener('error', () => img.remove());
    if (img.complete && img.naturalWidth) ok();
  });
  window.Nori = { esc, safeUrl, link, getJson, getData };
})();
