// Ebenen der Kartenunterlage: Anbieter-Katalog vom Pi (chart-proxy) + gerätelokale Auswahl, Deckkraft,
// Reihenfolge, Ausrichtungs-Versatz und benannte Presets.

export type Kind = 'base' | 'satellite' | 'depth' | 'overlay';

export interface OptionDef {
	type: 'select' | 'text' | 'number';
	values?: string[];
	min?: number;
	max?: number;
	default: string | number;
}

export interface ProviderInfo {
	id: string;
	name: string;
	kind: Kind;
	resolution: string | null;
	maxNativeZoom: number;
	mode: 'cache' | 'live' | 'direct';
	prefetch: boolean;
	prefetchMax: number;
	needsKey: boolean;
	keySet: boolean;
	keyLabel?: string;
	keyUrl?: string;
	attribution: string;
	info: string;
	options: Record<string, OptionDef>;
	values: Record<string, string | number>;
	directUrl?: string;
	status: { ok: boolean; err?: string; t: number } | null;
}

export interface LayerCfg {
	id: string; // Anbieter-ID oder 'coral'
	on: boolean;
	opacity: number;
	/** Ausrichtungs-Versatz in m (Ost, Nord) */
	dx: number;
	dy: number;
}

export interface ChartCfg {
	base: string; // 'osm' | 'none' | Satelliten-ID als Basis
	baseOpacity: number;
	layers: LayerCfg[]; // unten → oben
	seamarks: boolean;
	seamarkOpacity: number;
	presets: { name: string; cfg: Omit<ChartCfg, 'presets'> }[];
	/** Zähler, der bei Anbieter-Optionsänderungen hochgeht (Kacheln neu laden) */
	rev: number;
}

export const providers = $state({ list: [] as ProviderInfo[], loaded: false, error: '' });

const KEY = 'suki-radar-chart-v1';

const DEFAULT_ORDER = ['emodnet', 'gebco', 'eox', 'copernicus', 'esri', 'mapbox', 'maptiler', 'google', 'gibs', 'coral'];
const DEFAULT_OPACITY: Record<string, number> = { emodnet: 0.5, gebco: 0.5, coral: 0.6 };

function defaults(): ChartCfg {
	return {
		base: 'osm',
		baseOpacity: 1,
		layers: DEFAULT_ORDER.map((id) => ({ id, on: false, opacity: DEFAULT_OPACITY[id] ?? 0.25, dx: 0, dy: 0 })),
		seamarks: true,
		seamarkOpacity: 1,
		presets: [],
		rev: 0
	};
}

function load(): ChartCfg {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) {
			const c = { ...defaults(), ...JSON.parse(raw) } as ChartCfg;
			// neue Anbieter ergänzen
			for (const id of DEFAULT_ORDER) if (!c.layers.some((l) => l.id === id)) c.layers.push({ id, on: false, opacity: 0.25, dx: 0, dy: 0 });
			return c;
		}
	} catch {
		/* ignore */
	}
	return defaults();
}

export const chartCfg: ChartCfg = $state(load());

$effect.root(() => {
	$effect(() => {
		const s = JSON.stringify(chartCfg);
		try {
			localStorage.setItem(KEY, s);
		} catch {
			/* ignore */
		}
	});
});

export async function loadProviders() {
	try {
		const r = await fetch('/tiles/api/providers', { cache: 'no-store' });
		if (!r.ok) throw new Error(String(r.status));
		providers.list = await r.json();
		providers.loaded = true;
		providers.error = '';
		for (const p of providers.list)
			if (p.kind !== 'base' && p.kind !== 'overlay' && !chartCfg.layers.some((l) => l.id === p.id))
				chartCfg.layers.push({ id: p.id, on: false, opacity: 0.25, dx: 0, dy: 0 });
	} catch (e) {
		providers.error = 'Chart server not reachable';
	}
}

export const provider = (id: string) => providers.list.find((p) => p.id === id);

