<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { boatIconSvg } from '$lib/utils/boatIcons.js';
	import { page } from '$app/stores';

	type TrackPoint = {
		lat: number; lon: number; logged_at: string;
		sog_kn: number | null; wind_speed_kn: number | null;
		wind_dir_deg: number | null; engine_on: boolean; batt_soc: number | null;
	};
	type BoatIcon = 'monohull' | 'catamaran' | 'trimaran' | 'motorboat';
	type GpsSource = { lat: number; lon: number; at: string } | null;
	type TrackerData = {
		boat:      { name: string; slug: string; engine_count: number; boat_icon?: BoatIcon };
		telemetry: Record<string, number | null> | null;
		derived:   { tws_kn: number | null; twd_deg: number | null };
		gps_sources?: { signalk: GpsSource; vrm: GpsSource; inreach: GpsSource };
		track:     TrackPoint[];
		trip:      { name: string | null; started_at: string; from_port: string | null; total_nm: number | null; max_sog_kn: number | null } | null;
		generated_at: string;
	};

	type ResolvedGPS = { lat: number; lon: number; source: 'signalk' | 'vrm' | 'inreach' | 'track'; ageMs: number };

	function resolveGPS(d: TrackerData): ResolvedGPS | null {
		const now = Date.now();
		const src = d.gps_sources;

		// 1) SignalK — server already verified freshness (<5 min), trust it
		if (src?.signalk) return { ...src.signalk, source: 'signalk', ageMs: now - new Date(src.signalk.at).getTime() };

		// 2) VRM GPS — server verified freshness (<30 min)
		if (src?.vrm)     return { ...src.vrm,     source: 'vrm',     ageMs: now - new Date(src.vrm.at).getTime()     };

		// 3) InReach — server verified freshness (<2 h)
		if (src?.inreach) return { ...src.inreach, source: 'inreach', ageMs: now - new Date(src.inreach.at).getTime() };

		// 4) Last track point — always valid as last resort
		const last = d.track.at(-1);
		if (last?.lat && last?.lon) return { lat: last.lat, lon: last.lon, source: 'track', ageMs: now - new Date(last.logged_at).getTime() };

		return null;
	}

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
	let baseLayer: any   = null;
	let seamarkLayer: any = null;
	let refreshTimer: ReturnType<typeof setInterval>;

	type MapType = 'nautical' | 'satellite' | 'street';
	let mapType = $state<MapType>('satellite');

	const TILES: Record<MapType, { url: string; opts: Record<string, unknown>; label: string }> = {
		nautical: {
			url:  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
			opts: { attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 19 },
			label: 'Nautical',
		},
		satellite: {
			url:  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
			opts: { attribution: '© Esri, Maxar', maxZoom: 19 },
			label: 'Satellite',
		},
		street: {
			url:  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
			opts: { attribution: '© OpenStreetMap contributors', subdomains: 'abc', maxZoom: 19 },
			label: 'OSM',
		},
	};

	function switchMapType(t: MapType) {
		if (!map || !L || t === mapType) return;
		if (baseLayer) map.removeLayer(baseLayer);
		const def = TILES[t];
		baseLayer = L.tileLayer(def.url, def.opts).addTo(map);
		baseLayer.bringToBack();
		seamarkLayer?.bringToFront();
		mapType = t;
	}

	function centerOnBoat() {
		if (!map || !data) return;
		const gps = resolveGPS(data);
		if (gps) map.panTo([gps.lat, gps.lon]);
	}

	// ── Wind particle canvas ────────────────────────────────────────────────
	let windCanvas = $state<HTMLCanvasElement | null>(null);
	let windAnimFrame: number | null = null;
	let meteoWind = $state<{ speed_ms: number; dir_deg: number } | null>(null);

	type WeatherDay = { date: string; wmo: number; tMax: number; tMin: number; windMax: number; };
	let weatherDays = $state<WeatherDay[]>([]);
	let waterTempC  = $state<number | null>(null);

	// SVG weather icons — no emoji
	function wmoSvg(code: number): string {
		const sun = `<circle cx="10" cy="10" r="3.8" fill="#fbbf24"/>
			<g stroke="#fbbf24" stroke-width="1.4" stroke-linecap="round">
				<line x1="10" y1="1.5" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18.5"/>
				<line x1="1.5" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18.5" y2="10"/>
				<line x1="3.8" y1="3.8" x2="5.5" y2="5.5"/><line x1="14.5" y1="14.5" x2="16.2" y2="16.2"/>
				<line x1="3.8" y1="16.2" x2="5.5" y2="14.5"/><line x1="14.5" y1="5.5" x2="16.2" y2="3.8"/>
			</g>`;
		const cloud = `<path d="M3.5 13 Q3.5 10 7 10 Q8.5 7 12 7.5 Q15.5 8 15.5 11 Q17.5 11 17.5 13.5 Q17.5 16 14.5 16 H6.5 Q3.5 16 3.5 13Z" fill="#94a3b8"/>`;
		const suncld = `<circle cx="7" cy="8.5" r="3.2" fill="#fbbf24"/>
			<path d="M5 14 Q5 11.5 8 11.5 Q9 9 11.5 9.5 Q14 10 14 12 Q15.5 12 15.5 14 Q15.5 16 13.5 16 H6.5 Q5 16 5 14Z" fill="#94a3b8"/>`;
		const rain = `${cloud}
			<g stroke="#60a5fa" stroke-width="1.4" stroke-linecap="round">
				<line x1="7.5" y1="17.5" x2="6.5" y2="20"/><line x1="10.5" y1="17.5" x2="9.5" y2="20"/><line x1="13.5" y1="17.5" x2="12.5" y2="20"/>
			</g>`;
		const snow = `${cloud}
			<g stroke="#bae6fd" stroke-width="1.4" stroke-linecap="round">
				<line x1="7.5" y1="17.5" x2="7.5" y2="20"/><line x1="10.5" y1="17.5" x2="10.5" y2="20"/><line x1="13.5" y1="17.5" x2="13.5" y2="20"/>
			</g>`;
		const storm = `<path d="M3.5 13 Q3.5 10 7 10 Q8.5 7 12 7.5 Q15.5 8 15.5 11 Q17.5 11 17.5 13.5 Q17.5 16 14.5 16 H6.5 Q3.5 16 3.5 13Z" fill="#475569"/>
			<path d="M11 17 L9 20.5 L11 19.5 L10 23 L13 18 L11 19 Z" fill="#fbbf24"/>`;
		const fog = `<g stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round">
			<line x1="3" y1="8" x2="17" y2="8"/><line x1="4" y1="11" x2="16" y2="11"/><line x1="5" y1="14" x2="15" y2="14"/>
			</g>`;
		let inner: string;
		if (code === 0)        inner = sun;
		else if (code <= 3)    inner = suncld;
		else if (code <= 48)   inner = fog;
		else if (code <= 55)   inner = rain;
		else if (code <= 67)   inner = rain;
		else if (code <= 77)   inner = snow;
		else if (code <= 82)   inner = rain;
		else if (code <= 86)   inner = snow;
		else                   inner = storm;
		return `<svg viewBox="0 0 20 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
	}

	function wxDayLabel(dateStr: string): string {
		const [y, mo, d] = dateStr.split('-').map(Number);
		const dt    = new Date(y, mo - 1, d);
		const today = new Date(); today.setHours(0,0,0,0);
		const tom   = new Date(today); tom.setDate(today.getDate() + 1);
		if (dt.getTime() === today.getTime()) return 'Today';
		if (dt.getTime() === tom.getTime())   return 'Tmrw';
		return dt.toLocaleDateString('en', { weekday: 'short' });
	}

	async function fetchMeteoData(lat: number, lon: number) {
		try {
			const [wxRes, marineRes] = await Promise.all([
				fetch(
					`https://api.open-meteo.com/v1/forecast` +
					`?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
					`&current=windspeed_10m,winddirection_10m` +
					`&daily=weathercode,temperature_2m_max,temperature_2m_min,windspeed_10m_max` +
					`&wind_speed_unit=kn&forecast_days=4&timezone=auto`
				),
				fetch(
					`https://marine-api.open-meteo.com/v1/marine` +
					`?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
					`&current=sea_surface_temperature&forecast_days=1`
				).catch(() => null),
			]);
			const json = await wxRes.json();
			// Current wind → particles (kn → m/s)
			const c = json?.current;
			if (c?.windspeed_10m != null && c?.winddirection_10m != null) {
				meteoWind = { speed_ms: c.windspeed_10m / 1.94384, dir_deg: c.winddirection_10m };
				startWindParticles();
			}
			// Daily forecast
			const dly = json?.daily;
			if (dly?.time) {
				weatherDays = (dly.time as string[]).map((date, i) => ({
					date,
					wmo:     dly.weathercode[i] ?? 0,
					tMax:    Math.round(dly.temperature_2m_max[i] ?? 0),
					tMin:    Math.round(dly.temperature_2m_min[i] ?? 0),
					windMax: Math.round(dly.windspeed_10m_max[i] ?? 0),
				}));
			}
			// Water temp from marine API
			if (marineRes?.ok) {
				const mj = await marineRes.json();
				const sst = mj?.current?.sea_surface_temperature;
				if (sst != null) waterTempC = Math.round(sst * 10) / 10;
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
		// dir_deg is meteorological FROM direction. Negate to get TO direction.
		const vx  = -Math.sin(rad) * pxPerFrame;
		const vy  =  Math.cos(rad) * pxPerFrame;

		// PredictWind colour scale: purple → green → yellow → red → black
		const kn = speed_ms * 1.94384;
		const [r, g, b] = kn < 10 ? [168, 85, 247]   // purple
		                : kn < 20 ? [34, 197, 94]     // green
		                : kn < 30 ? [234, 179, 8]     // yellow
		                : kn < 40 ? [239, 68, 68]     // red
		                :           [80, 20, 20];     // near-black (dark red)

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
	function fmtCoord(v: number, isLat: boolean) {
		const dir = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
		return `${Math.abs(v).toFixed(5)}° ${dir}`;
	}

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
	// PredictWind colour scale: purple → green → yellow → red → black
	function beaufortColor(kn: number | null) {
		if (kn == null) return '#64748b';
		if (kn < 10) return '#a855f7';
		if (kn < 20) return '#22c55e';
		if (kn < 30) return '#eab308';
		if (kn < 40) return '#ef4444';
		return '#3f0f0f';
	}
	function sogColor(kn: number | null) {
		if (kn == null || kn < 0.5) return '#94a3b8';
		if (kn < 3)  return '#7dd3fc';
		if (kn < 6)  return '#6ee7b7';
		if (kn < 9)  return '#d9f99d';
		return '#fdba74';
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
		const gps = data ? resolveGPS(data) : null;
		const lat = gps?.lat ?? 39;
		const lon = gps?.lon ?? 20;
		map = L.map(mapEl, { center: [lat, lon], zoom: 11, zoomControl: false });

		baseLayer = L.tileLayer(TILES.satellite.url, TILES.satellite.opts).addTo(map);

		// OpenSeaMap nautical overlay (transparent PNG on top)
		seamarkLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
			maxZoom: 18, opacity: 0.7,
		}).addTo(map);

		// zoom handled by custom buttons in ctrl-col

		// Wind canvas — sized to match the map container
		if (windCanvas) {
			resizeWindCanvas();
			window.addEventListener('resize', resizeWindCanvas);
			map.on('resize', resizeWindCanvas);
		}

		mapReady = true;
		updateMap();
		centerOnBoat();   // always center on boat after initial render

		// Fetch weather data from Open-Meteo (free, no API key)
		if (lat && lon) fetchMeteoData(lat, lon);
	}

	// ── Boat icon SVGs (top-down view, bow pointing up) ───────────────────────
	// boatIconSvg() imported from $lib/utils/boatIcons.js

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

		const icon = data?.boat?.boat_icon ?? 'monohull';
		const boatSvg = `<div style="width:40px;height:60px;transform:rotate(${hdgDeg}deg);transform-origin:50% 50%;filter:drop-shadow(0 4px 14px rgba(0,0,0,.9))">${boatIconSvg(icon, col)}</div>`;
		const bIcon = L.divIcon({ className:'', iconSize:[40,60], iconAnchor:[20,30], html: boatSvg });

		// Use GPS fallback chain for boat marker position
		const gps = resolveGPS(data);
		if (gps) {
			if (!boatMarker) {
				boatMarker = L.marker([gps.lat, gps.lon], { icon: bIcon, zIndexOffset: 500 }).addTo(map);
				map.setView([gps.lat, gps.lon], 12);
			} else {
				boatMarker.setLatLng([gps.lat, gps.lon]);
				boatMarker.setIcon(bIcon);
			}
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

	// Restart particles whenever wind data or canvas becomes available
	$effect(() => {
		if (windCanvas && meteoWind) {
			resizeWindCanvas();
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
	const waterTemp = $derived(t?.temp_water != null ? Math.round(t.temp_water * 10) / 10 : waterTempC);
	const engOn     = $derived((t?.eng_rpm ?? 0) > 0 || (t?.eng_sb_rpm ?? 0) > 0);
	// Status: Anchored ≤ 1.5 kn, Motoring when engine on, Sailing otherwise
	const boatStatus = $derived(
		sog == null             ? null :
		sog <= 1.5              ? 'Anchored' :
		engOn                   ? 'Motoring' :
		                          'Sailing'
	);
	const statusColor = $derived(
		boatStatus === 'Sailing'  ? '#34d399' :
		boatStatus === 'Motoring' ? '#fb923c' :
		boatStatus === 'Anchored' ? '#60a5fa' : 'rgba(255,255,255,0.3)'
	);
	const isStale = $derived(t?.updated_at != null && (Date.now() - new Date(t.updated_at as unknown as string).getTime()) > 300_000);

	// GPS resolution — fallback chain: SignalK → VRM → InReach → track
	const resolvedGPS = $derived(data ? resolveGPS(data) : null);
	const gpsBadge = $derived(
		resolvedGPS?.source === 'vrm'     ? 'VRM GPS'     :
		resolvedGPS?.source === 'inreach' ? 'InReach GPS' :
		resolvedGPS?.source === 'track'   ? 'GPS: track'  : null
	);
	const gpsSourceLabel = $derived(
		resolvedGPS?.source === 'signalk' ? 'SignalK'       :
		resolvedGPS?.source === 'vrm'     ? 'VRM GPS'       :
		resolvedGPS?.source === 'inreach' ? 'Garmin InReach':
		resolvedGPS?.source === 'track'   ? 'Track log'     : null
	);

	// Wind compass SVG path helpers
	const windAngle = $derived(twd ?? 0);
	// Arrow endpoint in the compass (r=30 from center 44,44)
	const wx = $derived(44 + 30 * Math.sin(windAngle * Math.PI / 180));
	const wy = $derived(44 - 30 * Math.cos(windAngle * Math.PI / 180));

	let copied = $state(false);
	async function shareOrCopy() {
		const url   = window.location.href;
		const title = `${data?.boat?.name ?? 'SUKI'} · Live Tracker`;
		const text  = data?.boat?.name ? `Verfolge ${data.boat.name} live` : 'Live Boat Tracker';
		if (navigator.share) {
			try { await navigator.share({ title, text, url }); return; } catch { /* user cancelled */ }
		}
		navigator.clipboard.writeText(url).catch(() => {});
		copied = true; setTimeout(() => { copied = false; }, 2000);
	}

	// ── PWA install ──────────────────────────────────────────────────────────
	let deferredPrompt = $state<any>(null);
	let isStandalone   = $state(false);
	let isIOS          = $state(false);
	let showIOSTip     = $state(false);

	onMount(() => {
		isStandalone = window.matchMedia('(display-mode: standalone)').matches
		           || (navigator as any).standalone === true;
		isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

		const onPrompt = (e: Event) => { e.preventDefault(); deferredPrompt = e; };
		window.addEventListener('beforeinstallprompt', onPrompt);
		return () => window.removeEventListener('beforeinstallprompt', onPrompt);
	});

	async function installApp() {
		if (deferredPrompt) {
			deferredPrompt.prompt();
			await deferredPrompt.userChoice;
			deferredPrompt = null;
		} else if (isIOS) {
			showIOSTip = !showIOSTip;
		}
	}

	// Show button when: not already installed AND (prompt available OR iOS Safari)
	const showInstall = $derived(
		!isStandalone && (deferredPrompt != null || isIOS)
	);
</script>

<svelte:head>
	<title>{data?.boat?.name ?? 'Live Tracker'} · SUKI</title>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<meta name="apple-mobile-web-app-capable" content="yes">
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
	<meta name="apple-mobile-web-app-title" content="SUKI Tracker">
	<link rel="manifest" href="/track/{$page.params.slug}/manifest.json">
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
	<div class="gate-icon">
		<svg viewBox="0 0 32 32" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5">
			<circle cx="16" cy="7" r="3"/>
			<line x1="16" y1="10" x2="16" y2="28"/>
			<line x1="9" y1="16" x2="23" y2="16"/>
			<path d="M9 28 Q16 31 23 28"/>
		</svg>
	</div>
	<h2 class="gate-title">Tracker not found</h2>
	<p class="gate-sub">{error}</p>
</div>

{:else if data}

<div bind:this={mapEl} class="map-bg"></div>
<canvas bind:this={windCanvas} class="wind-canvas"></canvas>

<!-- ── Right control column ───────────────────────────────────────────────── -->
<div class="ctrl-col">
	<!-- Center on boat -->
	<button class="ctrl-btn" onclick={centerOnBoat} title="Center on boat">
		<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
			<circle cx="10" cy="10" r="3.5"/>
			<line x1="10" y1="1" x2="10" y2="5.5"/>
			<line x1="10" y1="14.5" x2="10" y2="19"/>
			<line x1="1" y1="10" x2="5.5" y2="10"/>
			<line x1="14.5" y1="10" x2="19" y2="10"/>
		</svg>
	</button>

	<div class="ctrl-sep"></div>

	<!-- Map type -->
	<button class="ctrl-btn ctrl-map" class:active={mapType === 'nautical'} onclick={() => switchMapType('nautical')} title="Nautical">
		<svg class="ctrl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="8" cy="4" r="1.8"/><line x1="8" y1="5.8" x2="8" y2="14"/>
			<line x1="4.5" y1="8.5" x2="11.5" y2="8.5"/>
			<path d="M4.5 14 Q4.5 11 8 11 Q11.5 11 11.5 14"/>
		</svg>
		<span class="ctrl-label">Nautical</span>
	</button>
	<button class="ctrl-btn ctrl-map" class:active={mapType === 'satellite'} onclick={() => switchMapType('satellite')} title="Satellite">
		<svg class="ctrl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
			<rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/>
			<line x1="1.5" y1="5.8" x2="14.5" y2="5.8"/><line x1="1.5" y1="10.2" x2="14.5" y2="10.2"/>
			<line x1="5.8" y1="1.5" x2="5.8" y2="14.5"/><line x1="10.2" y1="1.5" x2="10.2" y2="14.5"/>
		</svg>
		<span class="ctrl-label">Satellite</span>
	</button>
	<button class="ctrl-btn ctrl-map" class:active={mapType === 'street'} onclick={() => switchMapType('street')} title="Street">
		<svg class="ctrl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<path d="M2 4 L6 2 L10 4 L14 2 L14 13 L10 15 L6 13 L2 15 Z"/>
			<line x1="6" y1="2" x2="6" y2="13"/><line x1="10" y1="4" x2="10" y2="15"/>
		</svg>
		<span class="ctrl-label">Street</span>
	</button>

	<div class="ctrl-sep"></div>

	<!-- Zoom -->
	<button class="ctrl-btn ctrl-zoom" onclick={() => map?.zoomIn()}>+</button>
	<button class="ctrl-btn ctrl-zoom" onclick={() => map?.zoomOut()}>−</button>
</div>


<!-- ── Top pill ─────────────────────────────────────────────────────────── -->
<header class="pill-bar">
	<div class="pill-name-block">
		<div class="pill-name">{data.boat.name}</div>
		{#if data.boat.callsign || data.boat.mmsi}
		<div class="pill-ident">
			{#if data.boat.callsign}<span>{data.boat.callsign}</span>{/if}
			{#if data.boat.callsign && data.boat.mmsi}<span class="pill-ident-sep">·</span>{/if}
			{#if data.boat.mmsi}<span>MMSI {data.boat.mmsi}</span>{/if}
		</div>
		{/if}
	</div>
	<div class="pill-status" class:stale={isStale}>
		<span class="pill-dot" class:stale={isStale}></span>
		{isStale ? 'Stale' : 'Live'} · {fmtAgo((t?.updated_at ?? null) as unknown as string)}
	</div>
	{#if gpsBadge}
	<div class="pill-gps" title="GPS fallback active">
		<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
			<circle cx="6" cy="5" r="2"/><path d="M6 1v1M6 9v1M1 5h1M9 5h1M2.5 2.5l.7.7M8.8 8.8l.7.7M8.8 2.5l-.7.7M3.2 8.8l-.7.7"/>
		</svg>
		{gpsBadge}
	</div>
	{/if}
	{#if data.trip}
	<div class="pill-trip">
		{data.trip.from_port ? data.trip.from_port + ' · ' : ''}{fmt1(data.trip.total_nm)} nm · {fmtDuration(data.trip.started_at)}
	</div>
	{/if}
	{#if showInstall}
	<button class="pill-install" onclick={installApp} title="Zum Home-Bildschirm hinzufügen">
		<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="2" width="12" height="12" rx="2.5"/>
			<line x1="8" y1="5" x2="8" y2="11"/>
			<line x1="5" y1="8" x2="11" y2="8"/>
		</svg>
	</button>
	{/if}
	<button class="pill-share" onclick={shareOrCopy} title="Teilen">
		{#if copied}
		<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="2,7 5.5,11 12,3"/>
		</svg>
		{:else}
		<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
			<path d="M8 2v9"/>
			<path d="M5 5L8 2l3 3"/>
			<path d="M4 8H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1"/>
		</svg>
		{/if}
	</button>
</header>

{#if showIOSTip}
<div class="ios-tip" role="tooltip">
	<div class="ios-tip-row">
		<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
			<path d="M10 2v10M6 6l4-4 4 4"/>
			<path d="M4 13v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/>
		</svg>
		Auf <strong>Teilen</strong> tippen
	</div>
	<div class="ios-tip-row">
		<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
			<rect x="3" y="3" width="14" height="14" rx="3"/>
			<line x1="10" y1="7" x2="10" y2="13"/>
			<line x1="7" y1="10" x2="13" y2="10"/>
		</svg>
		<strong>„Zum Home-Bildschirm"</strong> wählen
	</div>
	<button class="ios-tip-close" onclick={() => showIOSTip = false}>
		<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
			<line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
		</svg>
	</button>
</div>
{/if}

<!-- ── Bottom stack: wind legend + glass panel (anchored together on mobile) -->
<div class="bottom-wrap">

{#if meteoWind}
<div class="wind-bar">
	<span class="wb-title">Wind</span>
	{#each [['#a855f7','< 10 kn'],['#22c55e','10–20'],['#eab308','20–30'],['#ef4444','30–40'],['#7f1d1d','≥ 40']] as [col, lbl]}
	<span class="wb-item">
		<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="{col}"/></svg>
		{lbl}
	</span>
	{/each}
</div>
{/if}

<!-- ── Side panel (glass) ───────────────────────────────────────────────── -->
<aside class="glass-panel">

	<!-- Speed block -->
	<div class="speed-block">
		<div class="speed-num" style="color:{sogColor(sog)}">{sog ?? '—'}</div>
		<div class="speed-unit">knots SOG</div>
		{#if boatStatus}
		<div class="status-badge" style="color:{statusColor}; border-color:{statusColor}">
			{#if boatStatus === 'Anchored'}
			<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="7" cy="2.5" r="1.5"/>
				<line x1="7" y1="4" x2="7" y2="12"/>
				<line x1="4" y1="7.5" x2="10" y2="7.5"/>
				<path d="M4.5 12 Q7 13.5 9.5 12"/>
			</svg>
			{:else if boatStatus === 'Sailing'}
			<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<line x1="7" y1="1.5" x2="7" y2="11.5"/>
				<path d="M7 2 L13 11 L7 11 Z"/>
				<path d="M3 13 Q7 12 11 13"/>
			</svg>
			{:else if boatStatus === 'Motoring'}
			<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M2 9.5 L4 7 L10.5 7 L12.5 9.5 Q7.5 12 2 9.5Z"/>
				<path d="M7.5 7 L7.5 5 L10.5 5 L10.5 7"/>
			</svg>
			{/if}
			{boatStatus}
		</div>
		{/if}
		<div class="speed-meta">{hdgDeg != null ? `HDG ${hdgDeg}°` : ''}</div>
	</div>

	<div class="divider"></div>

	<!-- Stats grid (incl. wind tiles) -->
	<div class="stats-grid">
		{#if aws != null}
		<div class="stat-item">
			<div class="stat-val" style="color:{beaufortColor(aws)}">{aws}</div>
			<div class="stat-key">kn AWS</div>
		</div>
		{/if}
		{#if twd != null}
		<div class="stat-item">
			<div class="stat-val" style="color:{beaufortColor(aws)}">{cardinal(twd)} {fmt0(twd)}°</div>
			<div class="stat-key">{awaRaw != null ? `AWA ${Math.abs(awaRaw).toFixed(0)}°${awaRaw < 0 ? 'P':'S'}` : 'wind dir'}</div>
		</div>
		{/if}
		{#if baro != null}
		<div class="stat-item">
			<div class="stat-val">{baro}</div>
			<div class="stat-key">hPa</div>
		</div>
		{/if}

		{#if data.trip?.max_sog_kn != null}
		<div class="stat-item">
			<div class="stat-val">{data.trip.max_sog_kn.toFixed(1)}</div>
			<div class="stat-key">kn max</div>
		</div>
		{/if}
		{#if waterTemp != null}
		<div class="stat-item">
			<div class="stat-val" style="color:#38bdf8">{waterTemp}°C</div>
			<div class="stat-key">water</div>
		</div>
		{/if}
	</div>

	{#if resolvedGPS}
	<div class="gps-row">
		{fmtCoord(resolvedGPS.lat, true)} &nbsp; {fmtCoord(resolvedGPS.lon, false)}
		<span class="gps-src">· {gpsSourceLabel}</span>
	</div>
	{/if}

	{#if weatherDays.length > 0}
	<div class="divider"></div>
	<div class="wx-strip">
		{#each weatherDays.slice(0, 4) as day}
		<div class="wx-day">
			<div class="wx-day-label">{wxDayLabel(day.date)}</div>
			<div class="wx-day-icon">{@html wmoSvg(day.wmo)}</div>
			<div class="wx-day-wind" style="color:{beaufortColor(day.windMax)}">{day.windMax}<span class="wx-day-unit">kn</span></div>
			<div class="wx-day-temp">{day.tMax}°<span class="wx-day-lo">/{day.tMin}°</span></div>
		</div>
		{/each}
	</div>
	{/if}

	<div class="panel-footer">
		{data.track.length} pts · 7 day track
		<br/>SUKI Dashboard Pro
	</div>
</aside>

</div><!-- /bottom-wrap -->

{/if}
</div>

<style>
	:global(html,body) { margin:0; padding:0; height:100%; background:#080c14; overflow:hidden; }

	/* CartoDB Voyager — no filter needed, tiles render naturally */

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
	.gate-icon  { display: flex; align-items: center; justify-content: center; }
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

	.map-bg {
		position: absolute; inset: 0;
		z-index: 0;
	}
	.wind-canvas {
		position: absolute; inset: 0;
		z-index: 650;   /* above Leaflet markers(600), below glass-panel(700) */
		pointer-events: none;
	}

	/* Desktop: wrapper is invisible — children keep their own absolute positioning */
	.bottom-wrap { display: contents; }

	/* ── Wind speed bar — single row at bottom of map ── */
	.wind-bar {
		position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
		z-index: 720;
		display: inline-flex; align-items: center; gap: 10px;
		padding: 5px 14px;
		background: rgba(8,12,20,0.72);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 20px;
		white-space: nowrap;
		pointer-events: none;
	}
	.wb-title {
		font-size: 9px; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.8px; color: rgba(255,255,255,0.35);
		margin-right: 4px;
	}
	.wb-item {
		display: flex; align-items: center; gap: 4px;
		font-size: 10px; color: rgba(255,255,255,0.65);
		font-variant-numeric: tabular-nums; white-space: nowrap;
	}

	/* ── Right control column ── */
	.ctrl-col {
		position: absolute; top: 70px; right: 16px;
		z-index: 800;
		display: flex; flex-direction: column; gap: 4px;
		align-items: stretch;
	}
	.ctrl-btn {
		height: 36px;
		background: rgba(8,12,20,0.78);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		border: 1px solid rgba(255,255,255,0.09);
		border-radius: 9px;
		color: rgba(255,255,255,0.6);
		cursor: pointer;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
		display: flex; align-items: center; justify-content: center;
	}
	.ctrl-btn:hover { color: #fff; background: rgba(255,255,255,0.12); }
	.ctrl-btn.active { color: #fff; background: rgba(14,165,233,0.2); border-color: rgba(14,165,233,0.5); }

	/* Map type buttons — icon + text label side by side */
	.ctrl-map {
		justify-content: flex-start;
		padding: 0 10px; gap: 7px;
		font-size: 12px; font-weight: 600;
		white-space: nowrap; min-width: 110px;
	}
	.ctrl-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
	.ctrl-label { font-size: 11px; }

	/* Zoom buttons — larger font */
	.ctrl-zoom { font-size: 18px; font-weight: 300; line-height: 1; }

	.ctrl-sep { height: 1px; background: rgba(255,255,255,0.07); margin: 2px 0; }


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
	.pill-name-block {
		display: flex; flex-direction: column; gap: 1px;
	}
	.pill-name {
		font-size: 14px; font-weight: 700;
		letter-spacing: -0.2px;
	}
	.pill-ident {
		font-size: 10px; color: rgba(255,255,255,0.35);
		letter-spacing: 0.4px;
		display: flex; align-items: center; gap: 5px;
	}
	.pill-ident-sep { color: rgba(255,255,255,0.18); }
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
	.pill-gps {
		display: flex; align-items: center; gap: 4px;
		font-size: 10px; font-weight: 600; letter-spacing: 0.3px;
		color: #fb923c;  /* amber — fallback GPS is a soft warning */
		white-space: nowrap;
		padding: 2px 7px;
		background: rgba(251,146,60,0.12);
		border: 1px solid rgba(251,146,60,0.3);
		border-radius: 20px;
	}
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

	.pill-install {
		width: 28px; height: 28px;
		background: rgba(14,165,233,0.15);
		border: 1px solid rgba(14,165,233,0.4);
		border-radius: 50%; color: #0ea5e9;
		cursor: pointer; display: flex; align-items: center; justify-content: center;
		transition: background 0.15s; flex-shrink: 0;
	}
	.pill-install:hover { background: rgba(14,165,233,0.28); }

	/* iOS "how to install" tooltip */
	.ios-tip {
		position: absolute; top: 64px; right: 16px;
		z-index: 900;
		background: rgba(8,12,20,0.95);
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
		border: 1px solid rgba(14,165,233,0.35);
		border-radius: 14px;
		padding: 12px 14px 12px 12px;
		display: flex; flex-direction: column; gap: 10px;
		min-width: 220px;
		box-shadow: 0 8px 32px rgba(0,0,0,0.6);
	}
	.ios-tip::before {
		content: '';
		position: absolute; top: -7px; right: 38px;
		width: 12px; height: 12px;
		background: rgba(8,12,20,0.95);
		border-left: 1px solid rgba(14,165,233,0.35);
		border-top: 1px solid rgba(14,165,233,0.35);
		transform: rotate(45deg);
	}
	.ios-tip-row {
		display: flex; align-items: center; gap: 8px;
		font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.3;
	}
	.ios-tip-row svg { flex-shrink: 0; color: #0ea5e9; }
	.ios-tip-close {
		position: absolute; top: 8px; right: 8px;
		background: none; border: none;
		color: rgba(255,255,255,0.3); cursor: pointer; padding: 4px;
	}
	.ios-tip-close:hover { color: rgba(255,255,255,0.7); }

	/* ── Glass side panel ── */
	.glass-panel {
		position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
		z-index: 700;
		width: 240px;
		background: rgba(8,12,20,0.78);
		backdrop-filter: blur(28px) saturate(1.6);
		-webkit-backdrop-filter: blur(28px) saturate(1.6);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 20px;
		padding: 14px;
		display: flex; flex-direction: column; gap: 0;
		max-height: calc(100dvh - 80px);
		overflow-y: auto;
	}
	.glass-panel::-webkit-scrollbar { width: 3px; }
	.glass-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

	/* Speed */
	.speed-block { padding-bottom: 10px; }
	.speed-num {
		font-size: 42px; font-weight: 700;
		letter-spacing: -2px;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.speed-unit { font-size: 12px; color: rgba(255,255,255,0.35); letter-spacing: 0.5px; margin-top: 2px; }
	.speed-meta { font-size: 10px; color: rgba(255,255,255,0.4); margin-top: 4px; }
	.status-badge {
		display: inline-flex; align-items: center; gap: 4px;
		margin-top: 8px;
		padding: 3px 10px;
		border: 1px solid;
		border-radius: 20px;
		font-size: 11px; font-weight: 700; letter-spacing: 0.3px;
		opacity: 0.9;
	}

	.divider { height: 1px; background: rgba(255,255,255,0.06); margin: 0 0 10px; }

	/* Stats grid */
	.stats-grid {
		display: grid; grid-template-columns: 1fr 1fr;
		gap: 6px; padding-bottom: 10px;
	}
	.stat-item {
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.05);
		border-radius: 10px; padding: 7px 10px;
	}
	.stat-val {
		font-size: 15px; font-weight: 600;
		letter-spacing: -0.3px;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.stat-key { font-size: 9px; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.8px; margin-top: 3px; }

	.gps-row {
		margin-top: 8px;
		font-size: 10px; color: rgba(255,255,255,0.38);
		letter-spacing: 0.2px; line-height: 1.5;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.gps-src { color: rgba(255,255,255,0.22); margin-left: 2px; }

	/* Daily weather strip */
	.wx-strip {
		display: grid; grid-template-columns: repeat(4, 1fr);
		gap: 4px; padding-bottom: 8px;
	}
	.wx-day {
		display: flex; flex-direction: column; align-items: center; gap: 3px;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.05);
		border-radius: 10px; padding: 7px 4px;
	}
	.wx-day-label {
		font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
		color: rgba(255,255,255,0.35);
	}
	.wx-day-icon { font-size: 18px; line-height: 1; }
	.wx-day-wind {
		font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
	}
	.wx-day-unit { font-size: 8px; font-weight: 400; color: rgba(255,255,255,0.4); margin-left: 1px; }
	.wx-day-temp {
		font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums;
		color: rgba(255,255,255,0.8);
	}
	.wx-day-lo { color: rgba(255,255,255,0.35); }

	.panel-footer {
		font-size: 10px; color: rgba(255,255,255,0.2);
		text-align: center; line-height: 1.6;
	}

	/* ── Mobile ── */
	@media (max-width: 600px) {
		.glass-panel {
			/* Reset absolute positioning so it participates in flex column of .bottom-wrap */
			position: relative; left: auto; right: auto; top: auto; bottom: auto;
			transform: none;
			width: 100%; border-radius: 16px 16px 0 0;
			max-height: 42dvh;
			padding: 12px 14px 10px;
			gap: 0;
		}

		/* Speed + Wind side-by-side on one row */
		.speed-block {
			display: flex; align-items: baseline; gap: 18px;
			padding-bottom: 8px; flex-wrap: wrap;
		}
.speed-num { font-size: 32px; }
		.speed-unit { font-size: 11px; }
		.speed-meta { font-size: 10px; margin-top: 2px; }
		.status-badge { margin-top: 4px; font-size: 10px; padding: 2px 8px; }

		.divider { margin: 0 0 8px; }

		/* Single-row flex — all tiles in one line regardless of count */
		.stats-grid {
			display: flex; gap: 4px; padding-bottom: 8px;
		}
		.stat-item {
			flex: 1 1 0; min-width: 0;
			padding: 5px 4px; border-radius: 8px;
		}
		.stat-val  { font-size: 11px; }
		.stat-key  { font-size: 7px; margin-top: 2px; }

		.panel-footer { display: none; }

		/* ctrl-col: tighten up, hide text labels — icon only on mobile */
		.ctrl-col { top: 58px; right: 12px; gap: 3px; }
		.ctrl-map { min-width: unset; padding: 0; justify-content: center; }
		.ctrl-label { display: none; }
		.ctrl-btn { height: 34px; width: 34px; border-radius: 8px; }
		.ctrl-map { width: 34px; }

		/* Bottom stack: flex column anchors wind legend directly above glass panel */
		.bottom-wrap {
			display: flex; flex-direction: column; align-items: center;
			position: fixed; bottom: 0; left: 0; right: 0;
			z-index: 720; pointer-events: none;
		}
		.wind-bar {
			position: static; transform: none;
			margin-bottom: 6px;
			gap: 8px; padding: 4px 10px;
		}
		.glass-panel { pointer-events: auto; }
		.wb-item { font-size: 9px; }

		.pill-bar  { top: 12px; }
		.pill-trip { display: none; }
		.ios-tip   { top: 56px; right: 12px; min-width: 200px; }
		.ios-tip::before { right: 34px; }
	}
</style>
