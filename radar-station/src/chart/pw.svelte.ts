// PredictWind-GRIB auf dem Pi: Sync-Status, Ordner neu einlesen, löschen (Ebenen → PredictWind GRIB)
import { loadWxModels } from './weather.svelte';
import { loadRoutes } from './routes.svelte';

type Stamp = { at: number; host: string; file?: string; error?: string };
export type PwStatus = { auto?: Stamp; manual?: Stamp; ping?: Stamp; error?: Stamp; files: number; readable: number; unreadable: string[]; unused?: string[] };

export const pw = $state({ st: null as PwStatus | null, busy: false, msg: '' });

export async function loadPw() {
	try {
		const r = await fetch('/tiles/api/pw/status', { cache: 'no-store' });
		if (r.ok) pw.st = await r.json();
	} catch {
		/* Pi nicht erreichbar */
	}
}

/** nach Upload/Löschen/Neu-Einlesen: Status, Wettermodelle und Routen neu holen */
export const pwReloadAll = () => Promise.all([loadPw(), loadWxModels(), loadRoutes()]);

/** Pi-Ordner neu einlesen (neue Dateien vom Mac-Sync oder Upload) */
export async function pwScan() {
	pw.busy = true;
	try {
		const r = await fetch('/tiles/api/pw/scan', { method: 'POST' });
		if (r.ok) pw.st = await r.json();
		await Promise.all([loadWxModels(), loadRoutes()]);
	} finally {
		pw.busy = false;
	}
}

/** ein GRIB-Modell (Katalog-ID ohne „wx:“) oder alle löschen → Anzahl Dateien */
export async function pwDelete(id: string | 'all') {
	const r = await fetch(id === 'all' ? '/tiles/api/pw/all' : `/tiles/api/pw/model/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
	const n = r?.ok ? ((await r.json()).deleted as number) : 0;
	await Promise.all([loadPw(), loadWxModels()]);
	return n;
}
