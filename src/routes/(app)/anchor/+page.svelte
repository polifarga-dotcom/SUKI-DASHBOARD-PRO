<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { haversine, destinationPoint, bearingTo } from '$lib/utils/geo.js';
	import { rad2deg, fmtDepth, ms2kn, bearingCardinal } from '$lib/utils/units.js';

	// ── DOM refs ──────────────────────────────────────────────────────────────
	let mapBoxEl:   HTMLDivElement;   // outer box (overflow:hidden)
	let mapWrapEl:  HTMLDivElement;   // rotating heading-up wrapper
	let mapInnerEl: HTMLDivElement;   // Leaflet target

	// ── Leaflet (plain vars, not reactive) ────────────────────────────────────
	let L:          any = null;
	let map:        any = null;
	let boatMarker: any = null;
	let ancMarker:  any = null;
	let radiusCircle: any = null;
	let chainCircle:  any = null;
	let chainLine:    any = null;
	let crumbLine:    any = null;

	// ── Reactive UI state ─────────────────────────────────────────────────────
	let mapReady     = $state(false);
	let followMode   = $state(true);
	let muteActive   = $state(false);
	let cfgLoaded    = $state(false);
	let breadcrumb   = $state<[number, number][]>([]);

	// Map box pixel dimensions for overlay positioning
	let mapBoxW = $state(360);
	let mapBoxH = $state(270);

	// Local slider copies — only saved to Supabase on release / step-click
	let localChain    = $state(30);
	let localRadius   = $state(50);
	let localBearing  = $state(0);
	let bearingManual = $state(false);

	// ── Derived boat/anchor values ────────────────────────────────────────────
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
			? haversine(boatLat, boatLon, cfg.lat, cfg.lon) : null
	);
	const ancBearingDeg = $derived(
		cfg?.lat != null && cfg?.lon != null && boatLat != null && boatLon != null
			? bearingTo(boatLat, boatLon, cfg.lat, cfg.lon) : null
	);

	// ── Overlay pixel positions (orbit ring like old app) ─────────────────────
	// Formula from old app: left = cx + sin(a)*r,  top = cy - cos(a)*r
	// N pill: a = hdgDeg (heading direction marks north on heading-up map)
	// AWA marker: a = awaDeg (from bow = from top in heading-up map)
	const overlayR = $derived(Math.min(mapBoxW / 2, mapBoxH / 2) * 0.72 - 14);
	const nPillPx  = $derived({
		x: mapBoxW / 2 + overlayR * Math.sin(hdgDeg  * Math.PI / 180),
		y: mapBoxH / 2 - overlayR * Math.cos(hdgDeg  * Math.PI / 180),
	});
	const awaPx = $derived(awaDeg != null ? {
		x: mapBoxW / 2 + overlayR * Math.sin(awaDeg * Math.PI / 180),
		y: mapBoxH / 2 - overlayR * Math.cos(awaDeg * Math.PI / 180),
	} : null);

	// ── Init local sliders once when cfg first arrives ────────────────────────
	$effect(() => {
		if (cfg && !cfgLoaded) {
			localChain   = cfg.chain_length_m;
			localRadius  = cfg.radius_m;
			localBearing = cfg.bearing_deg;
			cfgLoaded = true;
		}
	});

	// ── Breadcrumb (skip duplicate points) ───────────────────────────────────
	$effect(() => {
		if (boatLat != null && boatLon != null) {
			const last = breadcrumb.at(-1);
			if (!last || Math.abs(last[0] - boatLat) > 0.000001 || Math.abs(last[1] - boatLon) > 0.000001)
				breadcrumb = [...breadcrumb.slice(-199), [boatLat, boatLon]];
		}
	});

	// ── Map wrapper rotation (heading-up) ─────────────────────────────────────
	$effect(() => {
		if (mapWrapEl) mapWrapEl.style.transform = `rotate(${-hdgDeg}deg)`;
	});

	// ── Leaflet marker / layer updates ────────────────────────────────────────
	$effect(() => {
		if (!mapReady) return;
		// explicit reads so Svelte tracks deps:
		const _deps = [boatLat, boatLon, hdgDeg, cfg, alarming, breadcrumb, localChain, localRadius];
		updateMarkers();
	});

	function boatIconHtml(rot: number) {
		// Vesper-Cortex-style vessel: pointed bow, cyan fill — from old app
		return `<div style="width:30px;height:34px;transform:rotate(${rot}deg);transform-origin:50% 50%;transition:transform .25s linear;">
			<svg viewBox="0 0 32 36" width="30" height="34" style="overflow:visible;filter:drop-shadow(0 1px 3px rgba(0,0,0,.7));">
				<path d="M16 2 L26 16 L26 32 L6 32 L6 16 Z" fill="#00c8ff" stroke="#0a1929" stroke-width="1.5" stroke-linejoin="round"/>
				<line x1="16" y1="6" x2="16" y2="22" stroke="#0a1929" stroke-width="1.5" stroke-linecap="round"/>
				<circle cx="16" cy="2" r="1.6" fill="#ffffff" stroke="#0a1929" stroke-width="1"/>
			</svg>
		</div>`;
	}

	function anchorIconHtml(rot: number) {
		// Amber teardrop pin with anchor symbol — from old app
		return `<div style="width:24px;height:30px;transform:rotate(${rot}deg);transform-origin:50% 100%;transition:transform .25s linear;">
			<svg viewBox="0 0 32 40" width="24" height="30" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))">
				<path d="M16 0 C7 0 0 7 0 16 c0 11 16 24 16 24 s16-13 16-24 C32 7 25 0 16 0 z" fill="#f59e0b" stroke="#0a1929" stroke-width="1.5"/>
				<g transform="translate(16,15)" stroke="#0a1929" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="0" cy="-7" r="2.2"/>
					<line x1="0" y1="-5" x2="0" y2="9"/>
					<line x1="-4" y1="-1" x2="4" y2="-1"/>
					<path d="M-6 5 a6 6 0 0 0 12 0"/>
				</g>
			</svg>
		</div>`;
	}

	function updateMarkers() {
		if (!map || !L) return;
		const rot = hdgDeg; // counter-rotation for markers to stay upright

		// ── Boat marker ──
		if (boatLat != null && boatLon != null) {
			const icon = L.divIcon({ className: '', iconSize: [30, 34], iconAnchor: [15, 17], html: boatIconHtml(rot) });
			if (!boatMarker) {
				boatMarker = L.marker([boatLat, boatLon], { icon, zIndexOffset: 100 }).addTo(map);
			} else {
				boatMarker.setLatLng([boatLat, boatLon]);
				boatMarker.setIcon(icon);
			}
			if (followMode) map.panTo([boatLat, boatLon], { animate: true, duration: 0.3 });
		}

		// ── Anchor marker, chain circle, chain line, alarm radius ──
		if (cfg?.active && cfg.lat != null && cfg.lon != null) {
			const aIcon = L.divIcon({ className: '', iconSize: [24, 30], iconAnchor: [12, 30], html: anchorIconHtml(rot) });
			if (!ancMarker) {
				ancMarker = L.marker([cfg.lat, cfg.lon], { icon: aIcon }).addTo(map);
			} else {
				ancMarker.setLatLng([cfg.lat, cfg.lon]);
				ancMarker.setIcon(aIcon);
			}

			// Chain length circle (how far the anchor can swing)
			const chainR = cfg.chain_length_m;
			if (!chainCircle) {
				chainCircle = L.circle([cfg.lat, cfg.lon], {
					radius: chainR, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.05,
					weight: 1.5, dashArray: '3,4', interactive: false
				}).addTo(map);
			} else {
				chainCircle.setLatLng([cfg.lat, cfg.lon]);
				chainCircle.setRadius(chainR);
			}

			// Chain line: boat → anchor (visual rope)
			if (boatLat != null && boatLon != null) {
				const pts: [number, number][] = [[boatLat, boatLon], [cfg.lat, cfg.lon]];
				if (!chainLine) {
					chainLine = L.polyline(pts, {
						color: '#00c8ff', weight: 2, dashArray: '4,4', opacity: 0.85, interactive: false
					}).addTo(map);
				} else {
					chainLine.setLatLngs(pts);
				}
			}

			// Alarm radius circle
			const col = alarming ? '#ef4444' : '#00c8ff';
			if (!radiusCircle) {
				radiusCircle = L.circle([cfg.lat, cfg.lon], {
					radius: cfg.radius_m, color: col, fillColor: col, fillOpacity: 0.04,
					weight: 2, dashArray: '6 4', interactive: false
				}).addTo(map);
			} else {
				radiusCircle.setLatLng([cfg.lat, cfg.lon]);
				radiusCircle.setRadius(cfg.radius_m);
				(radiusCircle.options as any).color = col;
				(radiusCircle.options as any).fillColor = col;
				radiusCircle.redraw();
			}
		} else {
			ancMarker?.remove();    ancMarker    = null;
			chainCircle?.remove();  chainCircle  = null;
			chainLine?.remove();    chainLine    = null;
			radiusCircle?.remove(); radiusCircle = null;
		}

		// ── Breadcrumb polyline ──
		if (breadcrumb.length > 1) {
			if (!crumbLine) {
				crumbLine = L.polyline(breadcrumb, { color: '#00c8ff', weight: 1.5, opacity: 0.5 }).addTo(map);
			} else {
				crumbLine.setLatLngs(breadcrumb);
			}
		}
	}

	// ── Supabase helpers ──────────────────────────────────────────────────────
	async function saveConfig(patch: Record<string, unknown>) {
		const { data } = await supabase.from('anchor_config').update(patch).eq('id', 1).select().single();
		if (data) anchorConfig.set(data);
	}

	async function setAnchor() {
		if (!boatLat || !boatLon) return;
		const [ancLat, ancLon] = destinationPoint(boatLat, boatLon, localBearing, localChain);
		await saveConfig({
			lat: ancLat, lon: ancLon, active: true, alarming: false,
			chain_length_m: localChain, radius_m: localRadius, bearing_deg: localBearing
		});
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
		if (map && boatLat != null && boatLon != null)
			map.setView([boatLat, boatLon], map.getZoom(), { animate: true });
	}

	// ── Leaflet init ──────────────────────────────────────────────────────────
	onMount(async () => {
		// Load recent track from history (last 2h, max 200 points)
		supabase
			.from('telemetry_history')
			.select('nav_lat,nav_lon,recorded_at')
			.not('nav_lat', 'is', null)
			.not('nav_lon', 'is', null)
			.gte('recorded_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
			.order('recorded_at', { ascending: true })
			.limit(200)
			.then(({ data }) => {
				if (data && data.length > 1) {
					breadcrumb = data.map(r => [r.nav_lat, r.nav_lon] as [number, number]);
				}
			});

		await new Promise(r => requestAnimationFrame(r));
		await new Promise(r => requestAnimationFrame(r));

		// Capture actual box dimensions for overlay positioning
		const rect = mapBoxEl.getBoundingClientRect();
		if (rect.width > 0) { mapBoxW = rect.width; mapBoxH = rect.height; }

		L = await import('leaflet') as typeof import('leaflet');
		await import('leaflet/dist/leaflet.css');

		map = L.map(mapInnerEl, { zoomControl: false, attributionControl: false });

		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 22 }).addTo(map);
		// OpenSeaMap: buoys, depth contours, lights
		L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
			maxNativeZoom: 18, maxZoom: 22, opacity: 0.9
		}).addTo(map);

		map.on('dragstart', () => { followMode = false; });
		map.on('zoomend moveend resize', () => {
			const r = mapBoxEl?.getBoundingClientRect();
			if (r && r.width > 80) { mapBoxW = r.width; mapBoxH = r.height; }
		});

		const lat = boatLat ?? cfg?.lat ?? 54.0;
		const lon = boatLon ?? cfg?.lon ?? 10.0;
		map.setView([lat, lon], 16);

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
	<div class="alarm-dist">{ancDistM != null ? ancDistM.toFixed(0) + ' m vom Ankerpunkt' : 'Position unbekannt'}</div>
	<button class="alarm-mute-btn" onclick={muteAlarm}>Stumm (30s)</button>
