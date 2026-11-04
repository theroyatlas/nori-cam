import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ClockSync, LiveTimeline, MIN_POLL_MS, POLL_MS, backoffDelayMs, computeOffset, effectiveEnd,
  firstLoadPose, heldPose, isFixtureMode, mergeSegments, nextPollDelayMs, parseMode, pruneSegments,
} from '../public/cam-live.js';
import { poseAt } from '../public/cam-shared.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx1: any = JSON.parse(readFileSync(new URL('./fixtures/cam-live-1.json', import.meta.url), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx2: any = JSON.parse(readFileSync(new URL('./fixtures/cam-live-2.json', import.meta.url), 'utf8'));

function fakeFetch(handler: (url: string, init: any, n: number) => any) {
  let n = 0;
  const calls: { url: string; headers: any }[] = [];
  const fn = async (url: string, init: any) => {
    n += 1; calls.push({ url: String(url), headers: init?.headers || {} });
    return handler(String(url), init, n);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
function jsonRes(body: any, etag: string, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ETag: etag } });
}

describe('offset math', () => {
  it('offset = server_now - midpoint, lowest-RTT sample wins', () => {
    expect(computeOffset(10000, 1000, 1100)).toBe(8950);
    const c = new ClockSync();
    c.addSample(10000, 1000, 1200); // rtt 200, offset 8900
    c.addSample(10100, 2000, 2050); // rtt 50, offset 8075
    c.addSample(10200, 3000, 3300); // rtt 300, offset 7050
    expect(c.offset).toBe(8075);
    expect(c.now(2050)).toBe(10125);
  });
});

describe('ETag / 304 handling', () => {
  it('sends If-None-Match, keeps timeline on 304, updates offset from X-Server-Now', async () => {
    let perf = 1000;
    const { fn, calls } = fakeFetch((_u, _i, n) => {
      perf += 40;
      if (n === 1) return jsonRes(fx1, 'W/"1-1793530800000"');
      return new Response(null, { status: 304, headers: { ETag: 'W/"1-1793530800000"', 'X-Server-Now': String(fx1.server_now + 5000) } });
    });
    const live = new LiveTimeline({ fetchFn: fn, perfNow: () => perf, wallNow: () => fx1.server_now });
    const r1 = await live.fetchOnce(fx1.server_now);
    expect(r1.status).toBe(200);
    expect(live.segments).toHaveLength(3);
    expect((live.weather as any).condition).toBe('clear');
    const r2 = await live.fetchOnce(fx1.server_now + 5000);
    expect(r2.status).toBe(304);
    expect(calls[1].headers['If-None-Match']).toBe('W/"1-1793530800000"');
    expect(calls[0].url).toContain('/api/cam?from=');
    expect(live.segments).toHaveLength(3); // kept
    expect(live.serverNowValue).toBe(fx1.server_now + 5000);
    expect(live.failures).toBe(0);
  });
});

describe('merge by id with cut_at', () => {
  it('later fetch wins and cut_at truncates the effective end', () => {
    const merged = mergeSegments(fx1.segments, fx2.segments, fx1.server_now);
    const seg = merged.find((s: any) => s.id === 1000000001)!;
    expect(seg.cut_at).toBe(1793527230000);
    expect(effectiveEnd(seg)).toBe(1793527230000);
    expect(merged.map((s: any) => s.id)).toContain(1000000003);
  });
  it('prunes segments ended more than 10 minutes ago, keeping the last', () => {
    const old = [{ id: 1, start_at: 0, end_at: 1000 }, { id: 2, start_at: 1000, end_at: 2000 }];
    expect(pruneSegments(old as any, 2000 + 600001).map((s: any) => s.id)).toEqual([2]);
    expect(pruneSegments(old as any, 1000 + 600000)).toHaveLength(2);
  });
});

describe('polling schedule and backoff', () => {
  it('polls at 60 s or timeline_until - 5 min, whichever is earlier', () => {
    expect(nextPollDelayMs({ nowServer: 0, timelineUntil: 3600000 })).toBe(60000);
    expect(nextPollDelayMs({ nowServer: 0, timelineUntil: 200000 })).toBe(MIN_POLL_MS);
    expect(nextPollDelayMs({ nowServer: 0, timelineUntil: 305000 })).toBe(MIN_POLL_MS);
    expect(nextPollDelayMs({ nowServer: 0, timelineUntil: 320000 })).toBe(20000);
    expect(nextPollDelayMs({})).toBe(60000);
  });
  it('schedules the first loop poll after the snapshot already fetched by cam.js', async () => {
    const { fn, calls } = fakeFetch(() => jsonRes({ ...fx1, server_now: 1000, timeline_until: 2000 }, 'initial'));
    const schedule = vi.fn();
    const live = new LiveTimeline({ fetchFn: fn, perfNow: () => 1000, wallNow: () => 1000,
      setTimeoutFn: schedule, clearTimeoutFn: () => {} });
    await live.fetchOnce();
    live.start();
    expect(calls).toHaveLength(1);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), MIN_POLL_MS);
    live.stop();
  });
  it('keeps repeated near-end 304 polls at least MIN_POLL_MS apart', async () => {
    let now = 1000;
    const calls: number[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const live = new LiveTimeline({
      perfNow: () => now, wallNow: () => now,
      fetchFn: async () => {
        calls.push(now);
        return new Response(null, { status: 304, headers: { 'X-Server-Now': String(now) } });
      },
      setTimeoutFn: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeoutFn: () => {},
    });
    live.timelineUntil = now + 210000;
    live.start();
    try {
      for (let i = 0; i < 5; i++) {
        await vi.waitFor(() => expect(timers).toHaveLength(1));
        const timer = timers.shift()!;
        expect(timer.ms).toBeGreaterThanOrEqual(MIN_POLL_MS);
        expect(timer.ms).toBeLessThanOrEqual(POLL_MS);
        now += timer.ms;
        timer.fn();
      }
      await vi.waitFor(() => expect(calls).toHaveLength(6));
      expect(calls.slice(1).every((at, i) => at - calls[i] >= MIN_POLL_MS)).toBe(true);
      expect(live.timelineUntil).toBe(211000);
    } finally { live.stop(); }
  });
  it('backoff grows 5 s to 60 s and reconnect shows after 2 failures', async () => {
    expect([1, 2, 3, 4, 5].map(backoffDelayMs)).toEqual([5000, 10000, 20000, 40000, 60000]);
    const { fn } = fakeFetch(() => new Response('x', { status: 500 }));
    const live = new LiveTimeline({ fetchFn: fn, perfNow: () => 0, wallNow: () => 0 });
    await expect(live.fetchOnce(0)).rejects.toThrow();
    expect(live.shouldShowReconnect()).toBe(false);
    await expect(live.fetchOnce(0)).rejects.toThrow();
    expect(live.shouldShowReconnect()).toBe(true);
    expect(live.nextPollDelayMs()).toBe(10000);
  });
});

