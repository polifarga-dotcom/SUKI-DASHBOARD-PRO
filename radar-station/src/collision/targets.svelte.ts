// Einheitliche Zielliste aus AIS + ARPA (mayara) inkl. Fusion, CPA/TCPA, BCR, Lage und Gefahrenklasse.
import { own, vessels, type Vessel, type AisClass } from '../data/signalk.svelte';
import { arpa, radar, type ArpaTarget } from '../data/mayara.svelte';
import { settings } from '../lib/settings.svelte';
import { bearingOf, fromLocal, normPi, toLocal, D2R, NM, KN, type LatLon } from '../lib/geo';
import { dangerLevel, encounter, situation, type Danger, type Encounter, type Situation } from './cpa';

export interface Target {
	key: string;
	kind: 'ais' | 'arpa';
	label: string; // Name / MMSI / „T12“
	aisClass: AisClass | 'ARPA';
	pos: LatLon;
	/** relativ zum eigenen Schiff zum Berechnungszeitpunkt (m, Ost/Nord) */
	x: number;
	y: number;
	t: number; // Berechnungszeit
	range: number;
	bearing: number;
	cog: number | null;
	sog: number | null;
	hdg: number | null;
	enc: Encounter | null;
	situation: Situation;
	danger: Danger;
	lost: boolean;
	ageS: number;
	moored: boolean;
	vessel?: Vessel;
	arpa?: ArpaTarget & { radarId: string };
	/** ARPA-Ziel, das dieses AIS-Ziel bestätigt (Fusion) */
	radarMatch?: number;
	sim?: boolean;
}

export const targets = {
	list: [] as Target[],
	byKey: new Map<string, Target>(),
	t: 0
};

export const ui = $state({ version: 0, selected: null as string | null });

const LOST_A = 3 * 60 * 1000;
const LOST_B = 6 * 60 * 1000;
const DROP = 12 * 60 * 1000;

const MOORED = /moored|anchored|aground/i;

/** unter 0,5 kn = stillstehend: GPS-Rauschen festgemachter Schiffe erzeugt sonst Schein-CPAs */
const MIN_SPEED = 0.5 * KN;
/** liegen wir selbst still (Hafen/Anker), melden festgemachte Klasse-B-Geräte oft bis ~1 kn Rauschen */
const MIN_SPEED_MOORED = 1.5 * KN;
const eff = (s: number | null | undefined) => (s != null && s >= MIN_SPEED ? s : 0);
const effTgt = (s: number | null | undefined) => (s != null && s >= ((own.sog ?? 0) < MIN_SPEED ? MIN_SPEED_MOORED : MIN_SPEED) ? s : 0);

function ownMotion() {
	return { course: own.cog ?? own.hdg, speed: eff(own.sog) };
}

function isActiveRadar(id: string) {
	return id === settings.radarId || (settings.dualRange && id === settings.radarIdB);
}