</div>
{/if}

<div class="anchor-page">

	<!-- ── Map ── -->
	<div class="map-box" class:alarming
		bind:this={mapBoxEl}
		bind:clientWidth={mapBoxW}
		bind:clientHeight={mapBoxH}
	>
		<!-- Heading-up rotating wrapper -->
		<div class="map-wrap" bind:this={mapWrapEl}>
			<div bind:this={mapInnerEl} class="map-inner"></div>
		</div>

		<!-- DOM overlays (not inside rotating wrapper) -->
		<div class="map-overlay">

			<!-- N pill: orbits to show North on the heading-up map -->
			<div class="north-pill" style="left:{nPillPx.x}px;top:{nPillPx.y}px">N</div>

			<!-- AWA / wind flag: orbits to show apparent wind direction + speed -->
			{#if awaPx && awsKn != null}
			<div class="awa-marker" style="left:{awaPx.x}px;top:{awaPx.y}px">
				<svg
					class="awa-arrow"
					viewBox="0 0 24 24" width="20" height="20"
					fill="#f59e0b" stroke="#0a1929" stroke-width="1.4" stroke-linejoin="round"
					style="transform:rotate({(awaDeg ?? 0) + 180}deg)"
				>
					<path d="M12 3 L19 19 L12 16 L5 19 Z"/>
				</svg>
				<div class="awa-label">
					{#if awsKn != null}<div class="awa-kn">{awsKn.toFixed(1)} kn</div>{/if}
					{#if awaDeg != null}<div class="awa-deg">AWA {((Math.round(awaDeg) % 360) + 360) % 360}°</div>{/if}
				</div>
			</div>
			{/if}

		</div>

		<!-- Map control buttons -->
		<div class="map-btns">
			<button class="map-btn" title="Zoom in"  onclick={() => map?.zoomIn()}>+</button>
			<button class="map-btn" title="Zoom out" onclick={() => map?.zoomOut()}>−</button>
			<button class="map-btn follow-btn" class:active={followMode}
				title="Zum Boot springen" onclick={jumpToBoat}>
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
					stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
					<circle cx="12" cy="12" r="3"/>
					<line x1="12" y1="2" x2="12" y2="7"/>
					<line x1="12" y1="17" x2="12" y2="22"/>
					<line x1="2" y1="12" x2="7" y2="12"/>
					<line x1="17" y1="12" x2="22" y2="12"/>
				</svg>
			</button>
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
				{ancBearingDeg != null ? bearingCardinal(ancBearingDeg) + ' ' + ancBearingDeg.toFixed(0) + '°' : '—'}
			</div>
		</div>
	</div>

	<!-- ── Control buttons ── -->
	<div class="ctrl-row">
		{#if !cfg?.active}
			<button class="ctrl-btn primary" onclick={setAnchor} disabled={!boatLat}>⚓ Anker setzen</button>
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
				<button class="sbtn" onclick={() => { localChain = Math.max(5, localChain-5); saveConfig({ chain_length_m: localChain }); }}>−</button>
				<input type="range" min="5" max="120" step="5" value={localChain}
					oninput={(e) => { localChain = +(e.target as HTMLInputElement).value; }}
					onchange={() => saveConfig({ chain_length_m: localChain })} />
				<button class="sbtn" onclick={() => { localChain = Math.min(120, localChain+5); saveConfig({ chain_length_m: localChain }); }}>+</button>
			</div>
		</div>

		<div class="srow">
			<div class="slabel">Alarmradius <span class="sval">{localRadius} m</span></div>
			<div class="sctrl">
				<button class="sbtn" onclick={() => { localRadius = Math.max(10, localRadius-10); saveConfig({ radius_m: localRadius }); }}>−</button>
				<input type="range" min="10" max="500" step="10" value={localRadius}
					oninput={(e) => { localRadius = +(e.target as HTMLInputElement).value; }}
					onchange={() => saveConfig({ radius_m: localRadius })} />
				<button class="sbtn" onclick={() => { localRadius = Math.min(500, localRadius+10); saveConfig({ radius_m: localRadius }); }}>+</button>
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
				<button class="sbtn" onclick={() => { localBearing = ((localBearing-10+360)%360); bearingManual=true; saveConfig({ bearing_deg: localBearing }); }}>−</button>
				<input type="range" min="0" max="359" step="1" value={localBearing}
					oninput={(e) => { localBearing = +(e.target as HTMLInputElement).value; bearingManual = true; }}
					onchange={() => saveConfig({ bearing_deg: localBearing })} />
				<button class="sbtn" onclick={() => { localBearing = ((localBearing+10)%360); bearingManual=true; saveConfig({ bearing_deg: localBearing }); }}>+</button>
			</div>
		</div>

	</div>
</div>

<style>
	/* ── Alarm overlay ── */
	.alarm-overlay {
		position: fixed; inset: 0; z-index: 9999;
		display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
		animation: apulse 1s ease-in-out infinite alternate;
	}
	@keyframes apulse {
		from { background: rgba(120,0,0,0.93); }
		to   { background: rgba(200,0,0,0.97); }
	}
	.alarm-icon  { font-size: 64px; }
	.alarm-title { font-size: 32px; font-weight: 900; color:#fff; letter-spacing:4px; }
	.alarm-dist  { font-size: 16px; color:#ffcccc; }
	.alarm-mute-btn {
		margin-top: 12px; padding: 12px 32px;
		background: rgba(255,255,255,0.15); border: 2px solid #fff;
		border-radius: 8px; color:#fff; font-size:16px; font-weight:600; cursor:pointer;
	}

	/* ── Page ── */
	.anchor-page { display:flex; flex-direction:column; gap:10px; }

	/* ── Map box ── */
	.map-box {
		position: relative;
		aspect-ratio: 4 / 3;
		border-radius: var(--r);
		overflow: hidden;
		border: 1px solid var(--border);
		background: #111;
	}
	.map-box.alarming { border-color: var(--red); }

	/* Extends -25% on each side so rotation never exposes corners */
	.map-wrap {
		position: absolute;
		inset: -25%;
		transition: transform 0.35s ease-out;
	}
	.map-inner { width:100%; height:100%; }

	/* ── DOM overlay (sits on top of map, no rotation) ── */
	.map-overlay { position:absolute; inset:0; pointer-events:none; z-index:500; }

	/* N pill */
	.north-pill {
		position: absolute;
		transform: translate(-50%, -50%);
		background: rgba(0,0,0,0.78);
		color: var(--accent);
		font-size: 11px; font-weight: 700;
		padding: 2px 7px; border-radius: 10px;
		border: 1px solid var(--accent);
		letter-spacing: 1px; white-space: nowrap;
	}

	/* AWA / wind marker */
	.awa-marker {
		position: absolute;
		transform: translate(-50%, -50%);
		display: flex; flex-direction: column; align-items: center; gap: 1px;
	}
	.awa-arrow { display: block; flex-shrink: 0; }
	.awa-label { display:flex; flex-direction:column; align-items:center; }
	.awa-kn {
		font-size: 10px; font-weight: 700; color: var(--amber);
		background: rgba(0,0,0,0.8); padding: 1px 4px; border-radius: 3px;
		white-space: nowrap;
	}
	.awa-deg {
		font-size: 8px; color: var(--muted);
		background: rgba(0,0,0,0.7); padding: 1px 3px; border-radius: 2px;
		white-space: nowrap;
	}

	/* ── Map control buttons ── */
	.map-btns {
		position: absolute; right: 10px; bottom: 10px; z-index: 600;
		display: flex; flex-direction: column; gap: 4px;
	}
	.map-btn {
		width: 36px; height: 36px;
		background: rgba(13,13,13,0.88); border: 1px solid var(--border);
		border-radius: 7px; color: var(--text);
		font-size: 18px; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: border-color 0.15s; backdrop-filter: blur(4px);
	}
	.map-btn:hover, .map-btn:active { border-color: var(--accent); color: var(--accent); }
	.follow-btn.active { border-color: var(--green); color: var(--green); }

	.map-loading {
		position: absolute; inset: 0; z-index: 400;
		display: flex; align-items: center; justify-content: center;
		font-size: 13px; color: var(--muted); background: #111;
	}

	/* ── Data cells ── */
	.data-cells { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
	.cell {
		background: var(--card); border: 1px solid var(--border);
		border-radius: 8px; padding: 8px 4px;
		display:flex; flex-direction:column; align-items:center; gap:3px;
	}
	.cell-label { font-size:8px; color:var(--muted); letter-spacing:0.5px; }
	.cell-val   { font-size:12px; font-weight:600; text-align:center; font-variant-numeric:tabular-nums; }

	/* ── Control buttons ── */
	.ctrl-row { display:flex; gap:8px; }
	.ctrl-btn {
		flex:1; padding:10px 8px; border-radius:8px;
		font-size:13px; font-weight:600; cursor:pointer; border:none; transition:opacity 0.15s;
	}
	.ctrl-btn:disabled { opacity:0.4; cursor:not-allowed; }
	.ctrl-btn.primary { background:var(--accent); color:#000; }
	.ctrl-btn.danger  { background:#7f1d1d; color:var(--red); border:1px solid var(--red); }
	.ctrl-btn.warning { background:#78350f; color:var(--amber); border:1px solid var(--amber); }

	/* ── Sliders ── */
	.sliders {
		background:var(--card); border:1px solid var(--border);
		border-radius:var(--r); padding:12px; display:flex; flex-direction:column; gap:14px;
	}
	.srow   { display:flex; flex-direction:column; gap:6px; }
	.slabel { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:8px; }
	.sval   { font-size:12px; font-weight:600; color:var(--text); }
	.sctrl  { display:flex; align-items:center; gap:8px; }
	.sbtn {
		width:40px; height:40px; background:var(--card2); border:1px solid var(--border);
		border-radius:8px; color:var(--text); font-size:20px; font-weight:300; cursor:pointer;
		display:flex; align-items:center; justify-content:center; flex-shrink:0;
	}
	.sbtn:active { border-color:var(--accent); color:var(--accent); }
	.auto-badge { font-size:9px; color:var(--green); border:1px solid var(--green); border-radius:3px; padding:1px 5px; }
	.reset-btn  { font-size:10px; color:var(--accent); background:none; border:1px solid var(--accent); border-radius:4px; padding:1px 6px; cursor:pointer; }

	input[type="range"] {
		flex:1; -webkit-appearance:none; appearance:none;
		height:4px; background:var(--border); border-radius:2px; outline:none;
	}
	input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance:none; appearance:none;
		width:26px; height:26px; border-radius:50%;
		background:var(--accent); cursor:pointer;
		border:3px solid var(--bg); box-shadow:0 0 0 2px var(--accent);
	}
</style>
