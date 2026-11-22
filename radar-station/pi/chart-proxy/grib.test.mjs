import { describe, it, expect } from 'vitest';
import { gribIndex, gribSummary, gribField, pwFileInfo } from './grib.mjs';
import { msg } from './gribfake.mjs';

describe('grib1', () => {
	// 3×2 Gitter, Nord-Zeile zuerst: u = 1…6 m/s, v = 0
	const u = [1, 2, 3, 4, 5, 6], z = [0, 0, 0, 0, 0, 0];
	const buf = Buffer.from([
		...msg({ param: 33, values: u }), ...msg({ param: 34, values: z }),
		...msg({ param: 33, hour: 3, values: u }), ...msg({ param: 34, hour: 3, values: z }),
		...msg({ param: 2, ltype: 102, level: 0, values: [101300, 101300, 101300, 101300, 101300, 101300], D: -1 })
	]);
	it('indexes records with run, step and grid', () => {
		const r = gribIndex(buf);
		expect(r.length).toBe(5);
		expect(r[0].run).toBe(Date.UTC(2026, 10, 21));
		expect(r[2].valid - r[2].run).toBe(3 * 3600e3);
		expect(r[0].grid).toMatchObject({ ni: 3, nj: 2, la1: 38, lo1: 14, la2: 37, lo2: 16 });
	});
	it('builds a south-up weather field in kn, “from” direction and hPa', () => {
		const s = gribSummary(buf);
		expect(s.kind).toBe('wind');
		expect(s.times.length).toBe(2);
		const f = gribField(buf, s, 37.5, 15, 120);
		expect([f.nx, f.ny, f.lat0, f.dlat, f.dt]).toEqual([3, 2, 37, 1, 3 * 3600e3]);
		expect(f.s.slice(0, 3)).toEqual([4, 5, 6].map((v) => Math.round(v * 1.943844 * 100) / 100)); // Süd-Zeile zuerst
		expect(f.d[0]).toBe(270); // Wind nach Osten = aus Westen
		expect(f.q[0]).toBe(1013);
	});
	it('handles bitmaps (missing points → null)', () => {
		const bm = [1, 0, 1, 1, 1, 0];
		const b = Buffer.from([...msg({ param: 33, values: u, bitmap: bm }), ...msg({ param: 34, values: z, bitmap: bm })]);
		const f = gribField(b, gribSummary(b), 37.5, 15, 120);
		expect(f.s.map((v) => v != null)).toEqual([true, true, false, true, false, true]); // Süd: 4,5,6(fehlt) · Nord: 1,2(fehlt),3
	});
	it('rejects non-GRIB1 files and parses PredictWind names', () => {
		expect(gribSummary(Buffer.from('PW01 encrypted'))).toBeNull();
		expect(pwFileInfo('20261121_0545_PWG_All_8km_3h_37.250_14.291__14.291_37.250_.040.grb')).toEqual({ stamp: '20261121_0545', model: 'PWG', variant: 'All', res: '8km' });
		expect(pwFileInfo('20261121_0710_ECMWF_Wave_10k_7d_24h_44N_33S_23E_12W.grb').variant).toBe('Wave');
	});
});
