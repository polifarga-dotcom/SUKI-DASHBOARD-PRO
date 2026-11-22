// Wetter-Ebene als Leaflet-GridLayer: Farbfläche (Stärke) + Windfiedern bzw. Pfeile (Richtung).
// Gezeichnet wird Nord-oben in Kachelkoordinaten; die Kartendrehung macht chartLayer per CSS.
// Zeitwechsel: vorhandene Kacheln werden an Ort und Stelle neu gezeichnet (kein Flackern durch Neuaufbau).
import L from 'leaflet';
import { fields, wx, wxId } from './weather.svelte';
import { colorAt, drawIsobars, fillAlpha, sample, sampleX, tileLatLon, timeIndex, type WxExtra, type WxField } from './wxField';

const CELLS = 32; // Farbfläche: 32 × 32 Stützstellen je Kachel, weich hochskaliert
const STEP = 64; // Abstand der Fiedern/Pfeile in px (kachelübergreifend gleichmäßig)

function strokeBoth(ctx: CanvasRenderingContext2D, path: () => void) {
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.strokeStyle = 'rgba(255,255,255,0.9)';
	ctx.lineWidth = 3.5;
	path();
	ctx.stroke();
	ctx.strokeStyle = '#111';
	ctx.lineWidth = 1.5;
	path();
	ctx.stroke();
}

/** Windfieder: Schaft zeigt in die Richtung, aus der der Wind kommt; halbe = 5, ganze = 10, Wimpel = 50 kn */
export function drawBarb(ctx: CanvasRenderingContext2D, x: number, y: number, kn: number, fromDeg: number) {
	if (kn < 2.5) {
		strokeBoth(ctx, () => {
			ctx.beginPath();
			ctx.arc(x, y, 4, 0, Math.PI * 2);
		});
		return;
	}
	const a = (fromDeg * Math.PI) / 180;
	const dx = Math.sin(a), dy = -Math.cos(a); // Einheitsvektor zum Ursprung des Windes (Bildschirm, y nach unten)
	const px = -dy, py = dx; // senkrecht
	const L = 22;
	let n = Math.round(kn / 5) * 5;
	const flags: ('p' | 'f' | 'h')[] = [];
	while (n >= 50) { flags.push('p'); n -= 50; }
	while (n >= 10) { flags.push('f'); n -= 10; }
	if (n >= 5) flags.push('h');
	const ex = x + dx * L, ey = y + dy * L;
	strokeBoth(ctx, () => {
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(ex, ey);
		let d = 0;
		for (const f of flags) {
			const bx = ex - dx * d, by = ey - dy * d;
			if (f === 'p') {
				ctx.moveTo(bx, by);
				ctx.lineTo(bx + px * 9 + dx * 2, by + py * 9 + dy * 2);
				ctx.lineTo(bx - dx * 5, by - dy * 5);
				d += 7;
			} else {
				const len = f === 'f' ? 10 : 5;
				// halbe Fieder allein nicht ganz am Ende (Lesbarkeit)
				const off = f === 'h' && flags.length === 1 ? 4 : 0;
				ctx.moveTo(bx - dx * off, by - dy * off);
				ctx.lineTo(bx - dx * off + px * len + dx * 3, by - dy * off + py * len + dy * 3);
				d += 4;
			}
		}
	});
}

/** Pfeil in Bewegungsrichtung (Strömung/Welle), Länge nach Stärke */
export function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, toDeg: number, len: number) {
	const a = (toDeg * Math.PI) / 180;
	const dx = Math.sin(a), dy = -Math.cos(a);
	const hx = x + (dx * len) / 2, hy = y + (dy * len) / 2;
	const tx = x - (dx * len) / 2, ty = y - (dy * len) / 2;
	strokeBoth(ctx, () => {
		ctx.beginPath();
		ctx.moveTo(tx, ty);
		ctx.lineTo(hx, hy);
		ctx.moveTo(hx - dx * 6 - dy * 4, hy - dy * 6 + dx * 4);
		ctx.lineTo(hx, hy);
		ctx.lineTo(hx - dx * 6 + dy * 4, hy - dy * 6 - dx * 4);
	});
}

export interface WxDraw {
	/** Fiedern/Pfeile (statisch) */
	symbols: boolean;
	/** Isobaren (nur Wind mit Luftdruck) */
	isobars: boolean;
	/** Farbfläche aus Zusatzwert (fehlt er im Feld: wie gewohnt Wind/Welle) */
	fill?: WxExtra | 'gust';
}

