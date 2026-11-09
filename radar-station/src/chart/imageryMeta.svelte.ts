// Aufnahmedatum und Auflösung der sichtbaren Satellitenbilder (vom chart-proxy; Esri/Copernicus je Ort).
// Abruf nur für aktive Satelliten-Ebenen, bei Bewegung > 2 km, Zoomwechsel oder spätestens alle 10 min.
import { chartCfg, provider, usable } from './layers.svelte';
import { settings } from '../lib/settings.svelte';
import { toLocal, type LatLon } from '../lib/geo';

export interface ImageryMeta {
	id: string;
	resolution: string | null; // Katalogangabe
	kind: 'year' | 'daily' | 'esri' | 'copernicus' | 'none';
	date?: string | null; // YYYY-MM-DD
	time?: string | null; // HH:MM UTC
	year?: string;
	res?: number | null; // m (Esri, je Ort)
	acc?: number | null; // m Lagegenauigkeit (Esri)
	cloud?: number | null; // % (Copernicus)
	source?: string;
	error?: string;
}

export const imagery = $state({ list: [] as ImageryMeta[] });

let last = { ids: '', center: null as LatLon | null, z: -1, t: 0 };
let busy = false;

/** aktive Satelliten-Ebenen (oben im Stapel zuerst) */
export function activeSatellites(): string[] {
	if (!settings.chart) return [];
	const ids: string[] = [];
	for (const l of [...chartCfg.layers].reverse()) if (l.on && usable(l.id) && provider(l.id)?.kind === 'satellite') ids.push(l.id);
	const b = provider(chartCfg.base);
	if (b?.kind === 'satellite' && usable(b.id) && !ids.includes(b.id)) ids.push(b.id);
	return ids;
}

/** aus dem Radarfenster aufrufen (1×/s); holt bei Bedarf neu */
export async function updateImageryMeta(center: LatLon | null, z: number) {
	const ids = activeSatellites();
	const key = ids.join(',');
	if (!ids.length || !center) {
		if (imagery.list.length) imagery.list = [];
		last.ids = key;
		return;
	}
	const moved = last.center ? Math.hypot(...toLocal(last.center, center)) : Infinity;
	const due = key !== last.ids || Math.abs(z - last.z) >= 1 || moved > 2000 || Date.now() - last.t > 600e3;
	if (!due || busy || Date.now() - last.t < 5000) return;
	busy = true;
	last = { ids: key, center, z, t: Date.now() };
	try {
		const r = await fetch(`/tiles/api/meta?ids=${key}&lat=${center.lat.toFixed(5)}&lon=${center.lon.toFixed(5)}&z=${z}`, { cache: 'no-store' });
		if (r.ok) imagery.list = await r.json();
	} catch {
		/* offline: alte Angaben bleiben */
	}
	busy = false;
}
