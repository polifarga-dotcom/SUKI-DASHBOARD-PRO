// Kartenunterlage unter dem Radarbild: Ebenen-Stapel (Basis, Satellitenbilder, Tiefen, Coral Atlas, Seezeichen)
// aus dem chart-proxy des Pi. Leaflet bleibt intern Nord-oben; Drehung per CSS um die Bildschirmmitte.
//
// Flackerfrei: Leaflet bekommt nur ganzzahlige Zoomstufen (jeder Zoomwechsel = kompletter Kachel-Reset),
// der Rest des Maßstabs und die Drehung laufen per CSS-Transform. Positionsänderungen werden nur verschoben
// (panTo ohne Reset). Die Containergröße wird in 256-px-Schritten gerundet, damit sie nicht ständig wechselt.
// Ausrichtungs-Versatz je Ebene: CSS-Translate des Layer-Containers (Leaflet transformiert nur die Ebenen darin).
import L from 'leaflet';
import { R2D, fromLocal, type LatLon } from '../lib/geo';
import type { View } from '../radar/view';
import { chartCfg, provider, usable } from './layers.svelte';
import { createCoralLayer } from './coralLayer';
import { createAnchLayer, type AnchLayer } from './anchorages.svelte';
import { createCoastLayer, type CoastLayer } from './coast.svelte';
import { createWeatherLayer, type WeatherLayer } from './weatherLayer';
import { FlowLayer } from './flowLayer';
import { wxModel } from './weather.svelte';

const MAX_Z = 21;

/** Abstand zweier Positionen in m (klein, eben) */
const moved = (a: LatLon, b: LatLon, cosLat: number) => Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * cosLat);

interface Entry {
	layer: L.GridLayer;
	sig: string;
	dx: number;
	dy: number;
}

export class ChartLayer {
	private wrap: HTMLDivElement;
	private map: L.Map;
	private entries = new Map<string, Entry>();
	private zoom = -1;
	private size = 0;
	private lastCenter: LatLon | null = null;
	private lastCss = '';
	private mpp = 1; // m je Leaflet-Pixel bei der aktuellen Ganzzahl-Zoomstufe

