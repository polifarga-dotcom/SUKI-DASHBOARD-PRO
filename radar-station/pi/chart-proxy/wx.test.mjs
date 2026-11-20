import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wxGrid, wxUrl, wxConvert, wxStore, wxModel, wxInside, wxLimitReset, wxMeter, wxCost, periodEnd } from './wx.mjs';

const fake = (g, nt, kind) =>
	Array.from({ length: g.nx * g.ny }, (_, p) => ({
		hourly: {
			time: Array.from({ length: nt + 2 }, (_, i) => 1795000000 + i * 3600),
			...(kind === 'current'
				? { ocean_current_velocity: [...Array(nt).fill(1.852), null, null], ocean_current_direction: [...Array(nt).fill(90), null, null] }
				: { wind_speed_10m: [...Array(nt).fill(p === 0 ? null : 12.34), null, null], wind_direction_10m: [...Array(nt).fill(270), null, null], wind_gusts_10m: [...Array(nt).fill(20.04), null, null], pressure_msl: [...Array(nt).fill(1013.27), null, null] })
		}
	}));

describe('weather grid', () => {
	it('asks regional models only for points inside their area, rest stays empty', () => {
		const m = wxModel('meteofrance_arome_france_hd');
		const g = wxGrid(37.5, 12, 200, m.res); // Rand des AROME-Gebiets
		const inside = wxInside(m, g);
		expect(inside.length).toBeGreaterThan(0);
		expect(inside.length).toBeLessThan(g.nx * g.ny);
		expect(wxUrl(m, g).match(/latitude=([^&]+)/)[1].split(',').length).toBe(inside.length);
		const all = fake(g, 2, 'wind');
		const w = wxConvert(m, g, inside.map((i) => all[i]));
		const outIdx = [...Array(g.nx * g.ny).keys()].find((i) => !inside.includes(i));
		expect(w.s[outIdx]).toBeNull();
		expect(wxInside(m, wxGrid(35.9, 14.5, 25, m.res)).length).toBe(0); // Malta: außerhalb
	});
	it('skips corners outside a slanted model area (AROME)', () => {
		const m = wxModel('meteofrance_arome_france');
		const ids = (pts) => wxInside(m, { lat0: 0, lon0: 0, dlat: 0, dlon: 0, nx: 1, ny: 1, ...pts });
		expect(ids({ lat0: 42.1, lon0: 9 }).length).toBe(1); // Korsika
		expect(ids({ lat0: 39, lon0: 12.5 }).length).toBe(0); // SO-Ecke, außerhalb
		expect(ids({ lat0: 50, lon0: 14.5 }).length).toBe(1);
	});
	it('stops asking Open-Meteo after its limit is exceeded, until the limit resets', async () => {
		const now = Date.UTC(2026, 10, 20, 11, 20);
		expect(wxLimitReset('Hourly API request limit exceeded', now)).toBe(Date.UTC(2026, 10, 20, 12));
		expect(wxLimitReset('Daily API request limit exceeded', now)).toBe(Date.UTC(2026, 10, 21));
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wxl-'));
		let calls = 0;
		const st = wxStore(dir, async () => (calls++, { ok: false, status: 429, json: async () => ({ error: true, reason: 'Hourly API request limit exceeded. Please try again in the next hour.' }) }));
		const m = wxModel('ecmwf_ifs025');
		await expect(st.get(m, 36, 14, 50)).rejects.toThrow(/limit exceeded/);
		await expect(st.get(m, 40, 10, 50)).rejects.toThrow(/limit exceeded/);
		expect(calls).toBe(1);
		await fs.rm(dir, { recursive: true });
	});
	it('keeps large areas inside ±89° latitude', () => {
		const g = wxGrid(75, 10, 1600, 0.25);
		expect(g.lat0 + (g.ny - 1) * g.dlat).toBeLessThanOrEqual(89);
		expect(g.nx).toBeLessThanOrEqual(15);
	});
	it('covers the radius with at most 15×15 points, snapped', () => {
		const g = wxGrid(36.78, 14.55, 100, 0.1);
		expect(g.nx).toBeLessThanOrEqual(15);
		expect(g.lat0).toBeLessThanOrEqual(36.78 - 100 / 60 + g.dlat);
		expect(g.lat0 + (g.ny - 1) * g.dlat).toBeGreaterThanOrEqual(36.78 + 100 / 60 - g.dlat);
		expect(wxGrid(36.79, 14.56, 100, 0.1)).toEqual(g); // kleine Bewegung → gleicher Cache-Schlüssel
		const small = wxGrid(36.78, 14.55, 10, 0.25); // Modellauflösung begrenzt
		expect(small.dlat).toBe(0.25);
		expect(small.nx).toBeLessThan(15);
		expect(wxUrl(wxModel('ecmwf_ifs'), g).match(/latitude=([^&]+)/)[1].split(',').length).toBe(g.nx * g.ny);
	});
	it('converts responses, trims beyond the model horizon, km/h → kn for currents', () => {
		const g = { lat0: 36, lon0: 14, dlat: 0.5, dlon: 0.5, nx: 2, ny: 2 };
		const w = wxConvert(wxModel('ecmwf_ifs'), g, fake(g, 3, 'wind'));
		expect(w.nt).toBe(3);
		expect(w.dt).toBe(3600e3);
		expect(w.s.slice(0, 4)).toEqual([null, 12.34, 12.34, 12.34]);
		expect(w.d[1]).toBe(270);
		expect(w.p[1]).toBe(20); // Böen
		expect(w.q[1]).toBe(1013.3); // Luftdruck
		const c = wxConvert(wxModel('meteofrance_currents'), g, fake(g, 2, 'current'));
		expect(c.s[0]).toBe(1);
		expect(c.p).toBeNull();
	});
	it('caches, and serves the stored field when the internet is gone', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wx-'));
		let calls = 0;
		let online = true;
		const fetchImpl = async (url) => {
			if (!online) throw new Error('offline');
			if (url.includes('/static/meta.json')) {
				expect(url).toBe('https://api.open-meteo.com/data/jma_gsm/static/meta.json');
				return { ok: true, json: async () => ({ last_run_initialisation_time: 1763596800, last_run_availability_time: 1763610000, update_interval_seconds: 21600 }) };
			}
			calls++;
			const n = new URL(url).searchParams.get('latitude').split(',').length;
			const side = Math.sqrt(n);
			return { ok: true, json: async () => fake({ nx: side, ny: side }, 4, 'wind') };
		};
		const st = wxStore(dir, fetchImpl);
		const m = wxModel('jma_seamless'); // grobe Auflösung → kleines Gitter
		const a = await st.get(m, 36.8, 14.5, 20);
		expect(a.nt).toBe(4);
		expect(a.run).toBe(1763596800e3); // Lauf des Wetterdienstes, nicht Abrufzeit
		expect(a.every).toBe(6 * 3600e3);
		await st.get(m, 36.8, 14.5, 20);
		expect(calls).toBe(1);
		// abgelaufen + offline → gespeicherter Stand als stale
		const st2 = wxStore(dir, fetchImpl);
		const f = (await fs.readdir(dir)).find((x) => x.startsWith('jma_seamless'));
		const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
		j.fetched = 0;
		await fs.writeFile(path.join(dir, f), JSON.stringify(j));
		online = false;
		const b = await st2.get(m, 36.8, 14.5, 20);
		expect(b.stale).toBe(true);
		expect(b.nt).toBe(4);
		await fs.rm(dir, { recursive: true });
	});
	describe('saving quota', () => {
		const now = Date.now();
		const meta = { run: (now - 3 * 3600e3) / 1e3, avail: (now - 2 * 3600e3) / 1e3, every: 3 * 3600 };
		function server() {
			const srv = { calls: 0, metaRun: meta.run, metaAvail: meta.avail };
			srv.fetch = async (url) => {
				if (url.includes('/static/meta.json'))
					return { ok: true, json: async () => ({ last_run_initialisation_time: srv.metaRun, last_run_availability_time: srv.metaAvail, update_interval_seconds: meta.every }) };
				srv.calls++;
				await new Promise((r) => setTimeout(r, 5));
				const n = new URL(url).searchParams.get('latitude').split(',').length;
				return { ok: true, json: async () => fake({ nx: Math.sqrt(n), ny: Math.sqrt(n) }, 4, 'wind') };
			};
			return srv;
		}
		const m = wxModel('jma_seamless');
		it('fetches again only when the service has published a newer run', async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wxr-'));
			const srv = server();
			let st = wxStore(dir, srv.fetch);
			await st.get(m, 36.8, 14.5, 20);
			// next run (avail + 3 h) still ahead → cached, no API call
			expect((await st.get(m, 36.8, 14.5, 20)).next).toBe(meta.avail * 1e3 + meta.every * 1e3);
			expect(srv.calls).toBe(1);
			// stored field is old, but meta says: same run → same data, no API call
			const f = (await fs.readdir(dir))[0];
			const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
			Object.assign(j, { fetched: 0, avail: j.avail - 86400e3 });
			await fs.writeFile(path.join(dir, f), JSON.stringify(j));
			st = wxStore(dir, srv.fetch);
			await st.get(m, 36.8, 14.5, 20);
			expect(srv.calls).toBe(1);
			// newer run available for > 10 min → fetch
			srv.metaRun += 3 * 3600;
			srv.metaAvail = (now - 15 * 60e3) / 1e3;
			st = wxStore(dir, srv.fetch);
			await st.get(m, 36.8, 14.5, 20);
			expect(srv.calls).toBe(2);
			await fs.rm(dir, { recursive: true });
		});
		it('asks once when several devices want the same field at the same time', async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wxd-'));
			const srv = server();
			const st = wxStore(dir, srv.fetch);
			await Promise.all([st.get(m, 36.8, 14.5, 20), st.get(m, 36.8, 14.5, 20), st.get(m, 36.8, 14.5, 20)]);
			expect(srv.calls).toBe(1);
			await fs.rm(dir, { recursive: true });
		});
		it('stops before the own count reaches the limit and falls back to a stored field covering the spot', async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wxq-'));
			const usage = path.join(dir, '..', path.basename(dir) + '-usage.json');
			const srv = server();
			const st = wxStore(dir, srv.fetch, usage);
			const big = await st.get(m, 36.8, 14.5, 200);
			// day almost used up
			await fs.writeFile(usage, JSON.stringify({ day: { n: 9499.5, end: periodEnd('day', Date.now()) } }));
			const st2 = wxStore(dir, srv.fetch, usage);
			const f = await st2.get(m, 37, 14.6, 25); // other area, not cached → would need a call
			expect(srv.calls).toBe(1);
			expect(f).toMatchObject({ stale: true, code: 'quota', lat0: big.lat0 });
			expect(f.resetAt).toBe(periodEnd('day', Date.now()));
			await expect(st2.get(m, -30, -40, 25)).rejects.toMatchObject({ code: 'quota' }); // nothing stored there
			await fs.rm(dir, { recursive: true });
			await fs.rm(usage, { force: true });
		});
		it('counts like Open-Meteo and resets per UTC window', () => {
			expect(wxCost(225, 4, 14)).toBe(225);
			expect(wxCost(10, 15, 28)).toBe(30);
			const mt = wxMeter();
			const t = Date.UTC(2026, 10, 30, 23, 59, 30);
			mt.add(500, t);
			expect(mt.block(200, t)).toMatchObject({ period: 'minute' });
			expect(mt.block(200, t + 60e3)).toBeNull();
			expect(mt.used(t + 60e3)).toMatchObject({ minute: 0, hour: 0, day: 0, month: 0 }); // neuer Monat 1.12.
		});
	});
});
