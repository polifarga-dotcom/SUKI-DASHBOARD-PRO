// Animierte Strömungslinien (Partikel) für Wind und Strömung, als Leaflet-Ebene im Kartenstapel.
// Die Partikel leben in Leaflet-Layer-Pixeln: beim Mitschieben der Karte (panTo) laufen sie einfach weiter,
// nur ein Zoomwechsel setzt sie neu. Geschwindigkeiten kommen aus einem vorberechneten Bildschirm-Gitter
// (alle CELL px), damit pro Bild nur gerechnet und nicht projiziert wird.
import L from 'leaflet';
import { fields, wx, wxId } from './weather.svelte';
import { sample, timeIndex } from './wxField';

const CELL = 10;
/** px je Bild und kn (Welle: je m Höhe): Wind sichtbar flott, Strömung (kleine Werte) verstärkt */
const PX_PER_KN = { wind: 0.08, current: 1.4, wave: 0.5 };
const MAX_AGE = 90;
const FADE = 0.93;

export class FlowLayer extends L.Layer {
	private canvas = document.createElement('canvas');
	private ctx = this.canvas.getContext('2d')!;
	private map: L.Map | null = null;
	private origin = L.point(0, 0);
	private zoom = -1;
	private w = 0;
	private h = 0;
	private gw = 0;
	private gh = 0;
	private vx = new Float32Array(0);
	private vy = new Float32Array(0);
	/** je Partikel x, y (Layer-px), Alter */
	private px = new Float32Array(0);
	private py = new Float32Array(0);
	private age = new Uint16Array(0);
	private raf = 0;
	private frame = 0;
	private opacity = 1;
	private color: string;
	/** Wind kräftiger (weiß, breiter, längere Spuren) */
	private strong: boolean;

	constructor(private layerId: string, kind: string) {
		super();
		this.strong = kind === 'wind';
		this.color = kind === 'current' ? '200,240,255' : kind === 'wave' ? '220,235,255' : '255,255,255';
		Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none' });
	}

	onAdd(map: L.Map) {
		this.map = map;
		map.getPanes().overlayPane.appendChild(this.canvas);
		map.on('moveend zoomend viewreset resize', this.reset, this);
		this.reset();
		const loop = () => {
			this.raf = requestAnimationFrame(loop);
			if (++this.frame % 2) return; // ~30 Bilder/s genügen und schonen das iPad
			this.step();
		};
		this.raf = requestAnimationFrame(loop);
		return this;
	}

	onRemove(map: L.Map) {
		cancelAnimationFrame(this.raf);
		map.off('moveend zoomend viewreset resize', this.reset, this);
		this.canvas.remove();
		this.map = null;
		return this;
	}

	// gleiche Schnittstelle wie GridLayer, damit chartLayer sie wie jede Ebene behandeln kann
	setOpacity(o: number) {
		this.opacity = o;
		this.canvas.style.opacity = String(this.strong ? Math.min(1, o * 1.5) : o); // Wind: Linien heller als die Farbfläche
		return this;
	}
	setZIndex(z: number) {
		this.canvas.style.zIndex = String(z);
		return this;
	}
	getContainer() {
		return this.canvas;
	}
	/** neue Daten oder andere Vorhersagezeit: Geschwindigkeitsgitter neu, Partikel laufen weiter */
	refresh() {
		this.buildGrid();
	}

	private reset() {
		const map = this.map;
		if (!map) return;
		const size = map.getSize();
		const o = map.containerPointToLayerPoint([0, 0]);
		const z = map.getZoom();
		if (size.x !== this.w || size.y !== this.h) {
			this.w = this.canvas.width = size.x;
			this.h = this.canvas.height = size.y;
		} else this.ctx.clearRect(0, 0, this.w, this.h); // alte Spuren passen nach dem Verschieben nicht mehr
		this.origin = o;
		L.DomUtil.setPosition(this.canvas, o);
		this.buildGrid();
		if (z !== this.zoom || !this.px.length) {
			this.zoom = z;
			this.spawnAll();
		}
	}

	private buildGrid() {
		const map = this.map;
		if (!map) return;
		this.gw = Math.ceil(this.w / CELL) + 1;
		this.gh = Math.ceil(this.h / CELL) + 1;
		this.vx = new Float32Array(this.gw * this.gh).fill(NaN);
		this.vy = new Float32Array(this.gw * this.gh).fill(NaN);
		const f = fields.get(wxId(this.layerId));
		if (!f) return;
		const ti = timeIndex(f, wx.time);
		if (ti < 0) return;
		const k = PX_PER_KN[f.kind];
		for (let j = 0; j < this.gh; j++)
			for (let i = 0; i < this.gw; i++) {
				const ll = map.layerPointToLatLng([this.origin.x + i * CELL, this.origin.y + j * CELL]);
				const s = sample(f, ti, ll.lat, ll.lng);
				if (!s) continue;
				const to = ((f.kind === 'current' ? s.dir : s.dir + 180) * Math.PI) / 180;
				this.vx[j * this.gw + i] = Math.sin(to) * s.s * k;
				this.vy[j * this.gw + i] = -Math.cos(to) * s.s * k;
			}
	}

	private spawnAll() {
		const n = Math.min(4000, Math.round((this.w * this.h) / 600));
		this.px = new Float32Array(n);
		this.py = new Float32Array(n);
		this.age = new Uint16Array(n);
		for (let i = 0; i < n; i++) this.spawn(i, true);
	}

	private spawn(i: number, randomAge = false) {
		this.px[i] = this.origin.x + Math.random() * this.w;
		this.py[i] = this.origin.y + Math.random() * this.h;
		this.age[i] = randomAge ? Math.floor(Math.random() * MAX_AGE) : 0;
	}

	private vel(x: number, y: number): [number, number] | null {
		const gx = (x - this.origin.x) / CELL;
		const gy = (y - this.origin.y) / CELL;
		const i = Math.round(gx), j = Math.round(gy);
		if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return null;
		const vx = this.vx[j * this.gw + i];
		return Number.isNaN(vx) ? null : [vx, this.vy[j * this.gw + i]];
	}

	private step() {
		const c = this.ctx;
		// Spuren ausblenden
		c.globalCompositeOperation = 'destination-in';
		c.fillStyle = `rgba(0,0,0,${this.strong ? 0.955 : FADE})`;
		c.fillRect(0, 0, this.w, this.h);
		c.globalCompositeOperation = 'source-over';
		if (this.opacity <= 0) return;
		c.strokeStyle = `rgba(${this.color},${this.strong ? 1 : 0.85})`;
		c.lineWidth = this.strong ? 2 : 1.2;
		c.beginPath();
		const ox = this.origin.x, oy = this.origin.y;
		for (let i = 0; i < this.px.length; i++) {
			const v = this.vel(this.px[i], this.py[i]);
			if (!v || ++this.age[i] > MAX_AGE) {
				this.spawn(i);
				continue;
			}
			const x0 = this.px[i], y0 = this.py[i];
			this.px[i] += v[0];
			this.py[i] += v[1];
			c.moveTo(x0 - ox, y0 - oy);
			c.lineTo(this.px[i] - ox, this.py[i] - oy);
		}
		c.stroke();
	}
}
