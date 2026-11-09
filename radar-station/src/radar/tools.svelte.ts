// Bedienwerkzeuge auf dem Radarschirm: EBL/VRM, Cursor, Marker/MOB (Marker werden gespeichert).
import type { LatLon } from '../lib/geo';
import { addSquallFix, type Squall } from '../collision/squall';

export interface Ebl {
	on: boolean;
	brg: number; // rad
	relative: boolean; // relativ zum Bug (R) oder wahr (T)
	vrm: number; // m, 0 = kein VRM
}

export interface Marker {
	id: number;
	pos: LatLon;
	label: string;
	kind: 'mark' | 'mob';
	t: number;
}

const MK = 'suki-radar-markers-v1';
const SK = 'suki-radar-squalls-v1';
function loadList<T>(key: string): T[] {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? '[]');
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

export const tools = $state({
	ebl: [
		{ on: false, brg: 0, relative: true, vrm: 0 },
		{ on: false, brg: Math.PI / 4, relative: true, vrm: 0 }
	] as Ebl[],
	activeEbl: 0,
	/** Cursorposition (geografisch fest, wandert nicht mit dem Boot) oder null */
	cursor: null as null | LatLon,
	markers: loadList<Marker>(MK),
	/** markierte Regenzellen (Squalls) */
	squalls: loadList<Squall>(SK),
	/** Tap-Modus: was ein Tap ins Bild tut */
	tapMode: 'select' as 'select' | 'acquire' | 'ebl' | 'mark' | 'align' | 'measure',
	/** Ebene, die ausgerichtet wird, und erster Tap (Merkmal im Satellitenbild) */
	align: null as null | { layer: string; first: LatLon | null },
	/** Messwerkzeug: Punkte A/B (Lat/Lon) */
	measure: null as null | { a: LatLon; b: LatLon | null },
	/** sichtbarer Kartenausschnitt [West, Süd, Ost, Nord] (für Revier-Download) */
	viewBBox: null as null | [number, number, number, number],
	/** wird hochgezählt, wenn die App aus dem Hintergrund zurückkommt (Verbindungen erneuern) */
	resume: 0,
	/** Kielspur vom Pi: [t, lat, lon] */
	track: [] as [number, number, number][],
	menu: null as null | { sx: number; sy: number; x: number; y: number; pane: number }
});

$effect.root(() => {
	$effect(() => {
		const s = JSON.stringify(tools.markers);
		try {
			localStorage.setItem(MK, s);
		} catch {
			/* ignore */
		}
	});
	$effect(() => {
		const s = JSON.stringify(tools.squalls);
		try {
			localStorage.setItem(SK, s);
		} catch {
			/* ignore */
		}
	});
});

export function addMarker(pos: LatLon, kind: Marker['kind'] = 'mark') {
	const id = Date.now();
	const n = tools.markers.filter((m) => m.kind === kind).length + 1;
	tools.markers.push({ id, pos, kind, label: kind === 'mob' ? 'MOB' : `M${n}`, t: Date.now() });
	return id;
}

export function removeMarker(id: number) {
	tools.markers = tools.markers.filter((m) => m.id !== id);
}

export const markSquall = (pos: LatLon) => (tools.squalls = addSquallFix(tools.squalls, pos, Date.now()));
export const removeSquall = (id: number) => (tools.squalls = tools.squalls.filter((s) => s.id !== id));
