// Stummschaltung und Wachalarm über den Pi mit allen Browsern/Geräten teilen.
// Der Pi gibt den Wachzustand auch an Node-RED weiter (Kabinen- und 7"-Display).
import { settings } from '../lib/settings.svelte';
import { alarms, watch } from './alarms.svelte';

const URL = '/tiles/api/shared';
/** über HTTP: Zeiten relativ (ms), damit die Uhren von Gerät und Pi nicht übereinstimmen müssen */
export type Wire = { sound: boolean; untilIn: number; watchOn: boolean; watchMin: number; lastAgo: number };
/** lokal: Zeiten absolut in Geräteuhr */
type State = { sound: boolean; until: number; watchOn: boolean; watchMin: number; last: number };

const TOL = 1500; // ms Netz-Laufzeit, darunter gelten Zeiten als gleich
const near = (a: number, b: number) => Math.abs(a - b) < TOL;
export const same = (a: State, b: State) =>
	a.sound === b.sound && a.watchOn === b.watchOn && a.watchMin === b.watchMin && near(a.until, b.until) && near(a.last, b.last);
export const fromWire = (w: Wire, now: number): State => ({
	sound: w.sound, until: w.untilIn > 0 ? now + w.untilIn : 0, watchOn: w.watchOn, watchMin: w.watchMin, last: now - w.lastAgo
});
export const toWire = (s: State, now: number): Wire => ({
	sound: s.sound, untilIn: Math.max(0, s.until - now), watchOn: s.watchOn, watchMin: s.watchMin, lastAgo: Math.max(0, now - s.last)
});
const local = (): State => ({ sound: settings.alarmSound, until: alarms.mutedUntil, watchOn: settings.watchOn, watchMin: settings.watchMin, last: watch.last });

/** Startet den Abgleich; gibt eine Stop-Funktion zurück. */
export function startAlarmSync(pollMs = 2000) {
	let remote: State | null = null; // letzter bekannter Stand auf dem Pi
	const poll = async () => {
		try {
			const r = await fetch(URL, { cache: 'no-store' });
			if (!r.ok) return;
			const m = fromWire(await r.json(), Date.now());
			if (remote && same(m, remote)) return;
			remote = m;
			settings.alarmSound = m.sound;
			alarms.mutedUntil = m.until;
			settings.watchOn = m.watchOn;
			settings.watchMin = m.watchMin;
			watch.last = m.last;
		} catch {
			/* Pi nicht erreichbar → lokaler Zustand gilt weiter */
		}
	};
	const stopEffect = $effect.root(() => {
		$effect(() => {
			const m = local();
			if (!remote || same(m, remote)) return; // erst nach dem ersten Abruf senden, nie das Echo
			remote = m;
			fetch(URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toWire(m, Date.now())) }).catch(() => {});
		});
	});
	poll();
	const t = setInterval(poll, pollMs);
	return () => {
		clearInterval(t);
		stopEffect();
	};
}
