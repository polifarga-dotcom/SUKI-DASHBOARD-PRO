// Ankerplätze: OpenStreetMap (vom Pi je 1°-Zelle, offline gespeichert) + eigene Ankerplätze (auf dem Pi, für alle Geräte).
// Ebene 'anch' im Kartenstapel; gezeichnet als Leaflet-GridLayer (Symbole + Ankergebiete), Tippen → Infofenster.
import L from 'leaflet';
import { ICONS } from '../ui/icons';
import type { LatLon } from '../lib/geo';

export type AnchKind = 'anchorage' | 'berth' | 'mooring' | 'marina';
export interface OsmAnch {
	id: string;
	kind: AnchKind;
	name: string;
	lat: number;
	lon: number;
	poly?: [number, number][];
	tags: Record<string, string>;
}
export interface OwnAnch {
	id: string;
	lat: number;
	lon: number;
	name: string;
	note: string;
	bottom: string;
	depth: number | null;
	/** guter Schutz bei Wind aus diesen Richtungen */
	shelter: string[];
	t: number;
}

export const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const BOTTOMS = ['Sand', 'Mud', 'Seagrass', 'Weed', 'Rock', 'Shingle', 'Mixed'];
export const ANCH_COLOR: Record<AnchKind | 'own', string> = { anchorage: '#d63af0', berth: '#d63af0', mooring: '#f2b705', marina: '#2f8fff', own: '#22c55e' };

export const anch = $state({ own: [] as OwnAnch[], version: 0, loading: 0, error: '', tooWide: false, count: 0 });

const MAX_CELLS = 16;

export interface CellState {
	version: number;
	loading: number;
	error: string;
	tooWide: boolean;
	count: number;
}

/** lädt 1°-Zellen (/tiles/api/<path>/<la>/<lo>) des sichtbaren Ausschnitts; weit herausgezoomt: nichts nachladen */
export function cellLoader<T>(path: string, st: CellState) {
	const cells = new Map<string, { items: T[]; stale?: boolean }>();
	const busy = new Set<string>();
	const failed = new Map<string, number>();
	function ensure(bbox: [number, number, number, number] | null) {
		if (!bbox) return;
		const [w, s, e, n] = bbox;
		const keys: [number, number][] = [];
		for (let la = Math.floor(s); la <= Math.floor(n); la++) for (let lo = Math.floor(w); lo <= Math.floor(e); lo++) keys.push([la, lo]);
		st.tooWide = keys.length > MAX_CELLS;
		if (st.tooWide) return;
		for (const [la, lo] of keys) {
			const k = `${la}_${lo}`;
			if (cells.has(k) || busy.has(k) || Date.now() - (failed.get(k) ?? 0) < 120e3) continue; // nach Fehler 2 min warten
			busy.add(k);
			st.loading++;
			fetch(`/tiles/api/${path}/${la}/${lo}`)
				.then(async (r) => {
					const j = await r.json();
					if (!r.ok) throw new Error(j.error ?? String(r.status));
					if (j.pending) {
						failed.set(k, Date.now() - 105e3); // Pi lädt noch – in 15 s wieder fragen
						return;
					}
					cells.set(k, { items: j.items, stale: j.stale });
					st.error = j.stale ? j.error : '';
					failed.delete(k);
				})
				.catch((err) => {
					failed.set(k, Date.now());
					st.error = String(err.message ?? err);
				})
				.finally(() => {
					busy.delete(k);
					st.loading--;
					st.count = [...cells.values()].reduce((a, c) => a + c.items.length, 0);
					st.version++;
				});
		}
	}
	return { cells, ensure };
}

const osmCells = cellLoader<OsmAnch>('anchorages', anch);
/** Zellen des sichtbaren Ausschnitts laden (aus App im Sekundentakt) */
export const ensureAnchorages = osmCells.ensure;

export const osmItems = () => [...osmCells.cells.values()].flatMap((c) => c.items);

export async function loadOwn() {
	try {
		const r = await fetch('/tiles/api/myanchorages', { cache: 'no-store' });
		if (r.ok) anch.own = await r.json();
		anch.version++;
	} catch {
		/* Pi nicht erreichbar */
	}
}

export async function saveOwn(a: OwnAnch) {
	const r = await fetch('/tiles/api/myanchorages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
	if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? String(r.status));
	await loadOwn();
}

export async function deleteOwn(id: string) {
	await fetch(`/tiles/api/myanchorages/${encodeURIComponent(id)}`, { method: 'DELETE' });
	await loadOwn();
}

export const newOwn = (p: LatLon, name = '', from?: OsmAnch): OwnAnch => ({
	id: String(Date.now()),
	lat: from?.lat ?? p.lat,
	lon: from?.lon ?? p.lon,
	name: from?.name || name,
	note: '',
	bottom: '',
	depth: null,
	shelter: [],
	t: Date.now()
});

