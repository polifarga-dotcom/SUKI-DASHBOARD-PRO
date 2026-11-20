import { describe, it, expect } from 'vitest';
import { wxArea, wxNeedsReload } from './weather.svelte';
import { drawIsobars, prepare, sample, timeIndex, colorAt, tileLatLon, type WxField } from './wxField';

const field = (kind: WxField['kind'], s: (number | null)[], d: (number | null)[]): WxField =>
	prepare({ model: 'm', kind, lat0: 36, lon0: 14, dlat: 1, dlon: 1, nx: 2, ny: 2, t0: 0, dt: 3600e3, nt: 1, s, d, p: null, fetched: 0 });

describe('weather field', () => {
	it('interpolates speed and keeps the direction convention', () => {
		const w = field('wind', [10, 20, 10, 20], [270, 270, 270, 270]);
		const s = sample(w, 0, 36.5, 14.5)!;
		expect(s.s).toBeCloseTo(15);
		expect(s.dir).toBeCloseTo(270); // Wind „woher“ bleibt „woher“
		const c = field('current', [1, 1, 1, 1], [90, 90, 90, 90]);
		expect(sample(c, 0, 36.2, 14.2)!.dir).toBeCloseTo(90); // Strömung „wohin“
	});
	it('interpolates directions across north without averaging to south', () => {
		const w = field('wind', [10, 10, 10, 10], [350, 10, 350, 10]);
		const dir = sample(w, 0, 36.5, 14.5)!.dir;
		expect(Math.min(dir, 360 - dir)).toBeLessThan(1);
	});
	it('ignores land points and returns null outside the grid or the model time', () => {
		const w = field('wave', [null, 2, null, 2], [0, 0, 0, 0]);
		expect(sample(w, 0, 36.5, 14.9)!.s).toBeCloseTo(2);
		expect(sample(w, 0, 36.5, 14.05)).toBeNull(); // nächster Punkt Land
		expect(sample(w, 0, 36.5, 14.6)!.s).toBeCloseTo(2); // nächster Punkt Meer
		expect(sample(w, 0, 40, 14.5)).toBeNull();
		expect(timeIndex(w, 1800e3 + 1)).toBe(-1);
		expect(timeIndex(w, 1000)).toBe(0);
	});
	it('colours and tile maths', () => {
		expect(colorAt('wind', 0)).toEqual([40, 60, 150]);
		expect(colorAt('wind', 999)).toEqual([100, 20, 120]);
		const [lat, lon] = tileLatLon(1, 1, 1);
		expect(lat).toBeCloseTo(0);
		expect(lon).toBeCloseTo(0);
	});
});

describe('isobars', () => {
	it('draws one line per 2 hPa level crossing the tile', () => {
		// Druck steigt nach rechts: 1000 … 1004 über 3 × 3 Punkte → Linien bei 1000, 1002, 1004
		const q = [1000, 1002, 1004, 1000, 1002, 1004, 1000, 1002, 1004];
		const lines: number[] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get: (o, k) => (k === 'moveTo' ? (x: number) => lines.push(x) : k in o ? o[k as string] : () => {}),
			set: (o, k, v) => ((o[k as string] = v), true)
		}) as unknown as CanvasRenderingContext2D;
		drawIsobars(ctx, 256, q, 2);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((x) => [0, 128, 256].includes(Math.round(x)))).toBe(true);
	});
});

describe('weather area follows the view', () => {
	it('uses the visible area, at least the set size, in cache-friendly steps', () => {
		expect(wxArea({ lat: 36, lon: 14 }, null, 100)).toEqual({ lat: 36, lon: 14, r: 100 });
		const small = wxArea(null, [14, 35.9, 14.1, 36], 100)!;
		expect(small.r).toBe(100);
		const big = wxArea(null, [4, 26, 24, 46], 100)!; // ±10° → ~600 sm
		expect(big.r).toBe(800);
		expect(big.lat).toBe(36);
	});
	it('reloads on zoom change or when the view leaves the loaded area', () => {
		const a = { lat: 36, lon: 14, r: 100 };
		expect(wxNeedsReload(undefined, a)).toBe(true);
		expect(wxNeedsReload(a, { ...a, lat: 36.2 })).toBe(false); // 12 sm
		expect(wxNeedsReload(a, { ...a, lat: 37 })).toBe(true); // 60 sm
		expect(wxNeedsReload(a, { ...a, r: 200 })).toBe(true);
	});
});
