<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';

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

	let data            = $state<TrackerData | null>(null);
	let error           = $state<string | null>(null);
	let loading         = $state(true);
	let mapEl           = $state<HTMLDivElement | null>(null);
	let mapReady        = $state(false);
	let passwordRequired = $state(false);
	let passwordInput   = $state('');
	let passwordWrong   = $state(false);
	let passwordChecking = $state(false);
	let sessionPw       = $state<string | null>(null);

	let L: any = null;
	let map: any = null;
	let boatMarker: any  = null;
	let trackLine: any   = null;
	let refreshTimer: ReturnType<typeof setInterval>;

	// ── Wind particle canvas ────────────────────────────────────────────────
	let windCanvas: HTMLCanvasElement | null = null;
	let windAnimFrame: number | null = null;
	let meteoWind = $state<{ speed_ms: number; dir_deg: number } | null>(null);

	async function fetchMeteoWind(lat: number, lon: number) {
		try {
			const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=windspeed_10m,winddirection_10m&wind_speed_unit=ms&forecast_days=1`;
			const res  = await fetch(url);
			const json = await res.json();
			const c    = json?.current;
			if (c?.windspeed_10m != null && c?.winddirection_10m != null) {
				meteoWind = { speed_ms: c.windspeed_10m, dir_deg: c.winddirection_10m };
				startWindParticles();
			}
		} catch { /* meteo optional — no error shown */ }
	}

	interface Particle {
		x: number; y: number; age: number; maxAge: number;
		speed: number; width: number; alpha: number;
	}

	function startWindParticles() {
		if (!windCanvas || !meteoWind) return;
		if (windAnimFrame) { cancelAnimationFrame(windAnimFrame); windAnimFrame = null; }

		const canvas = windCanvas;
		const ctx    = canvas.getContext('2d')!;

		const { speed_ms, dir_deg } = meteoWind;
		// pixels/frame — scale so ~5 m/s feels like a gentle flow
		const BASE_PX = 0.5;
		const pxPerFrame = Math.max(0.3, speed_ms * BASE_PX);
		const rad = dir_deg * Math.PI / 180;
		const vx  = Math.sin(rad) * pxPerFrame;
		const vy  = -Math.cos(rad) * pxPerFrame;

		// Wind-coded colour (subtle cyan→amber→red)
		const r = speed_ms < 8 ? 14 : speed_ms < 15 ? 250 : 244;
		const g = speed_ms < 8 ? 165 : speed_ms < 15 ? 204 : 63;
		const b = speed_ms < 8 ? 233 : speed_ms < 15 ? 21 : 21;

		const N = Math.max(80, Math.min(200, Math.round(speed_ms * 12)));
		const particles: Particle[] = [];

		function spawnParticle(existing?: Particle): Particle {
			const w = canvas.width, h = canvas.height;
			// Spawn along the upwind edge so particles drift across the viewport
			let x: number, y: number;
			// Probability: spawn on the edge the wind blows from
			if (Math.random() < 0.7) {
				// Spawn on one of the four edges (weighted by wind direction)
				if (Math.abs(vx) > Math.abs(vy)) {
					x = vx > 0 ? 0 : w;
					y = Math.random() * h;
				} else {
					x = Math.random() * w;
					y = vy > 0 ? 0 : h;
				}
			} else {
				x = Math.random() * w;
				y = Math.random() * h;
			}
			const maxAge = 80 + Math.random() * 120;
			return { x, y, age: existing ? 0 : Math.random() * maxAge, maxAge, speed: 0.6 + Math.random() * 0.8, width: 0.8 + Math.random() * 0.8, alpha: 0 };
		}

		for (let i = 0; i < N; i++) particles.push(spawnParticle());

		function draw() {
			const w = canvas.width, h = canvas.height;
			ctx.clearRect(0, 0, w, h);
			for (const p of particles) {
				// Move
				p.x   += vx * p.speed;
				p.y   += vy * p.speed;
				p.age += 1;

				// Respawn if off-screen or expired
				if (p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10 || p.age > p.maxAge) {
					Object.assign(p, spawnParticle(p));
					continue;
				}

				// Fade in/out envelope (sin curve over lifetime)
				const life = p.age / p.maxAge;
				const alpha = Math.sin(life * Math.PI) * 0.55;

				// Trail line
				const trailLen = p.speed * 12;
				ctx.beginPath();
				ctx.moveTo(p.x - vx * p.speed * trailLen / pxPerFrame,
				           p.y - vy * p.speed * trailLen / pxPerFrame);
				ctx.lineTo(p.x, p.y);
				ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
				ctx.lineWidth   = p.width;
				ctx.lineCap     = 'round';
				ctx.stroke();
			}
			windAnimFrame = requestAnimationFrame(draw);
		}
		draw();
	}

	function resizeWindCanvas() {
		if (!windCanvas || !mapEl) return;
		windCanvas.width  = mapEl.clientWidth;
		windCanvas.height = mapEl.clientHeight;
		if (meteoWind) startWindParticles();
	}

	const API = `https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/public-boat-tracker`;

	const CARDS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
	function cardinal(deg: number | null) { return deg != null ? CARDS[Math.round(((deg%360)+360)%360/22.5)%16] : '—'; }
	function fmt1(v: number | null, u = '') { return v != null ? `${v.toFixed(1)}${u}` : '—'; }
	function fmt0(v: number | null, u = '') { return v != null ? `${v.toFixed(0)}${u}` : '—'; }

	function beaufortLabel(kn: number | null): string {
		if (kn == null) return '';
		if (kn < 1)  return 'Calm';
		if (kn < 4)  return 'Light air';
		if (kn < 7)  return 'Light breeze';
		if (kn < 11) return 'Gentle breeze';
		if (kn < 17) return 'Moderate breeze';
		if (kn < 22) return 'Fresh breeze';
		if (kn < 28) return 'Strong breeze';
		if (kn < 34) return 'Near gale';
		if (kn < 41) return 'Gale';
		return 'Severe gale+';
	}
	function beaufortColor(kn: number | null) {
		if (kn == null) return '#64748b';
		if (kn < 7)  return '#22d3ee';
		if (kn < 17) return '#4ade80';
		if (kn < 28) return '#facc15';
		if (kn < 41) return '#f97316';
		return '#f43f5e';
	}
	function sogColor(kn: number | null) {
		if (kn == null || kn < 0.5) return '#475569';
		if (kn < 3)  return '#38bdf8';
		if (kn < 6)  return '#34d399';
		if (kn < 9)  return '#a3e635';
		return '#fb923c';
	}
	function fmtAgo(iso: string | null) {
		if (!iso) return '—';
		const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
		return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s/60)}m ago` : `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ago`;
	}
	function fmtDuration(iso: string) {
		const ms = Date.now() - new Date(iso).getTime();
		const h  = Math.floor(ms / 3_600_000);
		const m  = Math.floor((ms % 3_600_000) / 60_000);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}

	async function sha256(text: string): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
	}

	async function fetchData(pw?: string | null) {
		const slug = $page.params.slug;
		if (!slug) return;
		const pwParam = (pw ?? sessionPw) ? `&pw=${encodeURIComponent(pw ?? sessionPw!)}` : '';
		try {
			const res  = await fetch(`${API}?slug=${encodeURIComponent(slug)}${pwParam}`);
			const json = await res.json();
			if (res.status === 401) {
				passwordRequired = true;
				passwordWrong    = json.wrong_password ?? false;
				loading = false; return;
			}
			if (!res.ok) { error = json.error ?? 'Not found'; loading = false; return; }
			data = json as TrackerData;
			error = null; loading = false; passwordRequired = false;
			if (mapReady) updateMap();
		} catch { error = 'Network error — retrying…'; loading = false; }
	}

	async function submitPassword() {
		if (!passwordInput.trim()) return;
		passwordChecking = true; passwordWrong = false;
		const hashed = await sha256(passwordInput.trim());
		sessionPw = hashed;
		await fetchData(hashed);
		passwordChecking = false;
		if (!passwordWrong) passwordInput = '';
	}

	async function initMap() {
		if (!mapEl || map) return;
		const mod = await import('leaflet');
		L = mod.default ?? mod;
		const lat = data?.telemetry?.nav_lat ?? data?.track?.at(-1)?.lat ?? 39;
		const lon = data?.telemetry?.nav_lon ?? data?.track?.at(-1)?.lon ?? 20;
		map = L.map(mapEl, { center: [lat, lon], zoom: 11, zoomControl: false });

		// CartoDB Dark Matter — monochrome, minimal
		L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png', {
			attribution: '© CartoDB · OSM', subdomains: 'abcd', maxZoom: 19,
		}).addTo(map);

		// OpenSeaMap nautical overlay
		L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
			maxZoom: 18, opacity: 0.45,
		}).addTo(map);

		L.control.zoom({ position: 'bottomright' }).addTo(map);

		// Wind canvas — sized to match the map container
		if (windCanvas) {
			resizeWindCanvas();
			window.addEventListener('resize', resizeWindCanvas);
			map.on('resize', resizeWindCanvas);
		}

		mapReady = true;
		updateMap();

		// Fetch live wind from Open-Meteo (free, no API key)
		if (lat && lon) fetchMeteoWind(lat, lon);
	}

	function updateMap() {
		if (!map || !L || !data) return;
		const t   = data.telemetry;
		const pts = data.track.filter(p => p.lat && p.lon);

		// Track — gradient line (cyan accent on dark map)
		if (trackLine) { trackLine.remove(); trackLine = null; }
		if (pts.length > 1) {
			trackLine = L.polyline(pts.map(p => [p.lat, p.lon]), {
				color: '#0ea5e9', weight: 2.5, opacity: 0.85,
				lineCap: 'round', lineJoin: 'round',
			}).addTo(map);
		}

		// Boat icon — minimal, heading-up
		const hdgDeg  = t?.nav_hdg_rad != null ? t.nav_hdg_rad * 180 / Math.PI : 0;
		const sogKn   = t?.nav_sog_ms  != null ? t.nav_sog_ms  * 1.94384 : null;
		const col     = sogColor(sogKn);

		const boatSvg = `<div style="width:36px;height:36px;transform:rotate(${hdgDeg}deg);transform-origin:50% 50%;filter:drop-shadow(0 4px 12px rgba(0,0,0,.8))">
			<svg viewBox="0 0 36 36" width="36" height="36">
				<path d="M18 2 L29 18 L29 33 L7 33 L7 18 Z" fill="${col}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>
				<line x1="18" y1="7" x2="18" y2="23" stroke="rgba(0,0,0,0.4)" stroke-width="1.5" stroke-linecap="round"/>
				<circle cx="18" cy="2" r="2" fill="white" opacity="0.9"/>
			</svg></div>`;
		const bIcon = L.divIcon({ className:'', iconSize:[36,36], iconAnchor:[18,18], html: boatSvg });

		if (t?.nav_lat != null && t?.nav_lon != null) {
			if (!boatMarker) {
				boatMarker = L.marker([t.nav_lat, t.nav_lon], { icon: bIcon, zIndexOffset: 500 }).addTo(map);
				map.setView([t.nav_lat, t.nav_lon], 12);
			} else {
				boatMarker.setLatLng([t.nav_lat, t.nav_lon]);
				boatMarker.setIcon(bIcon);
			}
		} else if (pts.length > 0 && !boatMarker) {
			const last = pts.at(-1)!;
			boatMarker = L.marker([last.lat, last.lon], { icon: bIcon, zIndexOffset: 500 }).addTo(map);
			map.setView([last.lat, last.lon], 12);
		}
	}

	// ── Key fix: initMap when mapEl becomes available ────────────────────────
	// mapEl is null until the {:else if data} branch renders. The onMount
	// call was too early. This $effect fires whenever mapEl changes — which
	// happens exactly when the map div appears in the DOM after data loads.
	$effect(() => {
		if (mapEl && !map) {
			initMap();
		}
	});

	onMount(async () => {
		await fetchData();
		// initMap() will be triggered by the $effect above once mapEl is set
		refreshTimer = setInterval(fetchData, 30_000);
	});
	onDestroy(() => {
		clearInterval(refreshTimer);
		if (windAnimFrame) cancelAnimationFrame(windAnimFrame);
		window.removeEventListener('resize', resizeWindCanvas);
		map?.remove();
	});

	// Derived values
	const t       = $derived(data?.telemetry ?? null);
	const tws     = $derived(data?.derived?.tws_kn ?? null);
	const twd     = $derived(data?.derived?.twd_deg ?? null);
	const sog     = $derived(t?.nav_sog_ms != null ? +(t.nav_sog_ms * 1.94384).toFixed(1) : null);
	const hdgDeg  = $derived(t?.nav_hdg_rad != null ? Math.round(t.nav_hdg_rad * 180 / Math.PI) : null);
	const aws     = $derived(t?.env_aws_ms  != null ? +(t.env_aws_ms  * 1.94384).toFixed(1) : null);
	const awaRaw  = $derived(t?.env_awa_rad != null ? +(t.env_awa_rad * 180 / Math.PI) : null);
	const baro    = $derived(t?.env_pressure_pa != null ? Math.round(t.env_pressure_pa / 100) : null);
	const depth   = $derived(t?.env_depth_m ?? null);
	const battSoc = $derived(t?.batt_main_soc != null ? Math.round(t.batt_main_soc * 100) : null);
	const solar   = $derived(t?.solar_total_w ?? null);
	const engOn   = $derived((t?.eng_rpm ?? 0) > 0 || (t?.eng_sb_rpm ?? 0) > 0);
	const isStale = $derived(t?.updated_at != null && (Date.now() - new Date(t.updated_at as string).getTime()) > 300_000);

	// Wind compass SVG path helpers
	const windAngle = $derived(twd ?? 0);
	// Arrow endpoint in the compass (r=30 from center 44,44)
	const wx = $derived(44 + 30 * Math.sin(windAngle * Math.PI / 180));
	const wy = $derived(44 - 30 * Math.cos(windAngle * Math.PI / 180));

	let copied = $state(false);
	function copyLink() {
		navigator.clipboard.writeText(window.location.href).catch(() => {});
		copied = true; setTimeout(() => { copied = false; }, 2000);
	}
