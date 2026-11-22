// AIS-Kollisionsalarm kommt aus Node-RED (ein Alarm für Radar-App, Mini Dash, Cabin Watch und Piezo).
// Die App zeigt ihn an, quittiert dort und schreibt die gewählte Voreinstellung als Grenzwerte nach Node-RED.
import { settings, type AlarmPreset } from '../lib/settings.svelte';
import { NM, type LatLon } from '../lib/geo';
import { tools } from '../radar/tools.svelte';

const BASE = '/esp-dash/api';

export interface NrAisAlarm {
	key: string; // 'ais_' + MMSI
	mmsi: string;
	name: string;
	cpa: number; // m
	tcpa: number; // s
	acked: boolean;
}

export const nr = $state({
	ok: false,
	t: 0,
	mode: '' as string, // anchor = aus, cruising, offshore
	/** gewählte Alarmquelle; src = tatsächlich aktive (Cortex stumm → suki) */
	source: 'suki' as 'suki' | 'cortex',
	src: 'suki' as 'suki' | 'cortex',
	cortexProfile: '' as string,
	/** Bordzeitzone aus der GPS-Position (Node-RED) */
	tz: '' as string,
	/** Rigg-Last aus den Cyclops-Sensoren in t, Status ok/warn/alarm wie der Rigg-Alarm am Mini Dash */
	rig: null as null | { port: number | null; sb: number | null; pst: string; sst: string; warn: number; alarm: number },
	/** aktive Rigg-Alarme aus Node-RED (Schlüssel rig_port / rig_sb) */
	rigAlarms: [] as NrRigAlarm[],
	/** Rigg-Alarm-Einstellung in Node-RED (gilt für Mini Dash, Cabin Watch, Piezo und diese App) */
	rigCfg: null as null | { on: boolean; warn: number; alarm: number },
	aisAlarms: [] as NrAisAlarm[],
	/** in Node-RED quittierte Alarm-Schlüssel */
	acked: [] as string[]
});

