// Drives /demo in a real Chrome through CDP: ask, forget E01, compare. Local use only (fake upstream).
//   MSYS_NO_PATHCONV=1 node scripts/demo-flow-check.mjs http://127.0.0.1:8788 "C:/Program Files/Google/Chrome/Application/chrome.exe"
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [base, chrome] = process.argv.slice(2);
const profile = fileURLToPath(new URL('../.local/cdp-profile2', import.meta.url));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t;
for (let i = 0; i < 50 && !t; i++) { try { t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find((x) => x.type === 'page'); } catch {} await sleep(200); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); pend.get(d.id)?.(d); });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Page.navigate', { url: base + '/demo' }); await sleep(2000);
const errs = [];
console.log('experiences rendered:', await ev("document.querySelectorAll('#exp-list .exp').length"));
console.log('options order:', await ev("[...document.querySelectorAll('#options input')].map(i=>i.value).join(' | ')"));
await ev("document.getElementById('ask-btn').click()"); await sleep(1500);
console.log('ASK  :', await ev("document.querySelector('#result .choice')?.textContent + ' // ' + document.querySelector('#result .reason')?.textContent + ' // cites ' + document.querySelectorAll('#result .cite').length"));
await ev("document.querySelector('button[data-op=delete][data-id=E01]').click()"); await sleep(300);
console.log('after Forget E01:', await ev("document.getElementById('exp-count').textContent + ' | stored ' + localStorage.getItem('nori-edits-v1')"));
await ev("document.getElementById('compare-btn').click()"); await sleep(1800);
console.log('COMPARE panes:', await ev("document.querySelectorAll('#result .answer').length"), await ev("[...document.querySelectorAll('#result .answer')].map(a=>a.querySelector('h3').textContent+': '+a.querySelector('.choice')?.textContent).join(' || ')"));
await ev("document.getElementById('shuffle-btn').click()");
console.log('after Shuffle:', await ev("[...document.querySelectorAll('#options input')].map(i=>i.value).join(' | ')"));
ws.close(); proc.kill();
