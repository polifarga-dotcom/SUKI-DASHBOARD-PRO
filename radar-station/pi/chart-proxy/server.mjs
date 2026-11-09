// SUKI chart-proxy: Kachel-Proxy für Karten/Satellitenbilder mit Cache, Revier-Download, zentralen API-Keys,
// Kielspur-Aufzeichnung (SignalK) und Allen-Coral-Atlas-Dateien. Läuft auf dem Pi hinter nginx (/tiles/ → :8091).
// Node 22, keine externen Pakete.
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { PROVIDERS, byId } from './providers.mjs';
import { tileBBox3857, countTiles, iterTiles } from './tilemath.mjs';
import { trackStore, trackDistance } from './track.mjs';

const PORT = Number(process.env.PORT ?? 8091);
const DATA = process.env.CHART_DATA ?? '/home/admin/chart-proxy-data';
const CACHE = process.env.CHART_CACHE ?? '/home/admin/chart-cache';
const SIGNALK = process.env.SIGNALK_WS ?? 'ws://127.0.0.1:3000/signalk/v1/stream?subscribe=none';
const UA = 'SUKI-Radar-Station/0.3 (private yacht, chart-proxy)';

await fs.mkdir(path.join(DATA, 'coral'), { recursive: true });
await fs.mkdir(CACHE, { recursive: true });

// ── Persistente Einstellungen ────────────────────────────────────────────────
async function readJson(file, def) {
	try {
		return JSON.parse(await fs.readFile(path.join(DATA, file), 'utf8'));
	} catch {
		return def;
	}
}
async function writeJson(file, obj, mode = 0o644) {
	const p = path.join(DATA, file);
	await fs.writeFile(p + '.tmp', JSON.stringify(obj), { mode });
	await fs.rename(p + '.tmp', p);
}

// ── Herunterfahren der Pis ───────────────────────────────────────────────────
const OPENCPN_HOST = '192.168.0.99';
const OPENCPN_KEY = path.join(process.env.HOME ?? '/home/admin', '.ssh/power_opencpn');
function reachable(host, port, ms = 1500) {
	return new Promise((resolve) => {
		const s = net.connect({ host, port, timeout: ms }, () => (s.destroy(), resolve(true)));
		s.on('error', () => resolve(false));
		s.on('timeout', () => (s.destroy(), resolve(false)));
	});
}
function powerOffOpenCpn() {
	// Der Schlüssel ist auf dem OpenCPN-Pi auf command="sudo systemctl poweroff" beschränkt → kein Befehl nötig
	return new Promise((resolve) =>
		execFile('ssh', ['-i', OPENCPN_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', `admin@${OPENCPN_HOST}`], { timeout: 15000 }, (err, _o, e) => {
			// Abbruch der Verbindung durch den herunterfahrenden Pi zählt als Erfolg
			if (!err || /closed by remote|Connection reset|closed\.$/m.test(String(e))) return resolve({ ok: true });
			resolve({ ok: false, err: String(e || err.message).trim().split('\n').pop().slice(0, 200) });
		})
	);
}

let keys = await readJson('keys.json', {});
let config = await readJson('config.json', {});
// Gemeinsamer Alarmzustand aller Browser/Geräte (Stumm + Wachalarm). Zeiten in der Datei = Pi-Uhr
// (Node-RED liest sie für Kabinen-/7"-Display), über HTTP relativ, damit falsch gehende Geräteuhren egal sind.
let shared = { sound: true, untilAt: 0, watchOn: false, watchMin: 15, lastAt: Date.now(), ...(await readJson('alarmstate.json', {})) };
const sharedOut = (now = Date.now()) => ({
	sound: shared.sound, untilIn: Math.max(0, shared.untilAt - now), watchOn: shared.watchOn, watchMin: shared.watchMin, lastAgo: now - shared.lastAt
});
const status = {}; // id → { ok, err, t }

function opts(p) {
	const o = {};
	for (const [k, d] of Object.entries(p.options ?? {})) o[k] = config[p.id]?.[k] ?? d.default;
	return o;
}