</script>

<svelte:head>
	<title>{data?.boat?.name ?? 'Live Tracker'} · SUKI</title>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
</svelte:head>

<div class="root">

{#if loading}
<div class="gate">
	<div class="gate-spinner"></div>
	<p class="gate-label">Loading tracker…</p>
</div>

{:else if passwordRequired}
<div class="gate">
	<svg class="gate-lock" viewBox="0 0 48 48" fill="none">
		<rect x="10" y="22" width="28" height="20" rx="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>
		<path d="M16 22v-6a8 8 0 1 1 16 0v6" stroke="rgba(255,255,255,0.4)" stroke-width="2" stroke-linecap="round"/>
		<circle cx="24" cy="32" r="3" fill="rgba(255,255,255,0.5)"/>
	</svg>
	<h2 class="gate-title">Password required</h2>
	<p class="gate-sub">This tracking page is private.</p>
	<div class="gate-form">
		<input class="gate-input" type="password" bind:value={passwordInput}
			placeholder="Enter password"
			onkeydown={(e) => e.key === 'Enter' && submitPassword()}
			autofocus/>
		<button class="gate-btn" onclick={submitPassword}
			disabled={passwordChecking || !passwordInput.trim()}>
			{passwordChecking ? '…' : 'Continue'}
		</button>
	</div>
	{#if passwordWrong}
	<p class="gate-error">Incorrect password</p>
	{/if}
</div>

{:else if error}
<div class="gate">
	<div class="gate-icon">⚓</div>
	<h2 class="gate-title">Tracker not found</h2>
	<p class="gate-sub">{error}</p>
</div>

{:else if data}

<!-- ── Map (full screen background) ────────────────────────────────────── -->
<div bind:this={mapEl} class="map-bg"></div>
<!-- Wind particle canvas — rendered on top of the map, pointer-events:none -->
<canvas bind:this={windCanvas} class="wind-canvas"></canvas>

<!-- ── Top pill ─────────────────────────────────────────────────────────── -->
<header class="pill-bar">
	<div class="pill-name">{data.boat.name}</div>
	<div class="pill-status" class:stale={isStale}>
		<span class="pill-dot" class:stale={isStale}></span>
		{isStale ? 'Stale' : 'Live'} · {fmtAgo(t?.updated_at ?? null)}
	</div>
	{#if data.trip}
	<div class="pill-trip">
		{data.trip.from_port ? data.trip.from_port + ' · ' : ''}{fmt1(data.trip.total_nm)} nm · {fmtDuration(data.trip.started_at)}
	</div>
	{/if}
	<button class="pill-share" onclick={copyLink}>{copied ? '✓' : '↑'}</button>
</header>

<!-- ── Side panel (glass) ───────────────────────────────────────────────── -->
<aside class="glass-panel">

	<!-- Speed block -->
	<div class="speed-block">
		<div class="speed-num" style="color:{sogColor(sog)}">{sog ?? '—'}</div>
		<div class="speed-unit">knots SOG</div>
		<div class="speed-meta">
			{hdgDeg != null ? `HDG ${hdgDeg}°` : ''}
			{engOn ? ' · Motor' : sog != null && sog > 0.5 ? ' · Sailing' : ''}
		</div>
	</div>

	<div class="divider"></div>

	<!-- Wind block -->
	<div class="wind-block">
		<div class="wind-top-row">
			<div>
				<div class="wind-big" style="color:{beaufortColor(tws)}">{tws ?? '—'}</div>
				<div class="wind-unit">kn TWS</div>
				<div class="wind-label">{beaufortLabel(tws)}</div>
			</div>
			<!-- Compass ring -->
			<svg class="compass-svg" viewBox="0 0 88 88">
				<!-- Outer ring -->
				<circle cx="44" cy="44" r="40" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
				<!-- Tick marks -->
				{#each [0,45,90,135,180,225,270,315] as a}
				<line
					x1={44 + 36*Math.sin(a*Math.PI/180)}
					y1={44 - 36*Math.cos(a*Math.PI/180)}
					x2={44 + 40*Math.sin(a*Math.PI/180)}
					y2={44 - 40*Math.cos(a*Math.PI/180)}
					stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
				{/each}
				<!-- Cardinal labels -->
				{#each [['N',0],['E',90],['S',180],['W',270]] as [lbl, ang]}
				<text
					x={44 + 28*Math.sin((ang as number)*Math.PI/180)}
					y={44 - 28*Math.cos((ang as number)*Math.PI/180) + 3.5}
					text-anchor="middle" font-size="7"
					fill="rgba(255,255,255,0.3)" font-family="system-ui">{lbl}</text>
				{/each}
				<!-- Wind direction arrow -->
				{#if twd != null}
				<!-- Tail (where wind comes FROM) -->
				<circle
					cx={44 + 32*Math.sin((windAngle+180)*Math.PI/180)}
					cy={44 - 32*Math.cos((windAngle+180)*Math.PI/180)}
					r="2" fill={beaufortColor(tws)} opacity="0.4"/>
				<!-- Shaft -->
				<line
					x1={44 + 24*Math.sin((windAngle+180)*Math.PI/180)}
					y1={44 - 24*Math.cos((windAngle+180)*Math.PI/180)}
					x2={wx} y2={wy}
					stroke={beaufortColor(tws)} stroke-width="2" stroke-linecap="round"/>
				<!-- Arrow head (points TO where wind goes) -->
				<polygon
					points="{wx},{wy}
						{44+22*Math.sin((windAngle-15)*Math.PI/180)},{44-22*Math.cos((windAngle-15)*Math.PI/180)}
						{44+22*Math.sin((windAngle+15)*Math.PI/180)},{44-22*Math.cos((windAngle+15)*Math.PI/180)}"
					fill={beaufortColor(tws)}/>
				<!-- Direction label in center -->
				<text x="44" y="47.5" text-anchor="middle" font-size="9"
					fill="rgba(255,255,255,0.6)" font-family="system-ui" font-weight="600">
					{cardinal(twd)}
				</text>
				{:else}
				<text x="44" y="47.5" text-anchor="middle" font-size="9"
					fill="rgba(255,255,255,0.2)" font-family="system-ui">—</text>
				{/if}
			</svg>
		</div>
		{#if aws != null || awaRaw != null}
		<div class="wind-apparent">
			{#if aws != null}<span>AWS <b>{aws}</b> kn</span>{/if}
			{#if awaRaw != null}<span>AWA <b>{Math.abs(awaRaw).toFixed(0)}°{awaRaw < 0 ? 'P':'S'}</b></span>{/if}
		</div>
		{/if}
	</div>

	<div class="divider"></div>

	<!-- Stats grid -->
	<div class="stats-grid">
		{#if baro != null}
		<div class="stat-item">
			<div class="stat-val">{baro}</div>
			<div class="stat-key">hPa</div>
		</div>
		{/if}
		{#if depth != null}
		<div class="stat-item">
			<div class="stat-val">{depth.toFixed(1)}</div>
			<div class="stat-key">m depth</div>
		</div>
		{/if}
		{#if battSoc != null}
		<div class="stat-item">
			<div class="stat-val" style="color:{battSoc>50?'#4ade80':battSoc>20?'#facc15':'#f87171'}">{battSoc}%</div>
			<div class="stat-key">battery</div>
		</div>
		{/if}
		{#if solar != null && solar > 0}
		<div class="stat-item">
			<div class="stat-val">{Math.round(solar)}</div>
			<div class="stat-key">W solar</div>
		</div>
		{/if}
		{#if data.trip?.max_sog_kn != null}
		<div class="stat-item">
			<div class="stat-val">{data.trip.max_sog_kn.toFixed(1)}</div>
			<div class="stat-key">kn max</div>
		</div>
		{/if}
		{#if (t?.tank_fw ?? null) != null}
		<div class="stat-item">
			<div class="stat-val">{Math.round((t!.tank_fw as number)*100)}%</div>
			<div class="stat-key">fresh H₂O</div>
		</div>
		{/if}
	</div>

	<div class="panel-footer">
		{data.track.length} pts · 7 day track
		<br/>SUKI Dashboard Pro
	</div>
</aside>

{/if}
</div>

<style>
	:global(html,body) { margin:0; padding:0; height:100%; background:#080c14; overflow:hidden; }

	/* Slightly brighten dark tiles so labels are readable without a vignette */
	:global(.leaflet-tile-pane) {
		filter: brightness(1.05) contrast(0.95);
	}

	/* ── Root ── */
	.root {
		position: fixed; inset: 0;
		font-family: -apple-system, 'SF Pro Display', 'Segoe UI', sans-serif;
		color: #fff;
		-webkit-font-smoothing: antialiased;
	}

	/* ── Loading / gate screens ── */
	.gate {
		position: absolute; inset: 0;
		display: flex; flex-direction: column;
		align-items: center; justify-content: center;
		gap: 16px;
		background: #080c14;
	}
	.gate-spinner {
		width: 32px; height: 32px;
		border: 2px solid rgba(255,255,255,0.1);
		border-top-color: #0ea5e9;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.gate-label { font-size: 14px; color: rgba(255,255,255,0.4); margin: 0; }
	.gate-lock  { width: 56px; height: 56px; opacity: 0.6; }
	.gate-icon  { font-size: 48px; }
	.gate-title { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.3px; }
	.gate-sub   { font-size: 13px; color: rgba(255,255,255,0.4); margin: 0; max-width: 280px; text-align: center; }
	.gate-form  { display: flex; gap: 8px; }
	.gate-input {
		padding: 11px 16px; width: 220px;
		background: rgba(255,255,255,0.07);
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 12px; color: #fff; font-size: 15px;
		outline: none; transition: border-color 0.2s;
	}
	.gate-input:focus { border-color: #0ea5e9; }
	.gate-btn {
		padding: 11px 20px; background: #0ea5e9;
		border: none; border-radius: 12px;
		color: #fff; font-size: 14px; font-weight: 600;
		cursor: pointer; transition: opacity 0.15s;
	}
	.gate-btn:disabled { opacity: 0.4; cursor: default; }
	.gate-error { font-size: 13px; color: #f87171; margin: 0; }

	/* ── Map full background ── */
	.map-bg {
		position: absolute; inset: 0;
		z-index: 0;
	}
	/* No vignette — the dark tiles are enough contrast */

	/* ── Wind particle canvas ── */
	.wind-canvas {
		position: absolute; inset: 0;
		z-index: 200;          /* above map tiles, below markers */
		pointer-events: none;  /* clicks pass through to map */
		mix-blend-mode: screen; /* additive blend makes particles glow on dark map */
	}

	/* ── Top pill bar ── */
	.pill-bar {
		position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
		z-index: 800;
		display: flex; align-items: center; gap: 10px;
		padding: 8px 14px 8px 16px;
		background: rgba(8,12,20,0.75);
		backdrop-filter: blur(20px) saturate(1.8);
		-webkit-backdrop-filter: blur(20px) saturate(1.8);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 999px;
		white-space: nowrap;
		max-width: calc(100vw - 32px);
		overflow: hidden;
	}
	.pill-name {
		font-size: 14px; font-weight: 700;
		letter-spacing: -0.2px;
	}
	.pill-status {
		display: flex; align-items: center; gap: 5px;
		font-size: 12px; color: rgba(255,255,255,0.5);
	}
	.pill-dot {
		width: 6px; height: 6px; border-radius: 50%;
		background: #4ade80;
		animation: pulse-dot 2s ease-in-out infinite;
	}
	.pill-dot.stale { background: #facc15; animation: none; }
	@keyframes pulse-dot {
		0%,100% { opacity: 1; } 50% { opacity: 0.4; }
	}
	.pill-status.stale { color: #facc15; }
	.pill-trip { font-size: 11px; color: rgba(255,255,255,0.35); }
	.pill-share {
		width: 28px; height: 28px;
		background: rgba(255,255,255,0.08);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 50%; color: rgba(255,255,255,0.7);
		font-size: 14px; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: background 0.15s; flex-shrink: 0;
	}
	.pill-share:hover { background: rgba(255,255,255,0.15); }

	/* ── Glass side panel ── */
	.glass-panel {
		position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
		z-index: 700;
		width: 256px;
		background: rgba(8,12,20,0.78);
		backdrop-filter: blur(28px) saturate(1.6);
		-webkit-backdrop-filter: blur(28px) saturate(1.6);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 20px;
		padding: 20px;
		display: flex; flex-direction: column; gap: 0;
		max-height: calc(100dvh - 120px);
		overflow-y: auto;
	}
	.glass-panel::-webkit-scrollbar { width: 3px; }
	.glass-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

	/* Speed */
	.speed-block { padding-bottom: 16px; }
	.speed-num {
		font-size: 52px; font-weight: 700;
		letter-spacing: -3px;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.speed-unit { font-size: 12px; color: rgba(255,255,255,0.35); letter-spacing: 0.5px; margin-top: 2px; }
	.speed-meta { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 6px; }

	.divider { height: 1px; background: rgba(255,255,255,0.06); margin: 0 0 16px; }

	/* Wind */
	.wind-block { padding-bottom: 16px; }
	.wind-top-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.wind-big {
		font-size: 38px; font-weight: 700; letter-spacing: -2px;
		font-variant-numeric: tabular-nums; line-height: 1;
	}
	.wind-unit { font-size: 11px; color: rgba(255,255,255,0.35); letter-spacing: 0.5px; margin-top: 2px; }
	.wind-label { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 6px; }
	.compass-svg { width: 88px; height: 88px; flex-shrink: 0; }
	.wind-apparent {
		display: flex; gap: 12px; margin-top: 10px;
		font-size: 11px; color: rgba(255,255,255,0.4);
	}
	.wind-apparent b { color: rgba(255,255,255,0.75); font-weight: 600; }

	/* Stats grid */
	.stats-grid {
		display: grid; grid-template-columns: 1fr 1fr;
		gap: 8px; padding-bottom: 16px;
	}
	.stat-item {
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.05);
		border-radius: 12px; padding: 10px 12px;
	}
	.stat-val {
		font-size: 18px; font-weight: 600;
		letter-spacing: -0.5px;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.stat-key { font-size: 9px; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.8px; margin-top: 3px; }

	.panel-footer {
		font-size: 10px; color: rgba(255,255,255,0.2);
		text-align: center; line-height: 1.6;
	}

	/* ── Mobile ── */
	@media (max-width: 600px) {
		.glass-panel {
			left: 0; right: 0; top: auto; bottom: 0;
			transform: none;
			width: 100%; border-radius: 20px 20px 0 0;
			max-height: 52dvh;
			padding: 16px;
		}
		.speed-num { font-size: 40px; }
		.wind-big  { font-size: 30px; }
		.pill-bar  { top: 12px; }
		.pill-trip { display: none; }
	}
</style>
