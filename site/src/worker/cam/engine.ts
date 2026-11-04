import { SENSATIONS } from '../../../public/cam-shared.js';
import { random, rng, hash } from './rng.ts';
import type { WorldState, Sensations, Sensation, Appraisal, Interaction, CamObject } from './types.ts';
export const RULES = Object.freeze({
    temperature: 0.3, P: 1, N: 0.8, H: 0.6, C: 0.8, I: 1.2, energySleep: 0.09, energyActive: -0.12, energyPlay: -0.02,
    prefRate: 0.00025, dailyCap: 0.10, sleepThreshold: 0.6, sleepEnergyWeight: 5
});
export const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const map = (value: number) => Object.fromEntries(SENSATIONS.map(s => [s, value])) as Record<Sensation, number>;
export function initialState(at = 0): WorldState {
    return {
        nori: {
            energy: 0.7, curiosity: 0.6, security: 0.7, asleep: false, sleep_started_at: null, variant: 'default'
        }, prefs: map(0.5), wariness: map(0), familiarity: {}, novelty: {}, habits: {}, missing: [], settled_through: at
    };
}
const london = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23'
});
const dayFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
});
let cachedHour = NaN;
let cachedLondonHour = 0;
let cachedLondonDay = '';
function calendar(t: number) {
    const hour = Math.floor(t / 3600000);
    if (hour !== cachedHour) {
        cachedHour = hour;
        cachedLondonHour = Number(london.format(t));
        cachedLondonDay = dayFormat.format(t);
    }
}
export function londonHour(t: number): number {
    calendar(t);
    return cachedLondonHour;
}
export function londonDay(t: number): string {
    calendar(t);
    return cachedLondonDay;
}
export function circadian(t: number): number {
    const h = londonHour(t);
    return h < 4 ? 1.6 : h < 8 ? 0.2 : h < 12 ? 0.1 : h < 16 ? -0.4 : h < 21 ? 0.2 : 1.6;
}
export function assess(state: WorldState, objectId: string, sensations: Sensations, interactionId: string, segmentId: number): Appraisal {
    const n = state.nori, startle = clamp((sensations.sound || 0) * 0.7 + (sensations.motion ||
        0) * 0.5 - 0.4 - 0.3 * (state.familiarity[objectId] || 0) - 0.2 * n.security);
    const match = Object.entries(sensations).reduce((v, [s, w]) => v + w! * (state.prefs[s as Sensation] - 0.5) * 2, 0);
    const appraisal = clamp(match + 0.5 * (state.novelty[objectId] ?? 1) * n.curiosity - 0.8 * startle +
        0.4 * (n.security - 0.5) + 0.2 * (n.energy - 0.5) + (random(interactionId, segmentId) * 0.6 - 0.3), -1, 1);
    return {
        startle, appraisal, reaction: appraisal > 0.3 ? 'love' : appraisal > 0.1 ? 'question' : appraisal >= -0.1 ? 'meh' : 'unimpressed'
    };
}
export function continuous(state: WorldState, start: number, end: number, action: string): WorldState {
    const s: WorldState = {
        ...state, nori: {
            ...state.nori
        }, prefs: {
            ...state.prefs
        }, wariness: {
            ...state.wariness
        }, familiarity: {
            ...state.familiarity
        }, novelty: {
            ...state.novelty
        }, habits: {
            ...state.habits
        }, pref_deltas: {
            ...state.pref_deltas
        }
    }, hours = Math.max(0, end - start) / 3600000, sleep = action === 'sleep';
    s.nori.energy = clamp(s.nori.energy + hours * (sleep ? RULES.energySleep : RULES.energyActive +
        (action === 'play' ? RULES.energyPlay : 0)));
    s.nori.curiosity = 0.4 + (s.nori.curiosity - 0.4) * Math.pow(0.9, hours);
    for (const k of SENSATIONS)
        s.wariness[k] *= Math.pow(0.9, hours / 24);
    s.nori.asleep = sleep;
    s.nori.sleep_started_at = sleep ? (s.nori.sleep_started_at ?? start) : null;
    s.settled_through = end;
    return s;
}
export function preference(state: WorldState, s: Sensation, delta: number, at: number): number {
    const day = londonDay(at);
    if (state.pref_day !== day) {
        state.pref_day = day;
        state.pref_deltas = {};
    }
    const used = state.pref_deltas?.[s] || 0, allowed = clamp(used + delta, -RULES.dailyCap, RULES.dailyCap) - used;
    const actual = clamp(state.prefs[s] + allowed, 0.05, 0.95) - state.prefs[s];
    state.prefs[s] += actual;
    state.pref_deltas ??= {};
    state.pref_deltas[s] = used + actual;
    return actual;
}
export function utility(state: WorldState, object: CamObject, ix: Interaction, t: number, distance = 0, intent = 0): number {
    const sensations = ix.spec.sensations;
    const P = Object.entries(sensations).reduce((v, [s, w]) => v + w! * (state.prefs[s as Sensation] - 0.5), 0);
    const wariness = Object.entries(sensations).reduce((v, [s, w]) => v + w! * state.wariness[s as Sensation], 0);
    const h = state.habits[ix.id], H = (state.familiarity[object.id] || 0) + (h ? h.good / (h.n + 2) : 0);
    const sleep = ix.spec.steps.some(s => s.p === 'sleep');
    const C = (sleep ? (RULES.sleepThreshold - state.nori.energy) * RULES.sleepEnergyWeight +
        circadian(t) : state.nori.energy - 0.5) - distance * 0.04;
    return RULES.P * P + RULES.N * (state.novelty[object.id] ?? 1) + RULES.H * H + RULES.C * C + RULES.I * intent - 0.5 * wariness;
}
export function choose(scores: number[], version: number, start: number): number {
    if (!scores.length)
        return -1;
    const r = rng(hash(version, start)), noisy = scores.map(v => v + (r() - 0.5) * 0.1), max = Math.max(...noisy),
      weights = noisy.map(v => Math.exp((v - max) / RULES.temperature));
    let draw = r() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
        draw -= weights[i];
        if (draw <= 0)
            return i;
    }
    return weights.length - 1;
}
// Event handlers for A1b: call only within its settlement/CAS transaction.
export function objectArrived(input: WorldState, objectId: string): WorldState {
    const s = structuredClone(input);
    s.novelty[objectId] = 1;
    s.familiarity[objectId] ??= 0;
    s.nori.curiosity = clamp(s.nori.curiosity + 0.3);
    return s;
}
export function objectRemoved(input: WorldState, object: CamObject, at: number): WorldState {
    const s = structuredClone(input);
    s.missing = s.missing.filter(m => m.object_id !== object.id);
    s.missing.push({
        object_id: object.id, kind: object.kind, x: object.x, y: object.y, familiarity: s.familiarity[object.id] || 0, since: at
    });
    return s;
}
export function wakeResponse(state: WorldState, eventId: string, at: number, version: number, forced = false): boolean {
    if (!state.nori.asleep)
        return true;
    const elapsed = Math.max(0, at - (state.nori.sleep_started_at ?? at)) / 60000;
    const depth = Math.min(1, elapsed / 20) * Math.max(0, 1 - elapsed / 90);
    const wakes = forced || random(version, eventId, at) < clamp(state.nori.curiosity * (1 - 0.8 * depth));
    if (wakes) {
        state.nori.security = clamp(state.nori.security - 0.05);
        state.nori.asleep = false;
        state.nori.sleep_started_at = null;
    }
    return wakes;
}