/** Varianten-Schlüssel (Optionen + dynamische Werte) → eigener Cache-Ordner, damit z. B. Jahrgänge nicht mischen */
function variant(p) {
	const o = { ...opts(p) };
	for (const [k, f] of Object.entries(p.dynamic ?? {})) o[k] = f();
	if (p.id === 'copernicus') o.to = new Date().toISOString().slice(0, 10);
	const s = JSON.stringify(o);
	return s === '{}' ? 'v' : crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

// ── Upstream-URL bauen ────────────────────────────────────────────────────────
const googleSession = { token: '', exp: 0, key: '' };

async function googleToken(key) {
	if (googleSession.token && googleSession.key === key && Date.now() < googleSession.exp - 3600e3) return googleSession.token;
	const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mapType: 'satellite', language: 'en-US', region: 'US' })
	});
	if (!r.ok) throw new Error(`Google session ${r.status}`);
	const j = await r.json();
	Object.assign(googleSession, { token: j.session, exp: Number(j.expiry) * 1000 || Date.now() + 86400e3, key });
	return j.session;
}

async function upstreamUrl(p, z, x, y) {
	const key = keys[p.id] ?? '';
	if (p.needsKey && !key) throw Object.assign(new Error('no key'), { code: 412 });
	const o = opts(p);
	for (const [k, f] of Object.entries(p.dynamic ?? {})) o[k] = f();
	const fill = (s) =>
		s.replace(/\{(\w+)\}/g, (m, k) =>
			k === 'z' ? z : k === 'x' ? x : k === 'y' ? y : k === 'key' ? encodeURIComponent(key) : o[k] !== undefined ? encodeURIComponent(o[k]) : m
		);
	if (p.type === 'xyz') return fill(p.url);
	if (p.type === 'google') return fill(p.url).replace('{session}', encodeURIComponent(await googleToken(key)));
	if (p.type === 'wms') {
		const [a, b, c, d] = tileBBox3857(z, x, y);
		if (p.id === 'copernicus') {
			o.to = new Date().toISOString().slice(0, 10);
			o.from = new Date(Date.now() - Number(o.days) * 86400e3).toISOString().slice(0, 10);
		}
		const q = new URLSearchParams({
			SERVICE: 'WMS',
			VERSION: '1.1.1',
			REQUEST: 'GetMap',
			LAYERS: fill(p.layers).replace(/%2F/g, '/'),
			STYLES: '',
			SRS: 'EPSG:3857',
			BBOX: [a, b, c, d].map((v) => v.toFixed(2)).join(','),
			WIDTH: '256',
			HEIGHT: '256',
			FORMAT: p.format ?? 'image/png',
			TRANSPARENT: p.transparent ? 'TRUE' : 'FALSE'
		});
		let extra = p.extraParams ? '&' + p.extraParams.replace(/\{(\w+)\}/g, (m, k) => (o[k] !== undefined ? encodeURIComponent(o[k]) : m)) : '';
		return `${fill(p.url)}?${q}${extra}`;
	}
	throw new Error('unsupported type');
}

// ── Kachel holen (Cache → Upstream → stale) ──────────────────────────────────
const inflight = new Map();
let active = 0;
const queue = [];
const MAX_PARALLEL = 8;
function slot() {
	return new Promise((res) => {
		if (active < MAX_PARALLEL) {
			active++;
			res();
		} else queue.push(res);
	});
}
function release() {
	const n = queue.shift();
	if (n) n();
	else active--;
}

const cachePath = (p, z, x, y) => path.join(CACHE, p.id, variant(p), String(z), String(x), `${y}.${p.ext}`);

async function fetchUpstream(p, z, x, y) {
	const url = await upstreamUrl(p, z, x, y);
	await slot();
	try {
		const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
		const ct = r.headers.get('content-type') ?? '';
		if (!r.ok || !ct.startsWith('image/')) {
			const txt = ct.startsWith('image/') ? '' : (await r.text()).slice(0, 200);
			throw Object.assign(new Error(`${r.status} ${txt}`), { code: r.status === 404 ? 404 : 502 });
		}
		const buf = Buffer.from(await r.arrayBuffer());
		status[p.id] = { ok: true, t: Date.now() };
		return { buf, ct };
	} catch (e) {
		status[p.id] = { ok: false, err: String(e.message ?? e).slice(0, 200), t: Date.now() };
		throw e;
	} finally {
		release();
	}
}

