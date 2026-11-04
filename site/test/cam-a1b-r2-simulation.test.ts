import { it, expect } from 'vitest';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { tick } from '../src/worker/cam/timeline.ts';
it('24-hour cron-only simulation stays within request budget', async () => {
  const { env, sql } = database();
  let fetches = 0;
  let maxSegments = 0;
  const fetchFixture: typeof fetch = async () => {
    fetches++;
    return Response.json({ hourly: {
      time: Array.from({ length: 72 }, (_, i) => new Date(NOW + (i - 24) * 3600000).toISOString()),
      weather_code: Array(72).fill(0),
    } });
  };
  const count = () => Number(sql.prepare('SELECT count(*) AS n FROM segments').get()?.n);
  for (let minute = 0; minute < 1440; minute += 5) {
    const before = count();
    await tick(env, NOW + minute * 60000, { fetch: fetchFixture });
    maxSegments = Math.max(maxSegments, count() - before);
  }
  const events = sql.prepare('SELECT type, count(*) AS n FROM events GROUP BY type').all();
  const counts = Object.fromEntries(events.map(e => [e.type, e.n]));
  const fallbacks = sql.prepare(`SELECT json_extract(payload,'$.reason') AS reason, count(*) AS n
    FROM events WHERE type='safe_fallback' GROUP BY reason`).all();
  const summary = { ticks: 288, interval: '[0,24h)', fixture: '72 hours clear, refreshed hourly',
    interaction_done: counts.interaction_done || 0, interaction_interrupted: counts.interaction_interrupted || 0,
    safe_fallback_by_reason: Object.fromEntries(fallbacks.map(r => [r.reason, r.n])),
    max_segments_per_request: maxSegments, weather_fetches: fetches };
  console.log('CAM_SIMULATION', JSON.stringify(summary));
  expect(maxSegments).toBeLessThanOrEqual(30);
  expect(fetches).toBe(24);
  expect(Number(counts.interaction_done)).toBeGreaterThan(0);
  const active = sql.prepare('SELECT start_at,end_at FROM segments WHERE superseded_at IS NULL ORDER BY start_at').all();
  for (let i = 1; i < active.length; i++) expect(active[i].start_at).toBe(active[i - 1].end_at);
  sql.close();
});
