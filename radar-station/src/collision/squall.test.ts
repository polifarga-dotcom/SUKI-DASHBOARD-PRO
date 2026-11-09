import { describe, it, expect } from 'vitest';
import { addSquallFix, squallEncounter, squallPos, pruneSqualls, type Squall } from './squall';
import { fromLocal, gcDist, gcBearing, NM } from '../lib/geo';

const own = { lat: 36, lon: 14 };

describe('squall tracking', () => {
	it('derives motion from two fixes and predicts arrival', () => {
		const t0 = 1_000_000;
		// Zelle 4 sm nördlich, zieht mit 10 kn nach Süden genau auf uns zu (wir liegen still)
		let list: Squall[] = addSquallFix([], fromLocal(own, 0, 4 * NM), t0);
		expect(squallEncounter(list[0], own, { course: 0, speed: 0 }, t0)).toBeNull();
		const t1 = t0 + 6 * 60e3; // 6 min später 1 sm weiter südlich
		list = addSquallFix(list, fromLocal(own, 0, 3 * NM), t1);
		expect(list.length).toBe(1);
		const e = squallEncounter(list[0], own, { course: 0, speed: 0 }, t1)!;
		expect(e.cpa).toBeLessThan(50);
		expect(e.tcpa / 60).toBeCloseTo(18, 0); // 3 sm bei 10 kn
		const p = squallPos(list[0], t1 + 6 * 60e3);
		expect(gcDist(own, p) / NM).toBeCloseTo(2, 1);
	});
	it('a far away mark starts a new cell, old cells expire', () => {
		const list = addSquallFix(addSquallFix([], fromLocal(own, 0, 4 * NM), 0), fromLocal(own, 6 * NM, 0), 1000);
		expect(list.length).toBe(2);
		expect(pruneSqualls(list, 95 * 60e3).length).toBe(0);
	});
	it('great circle helpers', () => {
		expect(gcDist({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) / NM).toBeCloseTo(60, 0);
		expect((gcBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) * 180) / Math.PI).toBeCloseTo(90, 5);
	});
});
