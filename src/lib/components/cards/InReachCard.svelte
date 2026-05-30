<script lang="ts">
	import { onDestroy } from 'svelte';
	import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { inreachPoints, inreachStale } from '$lib/stores/inreach.js';
	import type { InReachPoint } from '$lib/types.js';

	// ── Leaflet ──────────────────────────────────────────────────────────────
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let L: typeof import('leaflet') | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let map: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let trackLine: any = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let posMarker: any = null;
	let mapEl: HTMLDivElement;
	let mapReady = $state(false);

	// ── Polling ───────────────────────────────────────────────────────────────
	let pollTimer: ReturnType<typeof setInterval>;
	let loaded = $state(false);

	const cfg     = $derived($anchorConfig);
	const pts     = $derived($inreachPoints);
	const hasData = $derived(!!cfg?.inreach_mapshare_id);
	const latest  = $derived<InReachPoint | null>(pts?.[0] ?? null);
	const stale   = $derived($inreachStale);

	// ── Haversine distance (km) ───────────────────────────────────────────────
	function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
		const R = 6371;
		const dLat = (lat2 - lat1) * Math.PI / 180;
		const dLon = (lon2 - lon1) * Math.PI / 180;
		const a = Math.sin(dLat / 2) ** 2 +
			Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
			Math.sin(dLon / 2) ** 2;
		return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	}

	// ── Total distance from all track points ──────────────────────────────────
	const totalNm = $derived(() => {
		if (!pts || pts.length < 2) return null;
		const sorted = [...pts].reverse(); // oldest→newest
		let km = 0;
		for (let i = 1; i < sorted.length; i++) {
			km += haversine(sorted[i-1].lat, sorted[i-1].lon, sorted[i].lat, sorted[i].lon);
		}
		return (km / 1.852).toFixed(1);
	});

	// ── Duration (oldest → newest) ────────────────────────────────────────────
	const durationStr = $derived(() => {
		if (!pts || pts.length < 2) return null;
		const oldest = pts[pts.length - 1].timestamp;
		const newest = pts[0].timestamp;
		if (!oldest || !newest) return null;
		const ms = new Date(newest).getTime() - new Date(oldest).getTime();
		const h = Math.floor(ms / 3_600_000);
		const m = Math.floor((ms % 3_600_000) / 60_000);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	});

	// ── Age of latest fix ─────────────────────────────────────────────────────
	function ageStr(ts: string): string {
		if (!ts) return '—';
		const diff = Date.now() - new Date(ts).getTime();
		const min = Math.floor(diff / 60_000);
		if (min < 1)  return 'just now';
		if (min < 60) return `${min} min ago`;
		const h = Math.floor(min / 60);
		return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
	}

	// ── Format lat/lon ────────────────────────────────────────────────────────
	function fmtDeg(deg: number, pos: string, neg: string): string {
		const dir = deg >= 0 ? pos : neg;
		const abs = Math.abs(deg);
		const d   = Math.floor(abs);
		const m   = ((abs - d) * 60).toFixed(3);
		return `${d}° ${m}′ ${dir}`;
	}

	// ── Course arrow ──────────────────────────────────────────────────────────
	function courseArrow(deg: number | null): string {
		if (deg === null) return '';
		const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
		return arrows[Math.round(deg / 45) % 8];
	}

	// ── Messages (unique, newest first) ───────────────────────────────────────
	const messages = $derived(() => {
		if (!pts) return [];
		const seen = new Set<string>();
		return pts
			.filter(p => p.message && !seen.has(p.message) && seen.add(p.message))
			.slice(0, 3);
	});

	// ── Fetch data ────────────────────────────────────────────────────────────
	async function fetchInReach() {
		const id = cfg?.inreach_mapshare_id;
		if (!id) return;
		const pw = cfg?.inreach_mapshare_password ?? '';

		try {
			let qs = `id=${encodeURIComponent(id)}&hours=24`;
			if (pw) qs += `&password=${encodeURIComponent(pw)}`;
			const res = await fetch(
				`${PUBLIC_SUPABASE_URL}/functions/v1/inreach-proxy?${qs}`,
				{ headers: { 'apikey': PUBLIC_SUPABASE_ANON_KEY } }
			);
			const result = await res.json();
			if (result?.ok) {
				inreachPoints.set(result.points ?? []);
				inreachStale.set(false);
			} else {
				inreachStale.set(true);
			}
		} catch {
			inreachStale.set(true);
		}
		loaded = true;
	}

	// ── Update map when points change ─────────────────────────────────────────
	function updateMap() {
		if (!map || !L || !pts || pts.length === 0) return;

		const sorted = [...pts].reverse(); // oldest → newest for polyline
		const latlngs = sorted.map(p => [p.lat, p.lon] as [number, number]);

		// Track polyline
		if (trackLine) { trackLine.remove(); trackLine = null; }
		if (latlngs.length > 1) {
			trackLine = L.polyline(latlngs, {
				color: '#00c8ff', weight: 2.5, opacity: 0.85,
			}).addTo(map);
		}

		// Position marker (latest point)
		const last = pts[0];
		const markerHtml = `<div style="
			width:12px;height:12px;border-radius:50%;
			background:#00c8ff;border:2px solid #fff;
			box-shadow:0 0 6px rgba(0,200,255,.8);
		"></div>`;
		const icon = L.divIcon({ className: '', html: markerHtml, iconSize: [12, 12], iconAnchor: [6, 6] });

		if (posMarker) { posMarker.remove(); posMarker = null; }
		posMarker = L.marker([last.lat, last.lon], { icon }).addTo(map);

		// Fit bounds with some padding
		if (latlngs.length > 1) {
			map.fitBounds(L.latLngBounds(latlngs), { padding: [20, 20], maxZoom: 13 });
		} else {
			map.setView([last.lat, last.lon], 11);
		}
	}

	// ── Center map on track ───────────────────────────────────────────────────
	function centerMap() {
		if (!map || !L || !pts || pts.length === 0) return;
		const latlngs = [...pts].reverse().map(p => [p.lat, p.lon] as [number, number]);
		if (latlngs.length > 1) {
			map.fitBounds(L.latLngBounds(latlngs), { padding: [20, 20], maxZoom: 13 });
		} else {
			map.setView([pts[0].lat, pts[0].lon], 11);
		}
	}

	// ── Init map ──────────────────────────────────────────────────────────────
	async function initMap() {
		await new Promise(r => requestAnimationFrame(r));
		await new Promise(r => requestAnimationFrame(r));

		L = await import('leaflet') as typeof import('leaflet');
		await import('leaflet/dist/leaflet.css');

		if (!mapEl) return;
		map = L.map(mapEl, { zoomControl: false, attributionControl: false });

		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxNativeZoom: 19, maxZoom: 22,
		}).addTo(map);

		L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
			maxNativeZoom: 18, maxZoom: 22, opacity: 0.9,
		}).addTo(map);

		mapReady = true;
		map.invalidateSize();   // recalc after async CSS load
		updateMap();
	}

	// ── Reactivity ────────────────────────────────────────────────────────────
	$effect(() => {
		if (!hasData) { loaded = true; return; }
		fetchInReach();
		clearInterval(pollTimer);
		pollTimer = setInterval(fetchInReach, 10 * 60_000);
	});

	// Init map as soon as hasData is known (config may load after onMount)
	let mapInitStarted = $state(false);
	$effect(() => {
		if (hasData && !mapInitStarted) {
			mapInitStarted = true;
			initMap();
		}
	});

	// Re-draw map whenever points update
	$effect(() => {
		if (pts && mapReady) updateMap();
	});

	onDestroy(() => {
		clearInterval(pollTimer);
		map?.remove();
	});
