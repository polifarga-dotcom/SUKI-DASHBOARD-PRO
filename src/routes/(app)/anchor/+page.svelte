<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { haversine, destinationPoint, bearingTo } from '$lib/utils/geo.js';
	import { rad2deg, fmtDepth, ms2kn, bearingCardinal } from '$lib/utils/units.js';

	let mapContainerEl: HTMLDivElement;
	let mapEl: HTMLDivElement;
	let L: typeof import('leaflet') | null = null;
	let map: ReturnType<typeof import('leaflet').map> | null = null;
	let boatMarker: any = null;
	let anchorMarker: any = null;
	let radiusCircle: any = null;
	let breadcrumbLine: any = null;
	let breadcrumb = $state<[number, number][]>([]);
	let mapReady = $state(false);
	let muteActive = $state(false);
	let cfgLoaded = $state(false);

	// Local slider copies — updated immediately on drag, saved to Supabase only on release
	let localChain   = $state(30);
	let localRadius  = $state(50);
	let localBearing = $state(0);
	let bearingManual = $state(false);

	const t   = $derived($telemetry);
	const cfg = $derived($anchorConfig);

	const boatLat  = $derived(t?.nav_lat ?? null);
	const boatLon  = $derived(t?.nav_lon ?? null);
	const hdgDeg   = $derived(rad2deg(t?.nav_hdg_rad ?? null) ?? 0);
	const awaDeg   = $derived(rad2deg(t?.env_awa_rad ?? null));
	const awsKn    = $derived(t?.env_aws_ms != null ? parseFloat(ms2kn(t.env_aws_ms)) : null);
	const depth    = $derived(fmtDepth(t?.env_depth_m ?? null));
	const alarming = $derived(cfg?.alarming ?? false);

	const anchorDistM = $derived(
		cfg?.lat != null && cfg?.lon != null && boatLat != null && boatLon != null
			? haversine(boatLat, boatLon, cfg.lat, cfg.lon)
			: null
	);

	const bearingToAnchorDeg = $derived(
		cfg?.lat != null && cfg?.lon != null && boatLat != null && boatLon != null
			? bearingTo(boatLat, boatLon, cfg.lat, cfg.lon)
			: null
	);

	// Init local sliders from cfg once on first load
	$effect(() => {
		if (cfg && !cfgLoaded) {
			localChain   = cfg.chain_length_m;
			localRadius  = cfg.radius_m;
			localBearing = cfg.bearing_deg;
			cfgLoaded = true;
		}
	});

	// Track breadcrumb — reads boatLat/boatLon, writes breadcrumb (no loop)
	$effect(() => {
		if (boatLat != null && boatLon != null) {
			breadcrumb = [...breadcrumb.slice(-99), [boatLat, boatLon]];
		}
	});

	// Rotate map wrapper — only reads hdgDeg, no store writes
	$effect(() => {
		if (mapContainerEl) {
			mapContainerEl.style.transform = `rotate(${-hdgDeg}deg)`;
		}
	});

	// Update Leaflet markers/layers — reads boat/anchor state, no store writes
	$effect(() => {
		if (!map || !L || !mapReady) return;
		const _ = [boatLat, boatLon, cfg, alarming, breadcrumb]; // declare deps
		updateMarkers();
	});

	function updateMarkers() {
		if (!map || !L) return;
		const counter = hdgDeg; // counter-rotate so markers appear upright

		if (boatLat != null && boatLon != null) {
			const boatIcon = L.divIcon({
				className: '',
				iconSize: [32, 32],
				iconAnchor: [16, 16],
				html: `<div style="width:32px;height:32px;transform:rotate(${counter}deg);display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1">⛵</div>`
			});
			if (!boatMarker) {
				boatMarker = L.marker([boatLat, boatLon], { icon: boatIcon, zIndexOffset: 100 }).addTo(map);
			} else {
				boatMarker.setLatLng([boatLat, boatLon]);
				boatMarker.setIcon(boatIcon);
			}
		}

		if (cfg?.active && cfg.lat != null && cfg.lon != null) {
			const ancIcon = L.divIcon({
				className: '',
				iconSize: [20, 20],
				iconAnchor: [10, 10],
				html: `<div style="width:20px;height:20px;transform:rotate(${counter}deg);display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1">⚓</div>`
			});
			if (!anchorMarker) {
				anchorMarker = L.marker([cfg.lat, cfg.lon], { icon: ancIcon }).addTo(map);
			} else {
				anchorMarker.setLatLng([cfg.lat, cfg.lon]);
				anchorMarker.setIcon(ancIcon);
			}

			const circleColor = alarming ? '#ef4444' : '#00c8ff';
			if (!radiusCircle) {
				radiusCircle = L.circle([cfg.lat, cfg.lon], {
					radius: cfg.radius_m, color: circleColor,
					fill: false, weight: 2, dashArray: '6 4'
				}).addTo(map);
			} else {
				radiusCircle.setLatLng([cfg.lat, cfg.lon]);
				radiusCircle.setRadius(cfg.radius_m);
				(radiusCircle.options as any).color = circleColor;
				radiusCircle.redraw();
			}
		} else {
			if (anchorMarker) { anchorMarker.remove(); anchorMarker = null; }
			if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }
		}

		if (breadcrumb.length > 1) {
			if (!breadcrumbLine) {
				breadcrumbLine = L.polyline(breadcrumb, { color: '#00c8ff', weight: 1.5, opacity: 0.6 }).addTo(map);
			} else {
				breadcrumbLine.setLatLngs(breadcrumb);
			}
		}
	}

	async function saveConfig(patch: Record<string, unknown>) {
		const { data } = await supabase
			.from('anchor_config')
			.update(patch)
			.eq('id', 1)
			.select()
			.single();
		if (data) anchorConfig.set(data);
	}

	async function setAnchor() {
		if (!boatLat || !boatLon) return;
		const [ancLat, ancLon] = destinationPoint(boatLat, boatLon, localBearing, localChain);
		await saveConfig({ lat: ancLat, lon: ancLon, active: true, alarming: false,
			chain_length_m: localChain, radius_m: localRadius, bearing_deg: localBearing });
	}

	async function clearAnchor() {
		await saveConfig({ active: false, alarming: false });
	}

	async function muteAlarm() {
		muteActive = true;
		await saveConfig({ alarming: false });
		setTimeout(() => { muteActive = false; }, 30000);
	}

	function snapBearingToHeading() {
		localBearing = hdgDeg;
		bearingManual = false;
		saveConfig({ bearing_deg: hdgDeg });
	}

	onMount(async () => {
		L = await import('leaflet') as typeof import('leaflet');
		await import('leaflet/dist/leaflet.css');

		map = L.map(mapEl, { zoomControl: false, attributionControl: false });
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

		const lat = boatLat ?? cfg?.lat ?? 54.0;
		const lon = boatLon ?? cfg?.lon ?? 10.0;
		map.setView([lat, lon], 15);
		mapReady = true;
	});

	onDestroy(() => { map?.remove(); });
