// Routen: Prüfung (Pi) sowie Import/Export (App). Ohne DOM, damit Pi, App und Tests dieselbe Datei nutzen.
// Formate: GPX (rte/trk/wpt), KML (LineString/Point, KMZ entpackt die App), GeoJSON, CSV, NMEA 0183 (WPL/RTE).

export const MAX_PTS = 1000;
export const MAX_ROUTES = 200;
export const MAX_WP_NAME = 80; // PredictWind schreibt Zeit + Wetter in den Namen (~55 Zeichen)
export const ROUTE_COLORS = ['#e040fb', '#ff9800', '#00bcd4', '#8bc34a', '#ffeb3b', '#f44336', '#3f51b5', '#ffffff'];

const okLat = (v) => Number.isFinite(v) && Math.abs(v) <= 90;
const okLon = (v) => Number.isFinite(v) && Math.abs(v) <= 180;
const str = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

/** Route vom Client prüfen: { id, name, color, show, pts: [{lat, lon, name?}] } oder null */
export function cleanRoute(r) {
	if (!r || typeof r !== 'object' || !/^[\w-]{4,40}$/.test(String(r.id ?? ''))) return null;
	const pts = Array.isArray(r.pts) ? r.pts.slice(0, MAX_PTS) : [];
	const clean = [];
	for (const p of pts) {
		const lat = Number(p?.lat), lon = Number(p?.lon);
		if (!okLat(lat) || !okLon(lon)) return null;
		const nm = str(p.name, MAX_WP_NAME);
		clean.push(nm ? { lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: nm } : { lat: +lat.toFixed(6), lon: +lon.toFixed(6) });
	}
	if (clean.length < 2) return null;
	const color = /^#[0-9a-f]{6}$/i.test(r.color ?? '') ? r.color : ROUTE_COLORS[0];
	return { id: r.id, name: str(r.name, 60) || 'Route', color, show: r.show !== false, pts: clean, updated: Date.now() };
}

