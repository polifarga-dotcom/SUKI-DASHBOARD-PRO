// mayara-Client: Radarliste, Capabilities, Controls (lesen/setzen), ARPA-Ziele.
// API: /signalk/v2/api/vessels/self/radars/… und Control-Stream /signalk/v1/stream (siehe mayara --openapi).
import { settings } from '../lib/settings.svelte';

export interface ControlDef {
	id: number;
	name: string;
	description?: string;
	category: 'base' | 'advanced' | 'targets' | 'trails' | 'installation' | 'info' | string;
	dataType: 'number' | 'enum' | 'string' | 'button' | 'zone' | 'sector' | string;
	minValue?: number;
	maxValue?: number;
	stepValue?: number;
	units?: string;
	hasAuto?: boolean;
	hasAutoAdjustable?: boolean;
	autoAdjustMinValue?: number;
	autoAdjustMaxValue?: number;
	hasEnabled?: boolean;
	descriptions?: Record<string, string>;
	validValues?: number[];
	isReadOnly?: boolean;
}

export interface ControlValue {
	value?: any;
	auto?: boolean | null;
	autoValue?: number | null;
	enabled?: boolean | null;
	endValue?: number | null;
	startDistance?: number | null;
	endDistance?: number | null;
	allowed?: boolean | null;
	error?: string | null;
	timestamp?: string | null;
}

export interface Legend {
	pixelColors: number;
	dopplerApproaching: [number, number] | null;
	dopplerReceding: [number, number] | null;
	historyStart: number;
	strongReturn: number;
	mediumReturn: number;
	lowReturn: number;
}

export interface Capabilities {
	maxRange: number;
	minRange: number;
	supportedRanges: number[];
	spokesPerRevolution: number;
	maxSpokeLength: number;
	pixelValues: number;
	legend: Legend;
	hasDoppler: boolean;
	hasDualRange: boolean;
	controls: Record<string, ControlDef>;
}

export interface ArpaTarget {
	id: number;
	status: 'tracking' | 'acquiring' | 'lost' | string;
	acquisition: 'auto' | 'manual' | string;
	position: { bearing: number; distance: number; latitude?: number | null; longitude?: number | null };
	motion?: { course: number; speed: number } | null;
	danger?: { cpa: number; tcpa: number; is_dangerous: boolean };
	sourceZone?: number | null;
	firstSeen: string;
	lastSeen: string;
	/** lokal: Verlauf (true) für Trails */
	track?: { lat: number; lon: number; t: number }[];
	rxT?: number;
}

export interface Radar {
	id: string;
	name: string;
	model: string;
	ip: string;
	replay: boolean;
	caps: Capabilities | null;
	controls: Record<string, ControlValue>;
	targetsEnabled: boolean;
	spokeConnected: boolean;
	spokeRate: number;
	lastSpoke: number;
	revPeriod: number;
	guardCounts: [number, number];
}

export const radar = $state({
	list: [] as string[],
	byId: {} as Record<string, Radar>,
	connected: false,
	error: '',
	lastError: '' as string,
	version: 0
});

/** ARPA-Ziele je Radar (nicht reaktiv; UI über radar.version) */
export const arpa = new Map<string, Map<number, ArpaTarget>>();

const api = () => `${settings.radarBase}/signalk/v2/api/vessels/self/radars`;

let ws: WebSocket | null = null;
let retry = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let currentBase = '';

async function getJson(url: string) {
	const r = await fetch(url, { cache: 'no-store' });
	if (!r.ok) throw new Error(`${r.status} ${url}`);
	return r.json();
}

