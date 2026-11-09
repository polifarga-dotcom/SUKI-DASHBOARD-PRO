// Alarmengine: wertet Ziele, Guard Zones und Sensorzustand aus; quittieren, stummschalten, Protokoll.
import { settings } from '../lib/settings.svelte';
import { fmtDist, norm2pi, NM, bearingOf, toLocal, dec } from '../lib/geo';
import { own, sk, ownFresh } from '../data/signalk.svelte';
import { radar, isLive, isTransmitting, ctlValue } from '../data/mayara.svelte';
import { targets, type Target } from '../collision/targets.svelte';
import { tools } from '../radar/tools.svelte';
import { squallEncounter, pruneSqualls } from '../collision/squall';
import type { Situation } from '../collision/cpa';
import { playAlarm, playWarning } from './audio';
import { t, t as tr } from '../lib/i18n.svelte';

export type Level = 'alarm' | 'warning';

export type Category = 'collision' | 'guard' | 'sart' | 'lost' | 'system' | 'mob' | 'depth' | 'watch' | 'squall';

export interface Alarm {
	id: string;
	level: Level;
	category: Category;
	/** Zielname bzw. Kurzbezeichnung */
	title: string;
	/** ein verständlicher Satz, was los ist */
	detail: string;
	/** was zu tun ist (KVR-Hinweis), optional */
	advice?: string;
	since: number;
	acked: boolean;
	targetKey?: string;
	/** zuletzt erfüllt (für den Nachlauf) */
	seen: number;
}

const CATEGORY_LABEL: Record<Category, string> = {
	collision: 'Collision risk',
	guard: 'Guard zone',
	sart: 'Distress beacon',
	lost: 'Target lost',
	system: 'System',
	mob: 'Man overboard',
	depth: 'Shallow water',
	watch: 'Watch alarm',
	squall: 'Squall'
};
export const categoryLabel = (c: Category) => t(CATEGORY_LABEL[c]);

export interface LogEntry {
	t: number;
	id: string;
	level: Level;
	text: string;
	event: 'raised' | 'acked' | 'cleared';
}

export const alarms = $state({
	active: [] as Alarm[],
	log: [] as LogEntry[],
	mutedUntil: 0,
	guardHit: [false, false] as [boolean, boolean]
});

/** Wachalarm: letzte Bestätigung */
export const watch = $state({ last: Date.now() });
export function confirmWatch() {
	watch.last = Date.now();
}
/** Wachalarm ein-/ausschalten; beim Einschalten läuft die Zeit ab jetzt */
export function setWatch(on: boolean) {
	settings.watchOn = on;
	confirmWatch();
}
/** nach so langer Zeit ohne Quittung wird der Wachalarm mit voller Lautstärke gespielt */
const WATCH_ESCALATE_MS = 2 * 60e3;
/** Squall-Warnung: CPA unter 1 sm und Eintreffen innerhalb von 20 min */
const SQUALL_CPA = 1852;
const SQUALL_TCPA = 20 * 60;
/** Alarme, die sofort enden (kein Nachlauf) und deren Quittung nicht gemerkt wird */
const NO_HOLD = new Set<Category>(['system', 'watch']);

const wasDangerous = new Map<string, number>();
/** Alarm bleibt so lange nach Wegfall der Bedingung stehen (kein Flackern an der Grenze) */
const HOLD_MS = 20000;
/** quittierte Alarme, die in dieser Zeit wiederkommen, bleiben quittiert */
const ACK_MEMORY_MS = 3 * 60 * 1000;
const ackedAt = new Map<string, number>();
const appStart = Date.now();
/** Anlaufzeit für Systemwarnungen: erst melden, wenn der Zustand so lange anhält */
const SYS_GRACE = 15000;
let skUpSince = 0; // seit wann SignalK verbunden ist
let skOkAt = Date.now(); // zuletzt verbunden gesehen
let lastSound = 0;
let lastWarnSound = 0;

function log(a: Alarm, event: LogEntry['event']) {
	alarms.log.unshift({ t: Date.now(), id: a.id, level: a.level, text: `${categoryLabel(a.category)}: ${a.title} — ${a.detail}`, event });
	if (alarms.log.length > 200) alarms.log.length = 200;
}

