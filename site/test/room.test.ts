import { describe, expect, it } from 'vitest';
import logic from '../public/room-logic.js';

describe('room-logic activity sprites', () => {
  it('maps sleeping to sleep-pillow on the cushion', () => {
    expect(logic.activityLayout('sleeping').sprite).toBe('sleep-pillow');
  });

  it('maps reading to laptop and browsing to browse at the desk', () => {
    expect(logic.activityLayout('reading').sprite).toBe('laptop');
    expect(logic.activityLayout('browsing').sprite).toBe('browse');
  });

  it('maps watching, drawing, posting, and thinking', () => {
    expect(logic.activityLayout('watching').sprite).toBe('watching');
    expect(logic.activityLayout('drawing').sprite).toBe('sketch');
    expect(logic.activityLayout('posting').sprite).toBe('phone-send');
    expect(logic.activityLayout('thinking').sprite).toBe('ponder');
  });

  it('falls back to sleeping for unknown activity', () => {
    expect(logic.activityLayout('unknown').sprite).toBe('sleep-pillow');
  });
});

describe('room-logic day/night background', () => {
  it('uses day background from 06:00 through 17:59', () => {
    expect(logic.backgroundForHour(6)).toBe('day');
    expect(logic.backgroundForHour(12)).toBe('day');
    expect(logic.backgroundForHour(17)).toBe('day');
  });

  it('uses night background outside daytime hours', () => {
    expect(logic.backgroundForHour(5)).toBe('night');
    expect(logic.backgroundForHour(18)).toBe('night');
    expect(logic.backgroundForHour(23)).toBe('night');
  });
});

describe('room-logic media URL whitelist', () => {
  it('accepts safe /media/ filenames', () => {
    expect(logic.safeMediaUrl('/media/nori-post.jpg')).toBe('/media/nori-post.jpg');
    expect(logic.safeMediaUrl('/media/x.webp')).toBe('/media/x.webp');
  });

  it('rejects javascript:, protocol-relative, and path traversal', () => {
    expect(logic.safeMediaUrl('javascript:alert(1)')).toBe('');
    expect(logic.safeMediaUrl('//evil.com/x.png')).toBe('');
    expect(logic.safeMediaUrl('/media/../secret.png')).toBe('');
    expect(logic.safeMediaUrl('/room/bg-day.jpg')).toBe('');
    expect(logic.safeMediaUrl('/media/bad.exe')).toBe('');
  });
});

describe('room-logic owner edit display', () => {
  it('labels delete without exposing the title', () => {
    const line = logic.formatEditLine({
      ts: '2026-10-01T12:00:00+00:00',
      op: 'delete',
      event_id: 'E1',
      title: 'Secret title',
      told_at: null,
    });
    expect(line.action).toBe('removed');
    expect(line.title).toBe('(removed — title not shown)');
    expect(line.told).toBe("Nori hasn't woken up since");
  });

  it('shows neutralize and restore actions with titles', () => {
    expect(
      logic.formatEditLine({
        ts: '2026-10-01T12:00:00+00:00',
        op: 'neutralize',
        event_id: 'E2',
        title: 'Lighthouse',
        told_at: '2026-10-02T08:00:00+00:00',
      }).action,
    ).toBe('set to neutral');
    expect(
      logic.formatEditLine({
        ts: '2026-10-01T12:00:00+00:00',
        op: 'restore',
        event_id: 'E2',
        title: 'Lighthouse',
        told_at: '2026-10-02T08:00:00+00:00',
      }).action,
    ).toBe('restored');
  });
});

describe('room-logic unavailable data defaults', () => {
  it('defaults to sleeping and a friendly unavailable message', () => {
    const d = logic.unavailableDefaults();
    expect(d.activity).toBe('sleeping');
    expect(d.banner).toBe("Nori's live data is not available right now.");
    expect(d.available).toBe(false);
  });
});

describe('room-logic wake step labels', () => {
  it('marks failed steps as could not complete', () => {
    expect(
      logic.formatWakeStep({
        label: 'Opened a page',
        title: null,
        ok: false,
      }),
    ).toBe("Opened a page (couldn't)");
    expect(
      logic.formatWakeStep({
        label: 'Read Wikipedia',
        title: 'Sample Lighthouse',
        ok: true,
      }),
    ).toBe('Read Wikipedia: Sample Lighthouse');
  });
});

describe('room-logic projectsView', () => {
  it('returns empty lists when projects is missing', () => {
    expect(logic.projectsView({})).toEqual({ active: [], finished: [] });
    expect(logic.projectsView(null)).toEqual({ active: [], finished: [] });
  });

  it('returns empty lists when projects is not an object', () => {
    expect(logic.projectsView({ projects: null })).toEqual({ active: [], finished: [] });
    expect(logic.projectsView({ projects: [] })).toEqual({ active: [], finished: [] });
  });

  it('reverses active project steps newest-first for display', () => {
    const room = {
      projects: {
        active: [
          {
            id: 'a1',
            title: 'T',
            steps: [
              { at: '2026-11-01T12:00:00+00:00', text: 'first', post_receipt: null },
              { at: '2026-11-01T13:00:00+00:00', text: 'second', post_receipt: 'p1' },
            ],
          },
        ],
        finished: [],
      },
    };
    const view = logic.projectsView(room);
    const steps = (view.active[0] as { steps: { text: string }[] }).steps;
    expect(steps.map((s) => s.text)).toEqual(['second', 'first']);
  });

  it('does not mutate the original room object', () => {
    const steps = [{ at: '2026-11-01T12:00:00+00:00', text: 'only', post_receipt: null }];
    const room = { projects: { active: [{ id: 'x', steps }], finished: [] } };
    logic.projectsView(room);
    expect(room.projects.active[0].steps).toBe(steps);
    expect(room.projects.active[0].steps[0].text).toBe('only');
  });
});

describe('room-logic projectStatusLabel', () => {
  it('maps active, done, dropped, and unknown statuses', () => {
    expect(logic.projectStatusLabel('active')).toBe('working on it');
    expect(logic.projectStatusLabel('done')).toBe('finished');
    expect(logic.projectStatusLabel('dropped')).toBe('set aside');
    expect(logic.projectStatusLabel('paused')).toBe('unknown');
  });
});

describe('room-logic receiptHref', () => {
  it('returns a posts hash link for valid receipts', () => {
    expect(logic.receiptHref('p1')).toBe('/posts#p1');
    expect(logic.receiptHref('p42')).toBe('/posts#p42');
  });

  it('returns null for invalid receipts', () => {
    expect(logic.receiptHref('p1x')).toBeNull();
    expect(logic.receiptHref('../x')).toBeNull();
    expect(logic.receiptHref('')).toBeNull();
    expect(logic.receiptHref(null)).toBeNull();
  });
});