</script>

<svelte:head><title>Anker · SUKI PRO</title></svelte:head>

<!-- Full-screen alarm overlay -->
{#if alarming && !muteActive}
<div class="alarm-overlay">
	<div class="alarm-icon">⚓</div>
	<div class="alarm-title">ANKER-ALARM</div>
	<div class="alarm-dist">
		{anchorDistM != null ? anchorDistM.toFixed(0) + ' m vom Ankerpunkt' : 'Position unbekannt'}
	</div>
	<button class="alarm-mute-btn" onclick={muteAlarm}>Stumm (30s)</button>
</div>
{/if}

<div class="anchor-page">

	<!-- Map box -->
	<div class="map-box" class:alarming>
		<!-- Rotating wrapper (heading-up) — Leaflet lives here -->
		<div class="map-wrapper" bind:this={mapContainerEl}>
			<div bind:this={mapEl} class="map-inner"></div>
		</div>

		<!-- N pill — orbits map center to always show North, counter-rotates to stay readable -->
		<div
			class="north-pill"
			style="transform: rotate({-hdgDeg}deg) translateY(-42px) rotate({hdgDeg}deg)"
		>N</div>

		<!-- Wind arrow — rotates to AWA from bow (heading-up frame) -->
		{#if awaDeg != null}
		<div class="wind-arrow-wrap" style="transform: rotate({hdgDeg + awaDeg}deg)">
			<div class="wind-arrow-shaft"></div>
			<div class="wind-arrow-head"></div>
			{#if awsKn != null}
			<div class="wind-label" style="transform: rotate({-(hdgDeg + awaDeg)}deg)">
				{awsKn.toFixed(1)} kn
			</div>
			{/if}
		</div>
		{/if}
	</div>

	<!-- 4 data cells -->
	<div class="data-cells">
		<div class="cell">
			<div class="cell-label">TIEFE</div>
			<div class="cell-val">{depth}</div>
		</div>
		<div class="cell">
			<div class="cell-label">KETTE</div>
			<div class="cell-val">{localChain} m</div>
		</div>
		<div class="cell">
			<div class="cell-label">SCOPE</div>
			<div class="cell-val">{anchorDistM != null ? anchorDistM.toFixed(0) + ' m' : '—'}</div>
		</div>
		<div class="cell">
			<div class="cell-label">KURS</div>
			<div class="cell-val">
				{bearingToAnchorDeg != null
					? bearingCardinal(bearingToAnchorDeg) + ' ' + bearingToAnchorDeg.toFixed(0) + '°'
					: '—'}
			</div>
		</div>
	</div>

	<!-- Control buttons -->
	<div class="ctrl-buttons">
		{#if !cfg?.active}
			<button class="ctrl-btn primary" onclick={setAnchor} disabled={!boatLat}>
				⚓ Anker setzen
			</button>
		{:else}
			<button class="ctrl-btn danger" onclick={clearAnchor}>Anker lichten</button>
		{/if}
		{#if alarming}
			<button class="ctrl-btn warning" onclick={muteAlarm}>Stumm</button>
		{/if}
	</div>

	<!-- Sliders -->
	<div class="sliders-card">

		<div class="slider-row">
			<div class="slider-head">
				<span class="slider-label">Kettenlänge</span>
				<span class="slider-val">{localChain} m</span>
			</div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => { localChain = Math.max(5, localChain - 5); saveConfig({ chain_length_m: localChain }); }}>−</button>
				<input
					type="range" min="5" max="120" step="5"
					value={localChain}
					oninput={(e) => { localChain = parseInt((e.target as HTMLInputElement).value); }}
					onchange={() => saveConfig({ chain_length_m: localChain })}
				/>
				<button class="step-btn" onclick={() => { localChain = Math.min(120, localChain + 5); saveConfig({ chain_length_m: localChain }); }}>+</button>
			</div>
		</div>

		<div class="slider-row">
			<div class="slider-head">
				<span class="slider-label">Radius</span>
				<span class="slider-val">{localRadius} m</span>
			</div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => { localRadius = Math.max(10, localRadius - 10); saveConfig({ radius_m: localRadius }); }}>−</button>
				<input
					type="range" min="10" max="500" step="10"
					value={localRadius}
					oninput={(e) => { localRadius = parseInt((e.target as HTMLInputElement).value); }}
					onchange={() => saveConfig({ radius_m: localRadius })}
				/>
				<button class="step-btn" onclick={() => { localRadius = Math.min(500, localRadius + 10); saveConfig({ radius_m: localRadius }); }}>+</button>
			</div>
		</div>

		<div class="slider-row">
			<div class="slider-head">
				<span class="slider-label">Peilung</span>
				<span class="slider-val">{localBearing.toFixed(0)}° {bearingCardinal(localBearing)}</span>
				{#if bearingManual}
					<button class="reset-btn" onclick={snapBearingToHeading}>↑ Kurs</button>
				{:else}
					<span class="auto-badge">auto</span>
				{/if}
			</div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => { localBearing = ((localBearing - 10 + 360) % 360); bearingManual = true; saveConfig({ bearing_deg: localBearing }); }}>−</button>
				<input
					type="range" min="0" max="359" step="1"
					value={localBearing}
					oninput={(e) => { localBearing = parseInt((e.target as HTMLInputElement).value); bearingManual = true; }}
					onchange={() => saveConfig({ bearing_deg: localBearing })}
				/>
				<button class="step-btn" onclick={() => { localBearing = ((localBearing + 10) % 360); bearingManual = true; saveConfig({ bearing_deg: localBearing }); }}>+</button>
			</div>
		</div>

	</div>
</div>

<style>
	/* ── Alarm overlay ── */
	.alarm-overlay {
		position: fixed;
		inset: 0;
		z-index: 9999;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		background: rgba(120, 0, 0, 0.93);
		animation: alarm-pulse 1s ease-in-out infinite alternate;
	}
	@keyframes alarm-pulse {
		from { background: rgba(120, 0, 0, 0.93); }
		to   { background: rgba(200, 0, 0, 0.97); }
	}
	.alarm-icon  { font-size: 64px; }
	.alarm-title { font-size: 32px; font-weight: 900; color: #fff; letter-spacing: 4px; }
	.alarm-dist  { font-size: 16px; color: #ffcccc; }
	.alarm-mute-btn {
		margin-top: 12px;
		padding: 12px 32px;
		background: rgba(255,255,255,0.15);
		border: 2px solid #fff;
		border-radius: 8px;
		color: #fff;
		font-size: 16px;
		font-weight: 600;
		cursor: pointer;
	}

	/* ── Page ── */
	.anchor-page { display: flex; flex-direction: column; gap: 10px; }

	/* ── Map ── */
	.map-box {
		position: relative;
		border-radius: var(--r);
		overflow: hidden;
		aspect-ratio: 4 / 3;
		border: 1px solid var(--border);
		background: #111;
	}
	.map-box.alarming { border-color: var(--red); }

	/* Extends past the box edges so rotation doesn't reveal corners */
	.map-wrapper {
		position: absolute;
		inset: -40%;
		transition: transform 0.4s ease-out;
	}
	.map-inner { width: 100%; height: 100%; }

	/* N pill — centered on map, orbits via rotate+translateY+counter-rotate */
	.north-pill {
		position: absolute;
		top: 50%;
		left: 50%;
		/* Center the pill on the rotation axis */
		width: 24px;
		height: 20px;
		margin-left: -12px;
		margin-top: -10px;
		/* Rotation origin = map center = (12px, 10px + 42px) from element top-left */
		transform-origin: 12px 52px;
		background: rgba(0, 0, 0, 0.75);
		color: var(--accent);
		font-size: 11px;
		font-weight: 700;
		border-radius: 10px;
		border: 1px solid var(--accent);
		pointer-events: none;
		z-index: 500;
		display: flex;
		align-items: center;
		justify-content: center;
		letter-spacing: 1px;
	}

	/* Wind arrow — centered on map, points toward apparent wind */
	.wind-arrow-wrap {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 2px;
		height: 44px;
		margin-left: -1px;
		margin-top: -44px;
		transform-origin: bottom center;
		pointer-events: none;
		z-index: 501;
	}
	.wind-arrow-shaft {
		width: 2px;
		height: 32px;
		background: var(--amber);
		margin: 0 auto;
	}
	.wind-arrow-head {
		width: 0;
		height: 0;
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-bottom: 10px solid var(--amber);
		margin: 0 auto;
		transform: translateX(-4px);
	}
	.wind-label {
		position: absolute;
		bottom: -20px;
		left: 50%;
		transform: translateX(-50%);
		font-size: 9px;
		color: var(--amber);
		white-space: nowrap;
		background: rgba(0,0,0,0.75);
		padding: 1px 4px;
		border-radius: 3px;
	}

	/* ── Data cells ── */
	.data-cells {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
	}
	.cell {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 4px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
	}
	.cell-label { font-size: 8px; color: var(--muted); letter-spacing: 0.5px; }
	.cell-val   { font-size: 12px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; }

	/* ── Control buttons ── */
	.ctrl-buttons { display: flex; gap: 8px; }
	.ctrl-btn {
		flex: 1;
		padding: 10px 8px;
		border-radius: 8px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: none;
		transition: opacity 0.15s;
	}
	.ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.ctrl-btn.primary { background: var(--accent); color: #000; }
	.ctrl-btn.danger  { background: #7f1d1d; color: var(--red);   border: 1px solid var(--red); }
	.ctrl-btn.warning { background: #78350f; color: var(--amber); border: 1px solid var(--amber); }

	/* ── Sliders ── */
	.sliders-card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--r);
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.slider-row    { display: flex; flex-direction: column; gap: 6px; }
	.slider-head   { display: flex; align-items: center; gap: 8px; }
	.slider-label  { font-size: 12px; color: var(--muted); }
	.slider-val    { font-size: 12px; font-weight: 600; color: var(--text); }
	.auto-badge {
		font-size: 9px;
		color: var(--green);
		border: 1px solid var(--green);
		border-radius: 3px;
		padding: 1px 5px;
	}
	.reset-btn {
		font-size: 10px;
		color: var(--accent);
		background: none;
		border: 1px solid var(--accent);
		border-radius: 4px;
		padding: 1px 6px;
		cursor: pointer;
	}
	.slider-controls { display: flex; align-items: center; gap: 8px; }
	.step-btn {
		width: 40px;
		height: 40px;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text);
		font-size: 20px;
		font-weight: 300;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.step-btn:active { border-color: var(--accent); color: var(--accent); }

	input[type="range"] {
		flex: 1;
		-webkit-appearance: none;
		appearance: none;
		height: 4px;
		background: var(--border);
		border-radius: 2px;
		outline: none;
	}
	input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		border: 3px solid var(--bg);
		box-shadow: 0 0 0 2px var(--accent);
	}
</style>
