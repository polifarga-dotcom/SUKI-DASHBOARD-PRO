<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { vrmData } from '$lib/stores/vrm.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { currentBoat } from '$lib/stores/boat.js';
	import { supabase } from '$lib/supabase.js';
	import { haversine, destinationPoint, bearingTo } from '$lib/utils/geo.js';
	import { rad2deg, fmtDepth, ms2kn, bearingCardinal, m2ft, scopeStatus } from '$lib/utils/units.js';
	import { unitSystem } from '$lib/stores/userSettings.js';
	import type { AnchorHistoryEntry } from '$lib/types.js';
	import { boatIconSvg } from '$lib/utils/boatIcons.js';

	// ── DOM refs ──────────────────────────────────────────────────────────────
	let mapBoxEl:   HTMLDivElement;
	let mapWrapEl:  HTMLDivElement;
	let mapInnerEl: HTMLDivElement;

	// ── Leaflet (plain vars, not reactive) ────────────────────────────────────
	let L:            any = null;
	let map:          any = null;
	let boatMarker:   any = null;
	let ancMarker:    any = null;
	let radiusCircle: any = null;
	let chainLine:    any = null;
	let crumbLine:    any = null;
	let histLayers:   any[] = [];

	// ── Reactive UI state ─────────────────────────────────────────────────────
	let mapReady      = $state(false);
	let followMode    = $state(true);
	let muteActive    = $state(false);
	let cfgLoaded     = $state(false);
	let breadcrumb    = $state<[number, number][]>([]);
	let anchorHistory    = $state<AnchorHistoryEntry[]>([]);
	let selectedHistory  = $state<number | null>(null); // index into anchorHistory currently previewed on map
	let showGPSInput     = $state(false);
	let manLatStr     = $state('');
	let manLonStr     = $state('');

	// Map box pixel dimensions for overlay positioning
	let mapBoxW = $state(360);
	let mapBoxH = $state(270);

	// Local slider copies — only saved to Supabase on release / step-click
	let localChain    = $state(0);
	let localRadius   = $state(50);
	let localBearing  = $state(0);
	let bearingManual = $state(false);
	let isDragging    = $state(false); // true while a slider thumb is being dragged

	// Seconds ticker for the "boat position updated X ago" overlay
	let nowMs = $state(Date.now());

	// Wind text overlay positioning (DOM ref + state)
	let windTextEl: HTMLDivElement;
	let windTextX = $state(0);
	let windTextY = $state(0);
	let windTextVisible = $state(false);
	let windTextContent = $state('');

	// ── Derived boat/anchor values ────────────────────────────────────────────
	const t   = $derived($telemetry);
	const vrm = $derived($vrmData);
	const cfg = $derived($anchorConfig);

	const boatLat  = $derived(t?.nav_lat  ?? vrm?.gps_lat ?? null);
	const boatLon  = $derived(t?.nav_lon  ?? vrm?.gps_lon ?? null);
	const hdgDeg   = $derived(rad2deg(t?.nav_hdg_rad ?? null) ?? 0);
	const awaDeg   = $derived(rad2deg(t?.env_awa_rad ?? null));
	const awsKn    = $derived(t?.env_aws_ms != null ? parseFloat(ms2kn(t.env_aws_ms)) : null);
	const depth    = $derived(t?.env_depth_m ?? null);
	const depthStr = $derived(fmtDepth(depth));
	const alarming = $derived(cfg?.alarming ?? false);

	// Scope = Chain / Depth ratio
	// Uses depth captured when anchor was set (stored in DB)
	// Only recalculates when chain slider is moved; does not change with current depth
	const scope = $derived(
		cfg?.anchor_depth_at_set != null && cfg.anchor_depth_at_set > 0.5 && localChain > 0
			? (localChain / cfg.anchor_depth_at_set).toFixed(1)
			: null
	);

	// ── Projected anchor position (slider preview, also used when saving to DB) ──
	// Always computed from current bearing/chain + boat position.
	// Used when: (a) anchor not yet set (preview), (b) user is actively dragging a slider.
	const projAncLat = $derived(
		boatLat != null && boatLon != null
			? destinationPoint(boatLat, boatLon, localBearing, localChain)[0]
			: cfg?.lat ?? null
	);
	const projAncLon = $derived(
		boatLat != null && boatLon != null
			? destinationPoint(boatLat, boatLon, localBearing, localChain)[1]
			: cfg?.lon ?? null
	);

	// ── Live anchor position shown on the map ────────────────────────────────
	// When anchor is active and sliders are NOT being dragged, show the stored
	// DB position (cfg.lat/cfg.lon) — this prevents the chain line from acting
	// as an involuntary heading indicator. While dragging, show the projected
	// preview so the user sees real-time feedback.
	const liveAncLat = $derived(
		cfg?.active && !isDragging && cfg.lat != null
			? cfg.lat
			: (projAncLat ?? null)
	);
	const liveAncLon = $derived(
		cfg?.active && !isDragging && cfg.lon != null
			? cfg.lon
			: (projAncLon ?? null)
	);

	// Distance / bearing use the stored DB position (cfg.lat/lon) so the DIST
	// cell shows real scope after setting, not the slider preview.
	const ancDistM = $derived(
		cfg?.lat != null && cfg?.lon != null && boatLat != null && boatLon != null
			? haversine(boatLat, boatLon, cfg.lat, cfg.lon) : null
	);
	const ancBearingDeg = $derived(
		cfg?.lat != null && cfg?.lon != null && boatLat != null && boatLon != null
			? bearingTo(boatLat, boatLon, cfg.lat, cfg.lon) : null
	);

	// GPS string for the live anchor preview
	const ancGPSStr = $derived(
		liveAncLat != null && liveAncLon != null
			? `${Math.abs(liveAncLat).toFixed(5)}° ${liveAncLat >= 0 ? 'N' : 'S'},  `
			+ `${Math.abs(liveAncLon).toFixed(5)}° ${liveAncLon >= 0 ? 'E' : 'W'}`
			: null
	);

	// Label: "Anchor" when active & settled (not dragging); "Preview" otherwise
	const ancGPSLabel = $derived(
		cfg?.active && !isDragging ? 'Anchor' : 'Preview'
	);

	// Leaflet markers for wind and compass (positioned on alarm radius ring)
	let windArrowMarker: any = null;  // Rotated arrow only
	let compassMarker: any = null;

	// ── "Boat position updated X ago" timestamp ───────────────────────────────
	const posAgeSec = $derived(
		t?.updated_at != null
			? Math.round((nowMs - new Date(t.updated_at).getTime()) / 1000)
			: null
	);
	const posAgeStr = $derived(
		posAgeSec == null  ? null
		: posAgeSec < 5    ? 'just now'
		: posAgeSec < 60   ? `${posAgeSec} seconds ago`
		: posAgeSec < 3600 ? `${Math.floor(posAgeSec / 60)} min ago`
		: `${Math.floor(posAgeSec / 3600)} h ago`
	);

	// ── Init local sliders once when cfg first arrives ────────────────────────
	$effect(() => {
		if (cfg && !cfgLoaded) {
			localChain   = cfg.chain_length_m;
			localRadius  = cfg.radius_m;
			localBearing = cfg.bearing_deg;
			cfgLoaded = true;
		}
	});

	// ── Seconds ticker ────────────────────────────────────────────────────────
	$effect(() => {
		const id = setInterval(() => { nowMs = Date.now(); }, 1000);
		return () => clearInterval(id);
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
		const _deps = [boatLat, boatLon, hdgDeg, cfg, alarming, breadcrumb,
		               localChain, localRadius, localBearing, liveAncLat, liveAncLon,
		               anchorHistory, isDragging, selectedHistory, awaDeg, awsKn];
		updateMarkers();
	});

	// ── Icon helpers ─────────────────────────────────────────────────────────
	function boatIconHtml(rot: number) {
		const iconType = ($currentBoat as any)?.boat_icon ?? 'monohull';
		const svg = boatIconSvg(iconType, '#00c8ff');
		return `<div style="width:30px;height:45px;transform:rotate(${rot}deg);transform-origin:50% 50%;transition:transform .25s linear;filter:drop-shadow(0 1px 4px rgba(0,0,0,.8));">${svg.replace('width="40" height="60"', 'width="30" height="45"')}</div>`;
	}

	function anchorIconHtml(rot: number) {
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

	function histAnchorIconHtml(rot: number, num: number) {
		return `<div style="width:22px;height:28px;transform:rotate(${rot}deg);transform-origin:50% 100%;opacity:0.5;">
			<svg viewBox="0 0 32 40" width="22" height="28" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,.5))">
				<path d="M16 0 C7 0 0 7 0 16 c0 11 16 24 16 24 s16-13 16-24 C32 7 25 0 16 0 z" fill="#6b7280" stroke="#222" stroke-width="1.5"/>
				<text x="16" y="19" text-anchor="middle" dominant-baseline="middle"
				      font-size="13" font-weight="700" fill="#fff" font-family="sans-serif">${num}</text>
			</svg>
		</div>`;
	}

	function updateMarkers() {
		if (!map || !L) return;
		const rot = hdgDeg;

		// ── Boat marker ──
		if (boatLat != null && boatLon != null) {
			const icon = L.divIcon({ className: '', iconSize: [30, 45], iconAnchor: [15, 22], html: boatIconHtml(rot) });
			if (!boatMarker) {
				boatMarker = L.marker([boatLat, boatLon], { icon, zIndexOffset: 100 }).addTo(map);
			} else {
				boatMarker.setLatLng([boatLat, boatLon]);
				boatMarker.setIcon(icon);
			}
			if (followMode) {
				// When anchor alarm is active, keep anchor centered; otherwise follow boat
				if (alarming && liveAncLat != null && liveAncLon != null) {
					map.panTo([liveAncLat, liveAncLon], { animate: true, duration: 0.3 });
				} else if (!alarming) {
					map.panTo([boatLat, boatLon], { animate: true, duration: 0.3 });
				}
			}
		}

		// ── Anchor marker — always visible when we have a position ──
		if (liveAncLat != null && liveAncLon != null) {
			const aIcon = L.divIcon({ className: '', iconSize: [24, 30], iconAnchor: [12, 30], html: anchorIconHtml(rot) });
			if (!ancMarker) {
				ancMarker = L.marker([liveAncLat, liveAncLon], { icon: aIcon }).addTo(map);
			} else {
				ancMarker.setLatLng([liveAncLat, liveAncLon]);
				ancMarker.setIcon(aIcon);
			}

			// Alarm radius circle — only when anchor is active
			if (cfg?.active) {
				const col = alarming ? '#ef4444' : '#00c8ff';
				if (!radiusCircle) {
					radiusCircle = L.circle([liveAncLat, liveAncLon], {
						radius: localRadius, color: col, fillColor: col, fillOpacity: 0.04,
						weight: 2, dashArray: '6 4', interactive: false
					}).addTo(map);
				} else {
					radiusCircle.setLatLng([liveAncLat, liveAncLon]);
					radiusCircle.setRadius(localRadius);
					(radiusCircle.options as any).color = col;
					(radiusCircle.options as any).fillColor = col;
					radiusCircle.redraw();
				}

				// Chain line: boat → anchor
				if (boatLat != null && boatLon != null) {
					const pts: [number, number][] = [[boatLat, boatLon], [liveAncLat, liveAncLon]];
					if (!chainLine) {
						chainLine = L.polyline(pts, {
							color: '#00c8ff', weight: 2, dashArray: '4,4', opacity: 0.85, interactive: false
						}).addTo(map);
					} else {
						chainLine.setLatLngs(pts);
					}
				}
			} else {
				// Anchor not active — remove radius + chain line
				radiusCircle?.remove(); radiusCircle = null;
				chainLine?.remove();    chainLine    = null;
			}
		} else {
			ancMarker?.remove();    ancMarker    = null;
			radiusCircle?.remove(); radiusCircle = null;
			chainLine?.remove();    chainLine    = null;
		}

		// ── Breadcrumb polyline ──
		if (breadcrumb.length > 1) {
			if (!crumbLine) {
				crumbLine = L.polyline(breadcrumb, { color: '#00c8ff', weight: 1.5, opacity: 0.5 }).addTo(map);
			} else {
				crumbLine.setLatLngs(breadcrumb);
			}
		}

		// ── Wind & Compass markers (on alarm radius ring) ──
		if (liveAncLat != null && liveAncLon != null && cfg?.active) {
			// Wind marker: positioned at AWA direction on the alarm radius ring
			// Uses left/top positioning like the old app (NOT Leaflet markers)
			if (awaDeg != null && awsKn != null) {
				// Geographic bearing: AWA is relative to boat heading, so add hdgDeg for true north
				// Wind comes FROM this direction → marker placed there, arrow points inward
				const windBearing = ((hdgDeg + awaDeg) % 360 + 360) % 360;
				const windPos = destinationPoint(liveAncLat, liveAncLon, windBearing, localRadius);

				// Arrow rotation: inside map-wrap (rotated -hdgDeg), so compensate:
				// visual = -hdgDeg + svgRot → we want visual = awaDeg+180 (inward) → svgRot = hdgDeg+awaDeg+180
				const arrowRot = ((hdgDeg + awaDeg + 180) % 360 + 360) % 360;
				const arrowHtml = `<svg viewBox="0 0 24 24" width="27" height="27" fill="#f59e0b" stroke="#0a1929" stroke-width="1.4" stroke-linejoin="round" style="transform:rotate(${arrowRot}deg); display:block;">
					<path d="M12 3 L19 19 L12 16 L5 19 Z"/>
				</svg>`;
				const arrowIcon = L.divIcon({ className: '', iconSize: [27, 27], iconAnchor: [13, 13], html: arrowHtml });
				if (!windArrowMarker) {
					windArrowMarker = L.marker(windPos, { icon: arrowIcon, interactive: false }).addTo(map);
				} else {
					windArrowMarker.setLatLng(windPos);
					windArrowMarker.setIcon(arrowIcon);
				}

				// Text overlay — positioned 15m BEYOND the arrow (outward from anchor)
				// so it doesn't cover the arrow itself.
				// Same rotation correction as arrow position.
				const windTextPos = destinationPoint(liveAncLat, liveAncLon, windBearing, localRadius + 25);
				const pt = map.latLngToContainerPoint(windTextPos);
				const θ = hdgDeg * Math.PI / 180;
				const dx = pt.x - 0.75 * mapBoxW;  // relative to map-wrap center
				const dy = pt.y - 0.75 * mapBoxH;
				// Rotate by +hdgDeg to undo the CSS rotation and get map-box coords
				windTextX = dx * Math.cos(θ) + dy * Math.sin(θ) + 0.5 * mapBoxW;
				windTextY = -dx * Math.sin(θ) + dy * Math.cos(θ) + 0.5 * mapBoxH;
				windTextContent = `${(awsKn as number).toFixed(1)} kn`;
				windTextVisible = true;
			} else {
				windArrowMarker?.remove();
				windArrowMarker = null;
				windTextVisible = false;
			}

			// Compass marker: positioned at North (0°), at localRadius distance from anchor
			const compassPos = destinationPoint(liveAncLat, liveAncLon, 0, localRadius);
			const compassHtml = `<div style="background:rgba(0,0,0,0.78); color:#00c8ff; font-size:10px; font-weight:700; padding:2px 6px; border-radius:10px; border:1px solid #00c8ff; letter-spacing:1px; white-space:nowrap;">N</div>`;
			const compassIcon = L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: compassHtml });
			if (!compassMarker) {
				compassMarker = L.marker(compassPos, { icon: compassIcon, interactive: false }).addTo(map);
			} else {
				compassMarker.setLatLng(compassPos);
				compassMarker.setIcon(compassIcon);
			}
		} else {
			windArrowMarker?.remove(); windArrowMarker = null;
			compassMarker?.remove(); compassMarker = null;
			const textEl = document.querySelector('.wind-text-overlay') as HTMLElement | null;
			if (textEl) textEl.style.opacity = '0';
		}

		// ── History anchor preview (only the button-selected entry) ──
		histLayers.forEach(l => l.remove());
		histLayers = [];
		if (selectedHistory != null && anchorHistory[selectedHistory]) {
			const h = anchorHistory[selectedHistory];
			const hIcon = L.divIcon({ className: '', iconSize: [22, 28], iconAnchor: [11, 28], html: histAnchorIconHtml(rot, selectedHistory + 1) });
			histLayers.push(
				L.marker([h.lat, h.lon], { icon: hIcon, interactive: false }).addTo(map),
				L.circle([h.lat, h.lon], {
					radius: h.radius_m, color: '#6b7280', fillColor: '#6b7280',
					fillOpacity: 0.04, weight: 1.5, dashArray: '5,4', opacity: 0.5,
					interactive: false
				}).addTo(map)
			);
		}
	}

	// ── Supabase helpers ──────────────────────────────────────────────────────
	function boatId() { return $currentBoat?.id ?? null; }

	async function saveConfig(patch: Record<string, unknown>) {
		const id = boatId();
		if (!id) return;
		const { data } = await supabase.from('anchor_config').update(patch).eq('boat_id', id).select().single();
		if (data) anchorConfig.set(data);
	}

	async function loadAnchorHistory() {
		const id = boatId();
		if (!id) return;
		const { data } = await supabase
			.from('anchor_history')
			.select('*')
			.eq('boat_id', id)
			.order('cleared_at', { ascending: false })
			.limit(3);
		if (data) anchorHistory = data as AnchorHistoryEntry[];
	}

	async function setAnchor() {
		if (!boatLat || !boatLon) return;
		const [ancLat, ancLon] = destinationPoint(boatLat, boatLon, localBearing, localChain);
		await saveConfig({
			lat: ancLat, lon: ancLon, active: true, alarming: false,
			chain_length_m: localChain, radius_m: localRadius, bearing_deg: localBearing,
			anchor_depth_at_set: depth
		});
		if (map) map.setView([ancLat, ancLon], Math.max(map.getZoom(), 16));
	}

	async function clearAnchor() {
		const id = boatId();
		if (!id) { await saveConfig({ active: false, alarming: false }); return; }

		if (cfg?.lat != null && cfg?.lon != null) {
			// Write to history
			await supabase.from('anchor_history').insert({
				boat_id: id,
				lat: cfg.lat, lon: cfg.lon,
				radius_m: cfg.radius_m,
				chain_length_m: cfg.chain_length_m,
				bearing_deg: cfg.bearing_deg
			});
			// Prune: keep only latest 3
			const { data: old } = await supabase
				.from('anchor_history')
				.select('id')
				.eq('boat_id', id)
				.order('cleared_at', { ascending: false })
				.range(3, 100);
			if (old && old.length > 0) {
				await supabase.from('anchor_history').delete().in('id', old.map((r: any) => r.id));
			}
		}

		// active=false — lat/lon stays in DB so Restore works
		await saveConfig({ active: false, alarming: false });
		await loadAnchorHistory();
	}

	async function restoreAnchor() {
		await saveConfig({ active: true, alarming: false });
		if (map && cfg?.lat != null && cfg?.lon != null)
			map.setView([cfg.lat, cfg.lon], Math.max(map.getZoom(), 16));
	}

	async function setAnchorByGPS() {
		const lat = parseFloat(manLatStr);
		const lon = parseFloat(manLonStr);
		if (!isFinite(lat) || !isFinite(lon)) return;
		await saveConfig({ lat, lon, active: true, alarming: false, anchor_depth_at_set: depth });
		if (boatLat != null && boatLon != null) {
			localBearing = Math.round(bearingTo(boatLat, boatLon, lat, lon)) % 360;
			localChain   = Math.min(Math.round(haversine(boatLat, boatLon, lat, lon)), 120);
			bearingManual = true;
			await saveConfig({ bearing_deg: localBearing, chain_length_m: localChain });
		}
		showGPSInput = false;
		if (map) map.setView([lat, lon], Math.max(map.getZoom(), 16));
	}

	async function muteAlarm() {
		// Set alarm_telegram_muted=true in DB — anchor-check will stop Telegram
		// escalation but keep firing Pushover and keep alarming=true visible in the UI.
		// The local muteActive flag hides the full-screen overlay for 30 s so the
		// user can interact with the map, but the alarm ring stays red.
		muteActive = true;
		await saveConfig({ alarm_telegram_muted: true });
		setTimeout(() => { muteActive = false; }, 30000);
	}

	function snapBearingToHeading() {
		localBearing = hdgDeg;
		bearingManual = false;
		saveConfig({ bearing_deg: hdgDeg });
	}

	// ── Anchor history helpers ───────────────────────────────────────────────
	function relativeTime(isoStr: string): string {
		const diffMs = Date.now() - new Date(isoStr).getTime();
		const h = Math.floor(diffMs / 3_600_000);
		if (h < 1)  return '<1h';
		if (h < 24) return `${h}h`;
		const d = Math.floor(h / 24);
		if (d < 30) return `${d}d`;
		return `${Math.floor(d / 30)}mo`;
	}

	async function adoptHistory(h: AnchorHistoryEntry) {
		localChain    = h.chain_length_m;
		localRadius   = h.radius_m;
		localBearing  = h.bearing_deg;
		bearingManual = true;
		await saveConfig({
			lat: h.lat, lon: h.lon,
			radius_m:       h.radius_m,
			chain_length_m: h.chain_length_m,
			bearing_deg:    h.bearing_deg,
			active: true, alarming: false
		});
		selectedHistory = null;
		if (map) map.setView([h.lat, h.lon], Math.max(map.getZoom(), 16));
	}

	function jumpToBoat() {
		followMode = true;
		if (!map) return;
		// When alarm active: center on anchor and zoom to show radius at ~70%
		if (alarming && liveAncLat != null && liveAncLon != null && localRadius > 0) {
			const targetRadius = localRadius / 0.7;
			const bounds = L.latLng(liveAncLat, liveAncLon).toBounds(targetRadius * 2);
			map.fitBounds(bounds, { animate: true, padding: [0, 0] });
		} else if (boatLat != null && boatLon != null) {
			map.setView([boatLat, boatLon], map.getZoom(), { animate: true });
		}
	}

	// ── Leaflet init ──────────────────────────────────────────────────────────
	onMount(async () => {
		const id = boatId();

		// Load recent track from history (last 2h, max 200 points)
		if (id) {
			supabase
				.from('telemetry_history')
				.select('nav_lat,nav_lon,recorded_at')
				.eq('boat_id', id)
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
		}

		// Load anchor history
		await loadAnchorHistory();

		await new Promise(r => requestAnimationFrame(r));
		await new Promise(r => requestAnimationFrame(r));

		const rect = mapBoxEl.getBoundingClientRect();
		if (rect.width > 0) { mapBoxW = rect.width; mapBoxH = rect.height; }

		L = await import('leaflet') as typeof import('leaflet');
		await import('leaflet/dist/leaflet.css');

		// dragging: false — we replace Leaflet's north-up drag with a heading-aware
		// custom pan handler below. touchZoom stays enabled for pinch-to-zoom.
		map = L.map(mapInnerEl, { zoomControl: false, attributionControl: false, dragging: false });

		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 22 }).addTo(map);
		L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
			maxNativeZoom: 18, maxZoom: 22, opacity: 0.9
		}).addTo(map);

		map.on('zoomend moveend resize', () => {
			const r = mapBoxEl?.getBoundingClientRect();
			if (r && r.width > 80) { mapBoxW = r.width; mapBoxH = r.height; }
		});

		// ── Heading-aware custom pan ─────────────────────────────────────────────
		// The map wrapper is CSS-rotated by -hdgDeg for heading-up display.
		// Leaflet's native drag doesn't know about the CSS rotation and always pans
		// in north-up screen coordinates. This causes "dragging up = pan north"
		// regardless of heading.
		//
		// Fix: capture raw screen-space delta (dx, dy) and rotate it by +heading
		// before calling panBy — this maps screen-up to the boat's forward direction.
		//
		//   map_dx = dx·cos(h) - dy·sin(h)
		//   map_dy = dx·sin(h) + dy·cos(h)
		//
		// Single-finger / mouse → custom pan. Two-finger pinch → Leaflet TouchZoom.
		let _panning = false, _lx = 0, _ly = 0, _touchCount = 0;

		function _applyPan(dx: number, dy: number) {
			const h = hdgDeg * Math.PI / 180;
			const c = Math.cos(h), s = Math.sin(h);
			map.panBy([-(dx * c - dy * s), -(dx * s + dy * c)], { animate: false, noMoveStart: true });
		}
		function _onMouseDown(e: MouseEvent) {
			if (e.button !== 0) return;
			_panning = true; _lx = e.clientX; _ly = e.clientY;
			followMode = false;
			e.preventDefault();
		}
		function _onMouseMove(e: MouseEvent) {
			if (!_panning) return;
			_applyPan(e.clientX - _lx, e.clientY - _ly);
			_lx = e.clientX; _ly = e.clientY;
		}
		function _onMouseUp() { _panning = false; }
		function _onTouchStart(e: TouchEvent) {
			_touchCount = e.touches.length;
			if (_touchCount === 1) {
				_panning = true; _lx = e.touches[0].clientX; _ly = e.touches[0].clientY;
				followMode = false;
			} else { _panning = false; } // 2-finger: Leaflet TouchZoom handles pinch
		}
		function _onTouchMove(e: TouchEvent) {
			_touchCount = e.touches.length;
			if (!_panning || _touchCount !== 1) { _panning = false; return; }
			const dx = e.touches[0].clientX - _lx;
			const dy = e.touches[0].clientY - _ly;
			_lx = e.touches[0].clientX; _ly = e.touches[0].clientY;
			_applyPan(dx, dy);
		}
		function _onTouchEnd(e: TouchEvent) { if (e.touches.length === 0) _panning = false; }

		mapInnerEl.addEventListener('mousedown',  _onMouseDown);
		document  .addEventListener('mousemove',  _onMouseMove);
		document  .addEventListener('mouseup',    _onMouseUp);
		mapInnerEl.addEventListener('touchstart', _onTouchStart, { passive: true });
		mapInnerEl.addEventListener('touchmove',  _onTouchMove,  { passive: true });
		mapInnerEl.addEventListener('touchend',   _onTouchEnd,   { passive: true });

		// Store refs for cleanup
		(map as any)._customPanCleanup = () => {
			document.removeEventListener('mousemove', _onMouseMove);
			document.removeEventListener('mouseup',   _onMouseUp);
		};

		const lat = boatLat ?? cfg?.lat ?? 54.0;
		const lon = boatLon ?? cfg?.lon ?? 10.0;
		map.setView([lat, lon], 16);

		await new Promise(r => setTimeout(r, 100));
		map.invalidateSize();
		mapReady = true;
	});

	onDestroy(() => {
		(map as any)?._customPanCleanup?.();
		map?.remove();
	});
