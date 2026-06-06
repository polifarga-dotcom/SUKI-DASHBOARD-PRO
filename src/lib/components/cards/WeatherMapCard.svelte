<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { vrmData } from '$lib/stores/vrm.js';
	import { inreachPoints } from '$lib/stores/inreach.js';
	import { weatherForecast } from '$lib/stores/weather.js';

	// ── GPS (same priority as WeatherCard) ────────────────────────────────────
	const t   = $derived($telemetry);
	const vrm = $derived($vrmData);
	const pts = $derived($inreachPoints);

	const posLat = $derived(
		t?.nav_lat   != null ? t.nav_lat   :
		vrm?.gps_lat != null ? vrm.gps_lat :
		pts?.[0]?.lat ?? null
	);
	const posLon = $derived(
		t?.nav_lon   != null ? t.nav_lon   :
		vrm?.gps_lon != null ? vrm.gps_lon :
		pts?.[0]?.lon ?? null
	);
	const pos = $derived(
		posLat != null && posLon != null ? { lat: posLat, lon: posLon } : null
	);

	const hours = $derived($weatherForecast);

	// ── UI state ──────────────────────────────────────────────────────────────
	let mode      = $state<'wind' | 'wave'>('wind');
	let sliderIdx = $state(0);

	let mapEl:    HTMLDivElement | undefined = $state();
	let canvasEl: HTMLCanvasElement | undefined = $state();

	type LeafletMap    = import('leaflet').Map;
	type LeafletMarker = import('leaflet').Marker;

	let mapInstance: LeafletMap | null  = null;
	let boatMarker:  LeafletMarker | null = null;
	let animFrame = 0;

	type Particle = { x: number; y: number; age: number; maxAge: number };
	let particles: Particle[] = [];

	// ── Color scales (Windy/Beaufort) ─────────────────────────────────────────
	function windColor(kn: number): string {
		if (kn <  3) return '#c8e6ff';
		if (kn < 10) return '#66d9ff';
		if (kn < 17) return '#33dd88';
		if (kn < 22) return '#aaee00';
		if (kn < 28) return '#ffcc00';
		if (kn < 34) return '#ff8800';
		if (kn < 48) return '#ff3300';
		return '#cc44ff';
	}
	function waveColor(m: number): string {
		if (m < 0.3) return '#88ddff';
		if (m < 0.8) return '#33bbff';
		if (m < 1.5) return '#33dd88';
		if (m < 2.5) return '#ffcc00';
		if (m < 4.0) return '#ff5500';
		return '#cc44ff';
	}
	function hexToRgb(hex: string): [number, number, number] {
		return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
	}

	const currentHour = $derived(hours[sliderIdx] ?? hours[0] ?? null);

	function fmtTime(iso: string): string {
		return new Date(iso).toLocaleDateString('en', { weekday: 'short' }) + ' ' + iso.slice(11, 16);
	}
	function dirAbbr(deg: number): string {
		const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
		return d[Math.round(deg / 22.5) % 16];
	}

	// ── Particle animation ────────────────────────────────────────────────────
	function initParticles(W: number, H: number) {
		particles = Array.from({ length: 200 }, () => ({
			x: Math.random() * W,
			y: Math.random() * H,
			age: Math.random() * 90,
			maxAge: 55 + Math.random() * 65,
		}));
	}

	function drawFrame(ctx: CanvasRenderingContext2D, W: number, H: number) {
		ctx.fillStyle = 'rgba(0,0,0,0.08)';
		ctx.fillRect(0, 0, W, H);

		const h = currentHour;
		if (!h) return;

		const useWave = mode === 'wave' && h.waveH != null;
		const fromDeg = useWave ? (h.waveD ?? 0) : h.dir;
		// from-direction → flow direction (particles move away from source)
		const flowRad = ((fromDeg + 180) % 360) * Math.PI / 180;
		const rawVal  = useWave ? (h.waveH ?? 0) : h.wind;
		const speed   = useWave ? rawVal * 2.0 + 0.5 : rawVal * 0.13 + 0.4;
		const color   = useWave ? waveColor(rawVal) : windColor(rawVal);
		const [cr,cg,cb] = hexToRgb(color);

		const dx = Math.sin(flowRad) * speed;
		const dy = -Math.cos(flowRad) * speed;

		for (const p of particles) {
			p.x += dx;
			p.y += dy;
			p.age++;
			if (p.x < 0)   p.x += W;
			if (p.x > W)   p.x -= W;
			if (p.y < 0)   p.y += H;
			if (p.y > H)   p.y -= H;

			const lr = p.age / p.maxAge;
			const alpha = lr < 0.12 ? lr / 0.12 : lr > 0.82 ? (1 - lr) / 0.18 : 1;

			ctx.beginPath();
			ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${cr},${cg},${cb},${(alpha * 0.88).toFixed(2)})`;
			ctx.fill();

			if (p.age >= p.maxAge) {
				p.x = Math.random() * W;
				p.y = Math.random() * H;
				p.age = 0;
				p.maxAge = 55 + Math.random() * 65;
			}
		}
	}

	function startAnimation() {
		stopAnimation();
		function loop() {
			if (!canvasEl) return;
			const ctx = canvasEl.getContext('2d');
			if (!ctx) return;
			drawFrame(ctx, canvasEl.width, canvasEl.height);
			animFrame = requestAnimationFrame(loop);
		}
		animFrame = requestAnimationFrame(loop);
	}

	function stopAnimation() {
		if (animFrame) { cancelAnimationFrame(animFrame); animFrame = 0; }
	}

	// Clear + reinit when mode/slot changes
	$effect(() => {
		void mode; void sliderIdx;
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
	});

	// Update marker when GPS changes
	$effect(() => {
		const p = pos;
		if (!boatMarker || !p) return;
		boatMarker.setLatLng([p.lat, p.lon]);
	});

	// Re-center map when boat moves significantly
	let lastCenteredPos: { lat: number; lon: number } | null = null;
	$effect(() => {
		const p = pos;
		if (!mapInstance || !p) return;
		if (!lastCenteredPos) {
			mapInstance.setView([p.lat, p.lon], 9);
			lastCenteredPos = p;
		}
	});

	// ── Map init ──────────────────────────────────────────────────────────────
	onMount(async () => {
		// Dynamic import so Leaflet only runs in browser
		const [{ default: L }] = await Promise.all([
			import('leaflet'),
			import('leaflet/dist/leaflet.css' as string),
		]);

		// Wait for DOM + layout
		await tick();
		if (!mapEl) return;

		const center: [number, number] = pos ? [pos.lat, pos.lon] : [43.0, 6.0]; // fallback: Med

		const map = L.map(mapEl, {
			center,
			zoom: 9,
			zoomControl: false,
			attributionControl: false,
		});

		// CartoDB Dark Matter (no labels) — dark monochrome
		L.tileLayer(
			'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
			{ subdomains: 'abcd', maxZoom: 19 }
		).addTo(map);

		// Boat marker
		if (pos) {
			const icon = L.divIcon({
				className: '',
				html: `<div style="width:10px;height:10px;border-radius:50%;
					background:#00e5ff;border:2px solid rgba(255,255,255,.9);
					box-shadow:0 0 10px #00e5ff,0 0 20px #00e5ff44;"></div>`,
				iconSize:   [10, 10],
				iconAnchor: [5, 5],
			});
			boatMarker = L.marker([pos.lat, pos.lon], { icon }).addTo(map);
		}

		// Zoom control (bottom right)
		L.control.zoom({ position: 'bottomright' }).addTo(map);

		mapInstance = map;
		lastCenteredPos = pos;

		// Force Leaflet to recalculate size after mount
		setTimeout(() => {
			map.invalidateSize();
			// Size the canvas to match
			if (canvasEl && mapEl) {
				canvasEl.width  = mapEl.clientWidth;
				canvasEl.height = mapEl.clientHeight;
				initParticles(canvasEl.width, canvasEl.height);
				startAnimation();
			}
		}, 100);
	});

	onDestroy(() => {
		stopAnimation();
		mapInstance?.remove();
	});

	function centerOnBoat() {
		if (!mapInstance || !pos) return;
		mapInstance.setView([pos.lat, pos.lon], 9, { animate: true });
	}
