<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { vrmData } from '$lib/stores/vrm.js';
	import { inreachPoints } from '$lib/stores/inreach.js';
	import { weatherForecast } from '$lib/stores/weather.js';

	// ── Reactive GPS position (same priority as WeatherCard) ──────────────────
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
	const pos = $derived(posLat != null && posLon != null ? { lat: posLat, lon: posLon } : null);

	const hours = $derived($weatherForecast);

	// ── UI state ──────────────────────────────────────────────────────────────
	let mode      = $state<'wind' | 'wave'>('wind');
	let sliderIdx = $state(0);

	let mapEl:    HTMLDivElement | undefined;
	let canvasEl: HTMLCanvasElement | undefined;

	let mapInstance: import('leaflet').Map | null = null;
	let boatMarker:  import('leaflet').Marker | null = null;
	let animFrame = 0;
	let particles: Particle[] = [];
	let mapReady  = $state(false);

	// ── Color scales ──────────────────────────────────────────────────────────
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
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return [r, g, b];
	}

	// ── Derived current hour ──────────────────────────────────────────────────
	const currentHour = $derived(hours[sliderIdx] ?? hours[0] ?? null);

	function fmtSliderLabel(time: string): string {
		const day = new Date(time).toLocaleDateString('en', { weekday: 'short' });
		return `${day} ${time.slice(11, 16)}`;
	}

	function dirAbbr(deg: number): string {
		const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
		return d[Math.round(deg / 22.5) % 16];
	}

	// ── Particle system ───────────────────────────────────────────────────────
	type Particle = {
		x: number; y: number;
		age: number; maxAge: number;
	};

	const PARTICLE_COUNT = 180;

	function initParticles(W: number, H: number) {
		particles = Array.from({ length: PARTICLE_COUNT }, () => ({
			x: Math.random() * W,
			y: Math.random() * H,
			age: Math.random() * 80,
			maxAge: 50 + Math.random() * 70,
		}));
	}

	function drawFrame(ctx: CanvasRenderingContext2D, W: number, H: number) {
		ctx.fillStyle = 'rgba(0,0,0,0.09)';
		ctx.fillRect(0, 0, W, H);

		const h = currentHour;
		if (!h) return;

		const useWave = mode === 'wave' && h.waveH != null;
		// Open-Meteo wind direction = FROM where wind blows → +180 for flow direction
		const fromDeg = useWave ? (h.waveD ?? 0) : h.dir;
		const flowRad = ((fromDeg + 180) % 360) * Math.PI / 180;

		const rawSpd  = useWave ? (h.waveH ?? 0) : h.wind;
		// scale: wind in knots → px/frame; wave height in m → px/frame
		const speed   = useWave ? rawSpd * 1.8 + 0.6 : rawSpd * 0.11 + 0.4;
		const color   = useWave ? waveColor(rawSpd) : windColor(rawSpd);
		const [cr, cg, cb] = hexToRgb(color);

		const dx = Math.sin(flowRad) * speed;
		const dy = -Math.cos(flowRad) * speed;

		for (const p of particles) {
			p.x += dx;
			p.y += dy;
			p.age++;

			if (p.x < -2)  p.x += W + 4;
			if (p.x > W+2) p.x -= W + 4;
			if (p.y < -2)  p.y += H + 4;
			if (p.y > H+2) p.y -= H + 4;

			const lr = p.age / p.maxAge;
			const alpha = lr < 0.12 ? lr / 0.12 : lr > 0.8 ? (1 - lr) / 0.2 : 1;

			ctx.beginPath();
			ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${cr},${cg},${cb},${(alpha * 0.9).toFixed(2)})`;
			ctx.fill();

			if (p.age >= p.maxAge) {
				p.x = Math.random() * W;
				p.y = Math.random() * H;
				p.age = 0;
				p.maxAge = 50 + Math.random() * 70;
			}
		}
	}

	function animate() {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;
		drawFrame(ctx, canvasEl.width, canvasEl.height);
		animFrame = requestAnimationFrame(animate);
	}

	function stopAnimation() {
		if (animFrame) { cancelAnimationFrame(animFrame); animFrame = 0; }
	}

	// Clear canvas when mode or time slot changes
	$effect(() => {
		void mode; void sliderIdx;
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
	});

	// Update boat marker position when GPS changes
	$effect(() => {
		const p = pos;
		if (!boatMarker || !p) return;
		boatMarker.setLatLng([p.lat, p.lon]);
	});

	// ── Map init ──────────────────────────────────────────────────────────────
	onMount(async () => {
		if (!mapEl || !canvasEl || !pos) return;

		const L = (await import('leaflet')).default;

		const map = L.map(mapEl, {
			center:           [pos.lat, pos.lon],
			zoom:             9,            // ~30 NM view
			zoomControl:      false,
			attributionControl: false,
		});

		L.tileLayer(
			'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
			{ subdomains: 'abcd', maxZoom: 19 }
		).addTo(map);

		// Boat marker
		const boatIcon = L.divIcon({
			className: '',
			html: `<div style="
				width:10px;height:10px;border-radius:50%;
				background:#00e5ff;border:2px solid rgba(255,255,255,0.9);
				box-shadow:0 0 10px #00e5ff,0 0 20px #00e5ff55;
			"></div>`,
			iconSize:   [10, 10],
			iconAnchor: [5, 5],
		});
		boatMarker = L.marker([pos.lat, pos.lon], { icon: boatIcon }).addTo(map);

		L.control.zoom({ position: 'bottomright' }).addTo(map);

		mapInstance = map;

		// Size canvas
		const W = mapEl.clientWidth;
		const H = mapEl.clientHeight;
		canvasEl.width  = W;
		canvasEl.height = H;

		initParticles(W, H);
		animate();
		mapReady = true;
	});

	onDestroy(() => {
		stopAnimation();
		mapInstance?.remove();
	});