/** liefert {buf, ct, src} – src: cache | net | stale */
async function getTile(p, z, x, y, { forceNet = false } = {}) {
	const cp = cachePath(p, z, x, y);
	const caching = p.mode === 'cache';
	let st = null;
	if (caching) {
		try {
			st = await fs.stat(cp);
		} catch {
			/* nicht im Cache */
		}
		const fresh = st && Date.now() - st.mtimeMs < (p.ttlDays ?? 30) * 86400e3;
		if (fresh && !forceNet) return { buf: await fs.readFile(cp), ct: `image/${p.ext === 'jpg' ? 'jpeg' : p.ext}`, src: 'cache' };
	}
	const k = cp;
	if (!inflight.has(k))
		inflight.set(
			k,
			fetchUpstream(p, z, x, y)
				.then(async (r) => {
					if (caching) {
						await fs.mkdir(path.dirname(cp), { recursive: true });
						await fs.writeFile(cp, r.buf);
					}
					return { ...r, src: 'net' };
				})
				.finally(() => inflight.delete(k))
		);
	try {
		return await inflight.get(k);
	} catch (e) {
		if (st) return { buf: await fs.readFile(cp), ct: `image/${p.ext === 'jpg' ? 'jpeg' : p.ext}`, src: 'stale' };
		throw e;
	}
}

// ── Revier-Download ──────────────────────────────────────────────────────────
const jobs = new Map();
const MAX_JOB_TILES = 60000;

function startPrefetch(p, bbox, zmin, zmax) {
	const total = countTiles(bbox, zmin, zmax);
	const id = crypto.randomUUID().slice(0, 8);
	const job = { id, provider: p.id, bbox, zmin, zmax, total, done: 0, failed: 0, cached: 0, state: 'running', started: Date.now() };
	jobs.set(id, job);
	(async () => {
		const it = iterTiles(bbox, zmin, zmax);
		const worker = async () => {
			for (let n = it.next(); !n.done; n = it.next()) {
				if (job.state !== 'running') return;
				const [z, x, y] = n.value;
				try {
					const r = await getTile(p, z, x, y);
					if (r.src === 'cache') job.cached++;
					else await new Promise((res) => setTimeout(res, 60)); // höflich zum Anbieter
				} catch {
					job.failed++;
				}
				job.done++;
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
		if (job.state === 'running') job.state = 'done';
		job.finished = Date.now();
		invalidateSizes();
		const old = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => b.started - a.started).slice(20);
		for (const j of old) jobs.delete(j.id);
	})();
	return job;
}

// Cache-Größe: Verzeichnis-Durchlauf ist bei großen Revieren teuer (SD-Karte) → 60 s merken
let sizeMemo = null;
let sizeMemoAt = 0;
const invalidateSizes = () => (sizeMemo = null);

async function dirSize(dir) {
	let bytes = 0;
	let files = 0;
	async function walk(d) {
		let ents;
		try {
			ents = await fs.readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of ents) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				bytes += (await fs.stat(p)).size;
				files++;
			}
		}
	}
	await walk(dir);
	return { bytes, files };
}

// ── Kielspur aus SignalK ─────────────────────────────────────────────────────
// Tagesdateien unter DATA/track, Aufbewahrung in Tagen (Einstellungen → Kielspur)
const trk = trackStore(path.join(DATA, 'track'));
await trk.init();
let trackCfg = { days: 30, ...(await readJson('track-cfg.json', {})) };
{
	// einmalige Übernahme der alten 48-h-Datei
	const old = await readJson('track.json', null);
	if (Array.isArray(old)) {
		for (const p of old) await trk.append(p);
		await fs.rename(path.join(DATA, 'track.json'), path.join(DATA, 'track.json.migrated'));
	}
}
let lastPt = (await trk.read(Date.now() - 86400e3)).at(-1) ?? null;
let lastFix = null;
const pruneTrack = () => trk.prune(trackCfg.days).catch(() => {});
pruneTrack();
setInterval(pruneTrack, 6 * 3600e3);