const ISO_N = 16; // Isobaren: 16 × 16 Zellen je Kachel
function drawTile(canvas: HTMLCanvasElement, c: L.Coords, f: WxField | undefined, o: WxDraw) {
	const ctx = canvas.getContext('2d')!;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	if (!f) return;
	const ti = timeIndex(f, wx.time);
	if (ti < 0) return; // außerhalb des Modellzeitraums: nichts zeigen statt falscher Werte
	const size = canvas.width;
	const gust = f.kind === 'wind' && o.fill === 'gust';
	const extra = o.fill && o.fill !== 'gust' && f.x?.[o.fill] ? o.fill : null;
	// Farbfläche
	const img = new ImageData(CELLS, CELLS);
	for (let j = 0; j < CELLS; j++)
		for (let i = 0; i < CELLS; i++) {
			const [lat, lon] = tileLatLon(c.z, c.x + (i + 0.5) / CELLS, c.y + (j + 0.5) / CELLS);
			let key: Parameters<typeof colorAt>[0] = f.kind, val: number;
			if (extra) {
				const v = sampleX(f, extra, ti, lat, lon);
				if (v == null) continue;
				key = extra;
				val = v;
			} else {
				const s = sample(f, ti, lat, lon);
				if (!s) continue;
				val = gust && s.p != null ? s.p : s.s;
			}
			const a = fillAlpha(key, val);
			if (!a) continue;
			const [r, g, b] = colorAt(key, val);
			const px = (j * CELLS + i) * 4;
			img.data[px] = r;
			img.data[px + 1] = g;
			img.data[px + 2] = b;
			img.data[px + 3] = Math.round(a * 255);
		}
	const off = document.createElement('canvas');
	off.width = off.height = CELLS;
	off.getContext('2d')!.putImageData(img, 0, 0);
	ctx.imageSmoothingEnabled = true;
	ctx.drawImage(off, 0, 0, size, size);
	if (o.isobars && f.q) {
		const q: (number | null)[] = [];
		for (let j = 0; j <= ISO_N; j++)
			for (let i = 0; i <= ISO_N; i++) {
				const [lat, lon] = tileLatLon(c.z, c.x + i / ISO_N, c.y + j / ISO_N);
				q.push(sample(f, ti, lat, lon)?.q ?? null);
			}
		drawIsobars(ctx, size, q, ISO_N);
	}
	if (!o.symbols) return;
	// Fiedern / Pfeile; Strömung/Welle um eine halbe Teilung versetzt, damit sie nicht auf den Windfiedern liegen.
	// Symbole auf der Kachelkante zeichnen beide Nachbarkacheln je zur Hälfte (px bis einschließlich size).
	const x0 = f.kind === 'wind' ? STEP / 2 : 0;
	for (let py = STEP / 2; py < size; py += STEP)
		for (let px = x0; px <= size; px += STEP) {
			const [lat, lon] = tileLatLon(c.z, c.x + px / size, c.y + py / size);
			const s = sample(f, ti, lat, lon);
			if (!s) continue;
			if (f.kind === 'wind') drawBarb(ctx, px, py, s.s, s.dir);
			else if (f.kind === 'wave') drawArrow(ctx, px, py, (s.dir + 180) % 360, 12 + Math.min(1, s.s / 4) * 16);
			else drawArrow(ctx, px, py, s.dir, 8 + Math.min(1, s.s / 2) * 22);
		}
}

export interface WeatherLayer extends L.GridLayer {
	refresh(): void;
}

export function createWeatherLayer(layerId: string, opts: L.GridLayerOptions, draw: WxDraw): WeatherLayer {
	const id = wxId(layerId);
	const Layer = L.GridLayer.extend({
		createTile(coords: L.Coords) {
			const tile = document.createElement('canvas');
			const s = this.getTileSize();
			tile.width = s.x;
			tile.height = s.y;
			drawTile(tile, coords, fields.get(id), draw);
			return tile;
		},
		refresh() {
			const f = fields.get(id);
			for (const t of Object.values(this._tiles as Record<string, { el: HTMLCanvasElement; coords: L.Coords }>)) drawTile(t.el, t.coords, f, draw);
		}
	});
	// in jeder Zoomstufe neu zeichnen (nicht hochskalieren), damit die Fiedern gleich groß bleiben
	return new (Layer as any)({ ...opts, updateWhenIdle: false }) as WeatherLayer;
}
