// Tiny dev server for Nori Cam live mode: serves site/public plus
// /api/cam from site/test/fixtures/cam-live-*.json with ETag/304.
// 127.0.0.1 only. Env: PORT (8805), MOCK_CAM_FAIL=1 (500 on /api/cam),
// MOCK_CAM_STEP_MS (fixture advance interval, default 15000).
// MOCK_CAM_SET=real|bed|drink|desk|computer|heights serves that rebased sample.
import { createServer } from 'node:http';
import { applyEffects } from '../public/cam-shared.js';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const port = Number(process.env.PORT || 8805);
const stepMs = Number(process.env.MOCK_CAM_STEP_MS || 15000);
const fail = process.env.MOCK_CAM_FAIL === '1';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

const setName = process.env.MOCK_CAM_SET || '';
const fixtureNames = setName ? ['cam-live-'+setName+'.json'] : ['cam-live-1.json', 'cam-live-2.json', 'cam-live-real.json'];
const fixtures = [];
for (const name of fixtureNames) {
  fixtures.push(JSON.parse(await readFile(join(fixturesDir, name), 'utf8')));
}
const startReal = Date.now();
const startServer = fixtures[0].server_now;
// Rebase once, including nested absolute times, without restarting on each poll.
const shift = setName && fixtures[0].segments?.length
  ? startServer - fixtures[0].segments[0].start_at - 1000 : 0;
for (const fixture of fixtures) {
  if (!setName) continue;
  fixture.timeline_until += shift;
  fixture.segments = fixture.segments.map(sg => ({ ...sg,
    start_at: sg.start_at + shift, end_at: sg.end_at + shift,
    cut_at: sg.cut_at == null ? sg.cut_at : sg.cut_at + shift,
    effects: (sg.effects || []).map(e => ({ ...e,
      ...(Number.isFinite(e.at_ms) ? {at_ms: e.at_ms + shift} : {}),
      ...(e.keyframes ? { keyframes: e.keyframes.map(f => ({...f, at_ms:f.at_ms+shift})) } : {})
    })) }));
}
const serverNow = () => startServer + (Date.now() - startReal);
function currentFixture() {
  const idx = Math.min(fixtures.length - 1, Math.floor((Date.now() - startReal) / stepMs));
  return fixtures[idx];
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/cam/fixture/heights.json') {
    const body = JSON.parse(await readFile(join(fixturesDir, 'cam-live-heights.json'), 'utf8'));
    const origin = body.server_now;
    body.server_now = 0;
    body.timeline_until -= origin;
    body.segments = body.segments.map(sg => ({...sg,
      start_at:sg.start_at-origin, end_at:sg.end_at-origin,
      cut_at:sg.cut_at == null ? sg.cut_at : sg.cut_at-origin,
      effects:(sg.effects || []).map(e => ({...e,
        ...(Number.isFinite(e.at_ms) ? {at_ms:e.at_ms-origin} : {}),
        ...(e.keyframes ? {keyframes:e.keyframes.map(f=>({...f,at_ms:f.at_ms-origin}))} : {})
      }))}));
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(body)); return;
  }
  if (url.pathname === '/api/cam') {
    if (fail) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('mock failure'); return; }
    const fixture = currentFixture();
    const etag = `W/"${fixture.world_version}-${fixture.timeline_until}"`;
    const now = serverNow();
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag, 'X-Server-Now': String(now) });
      res.end();
      return;
    }
    const body = { ...fixture, server_now: now,
      objects: setName ? applyEffects(fixture.objects, fixture.segments, now) : fixture.objects };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: etag, 'X-Server-Now': String(now) });
    res.end(JSON.stringify(body));
    return;
  }
  let path = url.pathname === '/' ? '/cam.html' : url.pathname;
  try {
    const file = normalize(join(root, path));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`mock-cam-api listening on http://127.0.0.1:${port}/cam.html`);
});