	constructor(host: HTMLElement) {
		this.wrap = document.createElement('div');
		this.wrap.className = 'chart-wrap';
		Object.assign(this.wrap.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', transformOrigin: '50% 50%' });
		host.prepend(this.wrap);
		this.map = L.map(this.wrap, {
			zoomControl: false,
			attributionControl: false,
			dragging: false,
			scrollWheelZoom: false,
			doubleClickZoom: false,
			boxZoom: false,
			keyboard: false,
			touchZoom: false,
			zoomSnap: 1,
			maxZoom: MAX_Z,
			fadeAnimation: false,
			zoomAnimation: false,
			markerZoomAnimation: false,
			inertia: false
		});
		this.map.setView([0, 0], 2);
		this.sync();
	}

	/** Ebenen an die Konfiguration angleichen (aus einem $effect aufrufen) */
	sync() {
		const want: { id: string; z: number; opacity: number; dx: number; dy: number }[] = [];
		if (chartCfg.base !== 'none' && usable(chartCfg.base)) want.push({ id: chartCfg.base, z: 1, opacity: chartCfg.baseOpacity, dx: 0, dy: 0 });
		chartCfg.layers.forEach((l, i) => {
			if (l.on && usable(l.id) && l.id !== chartCfg.base) want.push({ id: l.id, z: l.id === 'coast' ? 90 : 10 + i, opacity: l.opacity, dx: l.dx, dy: l.dy });
			if (l.on && (l.mode === 'animated' || l.mode === 'both') && l.id.startsWith('wx:')) want.push({ id: 'flow:' + l.id, z: 10 + i, opacity: l.opacity, dx: 0, dy: 0 });
		});
		if (chartCfg.seamarks) want.push({ id: 'seamark', z: 100, opacity: chartCfg.seamarkOpacity, dx: 0, dy: 0 });

		const keep = new Set<string>();
		for (const w of want) {
			const p = provider(w.id);
			const wxl = w.id.startsWith('wx:');
			const flow = w.id.startsWith('flow:');
			if (!p && w.id !== 'coral' && w.id !== 'anch' && w.id !== 'coast' && !wxl && !flow) continue;
			const lc = wxl ? chartCfg.layers.find((l) => l.id === w.id) : undefined;
			const sig = wxl ? `${w.id}:${lc?.mode ?? 'static'}:${!!lc?.isobars}:${lc?.fill ?? ''}` : flow || w.id === 'anch' || w.id === 'coast' ? w.id : w.id === 'coral' ? `coral:${chartCfg.rev}` : `${p!.mode}:${p!.directUrl ?? ''}:${JSON.stringify(p!.values)}:${chartCfg.rev}`;
			let e = this.entries.get(w.id);
			if (e && e.sig !== sig) {
				this.map.removeLayer(e.layer);
				this.entries.delete(w.id);
				e = undefined;
			}
			if (!e) {
				const layer = flow
					? (new FlowLayer(w.id.slice(5), wxModel(w.id.slice(5))?.kind ?? 'wind') as unknown as L.GridLayer)
					: wxl
					? createWeatherLayer(w.id, { maxZoom: MAX_Z }, { symbols: lc?.mode !== 'animated', isobars: !!lc?.isobars, fill: lc?.fill })
					: w.id === 'anch'
						? (createAnchLayer({ maxZoom: MAX_Z }) as unknown as L.GridLayer)
						: w.id === 'coast'
						? (createCoastLayer({ maxZoom: MAX_Z }) as unknown as L.GridLayer)
						: w.id === 'coral'
						? createCoralLayer({ maxZoom: MAX_Z })
						: L.tileLayer(p!.mode === 'direct' ? p!.directUrl! : `/tiles/t/${w.id}/{z}/{x}/{y}?r=${chartCfg.rev}`, {
								maxZoom: MAX_Z,
								maxNativeZoom: p!.maxNativeZoom,
								keepBuffer: 3,
								crossOrigin: p!.mode === 'direct' ? 'anonymous' : undefined
							});
				layer.addTo(this.map);
				e = { layer, sig, dx: 0, dy: 0 };
				this.entries.set(w.id, e);
			}
			e.layer.setOpacity(w.opacity);
			e.layer.setZIndex(w.z);
			e.dx = w.dx;
			e.dy = w.dy;
			keep.add(w.id);
		}
		for (const [id, e] of this.entries)
			if (!keep.has(id)) {
				this.map.removeLayer(e.layer);
				this.entries.delete(id);
			}
		this.applyOffsets();
	}

	/** Wetter-Ebenen neu zeichnen (neue Daten oder andere Vorhersagezeit) */
	refreshWeather() {
		for (const [id, e] of this.entries) if (id.startsWith('wx:') || id.startsWith('flow:')) (e.layer as unknown as WeatherLayer).refresh();
	}

	/** Ankerplätze neu zeichnen (neue Zellen / eigene Plätze) */
	refreshAnch() {
		(this.entries.get('anch')?.layer as unknown as AnchLayer | undefined)?.refresh();
	}

	/** Küstenlinie neu zeichnen (neue Zellen / Natural Earth geladen) */
	refreshCoast() {
		(this.entries.get('coast')?.layer as unknown as CoastLayer | undefined)?.refresh();
	}

	private applyOffsets() {
		for (const [id, e] of this.entries) {
			if (id.startsWith('flow:')) continue; // Position setzt die Ebene selbst (Leaflet-Transform)
			const c = e.layer.getContainer();
			if (!c) continue;
			const t = e.dx || e.dy ? `translate(${(e.dx / this.mpp).toFixed(1)}px, ${(-e.dy / this.mpp).toFixed(1)}px)` : '';
			if (c.style.transform !== t) c.style.transform = t;
		}
	}

	/**
	 * @param pos Eigenschiff (liegt bei v.cx/v.cy); die Karte wird auf die Bildschirmmitte zentriert,
	 *            damit auch beim Verschieben weg vom Schiff nur der sichtbare Bereich geladen wird.
	 */
	update(v: View, pos: LatLon | null, opacity: number, filter: string) {
		if (!pos) {
			this.wrap.style.display = 'none';
			return;
		}
		this.wrap.style.display = '';
		this.wrap.style.opacity = String(opacity);
		if (this.wrap.style.filter !== filter) this.wrap.style.filter = filter;

		// geografische Position der Bildschirmmitte
		const sx = (v.width / 2 - v.cx) / v.ppm;
		const sy = (v.cy - v.height / 2) / v.ppm;
		const c = Math.cos(v.up);
		const s = Math.sin(v.up);
		const center = fromLocal(pos, sx * c + sy * s, -sx * s + sy * c);

		const cosLat = Math.cos((center.lat * Math.PI) / 180);
		const z = Math.log2(156543.03392 * cosLat * v.ppm);
		const zi = Math.max(0, Math.min(MAX_Z, Math.round(z))); // 0 = ganze Welt in einer Kachel
		const scale = 2 ** (z - zi);

		// Quadrat um die Bildschirmmitte, groß genug für Drehung und Skalierung, in 256er-Schritten
		const size = Math.ceil(Math.hypot(v.width, v.height) / scale / 256) * 256;
		if (size !== this.size) {
			this.size = size;
			Object.assign(this.wrap.style, { width: `${size}px`, height: `${size}px` });
			this.map.invalidateSize({ pan: false, animate: false } as L.InvalidateSizeOptions);
			this.zoom = -1;
		}

		if (zi !== this.zoom) {
			this.zoom = zi;
			this.mpp = (156543.03392 * cosLat) / 2 ** zi;
			this.map.setView([center.lat, center.lon], zi, { animate: false });
			this.lastCenter = center;
			this.applyOffsets();
		} else if (!this.lastCenter || moved(this.lastCenter, center, cosLat) > this.mpp * 0.5) {
			this.map.panTo([center.lat, center.lon], { animate: false });
			this.lastCenter = center;
		}

		const css = `translate(${(v.width / 2 - size / 2).toFixed(1)}px, ${(v.height / 2 - size / 2).toFixed(1)}px) rotate(${(-v.up * R2D).toFixed(2)}deg) scale(${scale.toFixed(5)})`;
		if (css !== this.lastCss) {
			this.lastCss = css;
			this.wrap.style.transform = css;
		}
	}

	destroy() {
		this.map.remove();
		this.wrap.remove();
	}
}