</script>

<div class="wx-map-card">

	<!-- Toolbar -->
	<div class="wx-map-toolbar">
		<div class="wx-map-tabs">
			<button class="wx-tab" class:active={mode === 'wind'} onclick={() => mode = 'wind'}>
				<svg viewBox="0 0 20 14" width="14" height="10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
					<path d="M1 7 Q5 2 10 7 Q15 12 19 7"/>
					<path d="M1 3 Q4 1 7 3"/>
					<path d="M1 11 Q4 13 7 11"/>
				</svg>
				Wind
			</button>
			<button
				class="wx-tab"
				class:active={mode === 'wave'}
				class:disabled={!currentHour?.waveH}
				onclick={() => { if (currentHour?.waveH) mode = 'wave'; }}
				title={!currentHour?.waveH ? 'Wave data unavailable at this location' : ''}
			>
				<svg viewBox="0 0 20 12" width="14" height="9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
					<path d="M1 9 Q4 4 7 9 Q10 14 13 9 Q16 4 19 9"/>
					<path d="M1 4 Q4 1 6 4"/>
				</svg>
				Wave
			</button>
		</div>

		{#if currentHour}
		<div class="wx-map-info">
			{#if mode === 'wind'}
				<span class="wx-map-val" style="color:{windColor(currentHour.wind)}">{currentHour.wind} kn</span>
				<span class="wx-map-dir">{dirAbbr(currentHour.dir)}</span>
			{:else if mode === 'wave' && currentHour.waveH != null}
				<span class="wx-map-val" style="color:{waveColor(currentHour.waveH)}">{currentHour.waveH} m</span>
				{#if currentHour.waveD != null}<span class="wx-map-dir">{dirAbbr(currentHour.waveD)}</span>{/if}
			{/if}
			<span class="wx-map-time">{fmtTime(currentHour.time)}</span>
		</div>
		{:else}
		<span class="wx-map-loading">Loading forecast…</span>
		{/if}
	</div>

	<!-- Map + canvas overlay -->
	<div class="wx-map-wrap">
		<div bind:this={mapEl} class="wx-map-leaflet"></div>
		<canvas bind:this={canvasEl} class="wx-map-canvas"></canvas>

		<!-- Center button overlay -->
		<button class="wx-center-btn" onclick={centerOnBoat} title="Center on boat">
			<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="10" cy="10" r="3"/>
				<line x1="10" y1="1" x2="10" y2="5"/>
				<line x1="10" y1="15" x2="10" y2="19"/>
				<line x1="1"  y1="10" x2="5"  y2="10"/>
				<line x1="15" y1="10" x2="19" y2="10"/>
			</svg>
		</button>

		<!-- No data overlay -->
		{#if !pos}
		<div class="wx-map-overlay">
			<span>Waiting for GPS position…</span>
		</div>
		{:else if hours.length === 0}
		<div class="wx-map-overlay">
			<span>Loading weather data…</span>
		</div>
		{/if}
	</div>

	<!-- Time slider — full width, same as forecast table -->
	{#if hours.length > 1}
	<div class="wx-map-slider-wrap">
		<input
			type="range"
			min="0"
			max={hours.length - 1}
			step="1"
			bind:value={sliderIdx}
			class="wx-slider"
		/>
		<div class="wx-slider-labels">
			{#each hours as h, i}
				{#if i === 0 || i === hours.length - 1 || i % 4 === 0}
				<span class="wx-slider-tick" style="left:{(i / (hours.length - 1)) * 100}%">
					{h.time.slice(11,16)}
				</span>
				{/if}
			{/each}
		</div>
	</div>
	{/if}

	<!-- Wind speed color legend -->
	<div class="wx-legend">
		{#each [
			['calm', '#c8e6ff'], ['10', '#66d9ff'], ['17', '#33dd88'],
			['22', '#aaee00'], ['28', '#ffcc00'], ['34', '#ff8800'],
			['48', '#ff3300'], ['48+', '#cc44ff']
		] as [lbl, col]}
		<div class="wx-legend-item">
			<span class="wx-legend-dot" style="background:{col}"></span>
			<span class="wx-legend-lbl">{lbl}</span>
		</div>
		{/each}
		<span class="wx-legend-unit">kn</span>
	</div>

</div>

<style>
	.wx-map-card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 14px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	/* Toolbar */
	.wx-map-toolbar {
		display: flex; align-items: center; justify-content: space-between;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
		gap: 10px;
	}
	.wx-map-tabs { display: flex; gap: 4px; }
	.wx-tab {
		display: flex; align-items: center; gap: 5px;
		padding: 5px 12px; border-radius: 20px;
		border: 1px solid var(--border);
		background: transparent; color: var(--muted);
		font-size: 12px; font-weight: 600; cursor: pointer;
		transition: background .15s, color .15s, border-color .15s;
	}
	.wx-tab:hover:not(.disabled) { color: var(--text); }
	.wx-tab.active {
		background: rgba(0,200,255,.12);
		border-color: rgba(0,200,255,.4);
		color: #00e5ff;
	}
	.wx-tab.disabled { opacity: .35; cursor: default; }

	.wx-map-info { display: flex; align-items: center; gap: 6px; }
	.wx-map-val  { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
	.wx-map-dir  { font-size: 11px; color: var(--muted); font-weight: 600; }
	.wx-map-time { font-size: 11px; color: var(--muted); margin-left: 4px; }
	.wx-map-loading { font-size: 11px; color: var(--muted); }

	/* Map */
	.wx-map-wrap {
		position: relative;
		width: 100%;
		height: 300px;   /* fixed px height — Leaflet needs a concrete size */
		background: #0d1117;
		overflow: hidden;
	}
	.wx-map-leaflet {
		position: absolute; inset: 0;
		width: 100%; height: 100%;
		z-index: 1;
	}
	.wx-map-canvas {
		position: absolute; inset: 0;
		width: 100%; height: 100%;
		z-index: 2;
		pointer-events: none;
		mix-blend-mode: screen;
	}

	/* Center button — bottom-left so it doesn't clash with zoom (bottom-right) */
	.wx-center-btn {
		position: absolute;
		bottom: 42px; left: 10px;
		z-index: 10;
		width: 28px; height: 28px;
		display: flex; align-items: center; justify-content: center;
		background: rgba(15,15,22,.88);
		border: 1px solid rgba(255,255,255,.12);
		border-radius: 6px;
		color: #aaa; cursor: pointer;
		transition: color .15s, background .15s;
	}
	.wx-center-btn:hover {
		color: #00e5ff;
		background: rgba(0,200,255,.18);
		border-color: rgba(0,200,255,.35);
	}

	/* Overlay (loading / no GPS) */
	.wx-map-overlay {
		position: absolute; inset: 0; z-index: 5;
		display: flex; align-items: center; justify-content: center;
		background: rgba(10,10,16,.7);
		font-size: 13px; color: var(--muted);
	}

	/* Slider — full width, flush with card edges */
	.wx-map-slider-wrap {
		position: relative;
		padding: 12px 14px 22px;
		border-top: 1px solid var(--border);
	}
	.wx-slider {
		width: 100%; height: 3px;
		-webkit-appearance: none; appearance: none;
		background: var(--border); border-radius: 2px;
		outline: none; cursor: pointer;
	}
	.wx-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 16px; height: 16px; border-radius: 50%;
		background: #00e5ff; border: 2px solid var(--card);
		box-shadow: 0 0 6px #00e5ff88; cursor: pointer;
	}
	.wx-slider::-moz-range-thumb {
		width: 14px; height: 14px; border-radius: 50%;
		background: #00e5ff; border: 2px solid var(--card);
	}
	.wx-slider-labels {
		position: relative; height: 14px; margin-top: 5px;
	}
	.wx-slider-tick {
		position: absolute; transform: translateX(-50%);
		font-size: 9px; color: var(--muted); opacity: .7; white-space: nowrap;
	}

	/* Legend */
	.wx-legend {
		display: flex; align-items: center; gap: 5px;
		padding: 7px 12px;
		border-top: 1px solid var(--border);
		overflow-x: auto; flex-wrap: nowrap;
	}
	.wx-legend-item { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
	.wx-legend-dot  { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.wx-legend-lbl  { font-size: 9px; color: var(--muted); white-space: nowrap; }
	.wx-legend-unit { font-size: 9px; color: var(--muted); opacity: .5; margin-left: 2px; flex-shrink: 0; }

	/* Leaflet overrides */
	:global(.wx-map-leaflet .leaflet-control-zoom) {
		border: none !important; box-shadow: none !important;
	}
	:global(.wx-map-leaflet .leaflet-control-zoom a) {
		background: rgba(15,15,22,.88) !important;
		color: #999 !important;
		border: 1px solid rgba(255,255,255,.1) !important;
		font-size: 14px !important; line-height: 26px !important;
		width: 26px !important; height: 26px !important;
		display: flex !important; align-items: center !important; justify-content: center !important;
	}
	:global(.wx-map-leaflet .leaflet-control-zoom a:hover) {
		color: #fff !important; background: rgba(0,200,255,.18) !important;
	}
	:global(.wx-map-leaflet .leaflet-control-zoom-in) {
		border-radius: 6px 6px 0 0 !important;
		border-bottom: none !important;
	}
	:global(.wx-map-leaflet .leaflet-control-zoom-out) {
		border-radius: 0 0 6px 6px !important;
	}
	:global(.wx-map-leaflet .leaflet-tile-pane) { filter: brightness(0.9); }
</style>
