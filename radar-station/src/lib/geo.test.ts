import { describe, it, expect } from 'vitest';
import { antennaToRadar, toLocal, routeLength } from './geo';

const gps = { lat: 36, lon: 14 };
const off = (hdgDeg: number, fwd: number, stbd: number) => toLocal(gps, antennaToRadar(gps, (hdgDeg * Math.PI) / 180, fwd, stbd)).map((v) => Math.round(v * 100) / 100);

describe('GPS antenna offset', () => {
	it('moves the position from the GPS antenna to the radar antenna', () => {
		expect(off(0, 3, 0)).toEqual([0, -3]); // Kurs Nord, GPS 3 m voraus → Radar 3 m südlich
		expect(off(90, 3, 0)).toEqual([-3, 0]); // Kurs Ost → Radar 3 m westlich
		expect(off(0, 0, 2)).toEqual([-2, 0]); // GPS 2 m Steuerbord → Radar 2 m an Backbord (West)
		expect(off(180, 0, 2)).toEqual([2, 0]);
	});
});

describe('routeLength', () => {
	it('sums all legs', () => {
		const a = { lat: 0, lon: 0 }, b = { lat: 1 / 60, lon: 0 }, c = { lat: 1 / 60, lon: 1 / 60 };
		expect(routeLength([a])).toBe(0);
		expect(routeLength([a, b, c]) / 1852).toBeCloseTo(2, 2); // 1 sm Nord + 1 sm Ost
	});
});