describe('segment-end confirmation (3.8)', () => {
  it('refetch that cuts the segment blocks its effects; failed refetch applies them', async () => {
    const seg = { ...fx1.segments[0], effects: [{ e: 'glow', object_id: 'o_box1' }] };
    const cutBody = { ...fx1, segments: [{ ...seg, cut_at: seg.start_at + 100 }] };
    const a = fakeFetch((_u, _i, n) => (n === 1 ? jsonRes({ ...fx1, segments: [seg] }, 'W/"1-1"') : jsonRes(cutBody, 'W/"1-2"')));
    const liveA = new LiveTimeline({ fetchFn: a.fn, perfNow: () => 0, wallNow: () => fx1.server_now });
    await liveA.fetchOnce(0);
    await expect(liveA.confirmSegmentEnd(seg)).resolves.toBe(false);

    const b = fakeFetch((_u, _i, n) => (n === 1 ? jsonRes({ ...fx1, segments: [seg] }, 'W/"1-1"') : new Response('x', { status: 500 })));
    const liveB = new LiveTimeline({ fetchFn: b.fn, perfNow: () => 0, wallNow: () => fx1.server_now });
    await liveB.fetchOnce(0);
    await expect(liveB.confirmSegmentEnd(seg)).resolves.toBe(true);
  });
});

describe('hold last pose past timeline_until', () => {
  it('never vanishes: last position with a sit/loaf pose', () => {
    const held: any = heldPose(fx1.segments, fx1.timeline_until + 999999, poseAt as any);
    expect(held).not.toBeNull();
    expect(['sit', 'alert_loaf', 'sleepy']).toContain(held.pose);
    expect(held.x).toBe(1); expect(held.y).toBe(6);
    const live = new LiveTimeline({ fetchFn: (async () => { throw new Error('x'); }) as any, perfNow: () => 0, wallNow: () => 0 });
    live.segments = fx1.segments; live.timelineUntil = fx1.timeline_until;
    const p: any = live.poseAtLive(fx1.timeline_until + 5000, poseAt as any);
    expect(p.pose).toBe('sit');
  });
});

describe('fixture mode', () => {
  it('?fixture=now stays fixture; absence is live', () => {
    expect(isFixtureMode('?fixture=now')).toBe(true);
    expect(isFixtureMode('')).toBe(false);
    expect(parseMode('?fixture=now&t=1')).toEqual({ mode: 'fixture', fixture: 'now' });
    const src = readFileSync(new URL('../public/cam.js', import.meta.url), 'utf8');
    expect(src).toContain('/cam/fixture/now.json');
  });
});

describe('purity of drawing modules', () => {
  it('no wall-clock or random calls in cam.js, cam-anim.js, cam-window.js, cam-rig.js', () => {
    for (const f of ['cam.js', 'cam-anim.js', 'cam-window.js', 'cam-rig.js', 'cam-scene.js', 'cam-props.js']) {
      const src = readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/\bDate\b/);
      expect(src, f).not.toMatch(/Math\.random/);
    }
  });
});

describe('room field and first-load default (B5)', () => {
  it('stores room and picks bed or centre sleepy pose', async () => {
    const body: any = { server_now: 1000, timeline_until: 2000, objects: [{ id: 'b', kind: 'bed', x: 8, y: 6, z: 0 }], segments: [], weather: null, room: { grid: { w: 10, h: 8 }, window: 'london' } };
    const { fn } = fakeFetch(() => jsonRes(body, 'W/"r-1"'));
    const live = new LiveTimeline({ fetchFn: fn, perfNow: () => 0, wallNow: () => 1000 });
    await live.fetchOnce(1000);
    expect((live as any).room).toEqual({ grid: { w: 10, h: 8 }, window: 'london' });
    expect(firstLoadPose(body.objects, { w: 10, h: 8 })).toEqual({ x: 8, y: 6, z: 0, pose: 'sleepy', facing: 1 });
    expect(firstLoadPose([], { w: 10, h: 8 })).toEqual({ x: 5, y: 4, z: 0, pose: 'sleepy', facing: 1 });
  });
});