</script>

<svelte:head>
	<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
</svelte:head>

{#if pos && hours.length > 0}
<div class="wx-map-card">

	<!-- Toolbar -->
	<div class="wx-map-toolbar">
		<div class="wx-map-tabs">
			<button class="wx-tab" class:active={mode === 'wind'} onclick={() => mode = 'wind'}>
				<svg viewBox="0 0 20 14" width="14" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
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
			>
				<svg viewBox="0 0 20 12" width="14" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
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
			<span class="wx-map-time">{fmtSliderLabel(currentHour.time)}</span>
		</div>
		{/if}
	</div>

	<!-- Map + canvas -->
	<div class="wx-map-wrap">
		<div bind:this={mapEl} class="wx-map-leaflet"></div>
		<canvas bind:this={canvasEl} class="wx-map-canvas"></canvas>
	</div>

	<!-- Time slider -->
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
				{#if i % 4 === 0}
				<span class="wx-slider-tick" style="left:{(i / (hours.length - 1)) * 100}%">
					{h.time.slice(11,16)}
				</span>
				{/if}
			{/each}
		</div>
	</div>
	{/if}

	<!-- Wind speed legend -->
	<div class="wx-legend">
		{#each [
			['< 3', '#c8e6ff'], ['10', '#66d9ff'], ['17', '#33dd88'],
			['22', '#aaee00'], ['28', '#ffcc00'], ['34', '#ff8800'],
			['48', '#ff3300'], ['48+', '#cc44ff']
		] as [label, color]}
		<div class="wx-legend-item">
			<span class="wx-legend-dot" style="background:{color}"></span>
			<span class="wx-legend-lbl">{label}</span>
		</div>
		{/each}
		<span class="wx-legend-unit">kn</span>
	</div>

</div>
{/if}

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
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
		gap: 10px;
	}
	.wx-map-tabs { display: flex; gap: 4px; }
	.wx-tab {
		display: flex; align-items: center; gap: 5px;
		padding: 5px 12px;
		border-radius: 20px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--muted);
		font-size: 12px; font-weight: 600;
		cursor: pointer;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
	}
	.wx-tab:hover:not(.disabled) { color: var(--text); }
	.wx-tab.active {
		background: rgba(0,200,255,0.12);
		border-color: rgba(0,200,255,0.4);
		color: #00e5ff;
	}
	.wx-tab.disabled { opacity: 0.35; cursor: default; }

	.wx-map-info { display: flex; align-items: center; gap: 6px; }
	.wx-map-val  { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
	.wx-map-dir  { font-size: 11px; color: var(--muted); font-weight: 600; }
	.wx-map-time { font-size: 11px; color: var(--muted); margin-left: 4px; }

	/* Map container */
	.wx-map-wrap {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		max-height: 340px;
		overflow: hidden;
		background: #0d1117;
	}
	.wx-map-leaflet {
		position: absolute; inset: 0; z-index: 1;
	}
	.wx-map-canvas {
		position: absolute; inset: 0; z-index: 2;
		pointer-events: none;
		mix-blend-mode: screen;
	}

	/* Slider */
	.wx-map-slider-wrap {
		position: relative;
		padding: 10px 14px 22px;
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
		background: #00e5ff;
		border: 2px solid var(--card);
		box-shadow: 0 0 6px #00e5ff88;
		cursor: pointer;
	}
	.wx-slider::-moz-range-thumb {
		width: 14px; height: 14px; border-radius: 50%;
		background: #00e5ff;
		border: 2px solid var(--card);
	}
	.wx-slider-labels { position: relative; height: 14px; margin-top: 4px; }
	.wx-slider-tick {
		position: absolute; transform: translateX(-50%);
		font-size: 9px; color: var(--muted); opacity: 0.7;
		white-space: nowrap;
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
	.wx-legend-unit { font-size: 9px; color: var(--muted); opacity: 0.5; margin-left: 2px; flex-shrink: 0; }

	/* Leaflet overrides */
	:global(.wx-map-leaflet .leaflet-control-zoom) {
		border: none !important; box-shadow: none !important;
	}
	:global(.wx-map-leaflet .leaflet-control-zoom a) {
		background: rgba(15,15,22,0.88) !important;
		color: #999 !important;
		border: 1px solid rgba(255,255,255,0.1) !important;
		font-size: 14px !important; line-height: 26px !important;
		width: 26px !important; height: 26px !important;
	}
	:global(.wx-map-leaflet .leaflet-control-zoom a:hover) {
		color: #fff !important;
		background: rgba(0,200,255,0.18) !important;
	}
</style>
