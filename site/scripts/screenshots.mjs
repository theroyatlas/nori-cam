// Full-page screenshots at 390 and 1280 px through the Chrome DevTools Protocol (no extra packages).
//   node scripts/screenshots.mjs <base-url> <path-to-chrome> [pages...]      e.g. http://127.0.0.1:8788 "C:/Program Files/Google/Chrome/Application/chrome.exe"
// Local pages only. Writes site/screenshots/<name>-<width>.png (overwrites; nothing is deleted).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [base, chrome, ...pages] = process.argv.slice(2);
if (!base || !chrome) throw new Error('usage: screenshots.mjs <base-url> <chrome.exe> [pages...]');
const list = pages.length ? pages : ['/', '/demo', '/journal'];
const outDir = fileURLToPath(new URL('../screenshots/', import.meta.url));
const profile = fileURLToPath(new URL('../.local/cdp-profile', import.meta.url));
mkdirSync(outDir, { recursive: true });
const port = 9333;
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); const l = await r.json(); const t = l.find((x) => x.type === 'page'); if (t) return t; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('chrome did not start');
}

const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

for (const path of list) {
  for (const width of [390, 1280]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
    await send('Page.navigate', { url: base + path });
    await sleep(2500);
    const m = await send('Page.getLayoutMetrics');
    const h = Math.ceil(m.result.cssContentSize.height);
    const w = Math.ceil(m.result.cssContentSize.width);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.max(width, w), height: Math.min(h, 6000), scale: 1 } });
    const name = (path === '/' ? 'home' : path.slice(1).replace(/\//g, '-')) + '-' + width + '.png';
    writeFileSync(outDir + name, Buffer.from(shot.result.data, 'base64'));
    console.log(name, `content ${w}x${h}`, w > width ? 'HORIZONTAL OVERFLOW' : 'fits');
  }
}
ws.close();
proc.kill();
