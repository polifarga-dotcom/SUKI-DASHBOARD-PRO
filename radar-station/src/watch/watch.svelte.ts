// Wachplaner: Plan liegt auf dem Pi (/tiles/api/watchplan), nur diese App ändert ihn.
// Speichern ist entprellt; ein auf einem anderen Gerät geänderter Plan (409) wird übernommen.
import { emptyPlan, PRESETS, validTz, type Plan } from '../../pi/chart-proxy/watch.mjs';
import { nr } from '../data/nodered.svelte';

export const wp = $state({ doc: null as Plan | null, err: '', loaded: false, calendar: false });
const URL_ = '/tiles/api/watchplan';
let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

export const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/** Anzeigezone: Ortszeit aus GPS, sonst Gerät — nur Anzeige, der Plan bleibt in UTC */
export const showTz = () => (nr.tz && validTz(nr.tz) ? nr.tz : deviceTz());
export const presetOf = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1];
export const newId = () => Math.random().toString(36).slice(2, 10);

async function load() {
	try {
		const r = await fetch(URL_, { cache: 'no-store' });
		if (!r.ok) throw new Error(String(r.status));
		const j: Plan | null = await r.json();
		if (dirty) return; // eigene Änderung wartet aufs Speichern
		if (!wp.doc || (j && j.rev !== wp.doc.rev)) wp.doc = j ?? emptyPlan('UTC'); // Plan läuft in UTC, keine Verschiebung über Zeitzonen
		wp.loaded = true;
		wp.err = '';
	} catch (e) {
		wp.err = String((e as Error).message ?? e);
	}
}

async function save() {
	if (!wp.doc) return;
	const r = await fetch(URL_, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wp.doc) }).catch(() => null);
	dirty = false;
	if (!r) return (wp.err = 'Pi not reachable – plan not saved');
	const j = await r.json().catch(() => ({}));
	if (r.status === 409) {
		wp.doc = j.plan;
		wp.err = 'The plan was changed on another device – reloaded.';
	} else if (!r.ok) wp.err = j.error ?? String(r.status);
	else {
		wp.doc = j;
		wp.err = '';
	}
}

/** nach jeder Änderung am Plan aufrufen */
export function commit() {
	dirty = true;
	clearTimeout(timer);
	timer = setTimeout(save, 700);
}

export function startWatchPlan() {
	load();
	const t = setInterval(load, 10e3);
	return () => clearInterval(t);
}