function onPosition(lat, lon) {
	const t = Date.now();
	lastFix = { t, lat, lon };
	const last = lastPt;
	if (last) {
		const dt = t - last[0];
		const dy = (lat - last[1]) * 111320;
		const dx = (lon - last[2]) * 111320 * Math.cos((lat * Math.PI) / 180);
		const d = Math.hypot(dx, dy);
		if (dt < 10000 || (d < 5 && dt < 60000)) return;
	}
	lastPt = [t, +lat.toFixed(6), +lon.toFixed(6)];
	trk.append(lastPt).catch(() => {});
}

function connectSignalK() {
	let ws;
	try {
		ws = new WebSocket(SIGNALK);
	} catch {
		setTimeout(connectSignalK, 10000);
		return;
	}
	ws.onopen = () => ws.send(JSON.stringify({ context: 'vessels.self', subscribe: [{ path: 'navigation.position', period: 2000 }] }));
	ws.onmessage = (e) => {
		try {
			const m = JSON.parse(e.data);
			for (const u of m.updates ?? [])
				for (const v of u.values ?? [])
					if (v.path === 'navigation.position' && v.value && Number.isFinite(v.value.latitude)) onPosition(v.value.latitude, v.value.longitude);
		} catch {
			/* ignore */
		}
	};
	ws.onclose = () => setTimeout(connectSignalK, 5000);
	ws.onerror = () => ws.close();
}
connectSignalK();

// ── HTTP ─────────────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
	res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(obj));
};

async function body(req, limit = 1e6) {
	const chunks = [];
	let n = 0;
	for await (const c of req) {
		n += c.length;
		if (n > limit) throw Object.assign(new Error('too large'), { code: 413 });
		chunks.push(c);
	}
	return Buffer.concat(chunks);
}

// ── Bild-Metadaten (Aufnahmedatum, Auflösung) ────────────────────────────────
const metaCache = new Map(); // key → { t, v }
async function cached(key, ttlMs, fn) {
	const c = metaCache.get(key);
	if (c && Date.now() - c.t < ttlMs) return c.v;
	const v = await fn();
	metaCache.set(key, { t: Date.now(), v });
	if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
	return v;
}

/** Esri: öffentliche Zitations-Ebene des World-Imagery-Dienstes → Datum, Auflösung, Lagegenauigkeit */
async function esriMeta(lat, lon, z) {
	const key = `esri:${lat.toFixed(3)},${lon.toFixed(3)},${z}`;
	return cached(key, 3600e3, async () => {
		const u = `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/4/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE,SRC_RES,SRC_ACC,NICE_NAME,NICE_DESC,MinMapLevel,MaxMapLevel&returnGeometry=false&f=json`;
		const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
		const j = await r.json();
		const f = (j.features ?? []).map((x) => x.attributes).filter((a) => z >= a.MinMapLevel && z <= a.MaxMapLevel);
		const a = f.sort((x, y) => (y.SRC_DATE ?? 0) - (x.SRC_DATE ?? 0))[0];
		if (!a) return null;
		const d = a.SRC_DATE ? String(a.SRC_DATE) : '';
		return {
			date: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
			res: a.SRC_RES ?? null,
			acc: a.SRC_ACC ?? null,
			source: [a.NICE_NAME, a.NICE_DESC].filter(Boolean).join(' / ')
		};
	});
}

