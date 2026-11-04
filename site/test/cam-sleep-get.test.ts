import { it, expect } from 'vitest';
import { database, NOW } from '../scripts/cam-test-db.ts';
import { initialState } from '../src/worker/cam/engine.ts';
import { handle } from '../src/worker/index.ts';
  it('asleep pending events do not cause repeated full advances on public GET', async () => {
    const t = database();
    const state = initialState(NOW);
    state.nori.asleep = true;
    state.nori.curiosity = 0;
    state.nori.sleep_started_at = NOW - 3600000;
    t.sql.prepare('UPDATE world SET timeline_until=?,state_json=?').run(NOW + 3600000, JSON.stringify(state));
    t.sql.prepare(`INSERT INTO segments (id,start_at,end_at,action,primitive,pose,path,source,world_version)
      VALUES (111,?,?,'sleep','sleep','sleepy','[[2,6]]','routine',0)`).run(NOW, NOW + 3600000);
    t.sql.prepare(`INSERT INTO events (id,insert_token,at,type,actor,payload,public,world_version)
      VALUES ('sleep-event','fixture',?,'gift_arrived','visitor','{}',1,0)`).run(NOW);
    let statements = 0;
    let batches = 0;
    const db: D1Database = { ...t.db,
      prepare(q: string) { statements++; return t.db.prepare(q); },
      async batch(s: D1PreparedStatement[]) { batches++; return t.db.batch(s); },
    } as D1Database;
    const get = () => handle(new Request('http://fixture/api/cam'), { DB: db } as any, { now: () => NOW });
    await get();
    statements = batches = 0;
    expect((await get()).status).toBe(200);
    console.log('asleep-steady-get', { statements, batches });
    expect([statements, batches]).toEqual(process.env.CAM_MEASURE_BASELINE ? [25, 4] : [5, 1]);
    expect(t.sql.prepare("SELECT handled_version FROM events WHERE id='sleep-event'").get()?.handled_version).toBeNull();
  });
