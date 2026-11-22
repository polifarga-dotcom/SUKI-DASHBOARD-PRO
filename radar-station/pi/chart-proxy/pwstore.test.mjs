import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pwStore } from './pwstore.mjs';
import { msg } from './gribfake.mjs';

const gpx = (lon) => `<?xml version="1.0"?><gpx><rte><name>x</name><rtept lat="35.9" lon="14.5"/><rtept lat="36.5" lon="${lon}"/></rte></gpx>`;

describe('pwStore route import', () => {
	it('same file name with new content overwrites the route instead of adding one', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-'));
		let list = [];
		const pw = pwStore(dir, { read: async () => list, write: async (l) => (list = l) });
		const f = path.join(dir, 'routes', 'Offshore_Route_PWG_20261121_1048Z.gpx');
		await fs.mkdir(path.dirname(f));
		await fs.writeFile(f, gpx(15.1));
		await pw.scan();
		expect(list.length).toBe(1);
		list[0].color = '#123456';
		await pw.scan(); // unverändert → nichts passiert
		expect(list.length).toBe(1);
		await fs.writeFile(f, gpx(15.25)); // andere Größe/Zeit
		await fs.utimes(f, new Date(), new Date(Date.now() + 5000));
		await pw.scan();
		expect(list.length).toBe(1);
		expect(list[0].pts[1].lon).toBe(15.25);
		expect(list[0].color).toBe('#123456');
	});
	it('deletes GRIB files whose last forecast time has passed', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-'));
		const pw = pwStore(dir, { read: async () => [], write: async () => {} });
		// Lauf 21.11.2026 00 UTC, letzter Schritt +3 h → abgelaufen
		const u = [1, 2, 3, 4, 5, 6], z = [0, 0, 0, 0, 0, 0];
		const buf = Buffer.from([...msg({ param: 33, values: u }), ...msg({ param: 34, values: z }), ...msg({ param: 33, hour: 3, values: u }), ...msg({ param: 34, hour: 3, values: z })]);
		const f = path.join(dir, '20261121_0545_PWG_All_8km_3h_37.250_14.291__14.291_37.250_.040.grb');
		await fs.writeFile(f, buf);
		await pw.scan();
		await expect(fs.stat(f)).rejects.toThrow();
		expect(await pw.models()).toEqual([]);
	});
	it('removes one model or all GRIB files', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-'));
		const pw = pwStore(dir, { read: async () => [], write: async () => {} });
		const u = [1, 2, 3, 4, 5, 6], z = [0, 0, 0, 0, 0, 0];
		const buf = Buffer.from([...msg({ param: 33, values: u }), ...msg({ param: 34, values: z })]);
		const a = path.join(dir, '20261121_0545_PWG_All_8km_3h_37.250_14.291__14.291_37.250_.040.grb');
		const b = path.join(dir, '20261121_0545_ICON_All_5km_3h_37.250_14.291__14.291_37.250_.040.grb');
		const c = path.join(dir, '20261121_0540_UKMO_WRCTPG_10k_7d_24h_43N_32S_23E_12W.grb');
		await Promise.all([fs.writeFile(a, buf), fs.writeFile(b, buf), fs.writeFile(c, 'PW01 encrypted')]);
		const realNow = Date.now;
		Date.now = () => Date.UTC(2026, 10, 20); // vor dem Lauf → nichts abgelaufen
		try {
			expect(await pw.remove('pw_pwg_all_8km')).toBe(1);
			expect((await pw.models()).map((m) => m.id)).toEqual(['pw_icon_all_5km']);
			expect(await pw.remove('all')).toBe(2);
			expect(await fs.readdir(dir)).toEqual([]);
		} finally {
			Date.now = realNow;
		}
	});
});