/** WFS-Typname der Copernicus-Instanz (z. B. S2.TILE) – aus der Dienstbeschreibung, einmal ermittelt */
let copTypeName = { key: '', name: '' };
async function copernicusType(key) {
	if (copTypeName.key === key && copTypeName.name) return copTypeName.name;
	const r = await fetch(`https://sh.dataspace.copernicus.eu/ogc/wfs/${encodeURIComponent(key)}?SERVICE=WFS&REQUEST=GetCapabilities&VERSION=2.0.0`, { signal: AbortSignal.timeout(15000) });
	const t = await r.text();
	const name = [...t.matchAll(/<(?:wfs:)?Name>([^<]+)</g)].map((m) => m[1]).find((n) => /S2/i.test(n)) ?? 'S2.TILE';
	copTypeName = { key, name };
	return name;
}

/** Copernicus: Datum des neuesten Sentinel-2-Bildes im Ausschnitt über WFS der Instanz */
async function copernicusMeta(lat, lon) {
	const p = byId('copernicus');
	const key = keys.copernicus;
	if (!key) return null;
	const o = opts(p);
	const to = new Date().toISOString().slice(0, 10);
	const from = new Date(Date.now() - Number(o.days) * 86400e3).toISOString().slice(0, 10);
	return cached(`cop:${lat.toFixed(2)},${lon.toFixed(2)},${from},${o.maxcc}`, 3600e3, async () => {
		const d = 0.02;
		const q = new URLSearchParams({
			SERVICE: 'WFS',
			VERSION: '2.0.0',
			REQUEST: 'GetFeature',
			TYPENAMES: await copernicusType(key),
			BBOX: `${lat - d},${lon - d},${lat + d},${lon + d}`,
			SRSNAME: 'EPSG:4326',
			TIME: `${from}/${to}`,
			MAXCC: String(o.maxcc),
			MAXFEATURES: '50',
			OUTPUTFORMAT: 'application/json'
		});
		const r = await fetch(`https://sh.dataspace.copernicus.eu/ogc/wfs/${encodeURIComponent(key)}?${q}`, { signal: AbortSignal.timeout(15000) });
		if (!r.ok) return { date: null, error: `WFS ${r.status}` };
		const j = await r.json();
		const fs_ = (j.features ?? []).map((f) => f.properties).filter((x) => x?.date);
		fs_.sort((a, b) => String(b.date).localeCompare(String(a.date)));
		const f = fs_[0];
		return f ? { date: String(f.date).slice(0, 10), time: f.time ? String(f.time).slice(0, 5) : null, cloud: f.cloudCoverPercentage ?? null } : { date: null };
	});
}

async function imageryMeta(id, lat, lon, z) {
	const p = byId(id);
	if (!p) return null;
	const base = { id, resolution: p.resolution ?? null, kind: p.dateKind ?? 'none' };
	try {
		if (p.dateKind === 'year') return { ...base, year: opts(p).year };
		if (p.dateKind === 'daily') return { ...base, date: new Date(Date.now() - 86400e3).toISOString().slice(0, 10) };
		if (p.dateKind === 'esri') return { ...base, ...(await esriMeta(lat, lon, z)) };
		if (p.dateKind === 'copernicus') return { ...base, ...(await copernicusMeta(lat, lon)) };
	} catch (e) {
		return { ...base, error: String(e.message ?? e).slice(0, 120) };
	}
	return base;
}

function publicProvider(p) {
	return {
		id: p.id,
		name: p.name,
		kind: p.kind,
		resolution: p.resolution ?? null,
		maxNativeZoom: p.maxNativeZoom,
		mode: p.mode,
		prefetch: p.prefetch,
		prefetchMax: p.prefetchMax ?? MAX_JOB_TILES,
		needsKey: !!p.needsKey,
		keySet: !!keys[p.id],
		keyLabel: p.keyLabel,
		keyUrl: p.keyUrl,
		attribution: p.attribution,
		info: p.info ?? '',
		options: p.options ?? {},
		values: opts(p),
		// direct-Anbieter: der Browser braucht URL + Key (Bedingungen erlauben keinen Proxy)
		directUrl: p.mode === 'direct' && keys[p.id] ? p.url.replace('{key}', encodeURIComponent(keys[p.id])) : undefined,
		status: status[p.id] ?? null
	};
}

const CORAL_NAME = /^[a-z0-9_-]{1,40}$/i;