const ADVICE: Record<Situation, string> = {
	'head-on': 'Head-on: both vessels alter course to starboard.',
	'crossing-give-way': 'Crossing from starboard: you give way – alter course to starboard or slow down.',
	'crossing-stand-on': 'Crossing from port: keep course and speed, watch the other vessel.',
	overtaking: 'You are overtaking: keep well clear of this vessel.',
	overtaken: 'You are being overtaken: keep course and speed.',
	none: ''
};

const mins = (sec: number) => (sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);

function collisionText(tg: Target) {
	const e = tg.enc!;
	let txt = t('Passes {d} from you in {t}.', { d: fmtDist(e.cpa), t: mins(e.tcpa) });
	if (e.bcr != null && e.bct != null && e.bct < settings.tcpaLimit)
		txt +=
			' ' +
			t(e.bcr >= 0 ? 'Crosses {d} ahead of your bow in {t}.' : 'Crosses {d} astern of you in {t}.', { d: fmtDist(Math.abs(e.bcr)), t: mins(e.bct) });
	return txt;
}

/** Ist ein Ziel in einer Guard Zone (relativ zum Bug)? */
export function inGuard(t: Target, z: number): boolean {
	const g = settings.guard[z];
	if (!g.enabled || t.range < g.inner || t.range > g.outer) return false;
	const hdg = own.hdg ?? own.cog ?? 0;
	const rel = norm2pi(t.bearing - hdg);
	const w = norm2pi(g.end - g.start);
	if (w < 1e-6) return true;
	return norm2pi(rel - g.start) <= w;
}

