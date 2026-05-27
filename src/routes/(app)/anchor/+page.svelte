<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { haversine, destinationPoint, bearingTo } from '$lib/utils/geo.js';
	import { rad2deg, fmtDepth, ms2kn, bearingCardinal } from '$lib/utils/units.js';

	// ── DOM refs ──────────────────────────────────────────────────────────────
	let mapBoxEl: HTMLDivElement;      // visible clipping box (overflow:hidden)
	let mapWrapEl: HTMLDivElement;     // rotated heading-up wrapper
	let mapInnerEl: HTMLDivElement;    // Leaflet mounts here

	// ── Leaflet state (plain vars — not reactive) ─────────────────────────────
	let L: typeof import('leaflet') | null = null;
	let map: any = null;
	let boatMarker: any = null;
	let ancMarker: any = null;
	let radiusCircle: any = null;
	let crumbLine: any = null;

	// ── Reactive state ────────────────────────────────────────────────────────
	let mapReady    = $state(false);
	let followMode  = $state(true);
	let muteActive  = $state(false);
	let cfgLoaded   = $state(false);
	let breadcrumb  = $state<[number, number][]>([]);

	// Local slider copies — saved to Supabase only on release / step-click
	let localChain   = $state(30);
	let localRadius  = $state(50);
	let localBearing = $state(0);
	let bearingManual = $state(false);

	// ── Derived values ────────────────────────────────────────────────────────
	const t   = $derived($telemetry);
	const cfg = $derived($anchorConfig);

	const boatLat  = $derived(t?.nav_lat  ?? null);
	const boatLon  = $derived(t?.nav_lon  ?? null);
	const hdgDeg   = $derived(rad2deg(t?.nav_hdg_rad ?? null) ?? 0);
	const awaDeg   = $derived(rad2deg(t?.env_awa_rad ?? null));
	const awsKn    = $derived(t?.env_aws_ms != null ? parseFloat(ms2kn(t.env_aws_ms)) : null);
	const depth    = $derived(fmtDepth(t?.env_depth_m ?? null));
	const alarming = $derived(cfg?.alarming ?? false);

	const ancDistM = $derived(
		cfg?.lat != null && cfg?.lon != null && boatLat != null && boatLon != null
			? haversine(boatLat, boatLon, cfg.lat, cfg.lon)
			: null
	);
	const ancBearingDeg = $derived(
		cfg?.lat != null && cfg?.lon != null && boatLat != null && boatLon != null
			? bearingTo(boatLat, boatLon, cfg.lat, cfg.lon)
			: null
	);

	// N pill position — JS-computed so it orbits to show North on heading-up map.
	// In the (north-up) map-box screen space, north appears at:
	//   x = cx - r·sin(hdg),  y = cy - r·cos(hdg)   (r in %)
	const PILL_R = 32; // % of map dimensions
	const pillX = $derived(50 - PILL_R * Math.sin(hdgDeg * Math.PI / 180));
	const pillY = $derived(50 - PILL_R * Math.cos(hdgDeg * Math.PI / 180));

	// Wind arrow rotation in screen space: hdgDeg + awaDeg → points at AWA from bow
	const windRot = $derived(awaDeg != null ? hdgDeg + awaDeg : null);

	// ── Init local sliders once when cfg first arrives ────────────────────────
	$effect(() => {
		if (cfg && !cfgLoaded) {
			localChain   = cfg.chain_length_m;
			localRadius  = cfg.radius_m;
			localBearing = cfg.bearing_deg;
			cfgLoaded = true;
		}
	});

	// ── Breadcrumb ────────────────────────────────────────────────────────────
	$effect(() => {
		if (boatLat != null && boatLon != null) {
			const last = breadcrumb.at(-1);
			if (!last || last[0] !== boatLat || last[1] !== boatLon) {
				breadcrumb = [...breadcrumb.slice(-99), [boatLat, boatLon]];
			}
		}
	});

	// ── Map rotation (reads only hdgDeg) ──────────────────────────────────────
	$effect(() => {
		if (mapWrapEl) {
			mapWrapEl.style.transform = `rotate(${-hdgDeg}deg)`;
		}
	});

	// ── Leaflet marker / layer updates (reads boat + anchor state) ────────────
	$effect(() => {
		if (!mapReady) return;
		// explicit reads so Svelte tracks these as deps:
		const bl = boatLat, blo = boatLon, hd = hdgDeg;
		const cl = cfg, al = alarming, bc = breadcrumb;
		updateMarkers(bl, blo, hd, cl, al, bc);
	});

	function updateMarkers(
		bl: number | null, blo: number | null, hd: number,
		cl: typeof cfg, al: boolean, bc: [number, number][]
	) {
		if (!map || !L) return;

		// Boat marker
		if (bl != null && blo != null) {
			const icon = L.divIcon({
				className: '',
				iconSize: [32, 32], iconAnchor: [16, 16],
				html: `<div style="width:32px;height:32px;transform:rotate(${hd}deg);display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1">⛵</div>`
			});
			if (!boatMarker) {
				boatMarker = L.marker([bl, blo], { icon, zIndexOffset: 100 }).addTo(map);
			} else {
				boatMarker.setLatLng([bl, blo]);
				boatMarker.setIcon(icon);
			}
			if (followMode) map.panTo([bl, blo], { animate: true, duration: 0.3 });
		}

		// Anchor marker + radius circle
		if (cl?.active && cl.lat != null && cl.lon != null) {
			const aIcon = L.divIcon({
				className: '',
				iconSize: [20, 20], iconAnchor: [10, 10],
				html: `<div style="width:20px;height:20px;transform:rotate(${hd}deg);display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1">⚓</div>`
			});
			if (!ancMarker) {
				ancMarker = L.marker([cl.lat, cl.lon], { icon: aIcon }).addTo(map);
			} else {
				ancMarker.setLatLng([cl.lat, cl.lon]);
				ancMarker.setIcon(aIcon);
			}

			const col = al ? '#ef4444' : '#00c8ff';
			if (!radiusCircle) {
				radiusCircle = L.circle([cl.lat, cl.lon], {
					radius: cl.radius_m, color: col, fill: true,
					fillColor: col, fillOpacity: 0.04,
					weight: 2, dashArray: '6 4'
				}).addTo(map);
			} else {
				radiusCircle.setLatLng([cl.lat, cl.lon]);
				radiusCircle.setRadius(cl.radius_m);
				(radiusCircle.options as any).color = col;
				(radiusCircle.options as any).fillColor = col;
				radiusCircle.redraw();
			}
		} else {
			ancMarker?.remove();   ancMarker   = null;
			radiusCircle?.remove(); radiusCircle = null;
		}

		// Breadcrumb polyline
		if (bc.length > 1) {
			if (!crumbLine) {
				crumbLine = L.polyline(bc, { color: '#00c8ff', weight: 1.5, opacity: 0.55 }).addTo(map);
			} else {
				crumbLine.setLatLngs(bc);
			}
		}
	}

	// ── Supabase helpers ──────────────────────────────────────────────────────
	async function saveConfig(patch: Record<string, unknown>) {
		const { data } = await supabase
			.from('anchor_config').update(patch).eq('id', 1).select().single();
		if (data) anchorConfig.set(data);
	}

	async function setAnchor() {
		if (!boatLat || !boatLon) return;
		const [ancLat, ancLon] = destinationPoint(boatLat, boatLon, localBearing, localChain);
		await saveConfig({
			lat: ancLat, lon: ancLon, active: true, alarming: false,
			chain_length_m: localChain, radius_m: localRadius, bearing_deg: localBearing
		});
		// Center map on anchor after setting
		if (map) map.setView([ancLat, ancLon], Math.max(map.getZoom(), 16));
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

	function jumpToBoat() {
		followMode = true;
		if (map && boatLat != null && boatLon != null) {
			map.setView([boatLat, boatLon], map.getZoom(), { animate: true });
		}
	}

	// ── Leaflet init ──────────────────────────────────────────────────────────
	onMount(async () => {
		// Wait for layout so mapInnerEl has real pixel dimensions
		await new Promise(r => requestAnimationFrame(r));
		await new Promise(r => requestAnimationFrame(r));

		L = await import('leaflet') as typeof import('leaflet');
		await import('leaflet/dist/leaflet.css');

		map = L.map(mapInnerEl, {
			zoomControl: false,
			attributionControl: false,
			dragging: true,
			scrollWheelZoom: true
		});

		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19,
			attribution: '© OpenStreetMap'
		}).addTo(map);

		// Disable follow when user drags manually
		map.on('dragstart', () => { followMode = false; });

		const lat = boatLat ?? cfg?.lat ?? 54.0;
		const lon = boatLon ?? cfg?.lon ?? 10.0;
		map.setView([lat, lon], 15);

		// Ensure map knows its container size
		await new Promise(r => setTimeout(r, 100));
		map.invalidateSize();

		mapReady = true;
	});

	onDestroy(() => { map?.remove(); });
