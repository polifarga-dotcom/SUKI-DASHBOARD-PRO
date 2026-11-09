import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackStore, trackDistance } from './track.mjs';

describe('track store', () => {
	it('appends per day, reads after t, prunes old days, clears', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trk-'));
		const s = trackStore(dir);
		await s.init();
		const d0 = Date.UTC(2026, 10, 1, 12);
		const day = 86400e3;
		for (const t of [d0, d0 + 1000, d0 + 2 * day, d0 + 5 * day]) await s.append([t, 35.9, 14.5]);
		expect((await s.info()).files).toBe(3);
		expect((await s.read(d0)).map((p) => p[0])).toEqual([d0 + 1000, d0 + 2 * day, d0 + 5 * day]);
		expect((await s.read(d0 + 3 * day)).length).toBe(1);
		await s.prune(3, d0 + 5 * day); // behält 2026-11-03 … 2026-11-06
		expect((await s.info()).first).toBe('2026-11-03');
		await s.clear();
		expect((await s.info()).files).toBe(0);
		await fs.rm(dir, { recursive: true });
	});
	it('sums distance and skips GPS jumps', () => {
		// 1 Bogenminute Breite = 1 sm; 10 min je Schritt (6 kn); dritter Punkt springt 60 sm in 10 s
		const pts = [[0, 36, 14], [600e3, 36 + 1 / 60, 14], [610e3, 37 + 1 / 60, 14], [1210e3, 36 + 2 / 60, 14]];
		expect(trackDistance(pts.slice(0, 2)) / 1852).toBeCloseTo(1, 2);
		expect(trackDistance(pts) / 1852).toBeCloseTo(1, 2); // Hin- und Rücksprung zählen beide nicht
		expect(trackDistance([[0, 36, 14], [600e3, 36 + 1 / 60, 14], [1200e3, 36 + 2 / 60, 14]]) / 1852).toBeCloseTo(2, 2);
	});
});
