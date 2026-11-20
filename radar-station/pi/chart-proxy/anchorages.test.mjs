import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchConvert, anchStore, cleanOwn, overpassQuery, coastConvert } from './anchorages.mjs';

const OSM = {
	elements: [
		{ type: 'node', id: 1, lat: 35.95, lon: 14.4, tags: { 'seamark:type': 'anchorage', name: 'St Paul', 'seamark:anchorage:category': 'small_craft', foo: 'x' } },
		{
			type: 'way',
			id: 2,
			tags: { leisure: 'marina', name: 'Msida' },
			geometry: [{ lat: 35.9, lon: 14.49 }, { lat: 35.9, lon: 14.5 }, { lat: 35.91, lon: 14.5 }, { lat: 35.9, lon: 14.49 }]
		},
		{ type: 'node', id: 3, lat: 35.8, lon: 14.5, tags: { 'seamark:type': 'mooring', 'seamark:mooring:category': 'buoy' } }
	]
};

describe('anchorages', () => {
	it('converts OSM elements, keeps only useful tags, closed ways as areas', () => {
		const a = anchConvert(OSM);
		expect(a.map((x) => x.kind)).toEqual(['anchorage', 'marina', 'mooring']);
		expect(a[0]).toMatchObject({ id: 'n1', name: 'St Paul', lat: 35.95 });
		expect(a[0].tags.foo).toBeUndefined();
		expect(a[1].poly.length).toBe(4);
		expect(overpassQuery(35, 14)).toContain('(35,14,36,15)');
	});
	it('caches a cell and serves it offline', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anch-'));
		let calls = 0, online = true;
		const fetchImpl = async () => {
			calls++;
			if (!online) throw new Error('offline');
			return { ok: true, json: async () => OSM };
		};
		const st = anchStore(dir, fetchImpl);
		expect((await st.get(35, 14)).items.length).toBe(3);
		await st.get(35, 14);
		expect(calls).toBe(1);
		const f = path.join(dir, '35_14.json');
		const j = JSON.parse(await fs.readFile(f, 'utf8'));
		j.fetched = 0;
		await fs.writeFile(f, JSON.stringify(j));
		online = false;
		const b = await anchStore(dir, fetchImpl).get(35, 14);
		expect(b.stale).toBe(true);
		expect(b.items.length).toBe(3);
		await fs.rm(dir, { recursive: true });
	});
	it('splits coastlines where Overpass clipped them at the cell edge', () => {
		const g = (a, b) => ({ lat: a, lon: b });
		const lines = coastConvert({ elements: [{ type: 'way', geometry: [g(35, 14), g(35.1, 14.1), null, g(35.5, 14.5), g(35.6, 14.6), g(35.7, 14.7)] }, { type: 'way', geometry: [g(1, 1)] }] });
		expect(lines).toEqual([[35, 14, 35.1, 14.1], [35.5, 14.5, 35.6, 14.6, 35.7, 14.7]]);
	});
	it('validates own anchorages from the network', () => {
		expect(cleanOwn({ lat: 'x', lon: 1 })).toBeNull();
		const a = cleanOwn({ lat: 36, lon: 14, name: 'A'.repeat(200), shelter: ['N', 'XX', 'SW'], depth: '6', evil: 1 });
		expect(a.name.length).toBe(80);
		expect(a.shelter).toEqual(['N', 'SW']);
		expect(a.depth).toBe(6);
		expect(a.evil).toBeUndefined();
		expect(cleanOwn({ lat: 36, lon: 14, depth: null }).depth).toBeNull(); // leer bleibt leer, nicht 0 m
	});
});