export interface NrMob {
	id: number;
	lat: number;
	lon: number;
	t: number;
}
/** bordweite MOB-Positionen bzw. Wegpunkte „hier“ aus Node-RED als Marker übernehmen (eigene Marker bleiben unberührt) */
export function syncShared(kind: 'mob' | 'mark', list: NrMob[]) {
	const ids = new Set(list.map((m) => m.id));
	const keep = tools.markers.filter((m) => !m.shared || m.kind !== kind || ids.has(m.id));
	const add = list.filter((m) => !keep.some((x) => x.id === m.id)).map((m) => ({ id: m.id, pos: { lat: m.lat, lon: m.lon }, kind, label: kind === 'mob' ? 'MOB' : 'WP ' + (list.indexOf(m) + 1), t: m.t, shared: true }));
	if (add.length || keep.length !== tools.markers.length) tools.markers = [...keep, ...add];
}
/** MOB bordweit auslösen; false = Node-RED nicht erreichbar (dann nur lokal) */
export async function mobSet(pos: LatLon) {
	try {
		const r = await fetch(`${BASE}/mob`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', lat: pos.lat, lon: pos.lon, by: 'Radar app' }), signal: AbortSignal.timeout(3000) });
		if (!r.ok) return false;
		syncShared('mob', (await r.json()).mob ?? []);
		return true;
	} catch {
		return false;
	}
}

/** Grenzwerte, die Node-RED für eine Voreinstellung bekommt */
export function nrConfigFor(p: AlarmPreset, cpaM: number, tcpaS: number) {
	if (p === 'off') return { aisMode: 'anchor' };
	const tcpa = Math.round(Math.min(120, Math.max(1, tcpaS / 60)));
	const cpa = Math.round((cpaM / NM) * 100) / 100;
	if (p === 'offshore') return { aisMode: 'offshore', aisOffshoreNm: Math.min(10, Math.max(0.2, cpa)), aisTcpaMin: tcpa };
	return { aisMode: 'cruising', aisCruiseNm: Math.min(5, Math.max(0.05, cpa)), aisTcpaMin: tcpa };
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;
/** Voreinstellung nach Node-RED schreiben (entprellt, Schieberegler) */
export function pushAisConfig() {
	clearTimeout(pushTimer);
	pushTimer = setTimeout(() => {
		fetch(`${BASE}/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(nrConfigFor(settings.alarmPreset, settings.cpaLimit, settings.tcpaLimit))
		}).catch(() => {});
	}, 400);
}

/** AIS-Alarmquelle für alle Anzeigen: eigene Rechnung (SUKI) oder Vesper Cortex */
export function setAisSource(src: 'suki' | 'cortex') {
	nr.source = src;
	return fetch(`${BASE}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aisSource: src }) })
		.then(poll)
		.catch(() => {});
}

/** quittiert in Node-RED alle gerade aktiven Alarme (wie die Taste am Mini Dash) */
export function nrAck() {
	return fetch(`${BASE}/ack`, { method: 'POST' }).catch(() => {});
}

export interface NrRigAlarm {
	key: string;
	side: 'port' | 'sb';
	tons: number | null;
	acked: boolean;
}
export function parseRig(s: any): NrRigAlarm[] {
	const acked = new Set<string>(s?.ackedKeys ?? []);
	return ((s?.alarmKeys ?? []) as string[])
		.filter((k) => k === 'rig_port' || k === 'rig_sb')
		.map((key) => {
			const side = key === 'rig_port' ? 'port' : 'sb';
			return { key, side, tons: s?.sail?.rig?.[side] ?? null, acked: acked.has(key) };
		});
}

let rigTimer: ReturnType<typeof setTimeout> | undefined;
/** Rigg-Alarm in Node-RED ändern (entprellt, Schieberegler) */
export function setRigConfig(c: Partial<{ on: boolean; warn: number; alarm: number }>) {
	if (!nr.rigCfg) return;
	Object.assign(nr.rigCfg, c);
	clearTimeout(rigTimer);
	const { on, warn, alarm } = nr.rigCfg;
	rigTimer = setTimeout(() => {
		rigTimer = undefined;
		fetch(`${BASE}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rigAlarmOn: on, rigWarnT: warn, rigAlarmT: alarm }) }).catch(() => {});
	}, 400);
}
async function loadRigConfig() {
	try {
		const c = (await (await fetch(`${BASE}/config`, { cache: 'no-store' })).json())?.config;
		if (c && Number.isFinite(c.rigAlarmT)) nr.rigCfg = { on: c.rigAlarmOn !== false, warn: c.rigWarnT, alarm: c.rigAlarmT };
	} catch {
		/* Node-RED nicht erreichbar: Einstellung bleibt ausgeblendet */
	}
}

export function parseState(s: any): NrAisAlarm[] {
	const keys: string[] = s?.alarmKeys ?? [];
	const acked = new Set<string>(s?.ackedKeys ?? []);
	const tg = new Map<string, any>((s?.ais?.targets ?? []).map((t: any) => [t.m, t]));
	return keys
		.filter((k) => k.startsWith('ais_'))
		.map((key) => {
			const mmsi = key.slice(4);
			const t = tg.get(mmsi);
			return { key, mmsi, name: t?.nm || mmsi, cpa: (t?.cpa ?? 0) * NM, tcpa: (t?.tcpa ?? 0) * 60, acked: acked.has(key) };
		});
}

async function poll() {
	try {
		const r = await fetch(`${BASE}/state`, { cache: 'no-store' });
		if (!r.ok) throw new Error(String(r.status));
		const s = await r.json();
		nr.aisAlarms = parseState(s);
		nr.mode = s?.ais?.mode ?? '';
		nr.tz = typeof s?.tz === 'string' ? s.tz : '';
		nr.rig = s?.sail?.rig ?? null;
		// am Mini Dash geänderte Grenzen übernehmen (nicht während eigener Eingabe)
		if (nr.rig && nr.rigCfg && !rigTimer) Object.assign(nr.rigCfg, { warn: nr.rig.warn, alarm: nr.rig.alarm });
		nr.rigAlarms = parseRig(s);
		nr.acked = s?.ackedKeys ?? [];
		if (Array.isArray(s?.mob)) syncShared('mob', s.mob);
		if (Array.isArray(s?.marks)) syncShared('mark', s.marks);
		nr.source = s?.ais?.cortex ? 'cortex' : 'suki';
		nr.src = s?.ais?.src === 'cortex' ? 'cortex' : 'suki';
		nr.cortexProfile = s?.ais?.cortex?.profile ?? '';
		nr.ok = true;
		nr.t = Date.now();
		// AIS-Alarm am Mini Dash umgeschaltet → Anzeige hier angleichen
		if (nr.mode === 'anchor' && settings.alarmPreset !== 'off') settings.alarmPreset = 'off';
		else if (nr.mode && nr.mode !== 'anchor' && settings.alarmPreset === 'off') settings.alarmPreset = 'custom';
	} catch {
		nr.ok = false;
	}
}

export function startNodeRed() {
	poll();
	loadRigConfig();
	const t = setInterval(poll, 2000);
	return () => clearInterval(t);
}