// ── Import ──────────────────────────────────────────────────────────────────
const unxml = (s) =>
	String(s ?? '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
		.trim();
const tag = (s, t) => s.match(new RegExp(`<(?:\\w+:)?${t}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${t}>`, 'i'))?.[1];
const blocks = (s, t) => [...s.matchAll(new RegExp(`<(?:\\w+:)?${t}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${t}>)`, 'gi'))].map((m) => ({ attr: m[1], body: m[2] ?? '' }));
const attr = (a, n) => Number(a.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`))?.[1]);

/** zu viele Punkte (Tracks) gleichmäßig ausdünnen, Anfang und Ende bleiben */
function thin(pts) {
	if (pts.length <= MAX_PTS) return pts;
	const step = (pts.length - 1) / (MAX_PTS - 1);
	return Array.from({ length: MAX_PTS }, (_, i) => pts[Math.round(i * step)]);
}
const named = (name, pts) => ({ name: name || '', pts: thin(pts.filter((p) => okLat(p.lat) && okLon(p.lon))) });

function gpxPts(body, t) {
	return blocks(body, t).map((b) => {
		const nm = unxml(tag(b.body, 'name'));
		return { lat: attr(b.attr, 'lat'), lon: attr(b.attr, 'lon'), ...(nm && { name: nm }) };
	});
}
function parseGpx(s) {
	const out = [];
	for (const r of blocks(s, 'rte')) out.push(named(unxml(tag(r.body.split(/<rtept\b/i)[0], 'name')), gpxPts(r.body, 'rtept')));
	for (const t of blocks(s, 'trk')) out.push(named(unxml(tag(t.body.split(/<trkseg\b/i)[0], 'name')), gpxPts(t.body, 'trkpt')));
	if (!out.length) {
		const w = gpxPts(s, 'wpt');
		if (w.length) out.push(named(unxml(tag(s.split(/<wpt\b/i)[0], 'name')) || 'Waypoints', w));
	}
	return out;
}

const kmlCoords = (c) =>
	String(c ?? '')
		.trim()
		.split(/\s+/)
		.map((t) => t.split(',').map(Number))
		.map(([lon, lat]) => ({ lat, lon }));
function parseKml(s) {
	const out = [];
	const points = [];
	for (const p of blocks(s, 'Placemark')) {
		const nm = unxml(tag(p.body, 'name'));
		for (const ls of blocks(p.body, 'LineString')) out.push(named(nm, kmlCoords(tag(ls.body, 'coordinates'))));
		const pt = tag(p.body, 'Point');
		if (pt) {
			const [q] = kmlCoords(tag(pt, 'coordinates'));
			if (q) points.push(nm ? { ...q, name: nm.slice(0, MAX_WP_NAME) } : q);
		}
	}
	if (!out.length && points.length) out.push(named(unxml(tag(s, 'name')) || 'Waypoints', points));
	// Wegpunktnamen von gleich liegenden Punkt-Placemarks übernehmen (so exportiert z. B. diese App)
	const key = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
	const nm = new Map(points.filter((p) => p.name).map((p) => [key(p), p.name]));
	for (const r of out) r.pts = r.pts.map((p) => (p.name || !nm.has(key(p)) ? p : { ...p, name: nm.get(key(p)) }));
	return out;
}

function parseGeoJson(j) {
	const out = [];
	const points = [];
	const feats = j.type === 'FeatureCollection' ? j.features ?? [] : j.type === 'Feature' ? [j] : [{ geometry: j, properties: {} }];
	const ll = ([lon, lat]) => ({ lat, lon });
	for (const f of feats) {
		const g = f?.geometry, nm = f?.properties?.name ?? '';
		if (!g) continue;
		const wn = f.properties?.waypoints;
		if (g.type === 'LineString') out.push(named(nm, g.coordinates.map((c, i) => (Array.isArray(wn) && wn[i] ? { ...ll(c), name: str(wn[i], MAX_WP_NAME) } : ll(c)))));
		else if (g.type === 'MultiLineString') g.coordinates.forEach((c, i) => out.push(named(nm ? `${nm} ${i + 1}` : '', c.map(ll))));
		else if (g.type === 'MultiPoint') out.push(named(nm, g.coordinates.map(ll)));
		else if (g.type === 'Point') points.push({ ...ll(g.coordinates), ...(nm && { name: String(nm) }) });
	}
	if (!out.length && points.length) out.push(named('Waypoints', points));
	return out;
}

/** Koordinate als Dezimalgrad oder Grad/Minuten („36°05.123'N“, „36 05.123 N“, „-14.5“) */
export function parseCoord(s) {
	let t = String(s ?? '').trim().replace(/(\d),(\d)/g, '$1.$2');
	let neg = /^-/.test(t) || /[SW]$|^[SW]/i.test(t);
	t = t.replace(/^[-+]|^[NSEWO]\s*|\s*[NSEWO]$/gi, '');
	const m = t.match(/^(\d+(?:\.\d+)?)(?:[°\s]+(\d+(?:\.\d+)?)['′]?(?:\s*(\d+(?:\.\d+)?)["″])?)?°?$/);
	if (!m) return NaN;
	const v = +m[1] + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0);
	return neg ? -v : v;
}

function parseCsv(s) {
	const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return [];
	const sep = [';', '\t', ','].find((c) => lines[0].includes(c)) ?? ',';
	const rows = lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1')));
	let iLat = 0, iLon = 1, iName = 2, iRoute = -1;
	const head = rows[0].map((c) => c.toLowerCase());
	const hasHead = head.some((c) => /^(lat|latitude|breite)/.test(c));
	if (hasHead) {
		const f = (re) => head.findIndex((c) => re.test(c));
		iLat = f(/^(lat|latitude|breite)/);
		iLon = f(/^(lon|lng|long|longitude|länge|laenge)/);
		iName = f(/^(name|wp|waypoint|wegpunkt)/);
		iRoute = f(/^(route)/);
		rows.shift();
	} else if (!Number.isFinite(parseCoord(rows[0][0])) && Number.isFinite(parseCoord(rows[0][1]))) [iName, iLat, iLon] = [0, 1, 2]; // Name,Lat,Lon
	const byRoute = new Map();
	for (const r of rows) {
		const p = { lat: parseCoord(r[iLat]), lon: parseCoord(r[iLon]) };
		if (!okLat(p.lat) || !okLon(p.lon)) continue;
		const nm = iName >= 0 ? str(r[iName], MAX_WP_NAME) : '';
		if (nm) p.name = nm;
		const k = iRoute >= 0 ? r[iRoute] ?? '' : '';
		if (!byRoute.has(k)) byRoute.set(k, []);
		byRoute.get(k).push(p);
	}
	return [...byRoute].map(([k, pts]) => named(k, pts));
}

/** NMEA 0183: $..WPL (Wegpunkte), $..RTE (Reihenfolge, optional) */
function parseNmea(s) {
	const wp = new Map();
	const order = [];
	let rteName = '';
	const dm = (v, h) => {
		const n = Number(v);
		const d = Math.floor(n / 100);
		const x = d + (n - d * 100) / 60;
		return /[SW]/i.test(h) ? -x : x;
	};
	for (const line of s.split(/\r?\n/)) {
		const f = line.trim().replace(/\*[0-9A-F]{2}$/i, '').split(',');
		const id = f[0]?.slice(3);
		if (id === 'WPL' && f.length >= 6) wp.set(f[5], { lat: dm(f[1], f[2]), lon: dm(f[3], f[4]), name: str(f[5], MAX_WP_NAME) });
		if (id === 'RTE' && f.length >= 5) {
			rteName = f[4] || rteName;
			order.push(...f.slice(5).filter(Boolean));
		}
	}
	const pts = order.length ? order.map((n) => wp.get(n)).filter(Boolean) : [...wp.values()];
	return pts.length ? [named(rteName, pts)] : [];
}

/** Datei-Inhalt → [{ name, pts }] (nur Routen mit mindestens 2 Punkten) */
export function parseRoutes(text, filename = '') {
	const s = String(text ?? '').replace(/^﻿/, '');
	const ext = (filename.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();
	const head = s.trimStart().slice(0, 400);
	let out;
	if (ext === 'gpx' || /<gpx\b/i.test(head)) out = parseGpx(s);
	else if (ext === 'kml' || /<kml\b/i.test(head)) out = parseKml(s);
	else if (ext === 'geojson' || ext === 'json' || /^[{[]/.test(head)) out = parseGeoJson(JSON.parse(s));
	else if (/^\$..(WPL|RTE)/m.test(s)) out = parseNmea(s);
	else out = parseCsv(s);
	const base = filename.replace(/\.\w+$/, '');
	return out.filter((r) => r.pts.length >= 2).map((r, i, a) => ({ ...r, name: str(r.name || (a.length > 1 ? `${base} ${i + 1}` : base) || 'Route', 60) }));
}

// ── Wetter im Wegpunktnamen (PredictWind) ───────────────────────────────────
/**
 * „20261121-1223-+0200-TWS10.1-TWD304-TWA52S-Pres1019“ →
 * { eta (UTC ms), off (Minuten Zeitzone), vals: { TWS: 10.1, TWD: 304, TWA: 52, Pres: 1019 }, side: 'S' | 'P' | '' }
 * Unbekannte Kürzel (z. B. Wellen, Strom) landen ebenfalls in vals, nichts geht verloren.
 */
export function wpWeather(name) {
	const m = String(name ?? '').match(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(?:-([+-])(\d\d)(\d\d))?((?:-[A-Za-z]+(?:-?\d[\d.]*[SP]?)?)*)$/); // leere Werte (z. B. „TWA-“ am Ziel) erlaubt
	if (!m) return null;
	const [, y, mo, d, h, mi, sg, oh, om, rest] = m;
	const off = sg ? (sg === '-' ? -1 : 1) * (+oh * 60 + +om) : 0;
	const vals = {};
	let side = '';
	for (const [, k, v, sd] of rest.matchAll(/-([A-Za-z]+)(-?\d[\d.]*)?([SP])?/g)) {
		if (v == null) continue;
		vals[k] = +v;
		if (sd && k === 'TWA') side = sd;
	}
	return { eta: Date.UTC(+y, +mo - 1, +d, +h, +mi) - off * 6e4, off, vals, side };
}

// ── Export ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const wpName = (p, i) => p.name || `WP${String(i + 1).padStart(2, '0')}`;
const f6 = (v) => v.toFixed(6);

export function toGpx(routes) {
	const r = routes
		.map((x) => `<rte><name>${esc(x.name)}</name>\n${x.pts.map((p, i) => `<rtept lat="${f6(p.lat)}" lon="${f6(p.lon)}"><name>${esc(wpName(p, i))}</name></rtept>`).join('\n')}\n</rte>`)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="SUKI Radar Station" xmlns="http://www.topografix.com/GPX/1/1">\n${r}\n</gpx>\n`;
}

export function toKml(routes) {
	const pm = routes
		.map((x) => {
			const line = `<Placemark><name>${esc(x.name)}</name><Style><LineStyle><color>ff${x.color?.slice(5, 7) ?? 'ff'}${x.color?.slice(3, 5) ?? '00'}${x.color?.slice(1, 3) ?? 'ff'}</color><width>3</width></LineStyle></Style><LineString><tessellate>1</tessellate><coordinates>${x.pts.map((p) => `${f6(p.lon)},${f6(p.lat)}`).join(' ')}</coordinates></LineString></Placemark>`;
			const wps = x.pts.map((p, i) => `<Placemark><name>${esc(wpName(p, i))}</name><Point><coordinates>${f6(p.lon)},${f6(p.lat)}</coordinates></Point></Placemark>`).join('\n');
			return `<Folder><name>${esc(x.name)}</name>\n${line}\n${wps}\n</Folder>`;
		})
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>SUKI routes</name>\n${pm}\n</Document></kml>\n`;
}

export function toGeoJson(routes) {
	const features = routes.map((x) => ({
		type: 'Feature',
		properties: { name: x.name, stroke: x.color, waypoints: x.pts.map(wpName) },
		geometry: { type: 'LineString', coordinates: x.pts.map((p) => [+f6(p.lon), +f6(p.lat)]) }
	}));
	return JSON.stringify({ type: 'FeatureCollection', features }, null, 1) + '\n';
}

export function toCsv(routes) {
	const q = (s) => (/[",;\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
	const rows = routes.flatMap((x) => x.pts.map((p, i) => [q(x.name), q(wpName(p, i)), f6(p.lat), f6(p.lon)].join(',')));
	return ['route,name,lat,lon', ...rows].join('\n') + '\n';
}

/** NMEA 0183 WPL + RTE (für ältere Plotter / OpenCPN) */
export function toNmea(routes) {
	const ck = (s) => s.split('').reduce((a, c) => a ^ c.charCodeAt(0), 0).toString(16).toUpperCase().padStart(2, '0');
	const sen = (b) => `$${b}*${ck(b)}`;
	const dm = (v, w, pos, neg) => {
		const a = Math.abs(v);
		const d = Math.floor(a);
		return `${String(d).padStart(w, '0')}${((a - d) * 60).toFixed(3).padStart(6, '0')},${v < 0 ? neg : pos}`;
	};
	const ascii = (t, n) => t.normalize('NFD').replace(/[^\x20-\x7e]|[,*$!\\^~]/g, '').replace(/\s+/g, ' ').trim().slice(0, n); // NMEA: nur ASCII
	const out = [];
	routes.forEach((x, ri) => {
		const names = x.pts.map((p, i) => ascii(wpName(p, i), 16) || `WP${i + 1}`);
		x.pts.forEach((p, i) => out.push(sen(`GPWPL,${dm(p.lat, 2, 'N', 'S')},${dm(p.lon, 3, 'E', 'W')},${names[i]}`)));
		const per = 8;
		const n = Math.ceil(names.length / per);
		for (let k = 0; k < n; k++) out.push(sen(`GPRTE,${n},${k + 1},c,${ascii(x.name, 20) || ri + 1},${names.slice(k * per, k * per + per).join(',')}`));
	});
	return out.join('\r\n') + '\r\n';
}

export const EXPORTS = {
	gpx: { ext: 'gpx', mime: 'application/gpx+xml', make: toGpx, label: 'GPX (OpenCPN, Navionics, B&G, Garmin)' },
	kml: { ext: 'kml', mime: 'application/vnd.google-earth.kml+xml', make: toKml, label: 'KML (Google Earth)' },
	geojson: { ext: 'geojson', mime: 'application/geo+json', make: toGeoJson, label: 'GeoJSON' },
	csv: { ext: 'csv', mime: 'text/csv', make: toCsv, label: 'CSV (Excel)' },
	nmea: { ext: 'nmea', mime: 'text/plain', make: toNmea, label: 'NMEA 0183 (WPL/RTE)' }
};