/** lat/lon → Weltpixel (Web-Mercator, 256er Kacheln) */
export function worldPx(z: number, lat: number, lon: number): [number, number] {
	const n = 256 * 2 ** z;
	const s = Math.sin((lat * Math.PI) / 180);
	return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

const ANCHOR = new Path2D(ICONS.anchor);

function symbol(ctx: CanvasRenderingContext2D, x: number, y: number, kind: AnchKind | 'own', big: boolean) {
	const col = ANCH_COLOR[kind];
	if (kind === 'mooring') {
		ctx.beginPath();
		ctx.arc(x, y, 4.5, 0, Math.PI * 2);
		ctx.fillStyle = col;
		ctx.fill();
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = '#000';
		ctx.stroke();
		return;
	}
	const k = big ? 0.9 : 0.7;
	ctx.save();
	ctx.translate(x - 12 * k, y - 12 * k);
	ctx.scale(k, k);
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	const disc = kind === 'own' || kind === 'marina';
	if (disc) {
		// Marina / eigener Platz: weißer Anker auf farbiger Scheibe (auf dunkler Karte gut sichtbar)
		ctx.beginPath();
		ctx.arc(12, 12, 15, 0, Math.PI * 2);
		ctx.fillStyle = col;
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = '#fff';
		ctx.stroke();
	} else {
		ctx.strokeStyle = 'rgba(255,255,255,0.95)';
		ctx.lineWidth = 6;
		ctx.stroke(ANCHOR);
	}
	ctx.strokeStyle = disc ? '#fff' : col;
	ctx.lineWidth = 2.6;
	ctx.stroke(ANCHOR);
	ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, txt: string, col: string) {
	if (!txt) return;
	ctx.font = '600 11px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	ctx.lineWidth = 3;
	ctx.strokeStyle = 'rgba(0,0,0,0.85)';
	ctx.strokeText(txt, x, y);
	ctx.fillStyle = col === ANCH_COLOR.own ? '#bff5cf' : '#fff';
	ctx.fillText(txt, x, y);
}

function drawTile(canvas: HTMLCanvasElement, c: L.Coords) {
	const ctx = canvas.getContext('2d')!;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	const ox = c.x * 256, oy = c.y * 256;
	const M = 40; // Symbole an der Kachelkante: Nachbarkacheln zeichnen mit
	const inTile = (x: number, y: number) => x > -M && y > -M && x < 256 + M && y < 256 + M;
	const showOsm = c.z >= 8;
	const labels = c.z >= 12;
	if (showOsm) {
		const items = osmItems();
		// Ankergebiete zuerst (darunter)
		for (const a of items) {
			if (!a.poly) continue;
			ctx.beginPath();
			a.poly.forEach(([la, lo], i) => {
				const [x, y] = worldPx(c.z, la, lo);
				if (i) ctx.lineTo(x - ox, y - oy);
				else ctx.moveTo(x - ox, y - oy);
			});
			ctx.closePath();
			ctx.fillStyle = a.kind === 'marina' ? 'rgba(47,143,255,0.12)' : 'rgba(214,58,240,0.10)';
			ctx.fill();
			ctx.setLineDash([6, 4]);
			ctx.lineWidth = 1.5;
			ctx.strokeStyle = ANCH_COLOR[a.kind];
			ctx.stroke();
			ctx.setLineDash([]);
		}
		for (const a of items) {
			const [wx, wy] = worldPx(c.z, a.lat, a.lon);
			const x = wx - ox, y = wy - oy;
			if (!inTile(x, y)) continue;
			symbol(ctx, x, y, a.kind, c.z >= 11);
			if (labels && a.kind !== 'mooring') label(ctx, x, y + 14, a.name, ANCH_COLOR[a.kind]);
		}
	}
	for (const a of anch.own) {
		const [wx, wy] = worldPx(c.z, a.lat, a.lon);
		const x = wx - ox, y = wy - oy;
		if (!inTile(x, y)) continue;
		symbol(ctx, x, y, 'own', true);
		if (c.z >= 10) label(ctx, x, y + 16, a.name, ANCH_COLOR.own);
	}
}

export interface AnchLayer extends L.GridLayer {
	refresh(): void;
}

export function createAnchLayer(opts: L.GridLayerOptions): AnchLayer {
	const Layer = L.GridLayer.extend({
		createTile(coords: L.Coords) {
			const tile = document.createElement('canvas');
			tile.width = tile.height = 256;
			drawTile(tile, coords);
			return tile;
		},
		refresh() {
			for (const t of Object.values(this._tiles as Record<string, { el: HTMLCanvasElement; coords: L.Coords }>)) drawTile(t.el, t.coords);
		}
	});
	return new (Layer as any)({ ...opts, updateWhenIdle: false, tileSize: 256 }) as AnchLayer;
}
