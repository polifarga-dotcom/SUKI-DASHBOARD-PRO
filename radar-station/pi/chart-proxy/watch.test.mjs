import { describe, it, expect } from 'vitest';
import { PRESETS, schedule, watchNow, watchList, cleanWatch, zoned, hhmm } from './watch.mjs';

const TZ = 'Europe/Rome';
const crew = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id.toUpperCase() }));
const teams = [
	{ id: 'A', name: 'Team A', members: ['a', 'b'] },
	{ id: 'B', name: 'Team B', members: ['c', 'd'] },
	{ id: 'C', name: 'Team C', members: ['e', 'f'] }
];
const plan = (preset, units, extra = {}) => {
	const p = PRESETS.find((x) => x.id === preset);
	return { tz: TZ, crew, teams, model: { preset, mode: p.mode, starts: p.starts, units, start: '2026-11-20', shift: p.shift, on: p.on }, overrides: [], ...extra };
};
const T3 = ['A', 'B', 'C'].map((id) => ({ t: 'team', id }));
const day = (d, h = 0) => zoned(2026, 11, d, h * 60, TZ);
/** Team, das am Tag d um Stunde h Wache hat */
const who = (doc, d, h) => schedule(doc, day(d, h), day(d, h) + 1).map((e) => e.units.map((u) => u.id).join('+'))[0];

describe('watch planner', () => {
	it('classic 4/8 with dog watches rotates the night watch daily', () => {
		const doc = plan('classic48', T3);
		expect([0, 4, 8, 12, 16, 18, 20].map((h) => who(doc, 20, h))).toEqual(['A', 'B', 'C', 'A', 'B', 'C', 'A']);
		expect(who(doc, 21, 0)).toBe('B'); // 7 Wachen/Tag → nächste Nacht das nächste Team
		expect(who(doc, 22, 0)).toBe('C');
	});
	it('merchant 4/8 keeps the same hours every day', () => {
		const doc = plan('merchant48', T3);
		for (const d of [20, 21, 25]) expect([0, 4, 8, 12, 16, 20].map((h) => who(doc, d, h))).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
	});
	it('four crew: 3 on / 9 off fixed, 4 on / 12 off rotating', () => {
		const P4 = ['a', 'b', 'c', 'd'].map((id) => ({ t: 'person', id }));
		const f = plan('three9', P4);
		for (const d of [20, 23]) expect([0, 3, 6, 9, 12, 15, 18, 21].map((h) => who(f, d, h))).toEqual(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd']);
		const r = plan('four12', P4);
		expect([0, 4, 8, 12, 16, 20].map((h) => who(r, 20, h))).toEqual(['a', 'b', 'c', 'd', 'a', 'b']);
		expect(who(r, 21, 0)).toBe('c'); // nächster Tag läuft weiter
	});
	it('swedish: 6 h day, 4 h night, wraps over midnight', () => {
		const doc = plan('swedish', T3.slice(0, 2));
		const es = schedule(doc, day(20, 3), day(21, 3));
		expect(es.map((e) => (e.end - e.start) / 36e5)).toEqual([4, 6, 6, 4, 4]);
		expect(who(doc, 21, 1)).toBe(who(doc, 20, 23)); // 23–03 ist eine Wache
	});
	it('rolling watch: two on, one changes every hour', () => {
		const P = ['a', 'b', 'c', 'd'].map((id) => ({ t: 'person', id }));
		const doc = plan('rolling', P);
		const at = (h) => schedule(doc, day(20, h) + 1, day(20, h) + 2).flatMap((e) => e.members).sort().join('');
		expect([at(0), at(1), at(2)]).toEqual(['ad', 'ab', 'bc']);
		const n = watchNow(doc, day(20, 1) + 30 * 6e4);
		expect(n.now.names.sort()).toEqual(['A', 'B']);
		expect(n.atText).toBe('02:00');
	});
	it('override replaces one watch, watchNow gives label, change time and 10-min notice', () => {
		const doc = plan('classic48', T3, { overrides: [{ start: day(20, 4), units: [{ t: 'team', id: 'C' }] }] });
		expect(who(doc, 20, 4)).toBe('C');
		const n = watchNow(doc, day(20, 4) - 5 * 6e4);
		expect(n).toMatchObject({ now: { label: 'Team A', names: ['A', 'B'] }, next: { label: 'Team C' }, atText: '04:00', inMin: 5, soon: true });
	});
	it('handles DST end (25-hour day) in ship time', () => {
		const doc = { ...plan('merchant48', T3), model: { ...plan('merchant48', T3).model, start: '2026-10-24' } };
		const es = schedule(doc, zoned(2026, 10, 25, 0, TZ), zoned(2026, 10, 26, 0, TZ));
		expect(es.map((e) => hhmm(e.start, TZ))).toEqual(['00:00', '04:00', '08:00', '12:00', '16:00', '20:00']);
		expect((es[0].end - es[0].start) / 36e5).toBe(5); // Uhr wird zurückgestellt
	});
	it('stopped plan shows no watch; old plans count as running', () => {
		expect(watchNow({ ...plan('classic48', T3), active: false }, day(20, 1)).on).toBe(false);
		expect(cleanWatch(plan('classic48', T3)).active).toBe(true);
		expect(cleanWatch({ ...plan('classic48', T3), active: false }).active).toBe(false);
	});
	it('watchList gives flat entries with name, colour and lane', () => {
		const P = ['a', 'b', 'c'].map((id) => ({ t: 'person', id }));
		const l = watchList(plan('rolling', P), day(20, 0), day(20, 3));
		expect(l.map((x) => x.l)).toContain('A');
		expect(new Set(l.map((x) => x.n))).toEqual(new Set([0, 1]));
		const f = watchList(plan('three9', ['a', 'b', 'c', 'd'].map((id) => ({ t: 'person', id }))), day(20, 0), day(21, 0));
		expect(f.find((x) => x.s === day(20, 12))).toMatchObject({ l: 'A', rb: 9 * 60, ra: 9 * 60 }); // 3 an / 9 aus
		const c = watchList(plan('classic48', T3), day(20, 0), day(21, 0)).find((x) => x.s === day(20, 16));
		expect(c).toMatchObject({ l: 'Team B', rb: 8 * 60, ra: 6 * 60 }); // B: 04–08, 16–18, nächste Nacht 00–04
		expect(watchList({ ...plan('classic48', T3), active: false }, day(20, 0), day(21, 0))).toEqual([]);
	});
	it('validates input from the network', () => {
		expect(cleanWatch({ ...plan('classic48', T3), crew: Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, name: 'x' })) })).toMatch(/at most 8/);
		expect(cleanWatch({ ...plan('classic48', T3), tz: 'Mars/Base' })).toMatch(/time zone/);
		expect(cleanWatch({ ...plan('classic48', [{ t: 'team', id: 'X' }]) })).toMatch(/order/);
		const ok = cleanWatch({ ...plan('classic48', T3), crew: [...crew.slice(0, 1).map((c) => ({ ...c, name: 'N'.repeat(99), evil: 1 })), ...crew.slice(1)] });
		expect(ok.crew[0].name.length).toBe(30);
		expect(ok.crew[0].evil).toBeUndefined();
		expect(ok.teams[0].members).toEqual(['a', 'b']);
	});
});
