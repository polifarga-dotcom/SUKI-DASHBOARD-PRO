// Routenverwaltung: Routen liegen auf dem Pi (/tiles/api/routes), alle Geräte sehen dieselben.
// Anlegen/Bearbeiten über das Messwerkzeug auf der Karte (tools.measure), rt.editing = bearbeitete Route.
import { cleanRoute, parseRoutes, EXPORTS, ROUTE_COLORS } from '../../pi/chart-proxy/routes.mjs';
import type { LatLon } from '../lib/geo';

export interface RoutePt extends LatLon {
	name?: string;
}
export interface Route {
	id: string;
	name: string;
	color: string;
	show: boolean;
	pts: RoutePt[];
	updated?: number;
}
export type ExportFmt = keyof typeof EXPORTS;

export const rt = $state({ list: [] as Route[], err: '', editing: null as string | null });
const URL_ = '/tiles/api/routes';
export const newRouteId = () => Math.random().toString(36).slice(2, 10);

export async function loadRoutes() {
	try {
		const r = await fetch(URL_, { cache: 'no-store' });
		if (!r.ok) throw new Error(String(r.status));
		rt.list = ((await r.json()) as Route[]).sort((a, b) => a.name.localeCompare(b.name));
		rt.err = '';
	} catch (e) {
		rt.err = String((e as Error).message ?? e);
	}
}

export async function saveRoute(r: Omit<Route, 'id'> & { id?: string }) {
	const doc = cleanRoute({ ...r, id: r.id ?? newRouteId() });
	if (!doc) return (rt.err = 'Route needs at least 2 points'), null;
	const res = await fetch(URL_, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) }).catch(() => null);
	if (!res?.ok) return (rt.err = res ? ((await res.json().catch(() => ({}))).error ?? String(res.status)) : 'Pi not reachable'), null;
	await loadRoutes();
	return doc as Route;
}

export async function deleteRoute(id: string) {
	await fetch(`${URL_}/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
	if (rt.editing === id) rt.editing = null;
	await loadRoutes();
}

export const nextColor = () => ROUTE_COLORS[rt.list.length % ROUTE_COLORS.length];

/** ZIP (KMZ) ohne Bibliothek: erste .kml-Datei aus dem Archiv lesen */
async function unzipKml(buf: ArrayBuffer) {
	const v = new DataView(buf);
	for (let o = 0; o + 30 < buf.byteLength && v.getUint32(o, true) === 0x04034b50; ) {
		const method = v.getUint16(o + 8, true);
		const size = v.getUint32(o + 18, true);
		const nLen = v.getUint16(o + 26, true);
		const xLen = v.getUint16(o + 28, true);
		const name = new TextDecoder().decode(new Uint8Array(buf, o + 30, nLen));
		const start = o + 30 + nLen + xLen;
		if (/\.kml$/i.test(name)) {
			const data = new Uint8Array(buf, start, size);
			if (method === 0) return new TextDecoder().decode(data);
			const out = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
			return await new Response(out).text();
		}
		o = start + size;
	}
	throw new Error('no KML in KMZ');
}

/** Dateien importieren → Anzahl neuer Routen */
export async function importFiles(files: FileList | File[]) {
	let n = 0;
	for (const f of Array.from(files)) {
		const text = /\.kmz$/i.test(f.name) ? await unzipKml(await f.arrayBuffer()) : await f.text();
		for (const r of parseRoutes(text, f.name) as { name: string; pts: RoutePt[] }[]) {
			if (await saveRoute({ name: r.name, pts: r.pts, color: nextColor(), show: true })) n++;
		}
	}
	return n;
}

export function exportRoutes(routes: Route[], fmt: ExportFmt) {
	const e = EXPORTS[fmt];
	const base = routes.length === 1 ? routes[0].name.replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim().replace(/\s+/g, '-') || 'route' : 'suki-routes';
	const url = URL.createObjectURL(new Blob([e.make(routes)], { type: e.mime }));
	Object.assign(document.createElement('a'), { href: url, download: `${base}.${e.ext}` }).click();
	setTimeout(() => URL.revokeObjectURL(url), 10e3);
}

export function startRoutes() {
	loadRoutes();
	const t = setInterval(loadRoutes, 30e3);
	return () => clearInterval(t);
}
