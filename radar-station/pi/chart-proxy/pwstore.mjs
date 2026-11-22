// PredictWind-Downloads auf dem Pi: GRIB-Dateien als Wettermodelle, Routen (GPX) als Routen.
// Der Mac synchronisiert ~/Downloads/PredictWind/… und PredictWind_/Offshore_Route_*.gpx per Upload nach <dir>/ (siehe public/pw-sync/install.sh).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gribSummary, gribField, pwFileInfo } from './grib.mjs';
import { parseRoutes, cleanRoute, ROUTE_COLORS, MAX_ROUTES } from './routes.mjs';

const KEEP_DAYS = 10;
const SCAN_EVERY = 20e3;

const ABOUT = {
	PWG: ['PredictWind’s own global model (based on the UK Met Office core), 8 km in the downloaded area.', 'PredictWinds eigenes Globalmodell (auf Basis des UK Met Office), 8 km im geladenen Gebiet.'],
	PWE: ['PredictWind’s own model on ECMWF basis, 8 km in the downloaded area.', 'PredictWinds eigenes Modell auf ECMWF-Basis, 8 km im geladenen Gebiet.'],
	PWA: ['PredictWind AI model.', 'PredictWind-KI-Modell.'],
	AROME: ['Météo-France AROME via PredictWind; only sea points inside the AROME domain carry data.', 'Météo-France AROME über PredictWind; Daten nur für Seegebiete im AROME-Gebiet.'],
	ICON: ['DWD ICON via PredictWind.', 'DWD ICON über PredictWind.'],
	ECMWF: ['ECMWF via PredictWind.', 'ECMWF über PredictWind.'],
	GFS: ['NOAA GFS via PredictWind.', 'NOAA GFS über PredictWind.'],
	AIFS: ['ECMWF AI model AIFS via PredictWind.', 'ECMWF-KI-Modell AIFS über PredictWind.']
};

async function walk(dir) {
	const out = [];
	for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walk(p)));
		else out.push(p);
	}
	return out;
}

const f1 = (v) => Math.round(v * 10) / 10;
const bboxOf = (g) => [Math.min(g.la1, g.la2), Math.min(g.lo1, g.lo2), Math.max(g.la1, g.la2), Math.max(g.lo1, g.lo2)];

/**
 * @param dir   Ordner mit den synchronisierten Dateien
 * @param routesIo { read(): Promise<route[]>, write(list) } – gleiche routes.json wie /tiles/api/routes
 */