/** Einmal pro Sekunde aufrufen */
export function evaluateAlarms(now = Date.now()) {
	const want = new Map<string, Omit<Alarm, 'since' | 'acked' | 'seen'>>();

	for (const t of targets.list) {
		if (t.kind === 'arpa' && (t as any).fusedTo) continue;
		if (t.aisClass === 'SART') {
			const kind = /^972/.test(t.vessel?.mmsi ?? '') ? 'AIS MOB' : /^974/.test(t.vessel?.mmsi ?? '') ? 'AIS EPIRB' : 'AIS SART';
			want.set('sart:' + t.key, { id: 'sart:' + t.key, level: 'alarm', category: 'sart', title: `${kind} ${t.label}`, detail: tr('Distress signal {d} away, bearing {b}°.', { d: fmtDist(t.range), b: Math.round((t.bearing * 180) / Math.PI) }), advice: tr('Possible person or vessel in distress – check and report (VHF 16).'), targetKey: t.key });
			continue;
		}
		if (t.danger === 'dangerous' && !t.lost) {
			wasDangerous.set(t.key, now);
			want.set('cpa:' + t.key, { id: 'cpa:' + t.key, level: 'alarm', category: 'collision', title: t.label, detail: collisionText(t), advice: ADVICE[t.situation] ? tr(ADVICE[t.situation]) : '', targetKey: t.key });
		}
		if (t.lost && settings.lostTargetAlarm && now - (wasDangerous.get(t.key) ?? 0) < 10 * 60 * 1000) {
			want.set('lost:' + t.key, { id: 'lost:' + t.key, level: 'warning', category: 'lost', title: t.label, detail: tr('A dangerous target stopped reporting. Last seen {d} away.', { d: fmtDist(t.range) }), advice: tr('Look out visually and on radar.'), targetKey: t.key });
		}
		if (settings.aisGuard && !t.lost && !t.moored) {
			for (let z = 0; z < 2; z++)
				if (inGuard(t, z) && t.aisClass !== 'ATON' && t.aisClass !== 'BASE')
					want.set(`gz${z}:${t.key}`, { id: `gz${z}:${t.key}`, level: 'alarm', category: 'guard', title: t.label, detail: tr('Vessel inside guard zone {z}, {d} away.', { z: z + 1, d: fmtDist(t.range) }), targetKey: t.key });
		}
	}
	for (const [k, t] of wasDangerous) if (now - t > 15 * 60 * 1000) wasDangerous.delete(k);

	// Radar-Echos in Guard Zones (Zählung im Spoke-Worker)
	const rid = settings.radarId;
	const r = radar.byId[rid];
	const tx = r && isLive(rid);
	const hit: [boolean, boolean] = [false, false];
	for (let z = 0; z < 2; z++) {
		const g = settings.guard[z];
		if (!g.enabled || !tx) continue;
		if ((r?.guardCounts[z] ?? 0) >= g.sensitivity) {
			hit[z] = true;
			want.set(`gzr${z}`, { id: `gzr${z}`, level: 'alarm', category: 'guard', title: tr('Zone {n}', { n: z + 1 }), detail: tr('Radar echo inside guard zone {z} ({a}–{b}).', { z: z + 1, a: fmtDist(g.inner), b: fmtDist(g.outer) }), advice: tr('Check the radar picture. If it is sea clutter, raise the echo sensitivity in Alarms.') });
		}
	}
	for (const a of want.values()) {
		const m = a.id.match(/^gz(\d):/);
		if (m) hit[Number(m[1])] = true;
	}
	alarms.guardHit = hit;

	// MOB: bleibt aktiv, bis der MOB-Marker gelöscht wird
	if (own.pos)
		for (const m of tools.markers) {
			if (m.kind !== 'mob') continue;
			const [x, y] = toLocal(own.pos, m.pos);
			want.set(`mob:${m.id}`, {
				id: `mob:${m.id}`,
				level: 'alarm',
				category: 'mob',
				title: 'MOB',
				detail: tr('Bearing {b}°, distance {d}, {t} ago.', { b: Math.round((bearingOf(x, y) * 180) / Math.PI), d: fmtDist(Math.hypot(x, y)), t: mins((now - m.t) / 1000) }),
				advice: tr('Keep visual contact, point at the person, call MAYDAY on VHF 16. Delete the MOB marker when recovered.')
			});
		}

	// Flachwasser (mit 0,3 m Hysterese)
	const lim = settings.shallowAlarm;
	const fresh = own.depth != null && now - own.depthT < 15000;
	if (lim > 0 && fresh && (own.depth! < lim || (alarms.active.some((a) => a.id === 'depth') && own.depth! < lim + 0.3)))
		want.set('depth', {
			id: 'depth',
			level: 'alarm',
			category: 'depth',
			title: tr('Depth {d} m', { d: dec(own.depth!, 1) }),
			detail: tr('Below the shallow-water limit of {l} m ({w}).', { l: dec(lim, 1), w: tr(own.depthKeel ? 'below keel' : 'below transducer') }),
			advice: tr('Slow down and check the chart.')
		});

	// Wachalarm (Totmann): Bestätigung alle n Minuten, 1 min vorher Vorwarnung
	if (settings.watchOn && settings.watchMin > 0) {
		const left = watch.last + settings.watchMin * 60e3 - now;
		if (left <= 0)
			want.set('watch', { id: 'watch', level: 'alarm', category: 'watch', title: tr('Watch check'), detail: tr('No watch confirmation for {t}.', { t: mins((now - watch.last) / 1000) }), advice: tr('Look around, check radar and AIS, then press “Watch OK”.') });
		else if (left <= Math.min(60e3, (settings.watchMin * 60e3) / 3)) // Vorwarnung (bei kurzen Intervallen kürzer)
			want.set('watch-pre', { id: 'watch-pre', level: 'warning', category: 'watch', title: tr('Watch check'), detail: tr('Confirm the watch within {t}.', { t: mins(left / 1000) }) });
	}

	// Squalls (markierte Regenzellen)
	if (tools.squalls.length) {
		const kept = pruneSqualls(tools.squalls, now);
		if (kept.length !== tools.squalls.length) tools.squalls = kept;
	}
	if (own.pos)
		tools.squalls.forEach((s, i) => {
			const e = squallEncounter(s, own.pos!, { course: own.cog, speed: own.sog }, now);
			if (e && e.tcpa > 0 && e.tcpa < SQUALL_TCPA && e.cpa < SQUALL_CPA)
				want.set(`squall:${s.id}`, { id: `squall:${s.id}`, level: 'warning', category: 'squall', title: `SQ${i + 1}`, detail: tr('Squall passes {d} from you in {t}.', { d: fmtDist(e.cpa), t: mins(e.tcpa) }), advice: tr('Reef early, secure the deck, close hatches.') });
		});

	// System
	const sys = (id: string, level: Level, title: string, detail: string) => want.set(id, { id, level, category: 'system', title: tr(title), detail });
	if (sk.connected) {
		skOkAt = now;
		if (!skUpSince) skUpSince = now;
	} else skUpSince = 0;
	// beim Start / nach Neuverbindung erst die Daten abwarten, statt sofort zu warnen
	if (!sk.connected && now - skOkAt > SYS_GRACE && now - appStart > SYS_GRACE)
		sys('sys:sk', 'warning', 'SignalK disconnected', tr('No AIS and no own position – collision alarms are not working.'));
	else if (sk.connected && skUpSince && now - skUpSince > SYS_GRACE && !ownFresh())
		sys('sys:gps', 'warning', 'No GPS position', tr('Own position is missing – CPA and AIS alarms are not working.'));
	if (r) {
		if (Number(ctlValue(rid, 'power')) === 4) sys('sys:fault', 'alarm', 'Radar fault', tr('{r} reports a fault.', { r: r.name }));
		if (isTransmitting(rid) && now - r.lastSpoke > 8000 && now - appStart > 10000) sys('sys:spokes', 'warning', 'No radar image', tr('The radar is transmitting but no picture arrives.'));
		if (tx && (own.hdg == null || now - own.hdgT > 10000)) sys('sys:hdg', 'warning', 'No heading', tr('Radar picture is not stabilised, ARPA tracking is degraded.'));
	} else if (radar.error) sys('sys:radar', 'warning', 'Radar server offline', tr('No connection to the radar server on the Pi.'));

	// Abgleich aktiv ↔ gewünscht
	const next: Alarm[] = [];
	for (const a of alarms.active) {
		const w = want.get(a.id);
		if (w) {
			next.push({ ...a, ...w, seen: now });
			want.delete(a.id);
		} else if (!NO_HOLD.has(a.category) && now - a.seen < HOLD_MS) next.push(a); // Nachlauf: kurz weg ≠ vorbei (System/Wache enden sofort)
		else {
			log(a, 'cleared');
			if (a.acked && !NO_HOLD.has(a.category)) ackedAt.set(a.id, now);
		}
	}
	for (const w of want.values()) {
		const acked = now - (ackedAt.get(w.id) ?? 0) < ACK_MEMORY_MS;
		const a: Alarm = { ...w, since: now, acked, seen: now };
		next.push(a);
		if (!acked) log(a, 'raised');
	}
	for (const [k, t] of ackedAt) if (now - t > ACK_MEMORY_MS) ackedAt.delete(k);
	next.sort((a, b) => (a.level === b.level ? b.since - a.since : a.level === 'alarm' ? -1 : 1));
	alarms.active = next;

	// Ton
	if (!settings.alarmSound || now < alarms.mutedUntil) return;
	const unackedAlarm = next.some((a) => a.level === 'alarm' && !a.acked);
	const unackedWarn = next.some((a) => a.level === 'warning' && !a.acked);
	if (unackedAlarm && now - lastSound > 1100) {
		lastSound = now;
		const escalate = next.some((a) => a.category === 'watch' && a.level === 'alarm' && !a.acked && now - a.since > WATCH_ESCALATE_MS);
		playAlarm(escalate ? 1 : settings.alarmVolume);
	} else if (!unackedAlarm && unackedWarn && now - lastWarnSound > 15000) {
		lastWarnSound = now;
		playWarning(settings.alarmVolume);
	}
}

export function ackAlarm(id: string) {
	const a = alarms.active.find((x) => x.id === id);
	if (a && !a.acked) {
		a.acked = true;
		log(a, 'acked');
	}
	if (a?.category === 'watch') confirmWatch();
}

export function ackAll() {
	for (const a of alarms.active) {
		if (!a.acked) {
			a.acked = true;
			log(a, 'acked');
		}
		if (a.category === 'watch') confirmWatch();
	}
}

export function muteFor(min: number) {
	alarms.mutedUntil = Date.now() + min * 60000;
}

export const GUARD_DEFAULT_OUTER = 0.75 * NM;
