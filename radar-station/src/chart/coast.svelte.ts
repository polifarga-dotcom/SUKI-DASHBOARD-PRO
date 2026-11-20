// Küstenlinie als reine Kontur über den Wetterdaten: weit draußen Natural Earth 10m (einmal vom Pi, ca. 1 km genau),
// ab Zoom 9 OpenStreetMap-Küstenlinie je 1°-Zelle (vom Pi gespeichert, hafengenau). Linien als flache Arrays [lat, lon, …].
import L from 'leaflet';
import { cellLoader, worldPx, type CellState } from './anchorages.svelte';

export const coast = $state<CellState & { ne: boolean }>({ version: 0, loading: 0, error: '', tooWide: false, count: 0, ne: false });
const osm = cellLoader<number[]>('coast', coast);
export const ensureCoast = osm.ensure;

let ne: number[][] = [];
let neLoading = false;
function loadNe() {
	if (neLoading || coast.ne) return;
	neLoading = true;
	fetch('/tiles/api/coast/ne')
		.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
		.then((j: number[][]) => {
			ne = j;
			coast.ne = true;
			coast.version++;
		})
		.catch((e) => (coast.error = String(e.message ?? e)))
		.finally(() => (neLoading = false));
}

/** Begrenzungsrechteck je Linie [S, W, N, E], einmal berechnet */
const boxes = new WeakMap<number[], number[]>();
function box(l: number[]) {
	let b = boxes.get(l);
	if (!b) {
		b = [90, 180, -90, -180];
		for (let i = 0; i < l.length; i += 2) {
			b[0] = Math.min(b[0], l[i]);
			b[2] = Math.max(b[2], l[i]);
			b[1] = Math.min(b[1], l[i + 1]);
			b[3] = Math.max(b[3], l[i + 1]);
		}
		boxes.set(l, b);
	}
	return b;
}

/** Kachel → [S, W, N, E] in Grad */
export function tileBox(z: number, x: number, y: number) {
	const n = 2 ** z;
	const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
	return [lat(y + 1), (x / n) * 360 - 180, lat(y), ((x + 1) / n) * 360 - 180];
}

const OSM_Z = 9;

function drawTile(canvas: HTMLCanvasElement, c: L.Coords) {
	const ctx = canvas.getContext('2d')!;
	ctx.clearRect(0, 0, 256, 256);
	const [s, w, n, e] = tileBox(c.z, c.x, c.y);
	const m = (n - s) * 0.05; // Rand, damit Linien an der Kachelkante nicht abreißen
	const hit = (b: number[]) => b[0] <= n + m && b[2] >= s - m && b[1] <= e + m && b[3] >= w - m;
	// genaue OSM-Linien, sobald für diese Kachel geladen; sonst Natural Earth
	let lines: number[][] = [];
	if (c.z >= OSM_Z)
		for (const [k, cell] of osm.cells) {
			const [la, lo] = k.split('_').map(Number);
			if (hit([la, lo, la + 1, lo + 1])) lines = lines.concat(cell.items);
		}
	if (!lines.length) lines = ne;
	const ox = c.x * 256, oy = c.y * 256;
	ctx.beginPath();
	for (const l of lines) {
		if (!hit(box(l))) continue;
		let px = NaN, py = NaN;
		for (let i = 0; i < l.length; i += 2) {
			const [wx, wy] = worldPx(c.z, l[i], l[i + 1]);
			const x = wx - ox, y = wy - oy;
			if (i === 0) ctx.moveTo(x, y);
			else if (Math.abs(x - px) + Math.abs(y - py) < 0.7 && i < l.length - 2) continue; // Punkte unter 1 px auslassen
			else ctx.lineTo(x, y);
			px = x;
			py = y;
		}
	}
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.strokeStyle = 'rgba(0,0,0,0.75)'; // dunkler Saum: auf hellem wie dunklem Wetter lesbar
	ctx.lineWidth = 4;
	ctx.stroke();
	ctx.strokeStyle = '#fff';
	ctx.lineWidth = 1.6;
	ctx.stroke();
}

export interface CoastLayer extends L.GridLayer {
	refresh(): void;
}

export function createCoastLayer(opts: L.GridLayerOptions): CoastLayer {
	loadNe();
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
	return new (Layer as any)({ ...opts, updateWhenIdle: false, tileSize: 256 }) as CoastLayer;
}