export function pwStore(dir, routesIo) {
	/** Datei → { mtime, buf, sum, info, bbox } */
	const files = new Map();
	const cache = new Map(); // Feld-Cache (Datei|Ausschnitt)
	let lastScan = 0;
	let scanning = null;

	async function importRoutes(gpx) {
		const doneFile = path.join(dir, 'imported.json');
		const done = new Set(JSON.parse(await fs.readFile(doneFile, 'utf8').catch(() => '[]')));
		// Schlüssel Name + Größe + Änderungszeit: gleicher Name mit anderem Inhalt wird erneut eingelesen und überschreibt
		const keyed = [];
		for (const p of gpx) {
			const st = await fs.stat(p).catch(() => null);
			if (st) keyed.push([p, `${path.basename(p)}|${st.size}|${Math.round(st.mtimeMs)}`]);
		}
		const todo = keyed.filter(([, key]) => !done.has(key));
		if (!todo.length) return;
		const list = await routesIo.read();
		const same = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p.lat - b[i].lat) < 1e-5 && Math.abs(p.lon - b[i].lon) < 1e-5);
		for (const [p, key] of todo) {
			const base = path.basename(p);
			try {
				const found = parseRoutes(await fs.readFile(p, 'utf8'), base);
				const m = base.match(/^(?:PredictWind|Offshore)_Route_(\w+?)_(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)Z/i);
				found.forEach((r, k) => {
					const name = m ? `PW ${m[1]} ${m[4]}.${m[3]}. ${m[5]}:${m[6]}Z` : r.name;
					const id = 'pw' + crypto.createHash('sha1').update(base + k).digest('hex').slice(0, 10);
					const at = list.findIndex((x) => x.id === id);
					if (at >= 0) {
						// gleiche Datei neu geladen → überschreiben, Farbe/Sichtbarkeit bleiben
						const doc = cleanRoute({ ...list[at], name, pts: r.pts });
						if (doc) list[at] = doc;
						return;
					}
					if (list.some((x) => same(x.pts, r.pts)) || list.length >= MAX_ROUTES) return; // identische Route schon (von Hand) importiert
					const doc = cleanRoute({ id, name, color: ROUTE_COLORS[list.length % ROUTE_COLORS.length], show: true, pts: r.pts });
					if (doc) list.push(doc);
				});
			} catch {
				/* kaputte Datei: Schlüssel trotzdem merken, nicht bei jedem Scan neu versuchen */
			}
			done.add(key);
		}
		await routesIo.write(list);
		await fs.writeFile(doneFile, JSON.stringify([...done]));
	}

	async function scan() {
		const all = await walk(dir);
		const now = Date.now();
		// je Modell/Variante/Gebiet nur den neuesten Lauf behalten, alles ältere als KEEP_DAYS löschen
		const newest = new Map();
		for (const p of all.filter((x) => /\.grb2?$/i.test(x))) {
			const base = path.basename(p);
			const info = pwFileInfo(base);
			const st = await fs.stat(p).catch(() => null);
			if (!st) continue;
			if (!info || now - st.mtimeMs > KEEP_DAYS * 86400e3) {
				if (info) await fs.rm(p).catch(() => {});
				continue;
			}
			const key = base.slice(info.stamp.length);
			const cur = newest.get(key);
			if (!cur || cur.stamp < info.stamp) {
				if (cur) await fs.rm(cur.p).catch(() => {});
				newest.set(key, { p, stamp: info.stamp, st, info });
			} else await fs.rm(p).catch(() => {});
		}
		for (const [p] of files) if (![...newest.values()].some((x) => x.p === p)) files.delete(p);
		for (const { p, st, info } of newest.values()) {
			const old = files.get(p);
			if (!(old && old.mtime === st.mtimeMs)) {
				const buf = await fs.readFile(p);
				const sum = gribSummary(buf);
				files.set(p, { mtime: st.mtimeMs, buf: sum ? buf : null, sum, info, bbox: sum ? bboxOf(sum.geo) : null, enc: buf.subarray(0, 4).toString('latin1') !== 'GRIB' });
			}
			// Vorhersage vorbei (letzter Zeitpunkt liegt in der Vergangenheit) → Datei weg, Modell verschwindet aus der Liste
			const sum = files.get(p).sum;
			if (sum && sum.times.at(-1) < now) {
				files.delete(p);
				await fs.rm(p).catch(() => {});
			}
		}
		cache.clear();
		await importRoutes(all.filter((x) => /(?:PredictWind|Offshore)_Route_.*\.gpx$/i.test(x))).catch(() => {});
		lastScan = Date.now();
	}
	const fresh = () => {
		if (Date.now() - lastScan < SCAN_EVERY) return Promise.resolve();
		return (scanning ??= scan().finally(() => (scanning = null)));
	};

	const idOf = (i) => `pw_${i.model}_${i.variant}_${i.res}`.toLowerCase();
	const statusFile = path.join(dir, 'sync.json');
	const readStatus = () => fs.readFile(statusFile, 'utf8').then(JSON.parse, () => ({}));
	const host = (h) => String(h ?? '').replace(/[^\w .'’()-]/g, '').slice(0, 60) || 'unknown';

	/** Dateiname einer hochgeladenen Datei prüfen (nur PredictWind-GRIB und Routen) */
	const okName = (n) => /^[\w.+-]{5,160}$/.test(n) && !n.startsWith('.') && (pwFileInfo(n) || /^(?:PredictWind|Offshore)_Route_.*\.gpx$/i.test(n));

	return {
		/** Modelle für den Katalog (/tiles/api/wx/models) */
		async models() {
			await fresh();
			const by = new Map();
			for (const f of files.values()) {
				if (!f.sum) continue;
				const id = idOf(f.info);
				(by.get(id) ?? by.set(id, []).get(id)).push(f);
			}
			return [...by].map(([id, fs_]) => {
				const f = fs_[0], i = f.info, g = f.sum.geo;
				const km = Number(i.res.match(/\d+/)[0]); // PredictWinds Angabe aus dem Dateinamen (8km, 10k)
				const days = Math.round((f.sum.times.at(-1) - f.sum.times[0]) / 86400e3);
				const [en, de] = ABOUT[i.model] ?? ['PredictWind GRIB download.', 'PredictWind-GRIB-Download.'];
				const areas = fs_.map((x) => x.bbox.map(f1).join(' / '));
				return {
					id,
					kind: f.sum.kind,
					name: `PredictWind ${i.model}${f.sum.kind === 'wave' ? ' Wave' : ''} ${km} km`,
					res: Math.abs(g.dj),
					info: `PredictWind GRIB ${km} km, ${f.sum.dt / 3600e3} h steps, ${days} days`,
					about: `${en} Downloaded with the PredictWind Offshore App and synced from the Mac; only the downloaded area (${fs_.length} file${fs_.length > 1 ? 's' : ''}).`,
					about_de: `${de} Mit der PredictWind Offshore App geladen und vom Mac übertragen; nur das geladene Gebiet (${fs_.length} Datei${fs_.length > 1 ? 'en' : ''}).`,
					region: `Downloaded area: ${areas.join('; ')} (S / W / N / E)`,
					region_de: `Geladenes Gebiet: ${areas.join('; ')} (S / W / N / O)`,
					grib: true
				};
			});
		},
		/** Feld wie wxStore.get; err.code 'outside', wenn keine Datei den Ort abdeckt */
		async get(id, lat, lon, rNm) {
			await fresh();
			const cand = [...files.entries()].filter(([, f]) => f.sum && idOf(f.info) === id);
			if (!cand.length) throw Object.assign(new Error('no such GRIB model'), { code: 'api' });
			// Datei, die den Ort enthält (neuester Lauf), sonst die nächstgelegene mit Überlappung
			const inside = (b) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
			const dist = (b) => Math.hypot(Math.max(b[0] - lat, 0, lat - b[2]), Math.max(b[1] - lon, 0, lon - b[3]));
			cand.sort(([, a], [, b]) => Number(inside(b.bbox)) - Number(inside(a.bbox)) || dist(a.bbox) - dist(b.bbox) || b.sum.run - a.sum.run);
			for (const [p, f] of cand) {
				const key = `${p}|${lat}|${lon}|${rNm}`;
				if (cache.has(key)) return cache.get(key);
				const fld = gribField(f.buf, f.sum, lat, lon, rNm);
				if (!fld) continue;
				const out = { ...fld, model: id, fetched: f.mtime, file: path.basename(p) };
				if (cache.size > 60) cache.clear();
				cache.set(key, out);
				return out;
			}
			throw Object.assign(new Error('outside the downloaded GRIB area'), { code: 'outside' });
		},
		scan,
		okName,
		/** GRIB-Dateien löschen: ein Modell (Katalog-ID) oder 'all' (auch unlesbare) → Anzahl gelöschter Dateien */
		async remove(id) {
			await fresh();
			let n = 0;
			for (const [p, f] of [...files]) {
				if (id !== 'all' && !(f.sum && idOf(f.info) === id)) continue;
				files.delete(p);
				await fs.rm(p).catch(() => {});
				n++;
			}
			cache.clear();
			return n;
		},
		/** Upload vom Mac-Dienst oder aus der App: Datei ablegen, beim nächsten Abruf eingelesen */
		async upload(name, buf, from, auto) {
			if (!okName(name)) throw Object.assign(new Error('not a PredictWind GRIB or route file'), { code: 'name' });
			const sub = /\.gpx$/i.test(name) ? 'routes' : 'upload';
			await fs.mkdir(path.join(dir, sub), { recursive: true });
			await fs.writeFile(path.join(dir, sub, name), buf);
			const st = await readStatus();
			st[auto ? 'auto' : 'manual'] = { at: Date.now(), host: host(from), file: name };
			if (auto) delete st.error;
			await fs.writeFile(statusFile, JSON.stringify(st));
			lastScan = 0;
		},
		/** Mac-Dienst meldet Probleme (z. B. kein Zugriff auf Downloads) oder dass er lief */
		async report(from, error) {
			const st = await readStatus();
			if (error) st.error = { at: Date.now(), host: host(from), error: String(error).slice(0, 200) };
			else {
				st.ping = { at: Date.now(), host: host(from) };
				if (st.error?.host === host(from)) delete st.error;
			}
			await fs.writeFile(statusFile, JSON.stringify(st));
		},
		async status() {
			await fresh();
			const grib = [...files.values()];
			// unreadable = von PredictWind verschlüsselt; unused = lesbares GRIB ohne Wind-/Wellen-/Stromfeld (z. B. nur Böen + CAPE)
			return { ...(await readStatus()), files: grib.length, readable: grib.filter((f) => f.sum).length, unreadable: grib.filter((f) => f.enc).map((f) => f.info.model), unused: grib.filter((f) => !f.sum && !f.enc).map((f) => `${f.info.model} ${f.info.variant}`) };
		}
	};
}
