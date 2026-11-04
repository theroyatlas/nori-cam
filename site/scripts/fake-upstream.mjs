// Fake "Meta Model API" for local runs and smoke tests: node scripts/fake-upstream.mjs [port]
// Answers POST /v1/chat/completions the way the real service does (OpenAI-style envelope with usage) but with a fixed rule:
// pick the option that mentions a memory felt "quietly pleased", else the first option. It never sees or needs a real key.
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8799);
createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end('not found'); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let choice = 'A0', ids = [], reason = 'FAKE UPSTREAM: no pleasant memory matches, taking the first option.';
    try {
      const body = JSON.parse(JSON.parse(raw).messages[1].content);
      outer: for (const o of body.options) {
        for (const m of body.context) {
          if (!m.feeling.includes('pleased after')) continue;
          const title = m.memory.trim().replace('I read the public article about ', '').replace(/\.$/, '').toLowerCase();
          if (title && o.text.toLowerCase().includes(title)) { choice = o.id; ids = [m.event_ids[0]]; reason = `FAKE UPSTREAM: I felt pleased reading about ${title}.`; break outer; }
        }
      }
    } catch { /* keep the defaults */ }
    const out = { model: 'fake-upstream', usage: { prompt_tokens: 3200, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 0 } },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ choice_id: choice, event_ids: ids, reason }) } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
}).listen(port, '127.0.0.1', () => console.log(`fake upstream on http://127.0.0.1:${port}`));