const server = http.createServer(async (req, res) => {
	try {
		const u = new URL(req.url, 'http://x');
		const parts = u.pathname.replace(/^\/tiles\/?/, '').split('/').filter(Boolean);

		// Kachel: /tiles/t/{id}/{z}/{x}/{y}
		if (parts[0] === 't' && parts.length === 5) {
			const p = byId(parts[1]);
			const [z, x, y] = parts.slice(2).map((s) => parseInt(s, 10));
			if (!p || p.mode === 'direct' || ![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z)
				return json(res, 404, { error: 'unknown tile' });
			try {
				const t = await getTile(p, z, x, y);
				res.writeHead(200, {
					'Content-Type': t.ct,
					'Cache-Control': p.mode === 'cache' ? 'public, max-age=86400' : 'private, max-age=3600',
					'X-Tile-Source': t.src
				});
				return res.end(t.buf);
			} catch (e) {
				res.writeHead(e.code === 412 ? 412 : e.code === 404 ? 404 : 504, { 'Cache-Control': 'no-store' });
				return res.end();
			}
		}

		if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });
		const [, what, a1] = parts;

		if (what === 'providers' && req.method === 'GET') return json(res, 200, PROVIDERS.map(publicProvider));

		if (what === 'keys' && req.method === 'PUT') {
			const { id, key } = JSON.parse((await body(req)).toString());
			if (!byId(id)) return json(res, 404, { error: 'unknown provider' });
			if (key && String(key).length > 1024) return json(res, 400, { error: 'key too long' });
			if (key) keys[id] = String(key).trim();
			else delete keys[id];
			if (id === 'google') googleSession.token = '';
			await writeJson('keys.json', keys, 0o600);
			return json(res, 200, publicProvider(byId(id)));
		}

		if (what === 'config' && req.method === 'PUT') {
			const { id, values } = JSON.parse((await body(req)).toString());
			const p = byId(id);
			if (!p) return json(res, 404, { error: 'unknown provider' });
			const clean = {};
			for (const [k, d] of Object.entries(p.options ?? {})) {
				if (values?.[k] === undefined) continue;
				let v = values[k];
				if (d.type === 'number') v = Math.max(d.min ?? -Infinity, Math.min(d.max ?? Infinity, Number(v)));
				if (d.type === 'select' && !d.values.includes(String(v))) continue;
				clean[k] = d.type === 'number' ? v : String(v);
			}
			config[id] = { ...(config[id] ?? {}), ...clean };
			await writeJson('config.json', config);
			return json(res, 200, publicProvider(p));
		}

		if (what === 'test' && req.method === 'POST') {
			// Schlüssel/Erreichbarkeit prüfen: eine Kachel über Malta holen (ohne Cache)
			const p = byId(a1);
			if (!p) return json(res, 404, { error: 'unknown provider' });
			if (p.mode === 'direct') return json(res, 200, { ok: !!keys[p.id], note: 'direct' });
			try {
				const r = await fetchUpstream(p, 10, 551, 397);
				return json(res, 200, { ok: true, bytes: r.buf.length });
			} catch (e) {
				return json(res, 200, { ok: false, error: String(e.message ?? e) });
			}
		}

		if (what === 'cache') {
			if (req.method === 'GET') {
				if (!sizeMemo || Date.now() - sizeMemoAt > 60000) {
					const out = {};
					for (const p of PROVIDERS.filter((x) => x.mode === 'cache')) out[p.id] = await dirSize(path.join(CACHE, p.id));
					sizeMemo = out;
					sizeMemoAt = Date.now();
				}
				return json(res, 200, sizeMemo);
			}
			if (req.method === 'DELETE' && byId(a1)) {
				invalidateSizes();
				await fs.rm(path.join(CACHE, a1), { recursive: true, force: true });
				return json(res, 200, { ok: true });
			}
		}

		if (what === 'prefetch') {
			if (req.method === 'GET') return json(res, 200, [...jobs.values()].sort((a, b) => b.started - a.started).slice(0, 20));
			if (req.method === 'POST') {
				const { id, bbox, zmin, zmax, dryRun } = JSON.parse((await body(req)).toString());
				const p = byId(id);
				if (!p) return json(res, 404, { error: 'unknown provider' });
				if (!p.prefetch || p.mode !== 'cache') return json(res, 403, { error: 'Provider terms do not allow downloading areas' });
				if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return json(res, 400, { error: 'bad bbox' });
				const z0 = Math.max(0, Math.min(p.maxNativeZoom, zmin | 0));
				const z1 = Math.max(z0, Math.min(p.maxNativeZoom, zmax | 0));
				const total = countTiles(bbox, z0, z1);
				const limit = p.prefetchMax ?? MAX_JOB_TILES;
				if (dryRun || total > limit) return json(res, dryRun ? 200 : 400, { total, zmin: z0, zmax: z1, limit, estMB: Math.round((total * (p.ext === 'png' ? 25 : 30)) / 1024) });
				if (p.needsKey && !keys[p.id]) return json(res, 412, { error: 'no key' });
				return json(res, 200, startPrefetch(p, bbox, z0, z1));
			}
			if (req.method === 'DELETE' && jobs.has(a1)) {
				jobs.get(a1).state = 'cancelled';
				return json(res, 200, { ok: true });
			}
		}

		// Stummschaltung + Wachalarm für alle Geräte/Browser gemeinsam (sonst nur im eigenen localStorage)
		if (what === 'shared') {
			if (req.method === 'PUT') {
				const { sound, untilIn, watchOn, watchMin, lastAgo } = JSON.parse(String(await body(req)));
				if (typeof sound !== 'boolean' || typeof watchOn !== 'boolean' || ![untilIn, lastAgo].every(Number.isFinite) || !(watchMin >= 1 && watchMin <= 60))
					return json(res, 400, { error: 'sound/watchOn bool, untilIn/lastAgo number, watchMin 1–60' });
				const now = Date.now();
				shared = { sound, untilAt: untilIn > 0 ? now + untilIn : 0, watchOn, watchMin: Math.round(watchMin), lastAt: now - Math.max(0, lastAgo) };
				await writeJson('alarmstate.json', shared);
			}
			if (req.method === 'GET' || req.method === 'PUT') return json(res, 200, sharedOut());
		}

		if (what === 'track' && a1 === 'info') {
			if (req.method === 'PUT') {
				const d = Math.round(Number(JSON.parse(String(await body(req))).days));
				if (!(d >= 1 && d <= 3650)) return json(res, 400, { error: 'days 1–3650' });
				trackCfg = { days: d };
				await writeJson('track-cfg.json', trackCfg);
				await pruneTrack();
			}
			if (req.method === 'GET' || req.method === 'PUT') return json(res, 200, { ...trackCfg, ...(await trk.info()) });
		}

		if (what === 'track' && a1 === 'dist' && req.method === 'GET') {
			// Etmal / Strecke seit Passagebeginn: ?since=<ms>
			const since = Number(u.searchParams.get('since'));
			if (!Number.isFinite(since)) return json(res, 400, { error: 'bad since' });
			const pts = await trk.read(since);
			return json(res, 200, { dist: Math.round(trackDistance(pts)), n: pts.length, t0: pts[0]?.[0] ?? null, t1: pts.at(-1)?.[0] ?? null });
		}

		if (what === 'track' && !a1) {
			if (req.method === 'GET') {
				// ?since=<ms>: nur neue Punkte (die App hängt an) – sonst ganze Spur der letzten ?hours
				const after = Number(u.searchParams.get('since') ?? 0);
				let pts = await trk.read(after || Date.now() - Number(u.searchParams.get('hours') ?? 6) * 3600e3);
				// lange Zeiträume ausdünnen, damit die Antwort klein bleibt (Overlay dünnt ohnehin weiter aus)
				if (pts.length > 20000) {
					const k = Math.ceil(pts.length / 20000);
					pts = pts.filter((_, i) => i % k === 0 || i === pts.length - 1);
				}
				if (lastFix && (!pts.length || lastFix.t - pts[pts.length - 1][0] > 2000)) pts.push([lastFix.t, +lastFix.lat.toFixed(6), +lastFix.lon.toFixed(6)]);
				return json(res, 200, pts);
			}
			if (req.method === 'DELETE') {
				await trk.clear();
				lastPt = null;
				return json(res, 200, { ok: true });
			}
		}

		if (what === 'coral') {
			const dir = path.join(DATA, 'coral');
			if (!a1 && req.method === 'GET') {
				const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.geojson'));
				const list = [];
				for (const f of files) list.push({ name: f.replace(/\.geojson$/, ''), bytes: (await fs.stat(path.join(dir, f))).size });
				return json(res, 200, list);
			}
			const name = (a1 ?? '').replace(/\.geojson$/, '');
			if (!CORAL_NAME.test(name)) return json(res, 400, { error: 'bad name' });
			const file = path.join(dir, name + '.geojson');
			if (req.method === 'GET') {
				try {
					await fs.access(file);
				} catch {
					return json(res, 404, { error: 'not found' });
				}
				res.writeHead(200, { 'Content-Type': 'application/geo+json', 'Cache-Control': 'no-cache' });
				return createReadStream(file).pipe(res);
			}
			if (req.method === 'PUT') {
				const buf = await body(req, 300e6);
				// JSON.parse einer 300-MB-Datei braucht > 1 GB RAM (Pi: 1,8 GB) → nur Kopf prüfen und Features zählen
				if (buf[0] !== 0x7b || !buf.subarray(0, 4096).toString().includes('"FeatureCollection"')) return json(res, 400, { error: 'not a GeoJSON FeatureCollection' });
				let features = 0;
				for (let i = buf.indexOf('"Feature"'); i >= 0; i = buf.indexOf('"Feature"', i + 9)) features++;
				await fs.writeFile(file + '.tmp', buf);
				await fs.rename(file + '.tmp', file);
				return json(res, 200, { name, features });
			}
			if (req.method === 'DELETE') {
				await fs.rm(file, { force: true });
				return json(res, 200, { ok: true });
			}
		}

		if (what === 'meta' && req.method === 'GET') {
			// /tiles/api/meta?ids=esri,eox&lat=..&lon=..&z=..
			const lat = Number(u.searchParams.get('lat'));
			const lon = Number(u.searchParams.get('lon'));
			const z = Math.round(Number(u.searchParams.get('z') ?? 14));
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'bad position' });
			const ids = (u.searchParams.get('ids') ?? '').split(',').filter((x) => byId(x)).slice(0, 12);
			const out = await Promise.all(ids.map((id) => imageryMeta(id, lat, lon, z)));
			return json(res, 200, out.filter(Boolean));
		}

		if (what === 'status' && req.method === 'GET') return json(res, 200, { status, lastPt, lastFix });

		// Herunterfahren (Einstellungen → System): OpenCPN-Pi per SSH-Schlüssel, der dort nur „poweroff“ darf; dieser Pi per sudo
		if (what === 'power') {
			if (req.method === 'GET') return json(res, 200, { opencpn: await reachable(OPENCPN_HOST, 22), keyReady: await fs.access(OPENCPN_KEY).then(() => true, () => false) });
			if (req.method === 'POST' && ['opencpn', 'signalk', 'both'].includes(a1)) {
				if (a1 !== 'signalk') {
					const r = await powerOffOpenCpn();
					if (!r.ok) return json(res, 502, { error: `OpenCPN-Pi: ${r.err}` });
				}
				if (a1 !== 'opencpn') setTimeout(() => execFile('sudo', ['-n', '/usr/bin/systemctl', 'poweroff'], () => {}), 1500); // erst antworten
				return json(res, 200, { ok: true });
			}
		}

		return json(res, 404, { error: 'not found' });
	} catch (e) {
		json(res, e.code === 413 ? 413 : 500, { error: String(e.message ?? e) });
	}
});

server.listen(PORT, '127.0.0.1', () => console.log(`chart-proxy on 127.0.0.1:${PORT}, cache ${CACHE}`));
