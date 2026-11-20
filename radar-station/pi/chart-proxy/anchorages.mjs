// Ankerplätze aus OpenStreetMap (Overpass) je 1°-Zelle, auf dem Pi gespeichert (offline nutzbar, 30 Tage),
// plus eigene Ankerplätze (auf dem Pi, damit MacBook und iPad dieselben sehen).
// Daten © OpenStreetMap-Mitwirkende, ODbL – Quellenangabe in der App.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ENDPOINTS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.private.coffee/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
	'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const TTL = 30 * 86400e3;
const MIN_GAP = 5e3; // höflich zu den öffentlichen Overpass-Servern: höchstens ein Abruf je 5 s

export const cellOf = (lat, lon) => [Math.floor(lat), Math.floor(lon)];

export function overpassQuery(la, lo) {
	const bb = `(${la},${lo},${la + 1},${lo + 1})`;
	return `[out:json][timeout:40];(nwr["seamark:type"~"^(anchorage|anchor_berth)$"]${bb};nwr["seamark:type"="mooring"]["seamark:mooring:category"="buoy"]${bb};nwr["leisure"="marina"]${bb};);out tags geom${bb};`;
}

const KEEP = /^(name|seamark:name|seamark:type|seamark:anchorage:category|seamark:mooring:category|seamark:information|description|note|depth|seamark:.*:depth|seamark:.*:nature_of_surface|website|url|phone|vhf|seamark:radio_station:channel|opening_hours|capacity|fee|leisure)$/;

/** Overpass-Antwort → kompakte Liste { id, kind, name, lat, lon, poly?, tags } */
export function anchConvert(j) {
	const out = [];
	for (const e of j.elements ?? []) {
		const t = e.tags ?? {};
		const st = t['seamark:type'];
		const kind = st === 'anchorage' ? 'anchorage' : st === 'anchor_berth' ? 'berth' : st === 'mooring' ? 'mooring' : 'marina';
		let lat = e.lat, lon = e.lon, poly;
		if (e.type === 'way' && e.geometry?.length) {
			const g = e.geometry.filter(Boolean);
			if (g.length > 2 && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon) poly = g.map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)]);
			lat = g.reduce((s, p) => s + p.lat, 0) / g.length;
			lon = g.reduce((s, p) => s + p.lon, 0) / g.length;
		} else if (e.type === 'relation') {
			const pts = (e.members ?? []).flatMap((m) => m.geometry ?? []).filter(Boolean);
			if (!pts.length) continue;
			lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
			lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
		}
		if (lat == null || lon == null) continue;
		const tags = Object.fromEntries(Object.entries(t).filter(([k]) => KEEP.test(k)));
		out.push({ id: `${e.type[0]}${e.id}`, kind, name: t.name ?? t['seamark:name'] ?? '', lat: +lat.toFixed(5), lon: +lon.toFixed(5), ...(poly ? { poly } : {}), tags });
	}
	return out;
}

/** 1°-Zellen aus Overpass, auf dem Pi gespeichert; query/convert: Ankerplätze (Standard) oder Küstenlinie */
export function anchStore(dir, fetchImpl = fetch, query = overpassQuery, convert = anchConvert) {
	const mem = new Map();
	let queue = Promise.resolve();
	let last = 0;
	const file = (la, lo) => path.join(dir, `${la}_${lo}.json`);

	async function upstream(la, lo) {
		const wait = last + MIN_GAP - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		let err;
		for (const url of ENDPOINTS) {
			last = Date.now();
			try {
				const r = await fetchImpl(url, {
					method: 'POST',
					headers: { 'User-Agent': 'suki-radar-station', 'Content-Type': 'application/x-www-form-urlencoded' },
					body: 'data=' + encodeURIComponent(query(la, lo)),
					signal: AbortSignal.timeout(45e3)
				});
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return convert(await r.json());
			} catch (e) {
				err = e; // nächsten Server versuchen
			}
		}
		throw err;
	}

	return {
		/** Zelle (ganzzahlige Breite/Länge der SW-Ecke); bei Netzfehler der gespeicherte Stand (stale) */
		async get(la, lo) {
			const key = `${la}_${lo}`;
			let e = mem.get(key) ?? (await fs.readFile(file(la, lo), 'utf8').then(JSON.parse).catch(() => null));
			if (e) mem.set(key, e);
			if (e && Date.now() - e.fetched < TTL) return e;
			const job = queue.then(() => upstream(la, lo));
			queue = job.catch(() => {});
			try {
				const f = { cell: [la, lo], fetched: Date.now(), items: await job };
				mem.set(key, f);
				await fs.mkdir(dir, { recursive: true });
				await fs.writeFile(file(la, lo) + '.tmp', JSON.stringify(f));
				await fs.rename(file(la, lo) + '.tmp', file(la, lo));
				return f;
			} catch (err) {
				if (e) return { ...e, stale: true, error: String(err.message ?? err) };
				throw err;
			}
		}
	};
}

export function coastQuery(la, lo) {
	const bb = `(${la},${lo},${la + 1},${lo + 1})`;
	return `[out:json][timeout:60];way["natural"="coastline"]${bb};out geom${bb};`;
}

/** Overpass-Küstenlinien → Linien als flache Arrays [lat, lon, lat, lon, …]; außerhalb der Zelle (null) trennt die Linie */
export function coastConvert(j) {
	const out = [];
	for (const e of j.elements ?? []) {
		let cur = [];
		for (const p of [...(e.geometry ?? []), null]) {
			if (p) cur.push(+p.lat.toFixed(5), +p.lon.toFixed(5));
			else {
				if (cur.length >= 4) out.push(cur);
				cur = [];
			}
		}
	}
	return out;
}

/** eigener Ankerplatz: nur bekannte Felder, Längen begrenzt (Eingabe vom Netz) */
export function cleanOwn(a) {
	const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
	const lat = num(a?.lat), lon = num(a?.lon);
	if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
	return {
		id: String(a.id ?? Date.now()).slice(0, 32),
		lat,
		lon,
		name: String(a.name ?? '').slice(0, 80),
		note: String(a.note ?? '').slice(0, 2000),
		bottom: String(a.bottom ?? '').slice(0, 40),
		depth: num(a.depth),
		shelter: Array.isArray(a.shelter) ? a.shelter.filter((d) => DIRS.includes(d)) : [],
		t: num(a.t) ?? Date.now()
	};
}
