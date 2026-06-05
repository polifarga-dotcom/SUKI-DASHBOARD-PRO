<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';

	// ── Types ─────────────────────────────────────────────────────────────────
	type TrackPoint = {
		lat: number; lon: number; logged_at: string;
		sog_kn: number | null; wind_speed_kn: number | null;
		wind_dir_deg: number | null; engine_on: boolean; batt_soc: number | null;
	};
	type TrackerData = {
		boat:      { name: string; slug: string; engine_count: number };
		telemetry: Record<string, number | null> | null;
		derived:   { tws_kn: number | null; twd_deg: number | null };
		track:     TrackPoint[];
		trip:      { name: string | null; started_at: string; from_port: string | null; total_nm: number | null; max_sog_kn: number | null } | null;
		generated_at: string;
	};

	// ── State ─────────────────────────────────────────────────────────────────
	let data     = $state<TrackerData | null>(null);
	let error    = $state<string | null>(null);
	let loading  = $state(true);
	let mapEl    = $state<HTMLDivElement | null>(null);
	let mapReady = $state(false);

	let L: any = null;
	let map: any = null;
	let boatMarker: any  = null;
	let trackLine: any   = null;
	let refreshTimer: ReturnType<typeof setInterval>;
	let lastSlug = '';

	const API = `https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/public-boat-tracker`;

	// ── Helpers ───────────────────────────────────────────────────────────────
	const CARDS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
	function cardinal(deg: number | null): string {
		if (deg == null) return '—';
		return CARDS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
	}
	function fmt1(v: number | null, unit = ''): string { return v != null ? `${v.toFixed(1)}${unit}` : '—'; }
	function fmt0(v: number | null, unit = ''): string { return v != null ? `${v.toFixed(0)}${unit}` : '—'; }
	function fmtPct(v: number | null): string { return v != null ? `${(v * 100).toFixed(0)}%` : '—'; }
	function fmtAgo(iso: string | null): string {
		if (!iso) return '—';
		const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
		if (s < 60)   return `${s}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		return `${Math.floor(s / 3600)}h ago`;
	}
	function fmtDuration(iso: string): string {
		const ms = Date.now() - new Date(iso).getTime();
		const h  = Math.floor(ms / 3_600_000);
		const m  = Math.floor((ms % 3_600_000) / 60_000);
		return `${h}h ${m}m`;
	}
	function beaufortColor(kn: number | null): string {
		if (kn == null) return '#6b7280';
		if (kn < 7)  return '#22c55e';
		if (kn < 17) return '#86efac';
		if (kn < 28) return '#fbbf24';
		if (kn < 41) return '#f97316';
		return '#ef4444';
	}
	function sogColor(kn: number | null): string {
		if (kn == null) return '#3b82f6';
		if (kn < 2)  return '#6b7280';
		if (kn < 4)  return '#3b82f6';
		if (kn < 6)  return '#22c55e';
		if (kn < 8)  return '#fbbf24';
		return '#f97316';
	}

	// ── Fetch data ────────────────────────────────────────────────────────────
	async function fetchData() {
		const slug = $page.params.slug;
		if (!slug) return;
		try {
			const res  = await fetch(`${API}?slug=${encodeURIComponent(slug)}`);
			const json = await res.json();
			if (!res.ok) { error = json.error ?? 'Failed to load'; loading = false; return; }
			data    = json as TrackerData;
			error   = null;
			loading = false;
			if (mapReady) updateMap();
		} catch (e: any) {
			error   = 'Network error — retrying…';
			loading = false;
		}
	}

	// ── Map ───────────────────────────────────────────────────────────────────
	async function initMap() {
		if (!mapEl || map) return;
		const mod = await import('leaflet');
		L = mod.default ?? mod;

		const lat = data?.telemetry?.nav_lat ?? data?.track?.at(-1)?.lat ?? 39;
		const lon = data?.telemetry?.nav_lon ?? data?.track?.at(-1)?.lon ?? 20;

		map = L.map(mapEl, {
			center: [lat, lon], zoom: 11,
			zoomControl: false,
		});
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19, attribution: '© OpenStreetMap',
		}).addTo(map);
		L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
			maxZoom: 18, opacity: 0.9,
		}).addTo(map);
		L.control.zoom({ position: 'bottomright' }).addTo(map);

		mapReady = true;
		updateMap();
	}

	function updateMap() {
		if (!map || !L || !data) return;
		const t = data.telemetry;

		// ── Track polyline (color-coded by SOG) ───────────────────────────────
		// Build segments colored by speed
		const pts = data.track.filter(p => p.lat && p.lon);
		if (trackLine) { trackLine.remove(); trackLine = null; }
		if (pts.length > 1) {
			// Simple single-color polyline for perf; fancy multi-color below
			const latlngs = pts.map(p => [p.lat, p.lon]);
			trackLine = L.polyline(latlngs, {
				color: '#00c8ff', weight: 2.5, opacity: 0.7,
				dashArray: undefined,
			}).addTo(map);
		}

		// ── Boat marker ───────────────────────────────────────────────────────
		const hdgDeg = t?.nav_hdg_rad != null ? t.nav_hdg_rad * 180 / Math.PI : 0;
		const sogKn  = t?.nav_sog_ms  != null ? t.nav_sog_ms  * 1.94384 : null;
		const boatColor = sogColor(sogKn);

		const boatHtml = `<div style="
			width:32px;height:36px;
			transform:rotate(${hdgDeg}deg);
			transform-origin:50% 50%;
			filter:drop-shadow(0 2px 6px rgba(0,0,0,.7));
		">
			<svg viewBox="0 0 32 36" width="32" height="36" style="overflow:visible">
				<path d="M16 2 L26 16 L26 32 L6 32 L6 16 Z"
					fill="${boatColor}" stroke="#0a1929" stroke-width="1.5" stroke-linejoin="round"/>
				<line x1="16" y1="6" x2="16" y2="22" stroke="#0a1929" stroke-width="1.5" stroke-linecap="round"/>
				<circle cx="16" cy="2" r="1.8" fill="#ffffff" stroke="#0a1929" stroke-width="1"/>
			</svg>
		</div>`;

		const bIcon = L.divIcon({ className: '', iconSize: [32, 36], iconAnchor: [16, 18], html: boatHtml });

		if (t?.nav_lat != null && t?.nav_lon != null) {
			if (!boatMarker) {
				boatMarker = L.marker([t.nav_lat, t.nav_lon], { icon: bIcon, zIndexOffset: 200 }).addTo(map);
				map.setView([t.nav_lat, t.nav_lon], 11);
			} else {
				boatMarker.setLatLng([t.nav_lat, t.nav_lon]);
				boatMarker.setIcon(bIcon);
			}
		} else if (pts.length > 0) {
			const last = pts.at(-1)!;
			if (!boatMarker) {
				boatMarker = L.marker([last.lat, last.lon], { icon: bIcon, zIndexOffset: 200 }).addTo(map);
				map.setView([last.lat, last.lon], 11);
			}
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────
	onMount(async () => {
		await fetchData();
		await initMap();
		refreshTimer = setInterval(fetchData, 30_000);
	});

	onDestroy(() => {
		clearInterval(refreshTimer);
		map?.remove();
	});

	// ── Derived display values ────────────────────────────────────────────────
	const t        = $derived(data?.telemetry ?? null);
	const tws      = $derived(data?.derived?.tws_kn ?? null);
	const twd      = $derived(data?.derived?.twd_deg ?? null);
	const sog      = $derived(t?.nav_sog_ms != null ? +(t.nav_sog_ms * 1.94384).toFixed(1) : null);
	const hdgDeg   = $derived(t?.nav_hdg_rad != null ? +(t.nav_hdg_rad * 180 / Math.PI).toFixed(0) : null);
	const aws      = $derived(t?.env_aws_ms  != null ? +(t.env_aws_ms  * 1.94384).toFixed(1) : null);
	const awaRaw   = $derived(t?.env_awa_rad != null ? +(t.env_awa_rad  * 180 / Math.PI).toFixed(0) : null);
	const awaStr   = $derived(awaRaw != null ? `${Math.abs(awaRaw)}° ${awaRaw < 0 ? 'P' : 'S'}` : '—');
	const baro     = $derived(t?.env_pressure_pa != null ? +(t.env_pressure_pa / 100).toFixed(0) : null);
	const depth    = $derived(t?.env_depth_m ?? null);
	const battSoc  = $derived(t?.batt_main_soc != null ? Math.round(t.batt_main_soc * 100) : null);
	const solar    = $derived(t?.solar_total_w ?? null);
	const engOn    = $derived((t?.eng_rpm ?? 0) > 0 || (t?.eng_sb_rpm ?? 0) > 0);
	const ageStr   = $derived(fmtAgo(t?.updated_at ?? null));
	const isStale  = $derived(t?.updated_at != null && (Date.now() - new Date(t.updated_at as string).getTime()) > 300_000);

	// Share URL
	function copyLink() {
		navigator.clipboard.writeText(window.location.href).catch(() => {});
		copied = true; setTimeout(() => { copied = false; }, 2000);
	}
	let copied = $state(false);
</script>

<svelte:head>
	<title>{data?.boat?.name ?? 'Boat Tracker'} · SUKI Live Tracking</title>
	<meta name="description" content="Live position and telemetry for {data?.boat?.name ?? 'this vessel'}">
	<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
</svelte:head>

<div class="tracker">

	{#if loading}
	<!-- Loading -->
	<div class="splash">
		<div class="splash-icon">⚓</div>
		<div class="splash-text">Loading tracker…</div>
	</div>

	{:else if error}
	<!-- Error -->
	<div class="splash">
		<div class="splash-icon">🔒</div>
		<div class="splash-title">{error}</div>
		<div class="splash-sub">The owner may not have enabled public tracking for this boat.</div>
	</div>

	{:else if data}
	<!-- ── Top bar ─────────────────────────────────────────────────────────── -->
	<header class="topbar">
		<div class="topbar-left">
			<span class="boat-name">⚓ {data.boat.name}</span>
			<span class="age-badge" class:stale={isStale}>
				{isStale ? '⚠ stale' : '● live'} · {ageStr}
			</span>
		</div>
		<div class="topbar-right">
			{#if data.trip}
			<span class="trip-badge">
				{data.trip.from_port ? `From ${data.trip.from_port}` : 'Underway'} ·
				{data.trip.total_nm ? `${data.trip.total_nm.toFixed(1)} nm` : ''}
				· {fmtDuration(data.trip.started_at)}
			</span>
			{/if}
			<button class="share-btn" onclick={copyLink}>
				{copied ? '✓ Copied!' : '🔗 Share'}
			</button>
		</div>
	</header>

	<!-- ── Main layout ─────────────────────────────────────────────────────── -->
	<div class="main">

		<!-- Data panel -->
		<aside class="panel">

			<!-- Position -->
			<div class="section-title">Navigation</div>
			<div class="stat-grid">
				<div class="stat">
					<div class="stat-val" style="color:{sogColor(sog)}">{fmt1(sog)}</div>
					<div class="stat-lbl">SOG kn</div>
				</div>
				<div class="stat">
					<div class="stat-val">{hdgDeg != null ? `${hdgDeg}°` : '—'}</div>
					<div class="stat-lbl">Heading</div>
				</div>
				<div class="stat">
					<div class="stat-val">{engOn ? '🔴 Motor' : '⛵ Sail'}</div>
					<div class="stat-lbl">Mode</div>
				</div>
				<div class="stat">
					<div class="stat-val">{depth != null ? `${depth.toFixed(1)} m` : '—'}</div>
					<div class="stat-lbl">Depth</div>
				</div>
			</div>

			<!-- Wind — hero section -->
			<div class="section-title wind-title">Wind</div>
			<div class="wind-hero">
				<!-- Wind direction compass -->
				<div class="wind-compass">
					<svg viewBox="0 0 80 80" width="80" height="80">
						<!-- Compass rose -->
						<circle cx="40" cy="40" r="36" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
						{#each ['N','E','S','W'] as d, i}
							<text x="40" y="40"
								transform="rotate({i*90} 40 40) translate(0,-28)"
								text-anchor="middle" dominant-baseline="middle"
								font-size="8" fill="rgba(255,255,255,0.4)" font-family="monospace">{d}</text>
						{/each}
						<!-- Wind direction arrow (points TO where wind goes) -->
						{#if twd != null}
							<g transform="rotate({twd} 40 40)">
								<line x1="40" y1="40" x2="40" y2="10" stroke={beaufortColor(tws)} stroke-width="3" stroke-linecap="round"/>
								<polygon points="40,6 36,14 44,14" fill={beaufortColor(tws)}/>
							</g>
						{:else}
							<text x="40" y="44" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.3)">—</text>
						{/if}
					</svg>
					<div class="wind-from">{cardinal(twd)}</div>
				</div>
				<!-- Wind speeds -->
				<div class="wind-speeds">
					<div class="wind-stat">
						<div class="wind-val" style="color:{beaufortColor(tws)}">{fmt1(tws)}</div>
						<div class="wind-lbl">TWS kn</div>
					</div>
					<div class="wind-stat">
						<div class="wind-val" style="color:{beaufortColor(aws)}">{fmt1(aws)}</div>
						<div class="wind-lbl">AWS kn</div>
					</div>
					<div class="wind-stat">
						<div class="wind-val">{awaStr}</div>
						<div class="wind-lbl">AWA</div>
					</div>
					<div class="wind-stat">
						<div class="wind-val">{twd != null ? `${fmt0(twd)}°` : '—'}</div>
						<div class="wind-lbl">TWD</div>
					</div>
				</div>
			</div>

			<!-- Environment -->
			<div class="section-title">Environment</div>
			<div class="stat-grid">
				<div class="stat">
					<div class="stat-val">{baro != null ? `${baro} hPa` : '—'}</div>
					<div class="stat-lbl">Barometer</div>
				</div>
				<div class="stat">
					<div class="stat-val">{battSoc != null ? `${battSoc}%` : '—'}</div>
					<div class="stat-lbl">Battery</div>
				</div>
				{#if solar != null}
				<div class="stat">
					<div class="stat-val">{fmt0(solar)} W</div>
					<div class="stat-lbl">Solar</div>
				</div>
				{/if}
				{#if (t?.tank_fw ?? null) != null}
				<div class="stat">
					<div class="stat-val">{fmt0((t!.tank_fw as number) * 100)}%</div>
					<div class="stat-lbl">Fresh water</div>
				</div>
				{/if}
			</div>

			<!-- Trip stats -->
			{#if data.trip}
			<div class="section-title">Current trip</div>
			<div class="stat-grid">
				<div class="stat">
					<div class="stat-val">{fmt1(data.trip.total_nm)} nm</div>
					<div class="stat-lbl">Distance</div>
				</div>
				<div class="stat">
					<div class="stat-val">{fmtDuration(data.trip.started_at)}</div>
					<div class="stat-lbl">Duration</div>
				</div>
				<div class="stat">
					<div class="stat-val">{fmt1(data.trip.max_sog_kn)} kn</div>
					<div class="stat-lbl">Max SOG</div>
				</div>
			</div>
			{/if}

			<!-- Track info -->
			<div class="track-info">
				{data.track.length} GPS points · last 7 days
			</div>

			<!-- Attribution -->
			<div class="attribution">
				Powered by <strong>SUKI Dashboard Pro</strong>
			</div>
		</aside>

		<!-- Map -->
		<div class="map-wrap">
			<div bind:this={mapEl} class="map-el"></div>
			{#if !mapReady}
			<div class="map-overlay">Loading map…</div>
			{/if}
		</div>
	</div>
	{/if}

</div>

<style>
	:global(html, body) { margin: 0; padding: 0; height: 100%; overflow: hidden; }

	.tracker {
		width: 100vw; height: 100dvh;
		display: flex; flex-direction: column;
		background: #0a0e1a;
		color: #fff;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
	}

	/* ── Splash ── */
	.splash {
		flex: 1; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 12px;
		color: rgba(255,255,255,0.6);
	}
	.splash-icon  { font-size: 48px; }
	.splash-text  { font-size: 16px; }
	.splash-title { font-size: 18px; color: #fff; font-weight: 600; }
	.splash-sub   { font-size: 13px; max-width: 320px; text-align: center; }

	/* ── Top bar ── */
	.topbar {
		display: flex; align-items: center; justify-content: space-between;
		padding: 8px 16px;
		background: rgba(0,0,0,0.7);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid rgba(255,255,255,0.08);
		flex-shrink: 0;
		gap: 12px;
		flex-wrap: wrap;
		z-index: 100;
	}
	.topbar-left  { display: flex; align-items: center; gap: 10px; min-width: 0; }
	.topbar-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
	.boat-name {
		font-size: 16px; font-weight: 700;
		letter-spacing: 0.3px;
		white-space: nowrap;
	}
	.age-badge {
		font-size: 11px; font-weight: 600;
		padding: 2px 8px; border-radius: 20px;
		background: rgba(34,197,94,0.15);
		color: #22c55e;
		white-space: nowrap;
	}
	.age-badge.stale {
		background: rgba(245,158,11,0.15);
		color: #f59e0b;
	}
	.trip-badge {
		font-size: 11px; color: rgba(255,255,255,0.6);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		max-width: 260px;
	}
	.share-btn {
		padding: 5px 14px;
		background: rgba(0,200,255,0.1);
		border: 1px solid rgba(0,200,255,0.3);
		border-radius: 20px;
		color: #00c8ff;
		font-size: 12px; font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.15s;
	}
	.share-btn:hover { background: rgba(0,200,255,0.2); }

	/* ── Main layout ── */
	.main {
		flex: 1; display: flex;
		overflow: hidden;
		min-height: 0;
	}

	/* ── Panel ── */
	.panel {
		width: 240px; flex-shrink: 0;
		background: rgba(10,14,26,0.92);
		backdrop-filter: blur(10px);
		border-right: 1px solid rgba(255,255,255,0.07);
		overflow-y: auto;
		padding: 12px;
		display: flex; flex-direction: column; gap: 4px;
	}
	.panel::-webkit-scrollbar { width: 4px; }
	.panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

	.section-title {
		font-size: 9px; font-weight: 700;
		color: rgba(255,255,255,0.35);
		text-transform: uppercase; letter-spacing: 1px;
		margin: 10px 0 6px;
	}
	.section-title:first-child { margin-top: 0; }

	.stat-grid {
		display: grid; grid-template-columns: 1fr 1fr;
		gap: 6px;
	}
	.stat {
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.06);
		border-radius: 8px;
		padding: 8px 10px;
		text-align: center;
	}
	.stat-val {
		font-size: 15px; font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}
	.stat-lbl {
		font-size: 9px; color: rgba(255,255,255,0.4);
		text-transform: uppercase; letter-spacing: 0.5px;
		margin-top: 2px;
	}

	/* ── Wind hero ── */
	.wind-hero {
		display: flex; align-items: center; gap: 12px;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 10px;
		padding: 10px;
		margin-bottom: 4px;
	}
	.wind-compass { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
	.wind-from { font-size: 10px; color: rgba(255,255,255,0.5); font-weight: 600; letter-spacing: 0.5px; }
	.wind-speeds { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; flex: 1; }
	.wind-stat { text-align: center; }
	.wind-val { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
	.wind-lbl { font-size: 8px; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.5px; }

	.track-info {
		font-size: 10px; color: rgba(255,255,255,0.25);
		text-align: center; margin-top: 8px;
	}
	.attribution {
		font-size: 10px; color: rgba(255,255,255,0.2);
		text-align: center; margin-top: auto; padding-top: 16px;
	}
	.attribution strong { color: rgba(255,255,255,0.35); }

	/* ── Map ── */
	.map-wrap { flex: 1; position: relative; }
	.map-el   { width: 100%; height: 100%; }
	.map-overlay {
		position: absolute; inset: 0;
		display: flex; align-items: center; justify-content: center;
		background: rgba(10,14,26,0.7);
		font-size: 14px; color: rgba(255,255,255,0.5);
	}

	/* ── Mobile ── */
	@media (max-width: 600px) {
		.main { flex-direction: column-reverse; }
		.panel { width: 100%; height: 220px; border-right: none; border-top: 1px solid rgba(255,255,255,0.08); flex-direction: row; flex-wrap: wrap; padding: 8px; overflow-x: auto; }
		.section-title { display: none; }
		.stat-grid { grid-template-columns: repeat(4, auto); }
		.wind-hero { flex-shrink: 0; }
		.track-info, .attribution { display: none; }
		.trip-badge { display: none; }
	}
</style>