export async function loadRadars() {
	try {
		const d = await getJson(api());
		const ids = Object.keys(d.radars ?? {});
		for (const id of ids) {
			const info = d.radars[id];
			const old = radar.byId[id];
			radar.byId[id] = {
				id,
				name: info.name ?? id,
				model: info.model ?? '',
				ip: info.radarIpAddress ?? '',
				replay: !!info.replay,
				caps: old?.caps ?? null,
				controls: old?.controls ?? {},
				targetsEnabled: old?.targetsEnabled ?? true,
				spokeConnected: old?.spokeConnected ?? false,
				spokeRate: old?.spokeRate ?? 0,
				lastSpoke: old?.lastSpoke ?? 0,
				revPeriod: old?.revPeriod ?? 0,
				guardCounts: old?.guardCounts ?? [0, 0]
			};
			if (!radar.byId[id].caps) {
				try {
					radar.byId[id].caps = await getJson(`${api()}/${id}/capabilities`);
				} catch (e) {
					console.warn('caps', id, e);
				}
			}
			await refreshControls(id);
		}
		for (const id of Object.keys(radar.byId)) if (!ids.includes(id)) delete radar.byId[id];
		radar.list = ids;
		// Auswahl korrigieren, falls die gespeicherte ID nicht (mehr) existiert
		if (ids.length && !ids.includes(settings.radarId)) settings.radarId = ids[0];
		if (ids.length > 1 && !ids.includes(settings.radarIdB)) settings.radarIdB = ids.find((i) => i !== settings.radarId) ?? ids[0];
		radar.error = '';
	} catch (e) {
		radar.error = 'Radar server not reachable';
		console.warn(e);
	}
}

export async function refreshControls(id: string) {
	try {
		const c = await getJson(`${api()}/${id}/controls`);
		const r = radar.byId[id];
		if (r) r.controls = c;
	} catch {
		/* ignore */
	}
}

async function pollTargets() {
	for (const id of radar.list) {
		const r = radar.byId[id];
		if (!r || !r.targetsEnabled) continue;
		try {
			const res = await fetch(`${api()}/${id}/targets`, { cache: 'no-store' });
			if (res.status === 400) {
				r.targetsEnabled = false;
				continue;
			}
			if (!res.ok) continue;
			const list: ArpaTarget[] = await res.json();
			const m = arpaMap(id);
			const seen = new Set<number>();
			for (const t of list) {
				seen.add(t.id);
				upsertTarget(id, t);
			}
			for (const k of m.keys()) if (!seen.has(k)) m.delete(k);
		} catch {
			/* ignore */
		}
	}
	radar.version++;
}

function arpaMap(id: string) {
	let m = arpa.get(id);
	if (!m) arpa.set(id, (m = new Map()));
	return m;
}

function upsertTarget(radarId: string, t: ArpaTarget) {
	const m = arpaMap(radarId);
	const old = m.get(t.id);
	const now = Date.now();
	const track = old?.track ?? [];
	const lat = t.position?.latitude;
	const lon = t.position?.longitude;
	if (lat != null && lon != null) {
		const last = track[track.length - 1];
		if (!last || now - last.t > 5000) track.push({ lat, lon, t: now });
		while (track.length && now - track[0].t > 15 * 60 * 1000) track.shift();
	}
	m.set(t.id, { ...t, track, rxT: now });
}

function onStream(msg: any) {
	if (!msg.updates) return;
	let touched = false;
	for (const u of msg.updates) {
		for (const v of u.values ?? []) {
			const p: string[] = (v.path ?? '').split('.');
			if (p[0] !== 'radars' || p.length < 4) continue;
			const id = p[1];
			const r = radar.byId[id];
			if (p[2] === 'controls' && r) {
				// mayara schickt {path, value: {value, auto, …}}; ältere Versionen flach {path, value, auto}
				const { path, ...rest } = v;
				const cvv = v.value && typeof v.value === 'object' && 'value' in v.value ? v.value : rest;
				r.controls[p[3]] = { ...(r.controls[p[3]] ?? {}), ...cvv };
			} else if (p[2] === 'targets') {
				const tid = Number(p[3]);
				if (v.value == null) arpaMap(id).delete(tid);
				else upsertTarget(id, { ...v.value, id: v.value.id ?? tid });
				touched = true;
			}
		}
	}
	if (touched) radar.version++;
}

