import { describe, it, expect } from 'vitest';
import { tileBBox3857, countTiles, lon2tile, lat2tile } from './tilemath.mjs';

describe('tilemath', () => {
	it('z0 covers the whole mercator square', () => {
		const [a, b, c, d] = tileBBox3857(0, 0, 0);
		expect(a).toBeCloseTo(-20037508.34, 1);
		expect(d).toBeCloseTo(20037508.34, 1);
		expect(c - a).toBeCloseTo(d - b, 3);
	});
	it('tile index of Malta at z12', () => {
		expect(lon2tile(14.5, 12)).toBe(2212);
		expect(lat2tile(35.9, 12)).toBe(1609);
	});
	it('counts tiles of a bbox over zoom levels', () => {
		const bbox = [14.4, 35.8, 14.6, 36.0];
		expect(countTiles(bbox, 10, 10)).toBeGreaterThanOrEqual(1);
		expect(countTiles(bbox, 10, 14)).toBeGreaterThan(countTiles(bbox, 10, 13));
	});
});