</script>

<svelte:head><title>Anker · SUKI PRO</title></svelte:head>

<!-- ── Full-screen alarm overlay ── -->
{#if alarming && !muteActive}
<div class="alarm-overlay">
	<div class="alarm-icon">⚓</div>
	<div class="alarm-title">ANKER-ALARM</div>
	<div class="alarm-dist">
		{ancDistM != null ? ancDistM.toFixed(0) + ' m vom Ankerpunkt' : 'Position unbekannt'}
	</div>
	<button class="alarm-mute-btn" onclick={muteAlarm}>Stumm (30s)</button>
</div>
{/if}

<div class="anchor-page">

	<!-- ── Map ── -->
	<div class="map-box" class:alarming bind:this={mapBoxEl}>

		<!-- Heading-up rotating wrapper — extends past the box to avoid white corners -->
		<div class="map-wrap" bind:this={mapWrapEl}>
			<div bind:this={mapInnerEl} class="map-inner"></div>
		</div>

		<!-- N pill: JS-computed position, always points to North on the heading-up map -->
		<div
			class="north-pill"
			style="left:{pillX}%;top:{pillY}%"
		>N</div>

		<!-- Wind arrow: points in AWA direction from bow (heading-up frame) -->
		{#if windRot != null}
		<div class="wind-arrow" style="transform:rotate({windRot}deg)">
			<div class="wind-shaft"></div>
			<div class="wind-head"></div>
			{#if awsKn != null}
			<div class="wind-label" style="transform:rotate({-windRot}deg)">
				{awsKn.toFixed(1)} kn
			</div>
			{/if}
		</div>
		{/if}

		<!-- Map control buttons (zoom + follow) -->
		<div class="map-btns">
			<button class="map-btn" title="Zoom in"  onclick={() => map?.zoomIn()}>+</button>
			<button class="map-btn" title="Zoom out" onclick={() => map?.zoomOut()}>−</button>
			<button class="map-btn follow-btn" class:active={followMode}
				title="Zum Boot springen" onclick={jumpToBoat}>⊕</button>
		</div>

		{#if !mapReady}
		<div class="map-loading">Karte lädt…</div>
		{/if}
	</div>

	<!-- ── Data cells ── -->
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
			<div class="cell-val">{ancDistM != null ? ancDistM.toFixed(0) + ' m' : '—'}</div>
		</div>
		<div class="cell">
			<div class="cell-label">KURS</div>
			<div class="cell-val">
				{ancBearingDeg != null
					? bearingCardinal(ancBearingDeg) + ' ' + ancBearingDeg.toFixed(0) + '°'
					: '—'}
			</div>
		</div>
	</div>

	<!-- ── Control buttons ── -->
	<div class="ctrl-row">
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

	<!-- ── Sliders ── -->
	<div class="sliders">

		<div class="srow">
			<div class="slabel">Kettenlänge <span class="sval">{localChain} m</span></div>
			<div class="sctrl">
				<button class="sbtn" onclick={() => { localChain = Math.max(5, localChain - 5); saveConfig({ chain_length_m: localChain }); }}>−</button>
				<input type="range" min="5" max="120" step="5" value={localChain}
					oninput={(e) => { localChain = +( e.target as HTMLInputElement).value; }}
					onchange={() => saveConfig({ chain_length_m: localChain })} />
				<button class="sbtn" onclick={() => { localChain = Math.min(120, localChain + 5); saveConfig({ chain_length_m: localChain }); }}>+</button>
			</div>
		</div>

		<div class="srow">
			<div class="slabel">Radius <span class="sval">{localRadius} m</span></div>
			<div class="sctrl">
				<button class="sbtn" onclick={() => { localRadius = Math.max(10, localRadius - 10); saveConfig({ radius_m: localRadius }); }}>−</button>
				<input type="range" min="10" max="500" step="10" value={localRadius}
					oninput={(e) => { localRadius = +(e.target as HTMLInputElement).value; }}
					onchange={() => saveConfig({ radius_m: localRadius })} />
				<button class="sbtn" onclick={() => { localRadius = Math.min(500, localRadius + 10); saveConfig({ radius_m: localRadius }); }}>+</button>
			</div>
		</div>

		<div class="srow">
			<div class="slabel">
				Peilung <span class="sval">{localBearing.toFixed(0)}° {bearingCardinal(localBearing)}</span>
				{#if bearingManual}
					<button class="reset-btn" onclick={snapBearingToHeading}>↑ Kurs</button>
				{:else}
					<span class="auto-badge">auto</span>
				{/if}
			</div>
			<div class="sctrl">
				<button class="sbtn" onclick={() => { localBearing = ((localBearing - 10 + 360) % 360); bearingManual = true; saveConfig({ bearing_deg: localBearing }); }}>−</button>
				<input type="range" min="0" max="359" step="1" value={localBearing}
					oninput={(e) => { localBearing = +(e.target as HTMLInputElement).value; bearingManual = true; }}
					onchange={() => saveConfig({ bearing_deg: localBearing })} />
				<button class="sbtn" onclick={() => { localBearing = ((localBearing + 10) % 360); bearingManual = true; saveConfig({ bearing_deg: localBearing }); }}>+</button>
			</div>
		</div>

	</div>
</div>

<style>
	/* ── Alarm overlay ── */
	.alarm-overlay {
		position: fixed; inset: 0; z-index: 9999;
		display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
		background: rgba(120,0,0,0.93);
		animation: apulse 1s ease-in-out infinite alternate;
	}
	@keyframes apulse {
		from { background: rgba(120,0,0,0.93); }
		to   { background: rgba(200,0,0,0.97); }
	}
	.alarm-icon  { font-size: 64px; }
	.alarm-title { font-size: 32px; font-weight: 900; color: #fff; letter-spacing: 4px; }
	.alarm-dist  { font-size: 16px; color: #ffcccc; }
	.alarm-mute-btn {
		margin-top: 12px; padding: 12px 32px;
		background: rgba(255,255,255,0.15); border: 2px solid #fff;
		border-radius: 8px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;
	}

	/* ── Page ── */
	.anchor-page { display: flex; flex-direction: column; gap: 10px; }

	/* ── Map container ── */
	.map-box {
		position: relative;
		aspect-ratio: 4 / 3;
		border-radius: var(--r);
		overflow: hidden;
		border: 1px solid var(--border);
		background: #111;
	}
	.map-box.alarming { border-color: var(--red); }

	/* Extends past box edges so rotation doesn't expose corners.
	   -25% on each side → content is 150% × 150% of the visible box.
	   Covers rotations up to ~45° without white corners. */
	.map-wrap {
		position: absolute;
		inset: -25%;
		transition: transform 0.35s ease-out;
	}
	.map-inner { width: 100%; height: 100%; }

	/* ── N pill ── */
	.north-pill {
		position: absolute;
		transform: translate(-50%, -50%);
		background: rgba(0,0,0,0.78);
		color: var(--accent);
		font-size: 11px;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 10px;
		border: 1px solid var(--accent);
		pointer-events: none;
		z-index: 500;
		letter-spacing: 1px;
		white-space: nowrap;
	}

	/* ── Wind arrow ── */
	.wind-arrow {
		position: absolute;
		top: 50%; left: 50%;
		width: 2px; height: 48px;
		margin-left: -1px; margin-top: -48px;
		transform-origin: bottom center;
		pointer-events: none;
		z-index: 501;
	}
	.wind-shaft {
		width: 2px; height: 36px;
		background: var(--amber);
		margin: 0 auto;
	}
	.wind-head {
		width: 0; height: 0;
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-bottom: 10px solid var(--amber);
		margin: 0 auto;
		transform: translateX(-4px);
	}
	.wind-label {
		position: absolute;
		bottom: -20px; left: 50%;
		transform: translateX(-50%);
		font-size: 9px; color: var(--amber);
		white-space: nowrap;
		background: rgba(0,0,0,0.78);
		padding: 1px 4px; border-radius: 3px;
	}

	/* ── Map control buttons ── */
	.map-btns {
		position: absolute;
		right: 10px; bottom: 10px;
		z-index: 600;
		display: flex; flex-direction: column; gap: 4px;
	}
	.map-btn {
		width: 36px; height: 36px;
		background: rgba(13,13,13,0.88);
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--text);
		font-size: 18px; font-weight: 400;
		cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: border-color 0.15s;
		backdrop-filter: blur(4px);
	}
	.map-btn:active, .map-btn:hover { border-color: var(--accent); color: var(--accent); }
	.follow-btn { font-size: 14px; }
	.follow-btn.active { border-color: var(--green); color: var(--green); }

	/* Loading placeholder */
	.map-loading {
		position: absolute; inset: 0; z-index: 400;
		display: flex; align-items: center; justify-content: center;
		font-size: 13px; color: var(--muted);
		background: #111;
	}

	/* ── Data cells ── */
	.data-cells {
		display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
	}
	.cell {
		background: var(--card); border: 1px solid var(--border);
		border-radius: 8px; padding: 8px 4px;
		display: flex; flex-direction: column; align-items: center; gap: 3px;
	}
	.cell-label { font-size: 8px; color: var(--muted); letter-spacing: 0.5px; }
	.cell-val   { font-size: 12px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; }

	/* ── Control buttons ── */
	.ctrl-row { display: flex; gap: 8px; }
	.ctrl-btn {
		flex: 1; padding: 10px 8px; border-radius: 8px;
		font-size: 13px; font-weight: 600; cursor: pointer; border: none;
		transition: opacity 0.15s;
	}
	.ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.ctrl-btn.primary { background: var(--accent); color: #000; }
	.ctrl-btn.danger  { background: #7f1d1d; color: var(--red);   border: 1px solid var(--red); }
	.ctrl-btn.warning { background: #78350f; color: var(--amber); border: 1px solid var(--amber); }

	/* ── Sliders ── */
	.sliders {
		background: var(--card); border: 1px solid var(--border);
		border-radius: var(--r); padding: 12px;
		display: flex; flex-direction: column; gap: 14px;
	}
	.srow   { display: flex; flex-direction: column; gap: 6px; }
	.slabel { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px; }
	.sval   { font-size: 12px; font-weight: 600; color: var(--text); }
	.sctrl  { display: flex; align-items: center; gap: 8px; }
	.sbtn {
		width: 40px; height: 40px;
		background: var(--card2); border: 1px solid var(--border);
		border-radius: 8px; color: var(--text);
		font-size: 20px; font-weight: 300; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.sbtn:active { border-color: var(--accent); color: var(--accent); }
	.auto-badge {
		font-size: 9px; color: var(--green);
		border: 1px solid var(--green); border-radius: 3px; padding: 1px 5px;
	}
	.reset-btn {
		font-size: 10px; color: var(--accent);
		background: none; border: 1px solid var(--accent);
		border-radius: 4px; padding: 1px 6px; cursor: pointer;
	}

	input[type="range"] {
		flex: 1; -webkit-appearance: none; appearance: none;
		height: 4px; background: var(--border); border-radius: 2px; outline: none;
	}
	input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none; appearance: none;
		width: 26px; height: 26px; border-radius: 50%;
		background: var(--accent); cursor: pointer;
		border: 3px solid var(--bg); box-shadow: 0 0 0 2px var(--accent);
	}
</style>
