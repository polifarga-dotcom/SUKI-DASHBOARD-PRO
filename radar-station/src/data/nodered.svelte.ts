// AIS-Kollisionsalarm kommt aus Node-RED (ein Alarm für Radar-App, Mini Dash, Cabin Watch und Piezo).
// Die App zeigt ihn an, quittiert dort und schreibt die gewählte Voreinstellung als Grenzwerte nach Node-RED.
import { settings, type AlarmPreset } from '../lib/settings.svelte';
import { NM } from '../lib/geo';

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
	aisAlarms: [] as NrAisAlarm[]
});

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
	const t = setInterval(poll, 2000);
	return () => clearInterval(t);
}