</script>

<svelte:head><title>Anchor · SUKI PRO</title></svelte:head>

<!-- ── Full-screen alarm overlay ── -->
{#if alarming && !muteActive}
<div class="alarm-overlay">
	<div class="alarm-icon">⚓</div>
	<div class="alarm-title">ANCHOR ALARM</div>
	<div class="alarm-dist">{scope ? `Scope: ${scope}:1` : 'Position unknown'}</div>
	{#if cfg?.alarm_telegram_muted}
		<div class="alarm-muted-badge">Telegram muted · Pushover active</div>
	{/if}
	<button class="alarm-mute-btn" onclick={muteAlarm}>Mute Telegram (30s)</button>
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
		<!-- Wind speed text overlay - positioned by Svelte state binding -->
		<div class="wind-text-overlay" style="left: {windTextX}px; top: {windTextY}px; opacity: {windTextVisible ? 1 : 0};">{windTextContent}</div>

		<!-- Map control buttons -->
		<div class="map-btns">
			<button class="map-btn" title="Zoom in"  onclick={() => map?.zoomIn()}>+</button>
			<button class="map-btn" title="Zoom out" onclick={() => map?.zoomOut()}>−</button>
			<button class="map-btn follow-btn" class:active={followMode}
				title="Center on boat" onclick={jumpToBoat}>
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

		<!-- Anchor / Preview GPS coordinates — top-left overlay -->
		{#if ancGPSStr != null}
			<div class="anc-gps-overlay">
				<span class="anc-gps-label">{ancGPSLabel}</span>
				<span class="anc-gps-val">{ancGPSStr}</span>
			</div>
		{/if}

		<!-- "Boat position updated X ago" timestamp overlay (bottom-right) -->
		{#if posAgeStr != null}
			<div class="pos-age" class:stale={posAgeSec != null && posAgeSec > 120}>
				boat position updated {posAgeStr}
			</div>
		{/if}

		{#if !mapReady}
		<div class="map-loading">Loading map…</div>
		{/if}
	</div>

	<!-- ── Data cells ── -->
	<div class="data-cells">
		<!-- DIST: live boat-to-anchor distance (from cfg.lat/cfg.lon, not slider) -->
		<div class="cell">
			<div class="cell-label">DIST</div>
			<div class="cell-val">
				{#if ancDistM != null}
					{$unitSystem === 'imperial' ? (ancDistM * 3.28084).toFixed(0) + ' ft' : ancDistM.toFixed(0) + ' m'}
				{:else}
					—
				{/if}
			</div>
		</div>

		<!-- DEPTH: live current water depth (from telemetry) -->
		<div class="cell">
			<div class="cell-label">DEPTH</div>
			<div class="cell-val">
				{#if depth != null}
					{$unitSystem === 'imperial' ? (depth * 3.28084).toFixed(1) + ' ft' : depth.toFixed(1) + ' m'}
				{:else}
					—
				{/if}
			</div>
		</div>

		<!-- SCOPE: chain/depth ratio with safety color -->
		<div class="cell" style="background-color: {scopeStatus(scope).status === 'safe' ? 'rgba(34, 197, 94, 0.1)' : scopeStatus(scope).status === 'marginal' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)'};">
			<div class="cell-label" style="color: {scopeStatus(scope).color}">{scopeStatus(scope).label}</div>
			<div class="cell-val" style="color: {scopeStatus(scope).color}; font-weight: 600;">
				{scope ? scope + ':1' : '—'}
			</div>
		</div>

		<!-- BEARING: direction to anchor -->
		<div class="cell">
			<div class="cell-label">BEARING</div>
			<div class="cell-val">
				{ancBearingDeg != null ? bearingCardinal(ancBearingDeg) + ' ' + ancBearingDeg.toFixed(0) + '°' : '—'}
			</div>
		</div>
	</div>

	<!-- ── Control buttons ── -->
	<div class="ctrl-row">
		{#if !cfg?.active}
			<button class="ctrl-btn primary" onclick={setAnchor} disabled={!boatLat}>⚓ Set Anchor</button>
			{#if cfg?.lat != null}
				<button class="ctrl-btn restore" onclick={restoreAnchor} title="Restore last anchor alarm">
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M3 7v6h6"/>
						<path d="M21 17A9 9 0 0 0 6 5.3L3 8"/>
					</svg>
					Restore
				</button>
			{/if}
		{:else}
			<button class="ctrl-btn danger" onclick={clearAnchor}>Clear Anchor</button>
		{/if}
		<button class="ctrl-btn gps-btn" class:active={showGPSInput}
			onclick={() => { showGPSInput = !showGPSInput; }}
			title="Set anchor by GPS coordinates">
			<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/>
				<circle cx="12" cy="10" r="3"/>
			</svg>
			GPS
		</button>
		{#if alarming}
			<button class="ctrl-btn warning" onclick={muteAlarm}>Mute</button>
		{/if}
	</div>

	<!-- ── Manual GPS input (collapsible) ── -->
	{#if showGPSInput}
		<div class="gps-input-block">
			<div class="gps-input-row">
				<label class="gps-lbl">Lat</label>
				<input class="gps-field" type="text" inputmode="decimal" placeholder="54.12345"
					bind:value={manLatStr} />
			</div>
			<div class="gps-input-row">
				<label class="gps-lbl">Lon</label>
				<input class="gps-field" type="text" inputmode="decimal" placeholder="10.12345"
					bind:value={manLonStr} />
			</div>
			<button class="ctrl-btn primary" onclick={setAnchorByGPS}
				disabled={!isFinite(parseFloat(manLatStr)) || !isFinite(parseFloat(manLonStr))}>
				Set Anchor Here
			</button>
		</div>
	{/if}

	<!-- ── Sliders ── -->
	<div class="sliders">

		<div class="srow">
			<div class="slabel">Distance from Anchor <span class="sval">{$unitSystem === 'imperial' ? m2ft(localChain) : localChain.toFixed(1)} {$unitSystem === 'imperial' ? 'ft' : 'm'}</span></div>
			<div class="sctrl">
				<button class="sbtn" onclick={() => {
					localChain = Math.max(0, localChain - 1);
					const patch: Record<string, unknown> = { chain_length_m: localChain };
					if (cfg?.active && projAncLat != null) Object.assign(patch, { lat: projAncLat, lon: projAncLon });
					saveConfig(patch);
				}}>−</button>
				<input type="range" min="0" max="120" step="1" value={localChain}
					oninput={(e) => { localChain = +(e.target as HTMLInputElement).value; isDragging = true; }}
					onchange={() => {
						isDragging = false;
						const patch: Record<string, unknown> = { chain_length_m: localChain };
						if (cfg?.active && projAncLat != null) Object.assign(patch, { lat: projAncLat, lon: projAncLon });
						saveConfig(patch);
					}} />
				<button class="sbtn" onclick={() => {
					localChain = Math.min(120, localChain + 1);
					const patch: Record<string, unknown> = { chain_length_m: localChain };
					if (cfg?.active && projAncLat != null) Object.assign(patch, { lat: projAncLat, lon: projAncLon });
					saveConfig(patch);
				}}>+</button>
			</div>
		</div>

		<div class="srow">
			<div class="slabel">Alarm radius <span class="sval">{$unitSystem === 'imperial' ? m2ft(localRadius) : localRadius.toFixed(1)} {$unitSystem === 'imperial' ? 'ft' : 'm'}</span></div>
			<div class="sctrl">
				<button class="sbtn" onclick={() => { localRadius = Math.max(10, localRadius - 5); saveConfig({ radius_m: localRadius }); }}>−</button>
				<input type="range" min="10" max="500" step="5" value={localRadius}
					oninput={(e) => { localRadius = +(e.target as HTMLInputElement).value; }}
					onchange={() => saveConfig({ radius_m: localRadius })} />
				<button class="sbtn" onclick={() => { localRadius = Math.min(500, localRadius + 5); saveConfig({ radius_m: localRadius }); }}>+</button>
			</div>
		</div>

		<div class="srow">
			<div class="slabel">
				Bearing <span class="sval">{localBearing.toFixed(0)}° {bearingCardinal(localBearing)}</span>
				{#if bearingManual}
					<button class="reset-btn" onclick={snapBearingToHeading}>↑ Heading</button>
				{:else}
					<span class="auto-badge">auto</span>
				{/if}
			</div>
			<div class="sctrl">
				<button class="sbtn" onclick={() => {
					localBearing = ((localBearing - 1 + 360) % 360);
					bearingManual = true;
					const patch: Record<string, unknown> = { bearing_deg: localBearing };
					if (cfg?.active && projAncLat != null) Object.assign(patch, { lat: projAncLat, lon: projAncLon });
					saveConfig(patch);
				}}>−</button>
				<input type="range" min="0" max="359" step="1" value={localBearing}
					oninput={(e) => { localBearing = +(e.target as HTMLInputElement).value; bearingManual = true; isDragging = true; }}
					onchange={() => {
						isDragging = false;
						const patch: Record<string, unknown> = { bearing_deg: localBearing };
						if (cfg?.active && projAncLat != null) Object.assign(patch, { lat: projAncLat, lon: projAncLon });
						saveConfig(patch);
					}} />
				<button class="sbtn" onclick={() => {
					localBearing = ((localBearing + 1) % 360);
					bearingManual = true;
					const patch: Record<string, unknown> = { bearing_deg: localBearing };
					if (cfg?.active && projAncLat != null) Object.assign(patch, { lat: projAncLat, lon: projAncLon });
					saveConfig(patch);
				}}>+</button>
			</div>
		</div>

	</div>

	<!-- ── Past anchors (history buttons) ── -->
	{#if anchorHistory.length > 0}
	<div class="past-anchors">
		<span class="past-label">Past</span>
		{#each anchorHistory as h, i}
			<button class="hist-btn" class:sel={selectedHistory === i}
				onclick={() => {
					if (selectedHistory === i) {
						selectedHistory = null;
					} else {
						selectedHistory = i;
						followMode = false;
						if (map) map.setView([h.lat, h.lon], Math.max(map.getZoom(), 15));
					}
				}}>
				#{i + 1} · {relativeTime(h.cleared_at)}
			</button>
		{/each}
		{#if selectedHistory != null}
			<button class="hist-use-btn" onclick={() => adoptHistory(anchorHistory[selectedHistory!])}>
				<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/>
					<circle cx="12" cy="10" r="3"/>
				</svg>
				Set as Anchor
			</button>
		{/if}
	</div>
	{/if}
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
	.alarm-muted-badge {
		font-size: 12px; color: rgba(255,220,100,0.9);
		background: rgba(0,0,0,0.3); padding: 4px 12px; border-radius: 4px;
		letter-spacing: 0.5px;
	}

	/* ── Page ── */
	.anchor-page { display:flex; flex-direction:column; gap:10px; }

	/* ── Map box ── */
	.map-box {
		position: relative;
		aspect-ratio: 4 / 3;
		border-radius: var(--r);
		@media (max-width: 480px) { aspect-ratio: unset; height: calc(56.25vw + 5px); }
		overflow: hidden;
		border: 1px solid var(--border);
		background: #111;
	}
	.map-box.alarming { border-color: var(--red); }

	.map-wrap {
		position: absolute;
		inset: -25%;
		transition: transform 0.35s ease-out;
	}
	.map-inner { width:100%; height:100%; }

	/* ── DOM overlay ── */
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

	/* Wind speed text overlay (DOM-based, positioned with left/top like old app's .anc-awa-marker) */
	.wind-text-overlay {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		transform: translate(-50%, -50%);
		font-size: 16px;
		color: var(--amber);
		font-weight: 700;
		background: rgba(0, 0, 0, 0.8);
		padding: 2px 6px;
		border-radius: 3px;
		white-space: nowrap;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.2s ease-in-out;
		z-index: 450;
	}

	/* ── Boat position timestamp overlay ── */
	.pos-age {
		position: absolute;
		bottom: 6px;
		right: 8px;
		z-index: 600;
		font-size: 10px;
		color: rgba(255, 255, 255, 0.75);
		background: rgba(0, 0, 0, 0.4);
		padding: 2px 6px;
		border-radius: 3px;
		pointer-events: none;
		white-space: nowrap;
	}
	.pos-age.stale { color: rgba(255, 160, 0, 0.9); }

	/* ── Map control buttons ── */
	.map-btns {
		position: absolute; right: 10px; top: 10px; z-index: 600;
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

	/* ── Anchor GPS overlay (top-left on map) ── */
	.anc-gps-overlay {
		position: absolute; top: 8px; left: 8px; z-index: 600;
		display: flex; align-items: center; gap: 5px;
		background: rgba(0,0,0,0.65); backdrop-filter: blur(4px);
		padding: 3px 7px; border-radius: 5px;
		pointer-events: none;
	}
	.anc-gps-label {
		color: var(--muted); font-size: 8px; text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.anc-gps-val { color: var(--text); font-variant-numeric: tabular-nums; font-size: 10px; }

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
	.ctrl-btn.restore { background: var(--card2); color: var(--text); border: 1px solid var(--border); flex: 0 0 auto; padding: 10px 14px; display: flex; align-items: center; gap: 5px; }
	.ctrl-btn.gps-btn { background: var(--card2); color: var(--muted); border: 1px solid var(--border); flex: 0 0 auto; padding: 10px 14px; display: flex; align-items: center; gap: 5px; }
	.ctrl-btn.gps-btn.active { color: var(--amber); border-color: var(--amber); }

	/* ── GPS input block ── */
	.gps-input-block {
		display: flex; flex-direction: column; gap: 8px;
		padding: 12px;
		background: var(--card); border: 1px solid var(--border);
		border-radius: var(--r);
	}
	.gps-input-row { display: flex; align-items: center; gap: 10px; }
	.gps-lbl { font-size: 11px; color: var(--muted); width: 28px; flex-shrink: 0; }
	.gps-field {
		flex: 1; padding: 8px 10px;
		background: var(--card2); border: 1px solid var(--border);
		border-radius: 6px; color: var(--text); font-size: 13px;
		outline: none;
	}
	.gps-field:focus { border-color: var(--accent); }

	/* ── Sliders ── */
	.sliders {
		background:var(--card); border:1px solid var(--border);
		border-radius:var(--r); padding:8px; display:flex; flex-direction:column; gap:8px;
	}
	.srow   { display:flex; flex-direction:column; gap:4px; }
	.slabel { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:8px; }
	.sval   { font-size:12px; font-weight:600; color:var(--text); }
	.sctrl  { display:flex; align-items:center; gap:8px; }
	.sbtn {
		width:32px; height:32px; background:var(--card2); border:1px solid var(--border);
		border-radius:8px; color:var(--text); font-size:16px; font-weight:300; cursor:pointer;
		display:flex; align-items:center; justify-content:center; flex-shrink:0;
	}
	.sbtn:active { border-color:var(--accent); color:var(--accent); }
	.auto-badge { font-size:9px; color:var(--green); border:1px solid var(--green); border-radius:3px; padding:1px 5px; }
	.reset-btn  { font-size:10px; color:var(--accent); background:none; border:1px solid var(--accent); border-radius:4px; padding:1px 6px; cursor:pointer; }

	/* ── Past anchors row ── */
	.past-anchors {
		display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
	}
	.past-label {
		font-size: 10px; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0;
	}
	.hist-btn {
		padding: 5px 10px;
		background: var(--card2); border: 1px solid var(--border);
		border-radius: 6px; color: var(--muted);
		font-size: 11px; cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
		white-space: nowrap;
	}
	.hist-btn.sel {
		border-color: #6b7280; color: var(--text);
		background: rgba(107, 114, 128, 0.15);
	}
	.hist-use-btn {
		display: flex; align-items: center; gap: 4px;
		padding: 5px 11px; margin-left: auto;
		background: rgba(107, 114, 128, 0.12); border: 1px solid #6b7280;
		border-radius: 6px; color: var(--text);
		font-size: 11px; font-weight: 600; cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
		white-space: nowrap;
	}
	.hist-use-btn:hover, .hist-use-btn:active {
		border-color: var(--accent); color: var(--accent);
	}

	input[type="range"] {
		flex:1; -webkit-appearance:none; appearance:none;
		height:4px; background:var(--border); border-radius:2px; outline:none;
	}
	input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance:none; appearance:none;
		width:20px; height:14px; border-radius:4px;
		background:var(--accent); cursor:pointer;
		border:2px solid var(--bg); box-shadow:0 0 0 1px var(--accent);
	}
</style>