</script>

{#if hasData && (loaded === false || (pts !== null) || stale)}
<div class="inreach-card card" class:emergency={latest?.in_emergency}>

	<!-- Header -->
	<div class="ir-header">
		<span class="ir-title">
			<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
				<path d="M12 2C12 2 16 5 16 10a4 4 0 0 1-8 0C8 5 12 2 12 2z"/>
				<circle cx="12" cy="10" r="1.5" fill="currentColor" stroke="none"/>
				<path d="M12 14v4M9 18h6"/>
			</svg>
			Garmin InReach
		</span>
		<span class="ir-age" class:stale>
			{#if stale}No signal{:else if latest}{ageStr(latest.timestamp)}{:else}—{/if}
			<span class="ir-dot" class:stale></span>
		</span>
	</div>

	{#if latest?.in_emergency}
	<div class="ir-emergency">🚨 EMERGENCY ACTIVE</div>
	{/if}

	<!-- Map -->
	<div class="ir-map-wrap">
		<div class="ir-map" bind:this={mapEl}></div>
		{#if !loaded || !pts}
		<div class="ir-map-overlay">Connecting to InReach…</div>
		{:else if pts.length === 0}
		<div class="ir-map-overlay">No positions in the last 24 h</div>
		{/if}
		<div class="ir-map-controls">
			<button class="ir-map-btn" onclick={() => map?.zoomIn()}  aria-label="Zoom in">+</button>
			<button class="ir-map-btn" onclick={() => map?.zoomOut()} aria-label="Zoom out">−</button>
			<button class="ir-map-btn ir-map-btn-center" onclick={centerMap} aria-label="Center on track">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="3"/>
					<line x1="8" y1="1" x2="8" y2="4"/>
					<line x1="8" y1="12" x2="8" y2="15"/>
					<line x1="1" y1="8" x2="4" y2="8"/>
					<line x1="12" y1="8" x2="15" y2="8"/>
				</svg>
			</button>
		</div>
	</div>

	{#if latest}
	<!-- Data grid -->
	<div class="ir-grid">
		<!-- Position -->
		<div class="ir-cell span2">
			<span class="ir-lbl">Position</span>
			<span class="ir-val mono">
				{fmtDeg(latest.lat, 'N', 'S')}<br>
				{fmtDeg(latest.lon, 'E', 'W')}
			</span>
		</div>

		<!-- Speed -->
		{#if latest.speed_kn !== null}
		<div class="ir-cell">
			<span class="ir-lbl">Speed</span>
			<span class="ir-val">{latest.speed_kn.toFixed(1)} kn</span>
		</div>
		{/if}

		<!-- Course -->
		{#if latest.course_deg !== null}
		<div class="ir-cell">
			<span class="ir-lbl">Course</span>
			<span class="ir-val">{courseArrow(latest.course_deg)} {Math.round(latest.course_deg)}°</span>
		</div>
		{/if}

		<!-- Total distance -->
		{#if totalNm()}
		<div class="ir-cell">
			<span class="ir-lbl">Distance (24h)</span>
			<span class="ir-val">{totalNm()} nm</span>
		</div>
		{/if}

		<!-- Duration -->
		{#if durationStr()}
		<div class="ir-cell">
			<span class="ir-lbl">Track duration</span>
			<span class="ir-val">{durationStr()}</span>
		</div>
		{/if}

		<!-- Track points -->
		{#if pts && pts.length > 0}
		<div class="ir-cell">
			<span class="ir-lbl">Track points</span>
			<span class="ir-val">{pts.length}</span>
		</div>
		{/if}

		<!-- Altitude -->
		{#if latest.altitude_m !== null}
		<div class="ir-cell">
			<span class="ir-lbl">Altitude</span>
			<span class="ir-val">{Math.round(latest.altitude_m)} m</span>
		</div>
		{/if}

		<!-- Messages -->
		{#each messages() as msg}
		<div class="ir-cell span2">
			<span class="ir-lbl">Message</span>
			<span class="ir-val ir-msg">"{msg.message}"</span>
		</div>
		{/each}
	</div>
	{/if}

</div>
{/if}

<style>
	.inreach-card {
		padding: 0;
		overflow: hidden;
		border-color: var(--border);
		transition: border-color 0.3s;
	}
	.inreach-card.emergency {
		border-color: var(--red);
		box-shadow: 0 0 0 1px var(--red);
	}

	/* Header */
	.ir-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 10px 12px 8px;
	}
	.ir-title {
		display: flex; align-items: center; gap: 5px;
		font-size: 11px; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.8px; color: var(--muted);
	}
	.ir-age {
		display: flex; align-items: center; gap: 5px;
		font-size: 10px; color: var(--muted);
	}
	.ir-dot {
		width: 6px; height: 6px; border-radius: 50%;
		background: var(--green); animation: pulse-live 2s ease-in-out infinite;
	}
	.ir-dot.stale { background: var(--amber); animation: none; }
	@keyframes pulse-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

	.ir-emergency {
		margin: 0 12px 8px;
		background: rgba(239,68,68,.12); border: 1px solid var(--red);
		color: var(--red); border-radius: 6px; padding: 6px 10px;
		font-size: 12px; font-weight: 700; text-align: center; letter-spacing: 0.5px;
	}

	/* Map */
	.ir-map-wrap {
		position: relative; height: 220px; background: #0a1520;
	}
	.ir-map {
		width: 100%; height: 100%;
	}
	.ir-map-overlay {
		position: absolute; inset: 0;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px; color: var(--muted);
		background: rgba(8,16,28,.85);
	}
	/* Slightly darken OSM tiles for dark UI */
	:global(.ir-map .leaflet-tile-pane) { filter: brightness(0.82) saturate(0.9); }

	/* Map controls */
	.ir-map-controls {
		position: absolute; bottom: 10px; right: 10px;
		display: flex; flex-direction: column; gap: 4px; z-index: 1000;
	}
	.ir-map-btn {
		width: 28px; height: 28px;
		background: rgba(8,16,28,.82); border: 1px solid rgba(255,255,255,.15);
		border-radius: 6px; color: var(--text);
		font-size: 16px; font-weight: 500; line-height: 1;
		display: flex; align-items: center; justify-content: center;
		cursor: pointer; transition: background 0.15s;
		padding: 0;
	}
	.ir-map-btn:hover { background: rgba(0,200,255,.18); border-color: rgba(0,200,255,.4); }
	.ir-map-btn-center { margin-top: 4px; color: #00c8ff; }

	/* Data grid */
	.ir-grid {
		display: grid; grid-template-columns: 1fr 1fr;
		gap: 1px; background: var(--border);
		border-top: 1px solid var(--border);
	}
	.ir-cell {
		display: flex; flex-direction: column; gap: 2px;
		background: var(--card); padding: 8px 12px;
	}
	.ir-cell.span2 { grid-column: 1 / -1; }
	.ir-lbl {
		font-size: 9px; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.6px; color: var(--muted);
	}
	.ir-val {
		font-size: 13px; color: var(--text);
		font-variant-numeric: tabular-nums; line-height: 1.3;
	}
	.ir-val.mono { font-size: 11px; }
	.ir-val.ir-msg {
		font-style: italic; color: var(--accent); font-size: 12px;
		white-space: pre-wrap; word-break: break-word;
	}
</style>
