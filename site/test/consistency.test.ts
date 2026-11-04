// Byte-for-byte consistency with the Python code (ground truth: fixtures/consistency.json, made by app/scripts/make_site_fixtures.py).
import { describe, expect, it } from 'vitest';
import demo from '../public/data/demo-events.json';
import { EVENTS } from '../src/worker/api.ts';
import { MODEL, SYSTEM, buildPayload, dumps, optionsList, parseChoice, project, pyStrip, type DemoEvent } from '../src/worker/nori.ts';
import { fixture } from './helpers.ts';

const fx = fixture();

describe('payload consistency with app/nori (5 fixed inputs, current + original view)', () => {
  it('uses the same model and system prompt text', () => {
    expect(MODEL).toBe(fx.model);
    expect(SYSTEM).toBe(fx.system);
  });
  it('the Worker data holds the same events as the Python side (titles, order, valence)', () => {
    expect(EVENTS.map((e: DemoEvent) => [e.id, e.title, e.valence])).toEqual(demo.events.map((e) => [e.id, e.title, e.valence]));
    expect(EVENTS).toHaveLength(20);
  });
  for (const c of fx.cases) {
    it(`case ${c.name}: byte-identical payload JSON`, () => {
      for (const view of ['current', 'original'] as const) {
        const got = dumps(buildPayload(project(EVENTS, c.input.edits, view), c.input.options));
        expect(got).toBe(c.expected[view]); // string equality = every character
        expect(new TextEncoder().encode(got)).toEqual(new TextEncoder().encode(c.expected[view])); // and every UTF-8 byte
      }
    });
  }
  it('the original view ignores edits; the current view drops deleted events', () => {
    const c = fx.cases[1];
    expect(project(EVENTS, c.input.edits, 'original')).toHaveLength(20);
    expect(project(EVENTS, c.input.edits, 'current')).toHaveLength(19);
  });
  it('every memory entry is exactly 384 UTF-8 bytes of compact JSON', () => {
    for (const m of project(EVENTS, {}, 'original')) expect(new TextEncoder().encode(dumps(m)).length).toBe(384);
  });
});

describe('Python str.strip() semantics', () => {
  it('strips NBSP, ideographic space and \\x1f but keeps U+FEFF', () => {
    expect(pyStrip(' 　 hi \x1f')).toBe('hi');
    expect(pyStrip('﻿hi')).toBe('﻿hi');
  });
  it('optionsList rejects anything but six non-blank strings', () => {
    expect(() => optionsList(['a', 'b'])).toThrow();
    expect(() => optionsList(['a', 'b', 'c', 'd', 'e', ' '])).toThrow();
    expect(optionsList(['a', 'b', 'c', 'd', 'e', ' f '])[5]).toEqual({ id: 'A5', text: 'f' });
  });
});

describe('parse_choice matches Python on good and bad model output', () => {
  for (const c of fx.parse_choice) {
    it(`parse_choice: ${c.name}`, () => {
      expect(parseChoice(c.raw, c.options)).toEqual(c.expected);
    });
  }
});