export function connectMayara() {
	currentBase = settings.radarBase;
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	ws = new WebSocket(`${proto}://${location.host}${currentBase}/signalk/v1/stream?subscribe=all&sendCachedValues=true`);
	ws.onopen = () => {
		retry = 0;
		radar.connected = true;
		loadRadars();
	};
	ws.onmessage = (e) => {
		if (typeof e.data !== 'string') return;
		try {
			onStream(JSON.parse(e.data));
		} catch {
			/* ignore */
		}
	};
	ws.onclose = () => {
		radar.connected = false;
		ws = null;
		setTimeout(() => {
			if (currentBase === settings.radarBase) connectMayara();
		}, Math.min(10000, 1000 * 2 ** retry++));
	};
	clearInterval(pollTimer);
	let n = 0;
	pollTimer = setInterval(() => {
		pollTargets();
		// Fallback alle 10 s, falls der Stream einzelne Controls nicht liefert
		if (++n % 5 === 0) for (const id of radar.list) refreshControls(id);
	}, 2000);
}

/** nach Hintergrund/Display-aus: Control-Stream neu verbinden (tote Verbindung), Zustand bleibt */
export function resumeMayara() {
	const old = ws;
	ws = null;
	if (old) {
		old.onopen = old.onmessage = old.onerror = old.onclose = null;
		try {
			old.close();
		} catch {
			/* ignore */
		}
	}
	radar.connected = false;
	connectMayara();
}

/** Server wechseln (echtes Radar ↔ Emulator) */
export function reconnectMayara() {
	const old = ws;
	currentBase = '';
	old?.close();
	radar.list = [];
	radar.byId = {};
	arpa.clear();
	connectMayara();
}

/** Control setzen. body z. B. {value: 50, auto: false} */
export async function setControl(id: string, control: string, body: ControlValue): Promise<boolean> {
	const r = radar.byId[id];
	if (r) r.controls[control] = { ...(r.controls[control] ?? {}), ...body };
	try {
		const res = await fetch(`${api()}/${id}/controls/${control}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			radar.lastError = `${control}: ${(await res.text()) || res.status}`;
			refreshControls(id);
			return false;
		}
		radar.lastError = '';
		return true;
	} catch (e) {
		radar.lastError = `${control}: ${e}`;
		return false;
	}
}

export async function acquireTarget(id: string, lat: number, lon: number) {
	try {
		const res = await fetch(`${api()}/${id}/targets`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ latitude: lat, longitude: lon })
		});
		if (!res.ok) radar.lastError = `Acquire: ${(await res.text()) || res.status}`;
		else pollTargets();
		return res.ok;
	} catch (e) {
		radar.lastError = `Acquire: ${e}`;
		return false;
	}
}

export async function cancelTarget(id: string, tid: number) {
	try {
		await fetch(`${api()}/${id}/targets/${tid}`, { method: 'DELETE' });
	} catch {
		/* ignore */
	}
	arpa.get(id)?.delete(tid);
	radar.version++;
}

export const ctl = (id: string, name: string) => radar.byId[id]?.controls?.[name];
export const ctlValue = (id: string, name: string) => radar.byId[id]?.controls?.[name]?.value;
/** am Plotter/der App eingestellte Reichweite (m) */
export const radarRange = (id: string): number => Number(ctlValue(id, 'range')) || 0;
export const isTransmitting = (id: string) => Number(ctlValue(id, 'power')) === 2;
/** sendet laut Status ODER es kommen gerade Spokes (Emulator/Fremdsteuerung melden den Status nicht immer korrekt) */
export const isLive = (id: string) => isTransmitting(id) || Date.now() - (radar.byId[id]?.lastSpoke ?? 0) < 3000;
export const spokeUrl = (id: string) => {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${location.host}${settings.radarBase}/signalk/v2/api/vessels/self/radars/${id}/spokes`;
};
