<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { haversine, destinationPoint, bearingTo } from '$lib/utils/geo.js';
	import { rad2deg, fmtDepth, ms2kn, bearingCardinal } from '$lib/utils/units.js';

	let mapContainerEl: HTMLDivElement;  // outer, gets CSS rotation
	let mapEl: HTMLDivElement;           // inner, Leaflet target
	let L: typeof import('leaflet') | null = null;
	let map: ReturnType<typeof import('leaflet').map> | null = null;
	let boatMarker: ReturnType<typeof import('leaflet').marker> | null = null;
	let anchorMarker: ReturnType<typeof import('leaflet').marker> | null = null;
	let radiusCircle: ReturnType<typeof import('leaflet').circle> | null = null;
	let breadcrumbLine: ReturnType<typeof import('leaflet').polyline> | null = null;
	let breadcrumb = $state<[number, number][]>([]);
	let mapReady = $state(false);
	let bearingManual = $state(false);
	let muteActive = $state(false);
	let showSettings = $state(false);

	const t = $derived($telemetry);
	const cfg = $derived($anchorConfig);

	const boatLat = $derived(t?.nav_lat ?? null);
	const boatLon = $derived(t?.nav_lon ?? null);
	const hdgDeg  = $derived(rad2deg(t?.nav_hdg_rad ?? null) ?? 0);
	const awaDeg  = $derived(rad2deg(t?.env_awa_rad ?? null));
	const awsKn   = $derived(t?.env_aws_ms != null ? parseFloat(ms2kn(t.env_aws_ms)) : null);
	const depth   = $derived(fmtDepth(t?.env_depth_m ?? null));

	const alarming = $derived(cfg?.alarming ?? false);

	const anchorDist = $derived(() => {
		if (!cfg?.lat || !cfg?.lon || !boatLat || !boatLon) return null;
		return haversine(boatLat, boatLon, cfg.lat, cfg.lon);
	});

	const scopeM = $derived(() => {
		const dist = anchorDist();
		return dist != null ? dist.toFixed(0) + ' m' : '—';
	});

	const chainM = $derived(cfg?.chain_length_m ?? 0);
	const radiusM = $derived(cfg?.radius_m ?? 0);
	const bearingDeg = $derived(cfg?.bearing_deg ?? 0);

	const bearingToAnchor = $derived(() => {
		if (!cfg?.lat || !cfg?.lon || !boatLat || !boatLon) return null;
		return bearingTo(boatLat, boatLon, cfg.lat, cfg.lon);
	});

	// Update breadcrumb when position changes
	$effect(() => {
		if (boatLat != null && boatLon != null) {
			breadcrumb = [...breadcrumb.slice(-99), [boatLat, boatLon]];
		}
	});

	// Sync bearing to heading unless manually set
	$effect(() => {
		if (!bearingManual && cfg && hdgDeg != null) {
			void updateConfig({ bearing_deg: hdgDeg });
		}
	});

	async function updateConfig(patch: Partial<typeof cfg>) {
		const { data } = await supabase
			.from('anchor_config')
			.update(patch)
			.eq('id', 1)
			.select()
			.single();
		if (data) anchorConfig.set(data);
	}

	async function setAnchor() {
		if (!boatLat || !boatLon || !cfg) return;
		const [ancLat, ancLon] = destinationPoint(boatLat, boatLon, cfg.bearing_deg, cfg.chain_length_m);
		const { data } = await supabase
			.from('anchor_config')
			.update({ lat: ancLat, lon: ancLon, active: true, alarming: false })
			.eq('id', 1)
			.select()
			.single();
		if (data) anchorConfig.set(data);
	}

	async function clearAnchor() {
		const { data } = await supabase
			.from('anchor_config')
			.update({ active: false, alarming: false })
			.eq('id', 1)
			.select()
			.single();
		if (data) anchorConfig.set(data);
	}

	async function muteAlarm() {
		muteActive = true;
		await updateConfig({ alarming: false });
		setTimeout(() => { muteActive = false; }, 30000);
	}

	function buildBoatIcon(hdg: number, counter: number) {
		return L!.divIcon({
			className: '',
			iconSize: [32, 32],
			iconAnchor: [16, 16],
			html: `<div style="width:32px;height:32px;transform:rotate(${counter}deg);display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1">⛵</div>`
		});
	}

	function buildAnchorIcon(counter: number) {
		return L!.divIcon({
			className: '',
			iconSize: [20, 20],
			iconAnchor: [10, 10],
			html: `<div style="width:20px;height:20px;transform:rotate(${counter}deg);display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1">⚓</div>`
		});
	}

	// Update map markers/layers reactively
	$effect(() => {
		if (!map || !L || !mapReady) return;

		// Rotate container heading-up
		if (mapContainerEl) {
			mapContainerEl.style.transform = `rotate(${-hdgDeg}deg)`;
		}

		const counter = hdgDeg;

		// Boat marker
		if (boatLat != null && boatLon != null) {
			if (!boatMarker) {
				boatMarker = L.marker([boatLat, boatLon], { icon: buildBoatIcon(hdgDeg, counter), zIndexOffset: 100 }).addTo(map);
			} else {
				boatMarker.setLatLng([boatLat, boatLon]);
				boatMarker.setIcon(buildBoatIcon(hdgDeg, counter));
			}
		}

		// Anchor marker + radius circle
		if (cfg?.active && cfg.lat != null && cfg.lon != null) {
			if (!anchorMarker) {
				anchorMarker = L.marker([cfg.lat, cfg.lon], { icon: buildAnchorIcon(counter) }).addTo(map);
			} else {
				anchorMarker.setLatLng([cfg.lat, cfg.lon]);
				anchorMarker.setIcon(buildAnchorIcon(counter));
			}

			if (!radiusCircle) {
				radiusCircle = L.circle([cfg.lat, cfg.lon], {
					radius: cfg.radius_m,
					color: alarming ? '#ef4444' : '#00c8ff',
					fill: false,
					weight: 2,
					dashArray: '6 4'
				}).addTo(map);
			} else {
				radiusCircle.setLatLng([cfg.lat, cfg.lon]);
				radiusCircle.setRadius(cfg.radius_m);
				(radiusCircle.options as { color: string }).color = alarming ? '#ef4444' : '#00c8ff';
				radiusCircle.redraw();
			}

			// Auto-center on anchor with radius fitting
			const size = map.getSize();
			if (size.x > 80 && size.y > 80) {
				const bounds = L.latLngBounds(
					L.latLng(cfg.lat - cfg.radius_m / 111000, cfg.lon - cfg.radius_m / (111000 * Math.cos(cfg.lat * Math.PI / 180))),
					L.latLng(cfg.lat + cfg.radius_m / 111000, cfg.lon + cfg.radius_m / (111000 * Math.cos(cfg.lat * Math.PI / 180)))
				);
				const zoom = map.getBoundsZoom(bounds, false);
				map.setView([cfg.lat, cfg.lon], Math.min(zoom, 18), { animate: false });
			}
		} else {
			if (anchorMarker) { anchorMarker.remove(); anchorMarker = null; }
			if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }
		}

		// Breadcrumb polyline
		if (breadcrumb.length > 1) {
			if (!breadcrumbLine) {
				breadcrumbLine = L.polyline(breadcrumb, { color: '#00c8ff', weight: 1.5, opacity: 0.6 }).addTo(map);
			} else {
				breadcrumbLine.setLatLngs(breadcrumb);
			}
		}
	});

	onMount(async () => {
		L = await import('leaflet') as typeof import('leaflet');
		await import('leaflet/dist/leaflet.css');

		map = L.map(mapEl, {
			zoomControl: false,
			attributionControl: false,
			dragging: true,
			scrollWheelZoom: true
		});

		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

		if (boatLat && boatLon) map.setView([boatLat, boatLon], 15);
		else if (cfg?.lat && cfg.lon) map.setView([cfg.lat, cfg.lon], 15);
		else map.setView([54.0, 10.0], 10);

		mapReady = true;
	});

	onDestroy(() => {
		map?.remove();
	});