export function computeTargets(now = Date.now()) {
	const list: Target[] = [];
	const byKey = new Map<string, Target>();
	const o = own.pos;
	if (!o) {
		targets.list = list;
		targets.byKey = byKey;
		targets.t = now;
		ui.version++;
		return;
	}
	const om = ownMotion();
	const add = (t: Target) => {
		list.push(t);
		byKey.set(t.key, t);
	};

	// ── AIS ──
	for (const v of vessels.values()) {
		if (!v.pos) continue;
		if (v.mmsi && v.mmsi === own.mmsi) continue;
		const age = now - v.posT;
		if (age > DROP) continue;
		const isA = v.aisClass === 'A';
		const lostLimit = v.aisClass === 'ATON' || v.aisClass === 'BASE' ? Infinity : isA ? LOST_A : LOST_B;
		// auf „jetzt“ extrapolieren (nur sinnvolle Fahrt, max. 3 min)
		let [x, y] = toLocal(o, v.pos);
		if (v.cog != null && v.sog != null && v.sog >= MIN_SPEED) {
			const dt = Math.min(age, 180000) / 1000;
			x += Math.sin(v.cog) * v.sog * dt;
			y += Math.cos(v.cog) * v.sog * dt;
		}
		const tm = { course: v.cog, speed: effTgt(v.sog) };
		const enc = v.aisClass === 'ATON' || v.aisClass === 'BASE' ? null : encounter(x, y, om, tm);
		const brg = bearingOf(x, y);
		const t: Target = {
			key: 'ais:' + v.id,
			kind: 'ais',
			label: v.name || v.mmsi || '?',
			aisClass: v.aisClass,
			pos: fromLocal(o, x, y),
			x,
			y,
			t: now,
			range: Math.hypot(x, y),
			bearing: brg,
			cog: v.cog,
			sog: v.sog,
			hdg: v.hdg,
			enc,
			situation: enc ? situation(brg, om, tm, enc) : 'none',
			danger: enc ? dangerLevel(enc, settings.cpaLimit, settings.tcpaLimit) : 'safe',
			lost: age > lostLimit,
			ageS: age / 1000,
			moored: MOORED.test(v.navState) || (v.sog ?? 0) < 0.15,
			vessel: v,
			sim: v.sim
		};
		if (v.aisClass === 'SART') t.danger = 'dangerous';
		add(t);
	}

	// ── ARPA (mayara) ──
	for (const [rid, m] of arpa) {
		if (!isActiveRadar(rid) || !radar.byId[rid]) continue;
		for (const a of m.values()) {
			if (a.status === 'lost' && now - (a.rxT ?? now) > 60000) continue;
			let x: number, y: number;
			if (a.position.latitude != null && a.position.longitude != null) {
				[x, y] = toLocal(o, { lat: a.position.latitude, lon: a.position.longitude });
			} else {
				x = Math.sin(a.position.bearing) * a.position.distance;
				y = Math.cos(a.position.bearing) * a.position.distance;
			}
			const tm = { course: a.motion?.course ?? null, speed: effTgt(a.motion?.speed) };
			const enc = a.motion ? encounter(x, y, om, tm) : null;
			const brg = bearingOf(x, y);
			add({
				key: `arpa:${rid}:${a.id}`,
				kind: 'arpa',
				label: `T${a.id % 1000000}`,
				aisClass: 'ARPA',
				pos: fromLocal(o, x, y),
				x,
				y,
				t: now,
				range: Math.hypot(x, y),
				bearing: brg,
				cog: a.motion?.course ?? null,
				sog: a.motion?.speed ?? null,
				hdg: null,
				enc,
				situation: enc ? situation(brg, om, tm, enc) : 'none',
				danger: enc && a.status === 'tracking' ? dangerLevel(enc, settings.cpaLimit, settings.tcpaLimit) : 'safe',
				lost: a.status === 'lost',
				ageS: (now - Date.parse(a.lastSeen || '')) / 1000 || 0,
				moored: false,
				arpa: { ...a, radarId: rid }
			});
		}
	}

	fuse(list);
	targets.list = list;
	targets.byKey = byKey;
	targets.t = now;
	ui.version++;
}

/** ARPA ↔ AIS: gleiche Position (Gate abhängig von Entfernung) und ähnliche Bewegung → ein Ziel */
function fuse(list: Target[]) {
	const ais = list.filter((t) => t.kind === 'ais' && !t.lost && t.aisClass !== 'ATON' && t.aisClass !== 'BASE');
	for (const a of list) {
		if (a.kind !== 'arpa' || !a.arpa) continue;
		const gate = Math.max(80, a.range * 0.04);
		let best: Target | null = null;
		let bestD = gate;
		for (const s of ais) {
			const d = Math.hypot(s.x - a.x, s.y - a.y);
			if (d > bestD) continue;
			if (a.sog != null && s.sog != null && a.sog > 1 && s.sog > 1) {
				if (Math.abs(a.sog - s.sog) > 2.5) continue;
				if (a.cog != null && s.cog != null && Math.abs(normPi(a.cog - s.cog)) > 35 * D2R) continue;
			}
			best = s;
			bestD = d;
		}
		if (best) {
			best.radarMatch = a.arpa.id;
			(a as Target & { fusedTo?: string }).fusedTo = best.key;
		}
	}
}

export const isFused = (t: Target) => !!(t as Target & { fusedTo?: string }).fusedTo;

/** sichtbare Ziele (für Liste und Overlay) */
export function visibleTargets(): Target[] {
	return targets.list.filter((t) => {
		if (t.kind === 'ais' && !settings.aisShow) return false;
		if (t.kind === 'arpa' && (!settings.arpaShow || isFused(t))) return false;
		if (settings.hideStaticAis && t.kind === 'ais' && t.moored && t.danger === 'safe' && t.aisClass !== 'SART') return false;
		return true;
	});
}

const dangerRank: Record<Danger, number> = { dangerous: 0, caution: 1, safe: 2 };

export function sortTargets(list: Target[], by: typeof settings.sortBy): Target[] {
	const tc = (t: Target) => (t.enc && t.enc.tcpa > 0 && isFinite(t.enc.tcpa) ? t.enc.tcpa : 1e9);
	const cp = (t: Target) => (t.enc && t.enc.tcpa > 0 ? t.enc.cpa : 1e9);
	const s = [...list];
	if (by === 'danger') s.sort((a, b) => dangerRank[a.danger] - dangerRank[b.danger] || tc(a) - tc(b) || a.range - b.range);
	else if (by === 'cpa') s.sort((a, b) => cp(a) - cp(b));
	else if (by === 'tcpa') s.sort((a, b) => tc(a) - tc(b));
	else s.sort((a, b) => a.range - b.range);
	return s;
}

export const AIS_NEAR = 12 * NM;
