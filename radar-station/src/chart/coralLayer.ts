// Allen-Coral-Atlas-Ebene: GeoJSON (Geomorphic = Riffzonen, Benthic = Bodentyp) vom Pi, gekachelt mit geojson-vt
// und als Canvas gezeichnet. Farben angelehnt an die Legende des Atlas.
import L from 'leaflet';
import geojsonvt from 'geojson-vt';

/** Klassen → Farbe; Reihenfolge = Legende */
export const CORAL_CLASSES: [string, string][] = [
	// Geomorphic
	['Reef Crest', '#614272'],
	['Outer Reef Flat', '#92739d'],
	['Inner Reef Flat', '#c5a7cb'],
	['Terrestrial Reef Flat', '#fbdefb'],
	['Reef Slope', '#288471'],
	['Sheltered Reef Slope', '#10bda6'],
	['Back Reef Slope', '#befbff'],
	['Plateau', '#cd6812'],
	['Patch Reefs', '#ffba15'],
	['Small Reef', '#ffba15'],
	['Shallow Lagoon', '#77d0fc'],
	['Deep Lagoon', '#2ca2f9'],
	// Benthic
	['Coral/Algae', '#ff6161'],
	['Rock', '#b19c3a'],
	['Rubble', '#e0d05e'],
	['Sand', '#ffffbe'],
	['Seagrass', '#668438'],
	['Microalgal Mats', '#9bcc4f']
];
const COLOR = new Map(CORAL_CLASSES);

const classOf = (props: Record<string, unknown> | null) => String(props?.class ?? props?.Class ?? props?.class_name ?? props?.CLASS ?? '');

export const coralState = { classes: new Set<string>(), files: [] as string[], loading: false, error: '' };

type Index = ReturnType<typeof geojsonvt>;
let indexes: Index[] = [];
let loadPromise: Promise<void> | null = null;

async function loadAll() {
	coralState.loading = true;
	coralState.error = '';
	coralState.classes.clear();
	indexes = [];
	try {
		const list: { name: string }[] = await (await fetch('/tiles/api/coral', { cache: 'no-store' })).json();
		// Riffzonen zuerst, Bodentyp darüber
		list.sort((a, b) => Number(/benthic/i.test(a.name)) - Number(/benthic/i.test(b.name)) || a.name.localeCompare(b.name));
		coralState.files = list.map((f) => f.name);
		for (const f of list) {
			const gj = await (await fetch(`/tiles/api/coral/${encodeURIComponent(f.name)}.geojson`)).json();
			for (const ft of gj.features ?? []) coralState.classes.add(classOf(ft.properties));
			indexes.push(geojsonvt(gj, { maxZoom: 18, tolerance: 2, extent: 4096, buffer: 64, indexMaxZoom: 6 }));
		}
	} catch (e) {
		coralState.error = String(e);
	}
	coralState.loading = false;
}

/** nach einem Import aufrufen */
export function reloadCoral() {
	loadPromise = null;
}

export function createCoralLayer(opts: L.GridLayerOptions): L.GridLayer {
	const Layer = L.GridLayer.extend({
		createTile(coords: L.Coords) {
			const tile = document.createElement('canvas');
			const size = this.getTileSize();
			tile.width = size.x;
			tile.height = size.y;
			const ctx = tile.getContext('2d')!;
			const k = size.x / 4096;
			for (const idx of indexes) {
				const t = idx.getTile(coords.z, coords.x, coords.y);
				if (!t) continue;
				for (const f of t.features) {
					if (f.type !== 3) continue;
					const col = COLOR.get(classOf(f.tags as Record<string, unknown>)) ?? '#ff00ff';
					ctx.beginPath();
					for (const ring of f.geometry as unknown as [number, number][][]) {
						ring.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
						ctx.closePath();
					}
					ctx.fillStyle = col;
					ctx.fill('evenodd');
				}
			}
			return tile;
		}
	});
	const layer: L.GridLayer = new (Layer as any)({ ...opts, updateWhenIdle: false });
	if (!loadPromise) loadPromise = loadAll();
	loadPromise.then(() => layer.redraw());
	return layer;
}

/** GeoJSON-Datei auf den Pi laden */
export async function uploadCoral(name: string, file: File): Promise<{ ok: boolean; error?: string; features?: number }> {
	const r = await fetch(`/tiles/api/coral/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/geo+json' }, body: file });
	const j = await r.json().catch(() => ({}));
	reloadCoral();
	return r.ok ? { ok: true, features: j.features } : { ok: false, error: j.error ?? String(r.status) };
}

export async function deleteCoral(name: string) {
	await fetch(`/tiles/api/coral/${encodeURIComponent(name)}`, { method: 'DELETE' });
	reloadCoral();
}