</script>

<svelte:head><title>Anker · SUKI PRO</title></svelte:head>

<!-- Full-screen alarm overlay -->
{#if alarming && !muteActive}
<div class="alarm-overlay">
	<div class="alarm-icon">⚓</div>
	<div class="alarm-title">ANKER-ALARM</div>
	<div class="alarm-dist">
		{anchorDist() != null ? anchorDist()!.toFixed(0) + ' m vom Ankerpunkt' : 'Position unbekannt'}
	</div>
	<button class="alarm-mute-btn" onclick={muteAlarm}>Stumm (30s)</button>
</div>
{/if}

<div class="anchor-page">
	<!-- Map -->
	<div class="map-box" class:alarming>
		<div class="map-wrapper" bind:this={mapContainerEl}>
			<div bind:this={mapEl} class="map-inner"></div>
		</div>

		<!-- North pill -->
		<div class="north-pill" style="transform: rotate({hdgDeg}deg) translateY(-38px) rotate(-{hdgDeg}deg)">N</div>

		<!-- Wind arrow overlay -->
		{#if awaDeg != null}
		<div
			class="wind-arrow"
			style="transform: rotate({hdgDeg + awaDeg}deg)"
			title="AWA {awaDeg?.toFixed(0)}°"
		>
			<div class="wind-shaft"></div>
			<div class="wind-head"></div>
			{#if awsKn != null}
			<div class="wind-label" style="transform: rotate(-{hdgDeg + awaDeg}deg)">
				{awsKn.toFixed(1)} kn
			</div>
			{/if}
		</div>
		{/if}
	</div>

	<!-- Data cells -->
	<div class="data-cells">
		<div class="cell">
			<div class="cell-label">TIEFE</div>
			<div class="cell-val">{depth}</div>
		</div>
		<div class="cell">
			<div class="cell-label">KETTE</div>
			<div class="cell-val">{chainM} m</div>
		</div>
		<div class="cell">
			<div class="cell-label">SCOPE</div>
			<div class="cell-val">{scopeM()}</div>
		</div>
		<div class="cell">
			<div class="cell-label">KURS</div>
			<div class="cell-val">{bearingCardinal(bearingToAnchor())} {bearingToAnchor() != null ? bearingToAnchor()!.toFixed(0) + '°' : '—'}</div>
		</div>
	</div>

	<!-- Control buttons -->
	<div class="ctrl-buttons">
		{#if !cfg?.active}
			<button class="ctrl-btn primary" onclick={setAnchor} disabled={!boatLat}>⚓ Anker setzen</button>
		{:else}
			<button class="ctrl-btn danger" onclick={clearAnchor}>Anker lichten</button>
		{/if}
		{#if alarming}
			<button class="ctrl-btn warning" onclick={muteAlarm}>Stumm</button>
		{/if}
		<button class="ctrl-btn ghost" onclick={() => { showSettings = !showSettings; }}>⚙ Config</button>
	</div>

	<!-- Sliders (shown when showSettings or always) -->
	<div class="sliders-section">
		<div class="slider-row">
			<div class="slider-label">Kettenlänge <span class="slider-val">{chainM} m</span></div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => updateConfig({ chain_length_m: Math.max(5, chainM - 5) })}>−</button>
				<input
					type="range" min="5" max="120" step="5"
					value={chainM}
					oninput={(e) => updateConfig({ chain_length_m: parseInt((e.target as HTMLInputElement).value) })}
				/>
				<button class="step-btn" onclick={() => updateConfig({ chain_length_m: Math.min(120, chainM + 5) })}>+</button>
			</div>
		</div>

		<div class="slider-row">
			<div class="slider-label">Radius <span class="slider-val">{radiusM} m</span></div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => updateConfig({ radius_m: Math.max(10, radiusM - 10) })}>−</button>
				<input
					type="range" min="10" max="500" step="10"
					value={radiusM}
					oninput={(e) => updateConfig({ radius_m: parseInt((e.target as HTMLInputElement).value) })}
				/>
				<button class="step-btn" onclick={() => updateConfig({ radius_m: Math.min(500, radiusM + 10) })}>+</button>
			</div>
		</div>

		<div class="slider-row">
			<div class="slider-label">
				Peilung <span class="slider-val">{bearingDeg.toFixed(0)}° {bearingCardinal(bearingDeg)}</span>
				{#if bearingManual}<span class="manual-badge">manuell</span>{/if}
			</div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => { bearingManual = true; updateConfig({ bearing_deg: ((bearingDeg - 10 + 360) % 360) }); }}>−</button>
				<input
					type="range" min="0" max="359" step="1"
					value={bearingDeg}
					oninput={(e) => { bearingManual = true; updateConfig({ bearing_deg: parseInt((e.target as HTMLInputElement).value) }); }}
				/>
				<button class="step-btn" onclick={() => { bearingManual = true; updateConfig({ bearing_deg: ((bearingDeg + 10) % 360) }); }}>+</button>
			</div>
			{#if bearingManual}
			<button class="reset-bearing" onclick={() => { bearingManual = false; }}>↺ Auto (Kurs)</button>
			{/if}
		</div>
	</div>
</div>

<style>
	/* ── Alarm overlay ── */
	.alarm-overlay {
		position: fixed;
		inset: 0;
		z-index: 9999;
		background: rgba(120, 0, 0, 0.92);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		animation: alarm-pulse 1s ease-in-out infinite alternate;
	}
	@keyframes alarm-pulse {
		from { background: rgba(120, 0, 0, 0.92); }
		to   { background: rgba(200, 0, 0, 0.97); }
	}
	.alarm-icon { font-size: 64px; }
	.alarm-title { font-size: 32px; font-weight: 900; color: #fff; letter-spacing: 4px; }
	.alarm-dist { font-size: 16px; color: #ffcccc; }
	.alarm-mute-btn {
		margin-top: 16px;
		padding: 12px 32px;
		background: rgba(255,255,255,0.15);
		border: 2px solid #fff;
		border-radius: 8px;
		color: #fff;
		font-size: 16px;
		font-weight: 600;
		cursor: pointer;
	}

	/* ── Page layout ── */
	.anchor-page {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* ── Map ── */
	.map-box {
		position: relative;
		border-radius: var(--r);
		overflow: hidden;
		/* 4:3 aspect ratio */
		aspect-ratio: 4 / 3;
		border: 1px solid var(--border);
		background: #111;
	}
	.map-box.alarming { border-color: var(--red); }

	.map-wrapper {
		position: absolute;
		inset: -30%;
		transition: transform 0.5s ease-out;
	}

	.map-inner {
		width: 100%;
		height: 100%;
	}

	/* North pill */
	.north-pill {
		position: absolute;
		top: 50%;
		left: 50%;
		margin-left: -12px;
		margin-top: -50px;
		background: rgba(0,0,0,0.7);
		color: var(--accent);
		font-size: 11px;
		font-weight: 700;
		padding: 2px 6px;
		border-radius: 10px;
		border: 1px solid var(--accent);
		pointer-events: none;
		z-index: 500;
		letter-spacing: 1px;
		transform-origin: 12px 50px;
	}

	/* Wind arrow */
	.wind-arrow {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 2px;
		height: 50px;
		margin-left: -1px;
		margin-top: -50px;
		transform-origin: bottom center;
		z-index: 501;
		pointer-events: none;
	}
	.wind-shaft {
		width: 2px;
		height: 40px;
		background: var(--amber);
		margin: 0 auto;
	}
	.wind-head {
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
		bottom: -18px;
		left: 50%;
		transform: translateX(-50%);
		font-size: 9px;
		color: var(--amber);
		white-space: nowrap;
		background: rgba(0,0,0,0.7);
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
	.cell-label {
		font-size: 8px;
		color: var(--muted);
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}
	.cell-val {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	/* ── Control buttons ── */
	.ctrl-buttons {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.ctrl-btn {
		flex: 1;
		min-width: 80px;
		padding: 10px 8px;
		border-radius: 8px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: none;
		transition: opacity 0.15s;
	}
	.ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.ctrl-btn.primary  { background: var(--accent); color: #000; }
	.ctrl-btn.danger   { background: #7f1d1d; color: var(--red); border: 1px solid var(--red); }
	.ctrl-btn.warning  { background: #78350f; color: var(--amber); border: 1px solid var(--amber); }
	.ctrl-btn.ghost    { background: var(--card2); color: var(--muted); border: 1px solid var(--border); }

	/* ── Sliders ── */
	.sliders-section {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--r);
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.slider-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.slider-label {
		font-size: 12px;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.slider-val {
		color: var(--text);
		font-weight: 600;
	}
	.manual-badge {
		font-size: 10px;
		color: var(--amber);
		border: 1px solid var(--amber);
		border-radius: 3px;
		padding: 1px 5px;
	}

	.slider-controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}

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
		transition: border-color 0.15s;
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

	.reset-bearing {
		background: none;
		border: none;
		color: var(--accent);
		font-size: 11px;
		cursor: pointer;
		padding: 0;
		text-align: left;
	}
</style>
