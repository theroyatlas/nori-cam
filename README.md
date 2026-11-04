# Nori Cam

A small, quiet window into another world. Nori, a fictional short-legged AI cat, lives in a miniature room on her own clock. You don't control her. You watch, and sometimes you send her a gift.

- **Public site:** https://nori-aipet.theroyatlas.workers.dev/. It shows the R40 room with Nori's real server timeline. Catalog gifts are free and fall from the sky into the room.
- **Demo video (under 3 minutes):** <VIDEO_URL>

## What happens when you send a gift

1. **Photo understanding: Meta Muse Spark 1.3.** One call turns a photo of a real object into a strict JSON object contract: name, kind, size class, materials and affordances. It is checked against a schema. Photos the pipeline can't use are refused rather than guessed.
2. **Redraw: Meta Muse Image 1.0.** One image per gift. The prompt carries the room's reference render, so the object comes back in the room's palette and light. We key out the flat background and cut a 512 px sprite.
3. **Authoritative placement: Cloudflare Worker + D1.** The world engine, not a model, decides where the object can go (cells, collisions, heights). Placement follows the same rules for every gift.
4. **Nori's own reaction.** The planner picks only actions her body and the object legally allow. She may look, approach, sniff, sit on it, carry it, hide in it, or ignore it. Nothing forces an interaction or raises her preferences. When an interaction ends, the engine settles it into her state as an experience: familiarity, plus small preference and wariness changes.
5. **Reflection: Meta Muse Wonder 1.0.** One call reflects on one settled experience.
   - The reflection must cite the exact settled event from the world log.
   - Its "tomorrow" intent must use a real object id and an allowed action. A validator rejects anything invented.
   - An accepted intent is scheduled into her timeline as ordinary behaviour.
   - The raw model output, the parse and the validator's reasons are saved as evidence for every attempt.

Memory here is continuity, not intelligence growth.

## What was verified, and how

| Feature | LIVE (real models / real server) | REPLAY | MOCK (no network, zero cost) |
| --- | --- | --- | --- |
| Shared world, timeline and catalog gifts | Public site (Worker + D1). Catalog gifts: one per visitor per day. Checked on 2026-11-05 with one real gift: it fell into the room and Nori looked up at it | — | `wrangler dev --local` with local D1; vitest |
| Photo understanding and redraw | Owner Live only, with your own Meta key. On 2026-11-05: eight photo gifts from five different photos, one attempt each. Seven became objects in the room; one stopped at the understanding step | The demo video shows those recorded runs | Unit tests with fixture model outputs |
| Nori's reaction and persisted state | The same engine on the public site and in owner Live. In the recorded runs she looked, interacted and reacted from her cell every time | — | vitest/pytest; accelerated simulations reuse the production engine with saved or mock outputs |
| Wonder reflection | Owner Live with `--reflect`. After the 2026-11-05 contract fix, all 6 live reflections were accepted (1 manual probe, then 5 automatic, one per photo gift), and each "tomorrow" intent was scheduled and settled on the timeline. One earlier live attempt, before the fix, failed with an unexplained error; its raw output had not been saved, which is why every attempt now keeps its evidence | Every live attempt saves its raw output, parse and validator reasons as JSON evidence in the world directory | `app/tests/test_wonder_reflection_fix.py` |

Live model spend for all of the above, as tracked by the local owner ledger: about US$0.46.

## Run locally at zero model cost

Requires Node.js with `node:sqlite` support (Node 22.13+ recommended) and npm. From the repository root:

```sh
cd site
npm ci
npx wrangler d1 migrations apply DB --local
npx wrangler d1 execute DB --local --file oneoff/r40_layout.sql
npx wrangler dev --local
```

Open the URL Wrangler prints. The R40 room is the default scene; `?scene=pixel` shows the earlier 2D room. Catalog gifts need no model calls and no API key.

## Optional owner Live with real Meta models (costs money)

Requires Python 3.10+, the packages in `app/requirements-cloud.txt`, the installed `site` dependencies, and a Meta Model API key in a file outside the repository:

```sh
python -m pip install -r app/requirements-cloud.txt
python -X utf8 -m app.cam.observatory_assets ../nori-observatory-session/assets
python -X utf8 -m app.cam.observatory_owner --state ../nori-observatory-session/world --assets ../nori-observatory-session/assets --port 8810 --key-file /absolute/path/outside/repo/meta-api-key.txt [--reflect]
```

Open `http://127.0.0.1:8810/` and enter the code from `owner-code.txt` in the external world directory.
- `--reflect` enables one automatic Wonder reflection per photo object. Without it, `tools/wonder_live_probe.py` triggers exactly one reflection by experience id.
- The runner keeps the key in memory only.
- It reserves every call against a shared local US$20 ledger at `~/.nori-cam/owner-live/budget.sqlite`. It makes one attempt per call, with no automatic retry and a 180 s timeout. The ledger is a local accounting guard, not a provider billing cap.

Rebuild the procedural room with Blender 4.4 from `site/observatory/model`:

```sh
blender -b --factory-startup --python build.py -- --tag r4
```

After changing `site/observatory/observatory.js`, run `npm run build:observatory` in `site/`.

## Limitations

- **Photo gifts are switched off on the public site.** They call paid models, and the public deployment keeps them off to protect a shared cost cap. The full photo loop runs in owner Live mode.
- **Placement.** The R40 room uses conservative floor colliders and has few legal floor cells. Gifts are placed near the door, next to Nori's usual spot. When the room is full, the least familiar visitor gift is tidied away (stored). Furniture climbing is not implemented.
- **Wonder.**
  - The "tomorrow" intent runs at the next planning step, not after a real day.
  - The page polls the timeline every 10–60 s, so very short segments, such as a 4.5 s intent, may not be drawn in the browser even though they settle on the server.
  - There is no paired live baseline, so we do not claim that memory changed Nori's behaviour.
- **Performance.** Mobile performance of the 3D room is untested. Headless software rendering runs at about 1–10 fps; real GPUs are faster.
- **Tests.** Historical research acceptance tests and their private inputs are excluded from this export (see `report.md`). Passing the public unit tests does not by itself establish live model behaviour.

## Built during the event

- The private development repository's first commit is dated 2026-10-28. The event ran from 2026-10-27 to 2026-11-05 (GMT+8).
- Nori's look was designed by the author with ChatGPT image generation on 10/28, 10/29 and 11/01.
- The R40 room was modelled in code (`site/observatory/model/build.py`, Blender 4.4) on 2026-11-05. All of its textures are generated procedurally; no downloaded assets.
- The original reference sheets are excluded because the product does not read them at runtime. The character assets produced from them are included.

## AI tools used in development

All development agents worked under the author's direction. Every change was reviewed and tested before merging.
- **Claude Code with Claude Opus 5.5:** project management, the R40 Blender build script and renderer, and the Remotion demo video.
- **OpenAI Codex with GPT-6.1 (Sol, Terra):** engineering and review.
- **Meta Muse Code with Muse Spark 1.3:** implementation tasks, run in an isolated runner.
- **Cursor Composer 2.5:** early drafts.
- **ChatGPT image generation:** the author's Nori design sheets.

At runtime, the only model calls are the Meta Model API calls described above. Everything else is deterministic code.

## Rights

Copyright © 2026 Roy Wang. All rights reserved. Source is published for hackathon judging.

Bundled dependencies retain their respective licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