/** Ist die Ebene nutzbar (Schlüssel vorhanden)? */
export const usable = (id: string) => {
	if (id === 'coral') return true;
	const p = provider(id);
	return !!p && (!p.needsKey || p.keySet);
};

export function moveLayer(id: string, dir: 1 | -1) {
	const i = chartCfg.layers.findIndex((l) => l.id === id);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= chartCfg.layers.length) return;
	const a = chartCfg.layers;
	[a[i], a[j]] = [a[j], a[i]];
}

export function savePreset(name: string) {
	const { presets, ...cfg } = $state.snapshot(chartCfg);
	const i = chartCfg.presets.findIndex((p) => p.name === name);
	const entry = { name, cfg };
	if (i >= 0) chartCfg.presets[i] = entry;
	else chartCfg.presets.push(entry);
}

export function applyPreset(name: string) {
	const p = chartCfg.presets.find((x) => x.name === name);
	if (!p) return;
	const c = structuredClone($state.snapshot(p.cfg));
	Object.assign(chartCfg, { ...c, presets: chartCfg.presets, rev: chartCfg.rev + 1 });
}

export function deletePreset(name: string) {
	chartCfg.presets = chartCfg.presets.filter((p) => p.name !== name);
}

export async function putKey(id: string, key: string) {
	const r = await fetch('/tiles/api/keys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, key }) });
	if (r.ok) await loadProviders();
	return r.ok;
}

export async function putOptions(id: string, values: Record<string, string | number>) {
	const r = await fetch('/tiles/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, values }) });
	if (r.ok) {
		await loadProviders();
		chartCfg.rev++;
	}
	return r.ok;
}

export async function testProvider(id: string): Promise<{ ok: boolean; error?: string }> {
	try {
		const r = await fetch(`/tiles/api/test/${id}`, { method: 'POST' });
		return await r.json();
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

/** Quellenangaben der aktiven Ebenen (Lizenzpflicht) */
export function activeAttributions(): string[] {
	const ids = new Set<string>();
	if (chartCfg.base !== 'none') ids.add(chartCfg.base);
	for (const l of chartCfg.layers) if (l.on && usable(l.id)) ids.add(l.id);
	if (chartCfg.seamarks) ids.add('seamark');
	const out: string[] = [];
	for (const id of ids) {
		if (id === 'coral') out.push('Allen Coral Atlas');
		else {
			const p = provider(id);
			if (p) out.push(p.attribution);
		}
	}
	return out;
}

// ── Revier-Download / Cache (chart-proxy) ──
export interface PrefetchJob {
	id: string;
	provider: string;
	total: number;
	done: number;
	failed: number;
	cached: number;
	state: 'running' | 'done' | 'cancelled';
	started: number;
	zmin: number;
	zmax: number;
}

async function api<T>(url: string, init?: RequestInit): Promise<T & { error?: string }> {
	const r = await fetch(url, { cache: 'no-store', ...init });
	const j = await r.json().catch(() => ({}));
	return r.ok ? j : { ...j, error: j.error ?? String(r.status) };
}

export const prefetchEstimate = (id: string, bbox: number[], zmin: number, zmax: number) =>
	api<{ total: number; estMB: number; zmin: number; zmax: number; limit: number }>('/tiles/api/prefetch', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, bbox, zmin, zmax, dryRun: true })
	});

export const prefetchStart = (id: string, bbox: number[], zmin: number, zmax: number) =>
	api<PrefetchJob>('/tiles/api/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, bbox, zmin, zmax }) });

export const prefetchJobs = () => api<PrefetchJob[]>('/tiles/api/prefetch');
export const prefetchCancel = (job: string) => api<{ ok: boolean }>(`/tiles/api/prefetch/${job}`, { method: 'DELETE' });
export const cacheInfo = () => api<Record<string, { bytes: number; files: number }>>('/tiles/api/cache');
export const cacheClear = (id: string) => api<{ ok: boolean }>(`/tiles/api/cache/${id}`, { method: 'DELETE' });
