import { describe, it, expect } from 'vitest';
import { trueWind } from './instruments';
import { D2R } from './geo';

describe('trueWind', () => {
	it('head wind: true wind = apparent minus boat speed', () => {
		const r = trueWind(10, 0, 4);
		expect(r.tws).toBeCloseTo(6, 6);
		expect(r.twa).toBeCloseTo(0, 6);
	});
	it('boat at rest: true = apparent', () => {
		const r = trueWind(8, 90 * D2R, 0);
		expect(r.tws).toBeCloseTo(8, 6);
		expect(r.twa).toBeCloseTo(90 * D2R, 6);
	});
	it('beam reach: true wind is further aft than apparent', () => {
		const r = trueWind(12, 60 * D2R, 6);
		expect(r.twa).toBeGreaterThan(60 * D2R);
		expect(r.tws).toBeCloseTo(Math.sqrt(144 + 36 - 2 * 12 * 6 * Math.cos(60 * D2R)), 6);
	});
	it('port side keeps negative angle', () => {
		expect(trueWind(10, -45 * D2R, 5).twa).toBeLessThan(0);
	});
});
