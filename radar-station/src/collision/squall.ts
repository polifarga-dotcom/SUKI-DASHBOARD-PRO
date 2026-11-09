// Squall-Verfolgung: Regenzelle zweimal (oder öfter) im Radarbild markieren → Zugrichtung, Fahrt, CPA/Eintreffen.
// Manuelles Plotten statt ARPA, weil ARPA auf große, diffuse Echos unzuverlässig ist.
import { bearingOf, fromLocal, toLocal, type LatLon } from '../lib/geo';
import { encounter, type Encounter, type Motion } from './cpa';

export interface Squall {
	id: number;
	fixes: { t: number; pos: LatLon }[];
}

/** mindestens so viel Zeit zwischen erster und letzter Markierung, sonst ist die Bewegung zu ungenau */
export const MIN_FIX_DT = 120e3;

/** Bewegung (m/s Ost, Nord) aus erster und letzter Markierung; null, solange nur eine Markierung */
export function squallVel(s: Squall): [number, number] | null {
	const a = s.fixes[0];
	const b = s.fixes[s.fixes.length - 1];
	const dt = (b.t - a.t) / 1000;
	if (dt < MIN_FIX_DT / 1000) return null;
	const [x, y] = toLocal(a.pos, b.pos);
	return [x / dt, y / dt];
}

/** vermutete Position jetzt */
export function squallPos(s: Squall, now: number): LatLon {
	const b = s.fixes[s.fixes.length - 1];
	const v = squallVel(s);
	if (!v) return b.pos;
	const dt = (now - b.t) / 1000;
	return fromLocal(b.pos, v[0] * dt, v[1] * dt);
}

export function squallEncounter(s: Squall, ownPos: LatLon, own: Motion, now: number): Encounter | null {
	const v = squallVel(s);
	if (!v) return null;
	const [px, py] = toLocal(ownPos, squallPos(s, now));
	return encounter(px, py, own, { course: bearingOf(v[0], v[1]), speed: Math.hypot(v[0], v[1]) });
}

/** Markierung hinzufügen: gehört sie zu einer bekannten Zelle (≤ 3 sm von deren vermuteter Position), sonst neue Zelle */
export function addSquallFix(list: Squall[], pos: LatLon, now: number): Squall[] {
	let best: Squall | null = null;
	let bestD = 3 * 1852;
	for (const s of list) {
		const d = Math.hypot(...toLocal(pos, squallPos(s, now)));
		if (d < bestD) [best, bestD] = [s, d];
	}
	if (!best) return [...list, { id: now, fixes: [{ t: now, pos }] }];
	// nur die letzten 40 min zählen (Zellen ändern Richtung/Form)
	const fixes = [...best.fixes, { t: now, pos }].filter((f) => now - f.t < 40 * 60e3).slice(-6);
	return list.map((s) => (s === best ? { ...s, fixes } : s));
}

/** Zellen ohne neue Markierung seit 90 min verwerfen */
export const pruneSqualls = (list: Squall[], now: number) => list.filter((s) => now - s.fixes[s.fixes.length - 1].t < 90 * 60e3);
