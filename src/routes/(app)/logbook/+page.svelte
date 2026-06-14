<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import 'leaflet/dist/leaflet.css';
	import { supabase } from '$lib/supabase.js';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { vrmData } from '$lib/stores/vrm.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { currentBoat, boatRole } from '$lib/stores/boat.js';
	import { inreachPoints } from '$lib/stores/inreach.js';
	import { latestWave } from '$lib/stores/weather.js';
	import { activeTrip, tripEntries, allTrips, logLoaded } from '$lib/stores/logbook.js';
	import { isOnline, pendingCount, syncInProgress } from '$lib/stores/offline.js';
	import { haversine } from '$lib/utils/geo.js';
	import { queueLogEntry, getPendingCount, syncPendingEntries, subscribeToOnline } from '$lib/offline.js';
	import type { LogEntry, LogTrip } from '$lib/types.js';
	import TripCharts, { type ChartPoint } from '$lib/components/charts/TripCharts.svelte';

	// ── Reactive store snapshots ──────────────────────────────────────────────
	const t    = $derived($telemetry);
	const vrm  = $derived($vrmData);
	const cfg  = $derived($anchorConfig);
	const boat = $derived($currentBoat);
	const role = $derived($boatRole);
	const pts  = $derived($inreachPoints);
	const wave = $derived($latestWave);

	// ── UI state ──────────────────────────────────────────────────────────────
	let showTripModal   = $state(false);
	let showEntryModal  = $state(false);
	let saving          = $state(false);
	let autoLogTimer: ReturnType<typeof setInterval>;

	// ── Realtime subscription (receives server-inserted entries) ──────────────
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let realtimeChannel: any = null;

	function subscribeToActiveTrip(tripId: string) {
		if (realtimeChannel) supabase.removeChannel(realtimeChannel);
		realtimeChannel = supabase
			.channel(`trip-${tripId}`)
			.on(
				'postgres_changes',
				{ event: 'INSERT', schema: 'public', table: 'log_entries', filter: `trip_id=eq.${tripId}` },
				(payload: { new: LogEntry }) => {
					const entry = payload.new;
					tripEntries.update(es => {
						if (es.find(e => e.id === entry.id)) return es;
						pushLog(`[srv] ${entry.lat?.toFixed(4) ?? '?'} ${entry.lon?.toFixed(4) ?? '?'}  ${entry.sog_kn?.toFixed(1) ?? '-'} kn`);
						return [entry, ...es].slice(0, 200);
					});
				}
			)
			.subscribe();
	}

	function unsubscribeTrip() {
		if (realtimeChannel) {
			supabase.removeChannel(realtimeChannel);
			realtimeChannel = null;
		}
	}

	// ── Auto-trip toggle (server handles all detection + start/stop) ─────────
	// localStorage provides a fast initial value; DB (cfg.auto_trip_enabled) overrides it.
	let autoEnabled = $state(
		typeof localStorage !== 'undefined'
			? localStorage.getItem('autoTripEnabled') !== 'false'
			: true
	);

	// ── Terminal log ──────────────────────────────────────────────────────────
	const MAX_LOG = 10;
	let terminalLines = $state<string[]>([]);
	function pushLog(msg: string) {
		const ts = new Date().toLocaleTimeString('en', {
			hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
		});
		terminalLines = [`${ts}  ${msg}`, ...terminalLines].slice(0, MAX_LOG);
	}

	// Sync autoEnabled from DB (authoritative) — fires once when cfg first loads,
	// then whenever the config store is refreshed (e.g. another session toggled it).
	$effect(() => {
		if (cfg?.auto_trip_enabled != null) {
			autoEnabled = cfg.auto_trip_enabled;
		}
	});

	// Mirror autoEnabled to localStorage (fast initial value on next page load)
	$effect(() => {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('autoTripEnabled', String(autoEnabled));
		}
	});

	// Persist the toggle to Supabase — server reads this to enable/disable auto-trip
	async function setAutoEnabled(val: boolean) {
		autoEnabled = val;
		anchorConfig.update(c => c ? { ...c, auto_trip_enabled: val } : c);
		const boatId = cfg?.boat_id ?? boat?.id;
		if (boatId) {
			await supabase
				.from('anchor_config')
				.update({ auto_trip_enabled: val })
				.eq('boat_id', boatId);
		}
	}

	// ── Past trips filter + sort ──────────────────────────────────────────────
	type FilterRange = 'week' | 'month' | 'year' | 'all';
	let filterRange = $state<FilterRange>('all');
	let sortDesc    = $state(true);

	const filteredPastTrips = $derived(() => {
		let ts = $allTrips.filter(tr => tr.ended_at != null);
		const now = Date.now();
		const days: Record<FilterRange, number> = { week: 7, month: 30, year: 365, all: Infinity };
		const limit = days[filterRange] * 86_400_000;
		if (filterRange !== 'all') ts = ts.filter(t => now - new Date(t.started_at).getTime() < limit);
		return sortDesc ? ts : [...ts].reverse();
	});

	// ── Expanded trip state ───────────────────────────────────────────────────
	let expandedTripId    = $state<string | null>(null);
	let expandedEntries   = $state<LogEntry[]>([]);   // first + last entry
	let expandedLoading   = $state(false);
	let expandedEntryCount = $state(0);
	let showAllEntries    = $state(false);
	let expandedAllEntries = $state<LogEntry[]>([]);
	let allEntriesLoading  = $state(false);

	// ── Wind chart data (loaded with expanded trip) ───────────────────────────
	// Legacy type kept for baro mini-charts; chartPoints is the full dataset
	type WindPoint = {
		t:   number;
		w:   number | null;   // TWS kn
		d:   number | null;   // TWD deg
		b:   number | null;   // baro hPa
		sog: number | null;   // SOG kn
		aws: number | null;   // AWS kn
		awa: number | null;   // AWA deg (0–360)
	};
	let expandedWindData = $state<WindPoint[]>([]);
	let chartPoints      = $state<ChartPoint[]>([]);

	// ── Monthly grouping ──────────────────────────────────────────────────────
	type MonthGroup = { year: number; month: number; label: string; trips: LogTrip[]; totalNm: number; tripCount: number };
	type YearGroup  = { year: number; months: MonthGroup[]; totalNm: number; tripCount: number };

	let collapsedYears  = $state<Set<number>>(new Set());
	let collapsedMonths = $state<Set<string>>(new Set());

	const groupedTrips = $derived(() => {
		const ts = filteredPastTrips();
		const byYear = new Map<number, Map<number, LogTrip[]>>();
		for (const tr of ts) {
			const d = new Date(tr.started_at);
			const y = d.getFullYear(), m = d.getMonth();
			if (!byYear.has(y)) byYear.set(y, new Map());
			const byM = byYear.get(y)!;
			if (!byM.has(m)) byM.set(m, []);
			byM.get(m)!.push(tr);
		}
		const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
		const years: YearGroup[] = [];
		for (const [year, byM] of [...byYear.entries()].sort((a,b) => b[0]-a[0])) {
			const months: MonthGroup[] = [];
			for (const [month, trips] of [...byM.entries()].sort((a,b) => b[0]-a[0])) {
				const totalNm = trips.reduce((s, t) => s + (t.total_nm ?? 0), 0);
				months.push({ year, month, label: MONTHS[month], trips, totalNm, tripCount: trips.length });
			}
			const totalNm = months.reduce((s, m) => s + m.totalNm, 0);
			years.push({ year, months, totalNm, tripCount: months.reduce((s,m) => s + m.tripCount, 0) });
		}
		return years;
	});

	function toggleYear(year: number) {
		const s = new Set(collapsedYears);
		if (s.has(year)) s.delete(year); else s.add(year);
		collapsedYears = s;
	}
	function toggleMonth(key: string) {
		const s = new Set(collapsedMonths);
		if (s.has(key)) s.delete(key); else s.add(key);
		collapsedMonths = s;
	}

	// ── SVG mini wind chart ───────────────────────────────────────────────────
	function svgWindChart(pts: WindPoint[], width = 320, height = 56): string {
		const speeds = pts.map(p => p.w).filter((v): v is number => v != null);
		if (speeds.length < 2) return '';
		const maxW = Math.max(...speeds, 5);
		const n = pts.length;
		const pad = { l: 24, r: 4, t: 6, b: 18 };
		const W = width - pad.l - pad.r;
		const H = height - pad.t - pad.b;
		const xs = pts.map((_, i) => pad.l + (i / (n - 1)) * W);
		const ys = pts.map(p => p.w != null ? pad.t + H - (p.w / maxW) * H : null);

		// Area fill path
		let area = `M${xs[0]},${pad.t + H}`;
		for (let i = 0; i < n; i++) if (ys[i] != null) area += ` L${xs[i]},${ys[i]}`;
		area += ` L${xs[n-1]},${pad.t + H} Z`;

		// Line path
		let line = ''; let inGap = true;
		for (let i = 0; i < n; i++) {
			if (ys[i] != null) { line += `${inGap ? 'M' : 'L'}${xs[i]},${ys[i]}`; inGap = false; }
			else inGap = true;
		}

		// Y-axis labels (0 and max)
		const gridY = [0, 0.5, 1].map(f => ({ y: pad.t + H - f * H, val: Math.round(f * maxW) }));

		// X-axis time labels (first and last)
		const t0 = pts[0]?.t, t1 = pts[n-1]?.t;
		const fmtT = (ms: number) => new Date(ms).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });

		return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${height}px;display:block">
  <defs>
    <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#00c8ff" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#00c8ff" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  ${gridY.map(g => `<line x1="${pad.l}" y1="${g.y}" x2="${pad.l+W}" y2="${g.y}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>
  <text x="${pad.l-3}" y="${g.y+3.5}" font-size="8" fill="rgba(255,255,255,.3)" text-anchor="end">${g.val}</text>`).join('')}
  <path d="${area}" fill="url(#wg)"/>
  <path d="${line}" fill="none" stroke="#00c8ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  ${t0 ? `<text x="${pad.l}" y="${height-3}" font-size="8" fill="rgba(255,255,255,.3)">${fmtT(t0)}</text>` : ''}
  ${t1 ? `<text x="${pad.l+W}" y="${height-3}" font-size="8" fill="rgba(255,255,255,.3)" text-anchor="end">${fmtT(t1)}</text>` : ''}
</svg>`;
	}

	// ── SVG mini baro chart ───────────────────────────────────────────────────
	function svgBaroChart(pts: WindPoint[], width = 320, height = 40): string {
		const baros = pts.map(p => p.b).filter((v): v is number => v != null);
		if (baros.length < 2) return '';
		const minB = Math.min(...baros) - 1;
		const maxB = Math.max(...baros) + 1;
		const n = pts.length;
		const pad = { l: 32, r: 4, t: 4, b: 14 };
		const W = width - pad.l - pad.r;
		const H = height - pad.t - pad.b;
		const xs = pts.map((_, i) => pad.l + (i / (n-1)) * W);
		const ys = pts.map(p => p.b != null ? pad.t + H - ((p.b - minB) / (maxB - minB)) * H : null);
		let line = ''; let inGap = true;
		for (let i = 0; i < n; i++) {
			if (ys[i] != null) { line += `${inGap ? 'M' : 'L'}${xs[i]},${ys[i]}`; inGap = false; }
			else inGap = true;
		}
		const fmtB = (v: number) => v.toFixed(0);
		return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${height}px;display:block">
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t+H}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>
  <text x="${pad.l-3}" y="${pad.t+4}" font-size="8" fill="rgba(255,255,255,.3)" text-anchor="end">${fmtB(maxB)}</text>
  <text x="${pad.l-3}" y="${pad.t+H+1}" font-size="8" fill="rgba(255,255,255,.3)" text-anchor="end">${fmtB(minB)}</text>
  <path d="${line}" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
	}

	// Generic area/line chart — reusable for SOG and AWS
	function svgAreaChart(
		vals: (number | null)[],
		times: number[],
		color: string,
		label: string,
		unit: string,
		width = 320, height = 56,
	): string {
		const nums = vals.filter((v): v is number => v != null);
		if (nums.length < 2) return '';
		const maxV = Math.max(...nums, 1);
		const n = vals.length;
		const pad = { l: 24, r: 4, t: 6, b: 18 };
		const W = width - pad.l - pad.r;
		const H = height - pad.t - pad.b;
		const xs = vals.map((_, i) => pad.l + (i / (n - 1)) * W);
		const ys = vals.map(v => v != null ? pad.t + H - (v / maxV) * H : null);

		let area = `M${xs[0]},${pad.t + H}`;
		for (let i = 0; i < n; i++) if (ys[i] != null) area += ` L${xs[i]},${ys[i]}`;
		area += ` L${xs[n-1]},${pad.t + H} Z`;

		let line = ''; let gap = true;
		for (let i = 0; i < n; i++) {
			if (ys[i] != null) { line += `${gap ? 'M' : 'L'}${xs[i]},${ys[i]}`; gap = false; }
			else gap = true;
		}

		const gridY = [0, 0.5, 1].map(f => ({ y: pad.t + H - f * H, val: (f * maxV).toFixed(f === 0 ? 0 : 1) }));
		const fmtT  = (ms: number) => new Date(ms).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
		const id    = `ag-${color.replace('#','')}`;

		return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${height}px;display:block">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  ${gridY.map(g => `<line x1="${pad.l}" y1="${g.y}" x2="${pad.l+W}" y2="${g.y}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>
  <text x="${pad.l-3}" y="${g.y+3.5}" font-size="8" fill="rgba(255,255,255,.3)" text-anchor="end">${g.val}</text>`).join('')}
  <path d="${area}" fill="url(#${id})"/>
  <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  ${times[0]       ? `<text x="${pad.l}" y="${height-3}" font-size="8" fill="rgba(255,255,255,.3)">${fmtT(times[0])}</text>` : ''}
  ${times[n-1]     ? `<text x="${pad.l+W}" y="${height-3}" font-size="8" fill="rgba(255,255,255,.3)" text-anchor="end">${fmtT(times[n-1])}</text>` : ''}
</svg>`;
	}

	// AWA polar scatter — points on a 180° half-circle (port=left, stbd=right)
	function svgAwaChart(pts: WindPoint[], width = 320, height = 110): string {
		// Normalise AWA to –180…+180 (negative = port, positive = stbd)
		const valid = pts
			.filter(p => p.awa != null)
			.map(p => {
				let a = p.awa!;
				if (a > 180) a -= 360;   // 270° → –90°
				return { a, aws: p.aws ?? p.w ?? 0 };
			});
		if (valid.length < 2) return '';

		const cx = width / 2, cy = height - 8;
		const R  = Math.min(cx - 20, cy - 10);
		// Arc path (semicircle top)
		const arcPath = `M${cx - R},${cy} A${R},${R} 0 0 1 ${cx + R},${cy}`;
		// Tick marks every 30°
		const ticks = [-150,-120,-90,-60,-30,0,30,60,90,120,150].map(deg => {
			const rad = (deg - 90) * Math.PI / 180;
			const x1 = cx + (R-4) * Math.cos(rad), y1 = cy + (R-4) * Math.sin(rad);
			const x2 = cx + R     * Math.cos(rad), y2 = cy + R     * Math.sin(rad);
			const xl = cx + (R+9) * Math.cos(rad), yl = cy + (R+9) * Math.sin(rad);
			const lbl = Math.abs(deg) === 90 ? '90' : Math.abs(deg) === 30 ? (deg<0?'P':'S') : '';
			return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,.15)" stroke-width="1"/>
${lbl ? `<text x="${xl.toFixed(1)}" y="${(yl+3).toFixed(1)}" font-size="7" fill="rgba(255,255,255,.3)" text-anchor="middle">${lbl}</text>` : ''}`;
		}).join('');

		// Scatter dots — radius encodes AWS, color encodes tack
		const maxAws = Math.max(...valid.map(v => v.aws), 5);
		const dots = valid.map(v => {
			const rad = (v.a - 90) * Math.PI / 180;
			const r2  = R * 0.85;
			const x   = cx + r2 * Math.cos(rad);
			const y   = cy + r2 * Math.sin(rad);
			const col = v.a < 0 ? '#34d399' : '#f97316';   // port green / stbd orange
			const sz  = 1.5 + (v.aws / maxAws) * 2.5;
			return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sz.toFixed(1)}" fill="${col}" fill-opacity="0.6"/>`;
		}).join('');

		// Forward direction line
		const fwdPath = `M${cx},${cy} L${cx},${cy - R * 0.92}`;

		return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${height}px;display:block">
  <path d="${arcPath}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1"/>
  <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy-R}" stroke="rgba(255,255,255,.1)" stroke-width="1" stroke-dasharray="3,3"/>
  ${ticks}
  ${dots}
  <path d="${fwdPath}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.5" stroke-linecap="round"/>
  <text x="${cx-R-2}" y="${cy+10}" font-size="8" fill="rgba(52,211,153,.7)" text-anchor="start">Port</text>
  <text x="${cx+R+2}" y="${cy+10}" font-size="8" fill="rgba(249,115,22,.7)" text-anchor="end">Stbd</text>
</svg>`;
	}

	// ── Trip map (lazy Leaflet, built when trip is expanded) ──────────────────
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let L_ref: any = null;
	let expandedMapEl = $state<HTMLDivElement | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let expandedMapInst: any = null;
	let expandedMapPositions = $state<{ lat: number; lon: number }[]>([]);

	async function ensureLeaflet() {
		if (!L_ref) {
			L_ref = await import('leaflet');
			// CSS is imported statically at module level — no dynamic inject needed
		}
		return L_ref as typeof import('leaflet');
	}

	async function initTripMap() {
		if (!expandedMapEl || expandedMapPositions.length === 0) return;
		if (expandedMapInst) { expandedMapInst.remove(); expandedMapInst = null; }

		const L = await ensureLeaflet();

		await new Promise(r => setTimeout(r, 50));
		if (!expandedMapEl) return;  // may have been removed while awaiting

		expandedMapInst = L.map(expandedMapEl, { zoomControl: false, attributionControl: false });

		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxNativeZoom: 19, maxZoom: 22,
		}).addTo(expandedMapInst);

		L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
			maxNativeZoom: 18, maxZoom: 22, opacity: 0.9,
		}).addTo(expandedMapInst);

		const latlngs = expandedMapPositions.map(p => [p.lat, p.lon] as [number, number]);

		if (latlngs.length > 1) {
			L.polyline(latlngs, { color: '#00c8ff', weight: 2.5, opacity: 0.85 }).addTo(expandedMapInst);
		}

		// Start marker — green
		if (latlngs.length > 0) {
			const startIcon = L.divIcon({
				className: '',
				html: '<div style="width:10px;height:10px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 0 4px rgba(34,197,94,.8)"></div>',
				iconSize: [10, 10], iconAnchor: [5, 5],
			});
			L.marker(latlngs[0], { icon: startIcon }).addTo(expandedMapInst);
		}

		// End marker — accent
		if (latlngs.length > 1) {
			const endIcon = L.divIcon({
				className: '',
				html: '<div style="width:12px;height:12px;border-radius:50%;background:#00c8ff;border:2px solid #fff;box-shadow:0 0 6px rgba(0,200,255,.8)"></div>',
				iconSize: [12, 12], iconAnchor: [6, 6],
			});
			L.marker(latlngs[latlngs.length - 1], { icon: endIcon }).addTo(expandedMapInst);
		}

		expandedMapInst.invalidateSize();

		if (latlngs.length > 1) {
			expandedMapInst.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24], maxZoom: 14 });
		} else {
			expandedMapInst.setView(latlngs[0], 11);
		}
	}

	function centerTripMap() {
		if (!expandedMapInst || !L_ref || expandedMapPositions.length === 0) return;
		const L = L_ref as typeof import('leaflet');
		const latlngs = expandedMapPositions.map(p => [p.lat, p.lon] as [number, number]);
		if (latlngs.length > 1) {
			expandedMapInst.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24], maxZoom: 14 });
		} else {
			expandedMapInst.setView(latlngs[0], 11);
		}
	}

	async function toggleTripExpand(tripId: string) {
		if (expandedTripId === tripId) {
			// Collapse
			expandedMapInst?.remove();
			expandedMapInst = null;
			expandedTripId    = null;
			expandedEntries   = [];
			expandedAllEntries = [];
			expandedMapPositions = [];
			expandedWindData  = []; chartPoints = []; expandedNotedEntries = [];
			expandedEntryCount = 0;
			showAllEntries    = false;
			return;
		}
		// Cleanup previous
		expandedMapInst?.remove();
		expandedMapInst = null;

		expandedTripId    = tripId;
		showAllEntries    = false;
		allEntriesLoading = false;
		expandedLoading   = true;
		expandedEntries   = [];
		expandedAllEntries = [];
		expandedMapPositions = [];
		expandedEntryCount = 0;

		// Parallel: first entry, last entry, count, all positions for map, wind/baro data
		const [firstRes, lastRes, countRes, posRes, windRes] = await Promise.all([
			supabase.from('log_entries').select('*')
				.eq('trip_id', tripId).order('logged_at', { ascending: true }).limit(1),
			supabase.from('log_entries').select('*')
				.eq('trip_id', tripId).order('logged_at', { ascending: false }).limit(1),
			supabase.from('log_entries').select('id', { count: 'exact', head: true })
				.eq('trip_id', tripId),
			supabase.from('log_entries').select('lat, lon')
				.eq('trip_id', tripId)
				.not('lat', 'is', null)
				.not('lon', 'is', null)
				.order('logged_at', { ascending: true })
				.limit(1000),
			supabase.from('log_entries')
				.select([
					'logged_at', 'sog_kn', 'wind_speed_kn', 'wind_dir_deg',
					'apparent_wind_speed_kn', 'apparent_wind_angle_deg',
					'baro_hpa', 'depth_m', 'batt_soc', 'air_temp_c', 'water_temp_c',
					'engine_on', 'engine_rpm', 'engine_sb_rpm', 'wave_height_m', 'wave_period_s',
				].join(', '))
				.eq('trip_id', tripId)
				.order('logged_at', { ascending: true })
				.limit(600),
		]);

		const first = firstRes.data?.[0] as LogEntry | undefined;
		const last  = lastRes.data?.[0]  as LogEntry | undefined;

		if (first && last && first.id !== last.id) {
			expandedEntries = [first, last];
		} else if (first) {
			expandedEntries = [first];
		}

		expandedEntryCount   = countRes.count ?? 0;
		expandedMapPositions = (posRes.data ?? []).filter(
			(p): p is { lat: number; lon: number } => p.lat != null && p.lon != null
		);

		// Legacy WindPoint (for existing mini SVG charts)
		expandedWindData = (windRes.data ?? []).map((r: Record<string, unknown>) => ({
			t:   new Date(r.logged_at as string).getTime(),
			w:   r.wind_speed_kn           as number | null,
			d:   r.wind_dir_deg            as number | null,
			b:   r.baro_hpa                as number | null,
			sog: r.sog_kn                  as number | null,
			aws: r.apparent_wind_speed_kn  as number | null,
			awa: r.apparent_wind_angle_deg as number | null,
		}));

		// Full ChartPoint dataset for interactive TripCharts
		chartPoints = (windRes.data ?? []).map((r: Record<string, unknown>) => ({
			t:          new Date(r.logged_at as string).getTime(),
			sog:        r.sog_kn                  as number | null,
			tws:        r.wind_speed_kn            as number | null,
			twd:        r.wind_dir_deg             as number | null,
			aws:        r.apparent_wind_speed_kn   as number | null,
			awa:        r.apparent_wind_angle_deg  as number | null,
			baro:       r.baro_hpa                 as number | null,
			depth:      r.depth_m                  as number | null,
			batt_soc:   r.batt_soc                 as number | null,
			air_temp:   r.air_temp_c               as number | null,
			water_temp: r.water_temp_c             as number | null,
			eng_on:     !!(r.engine_on),
			eng_rpm:    r.engine_rpm               as number | null,
			eng_sb_rpm: r.engine_sb_rpm            as number | null,
			wave_h:     r.wave_height_m            as number | null,
			wave_period_s: r.wave_period_s         as number | null,
		}));
		expandedLoading = false;

		// Load entries that have notes (lightweight query, separate from chart data)
		const { data: notedData } = await supabase
			.from('log_entries')
			.select('id, logged_at, notes')
			.eq('trip_id', tripId)
			.not('notes', 'is', null)
			.order('logged_at', { ascending: true });
		expandedNotedEntries = (notedData ?? []) as Array<{ id: string; logged_at: string; notes: string }>;

		await tick();   // DOM renders map container + entry list
		if (expandedMapEl) await initTripMap();
	}

	async function loadAllEntries(tripId: string) {
		showAllEntries    = true;
		allEntriesLoading = true;
		expandedAllEntries = [];
		const { data } = await supabase.from('log_entries').select('*')
			.eq('trip_id', tripId).order('logged_at', { ascending: false }).limit(500);
		expandedAllEntries = (data ?? []) as LogEntry[];
		allEntriesLoading = false;
	}

	// ── Edit trip ──────────────────────────────────────────────────────────────
	let editingTrip  = $state<LogTrip | null>(null);
	let editName     = $state('');
	let editFromPort = $state('');
	let editToPort   = $state('');
	let editNotes    = $state('');

	function openEditTrip(trip: LogTrip, e: Event) {
		e.stopPropagation();
		editingTrip  = trip;
		editName     = trip.name ?? '';
		editFromPort = trip.from_port ?? '';
		editToPort   = trip.to_port ?? '';
		editNotes    = trip.notes ?? '';
	}

	async function saveEditTrip() {
		if (!editingTrip || saving) return;
		saving = true;
		const patch: Partial<LogTrip> = {
			name:      editName.trim()     || null,
			from_port: editFromPort.trim() || null,
			to_port:   editToPort.trim()   || null,
			notes:     editNotes.trim()    || null,
		};
		await supabase.from('log_trips').update(patch)
			.eq('id', editingTrip.id).eq('boat_id', editingTrip.boat_id);
		allTrips.update(ts => ts.map(t => t.id === editingTrip!.id ? { ...t, ...patch } : t));
		saving = false;
		editingTrip = null;
	}

	async function deleteTripSingle(trip: LogTrip, e: Event) {
		e.stopPropagation();
		if (!confirm(`Delete "${trip.name ?? 'Unnamed trip'}" and all its log entries?`)) return;
		saving = true;
		await supabase.from('log_entries').delete().eq('trip_id', trip.id).eq('boat_id', trip.boat_id);
		await supabase.from('log_trips').delete().eq('id', trip.id).eq('boat_id', trip.boat_id);
		allTrips.update(ts => ts.filter(t => t.id !== trip.id));
		if (expandedTripId === trip.id) {
			expandedMapInst?.remove(); expandedMapInst = null;
			expandedTripId = null; expandedEntries = []; expandedMapPositions = [];
		}
		saving = false;
	}

	// ── Trip merge ────────────────────────────────────────────────────────────
	// Returns the trip that ended immediately before `trip` started, if it's
	// eligible to merge (both auto, gap < 4 h, previous trip is closed).
	function mergeCandidateFor(trip: LogTrip): LogTrip | null {
		if (!trip.started_at) return null;
		const sorted = [...$allTrips].sort(
			(a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
		);
		const idx = sorted.findIndex(t => t.id === trip.id);
		if (idx < 0) return null;
		const prev = sorted[idx + 1]; // next in desc-order = earlier trip
		if (!prev || !prev.ended_at) return null;
		const gapMs = new Date(trip.started_at).getTime() - new Date(prev.ended_at).getTime();
		if (gapMs < 0 || gapMs > 4 * 60 * 60_000) return null;
		return prev;
	}

	async function mergeWithPrevious(trip: LogTrip, e: Event) {
		e.stopPropagation();
		const prev = mergeCandidateFor(trip);
		if (!prev) return;
		const gapMin = Math.round(
			(new Date(trip.started_at).getTime() - new Date(prev.ended_at).getTime()) / 60_000
		);
		if (!confirm(
			`Merge "${trip.name ?? 'this trip'}" into the previous trip?\n` +
			`Gap: ${gapMin} min — all entries will be combined and the duplicate trip deleted.`
		)) return;
		saving = true;
		try {
			// 1. Re-assign all entries from trip → prev
			await supabase.from('log_entries')
				.update({ trip_id: prev.id })
				.eq('trip_id', trip.id).eq('boat_id', trip.boat_id);

			// 2. Recalculate stats for the surviving trip
			const { data: entries } = await supabase.from('log_entries')
				.select('distance_nm, engine_on, sog_kn, logged_at')
				.eq('trip_id', prev.id).order('logged_at', { ascending: true });
			const rows = entries ?? [];
			const totalNm  = +rows.reduce((s, r) => s + (r.distance_nm ?? 0), 0).toFixed(3);
			const sailNm   = +rows.filter(r => !r.engine_on).reduce((s, r) => s + (r.distance_nm ?? 0), 0).toFixed(3);
			const motorNm  = +rows.filter(r =>  r.engine_on).reduce((s, r) => s + (r.distance_nm ?? 0), 0).toFixed(3);
			const sogsArr  = rows.filter(r => r.sog_kn != null).map(r => r.sog_kn as number);
			const maxSog   = sogsArr.length ? +Math.max(...sogsArr).toFixed(2) : (prev.max_sog_kn ?? null);
			const avgSog   = sogsArr.length ? +(sogsArr.reduce((a, b) => a + b, 0) / sogsArr.length).toFixed(2) : null;

			// 3. Update the surviving trip: close with trip B's endpoint + merged stats
			await supabase.from('log_trips').update({
				ended_at:   trip.ended_at,
				to_port:    trip.to_port,
				total_nm:   totalNm,
				sail_nm:    sailNm,
				motor_nm:   motorNm,
				max_sog_kn: maxSog,
				avg_sog_kn: avgSog,
				auto_slow_since: null,
				is_auto: false,
			}).eq('id', prev.id).eq('boat_id', prev.boat_id);

			// 4. Delete the now-empty duplicate trip
			await supabase.from('log_trips').delete().eq('id', trip.id).eq('boat_id', trip.boat_id);

			// Update local store
			allTrips.update(ts => ts
				.filter(t => t.id !== trip.id)
				.map(t => t.id === prev.id
					? { ...t, ended_at: trip.ended_at, to_port: trip.to_port, total_nm: totalNm,
					    sail_nm: sailNm, motor_nm: motorNm, max_sog_kn: maxSog, avg_sog_kn: avgSog }
					: t
				)
			);
			if (expandedTripId === trip.id) {
				expandedMapInst?.remove(); expandedMapInst = null;
				expandedTripId = null; expandedEntries = []; expandedMapPositions = [];
			}
		} finally {
			saving = false;
		}
	}

	// ── Selection mode ─────────────────────────────────────────────────────────
	let selectionMode   = $state(false);
	let selectedTripIds = $state<Set<string>>(new Set());

	function toggleSelect(tripId: string) {
		const s = new Set(selectedTripIds);
		if (s.has(tripId)) s.delete(tripId); else s.add(tripId);
		selectedTripIds = s;
	}

	function selectAll() {
		selectedTripIds = new Set(filteredPastTrips().map(t => t.id));
	}

	function clearSelection() {
		selectedTripIds = new Set();
		selectionMode = false;
	}

	async function deleteSelected() {
		if (selectedTripIds.size === 0 || saving) return;
		if (!confirm(`Delete ${selectedTripIds.size} trip${selectedTripIds.size === 1 ? '' : 's'} and all their log entries? This cannot be undone.`)) return;
		saving = true;
		const ids = [...selectedTripIds];
		await supabase.from('log_entries').delete().in('trip_id', ids).eq('boat_id', boat!.id);
		await supabase.from('log_trips').delete().in('id', ids).eq('boat_id', boat!.id);
		allTrips.update(ts => ts.filter(t => !selectedTripIds.has(t.id)));
		if (expandedTripId && selectedTripIds.has(expandedTripId)) {
			expandedMapInst?.remove(); expandedMapInst = null;
			expandedTripId = null; expandedEntries = []; expandedMapPositions = [];
		}
		selectedTripIds = new Set();
		selectionMode = false;
		saving = false;
	}

	// ── Trip modal form ───────────────────────────────────────────────────────
	let tripName     = $state('');
	let tripFromPort = $state('');
	let tripToPort   = $state('');

	// ── Manual entry form ─────────────────────────────────────────────────────
	let entryNotes     = $state('');
	let entrySails     = $state('');
	let entryManualSOG = $state<string>('');
	let entryManualCOG = $state<string>('');

	// ── Quick note (inline, appended to last entry) ───────────────────────────
	let quickNoteText    = $state('');
	let quickNoteSaving  = $state(false);
	let showAllActiveEntries = $state(false);
	// ID of the entry the current note was saved to.
	// While this equals $tripEntries[0]?.id → note is "pending" (locked).
	// When a new entry is created the IDs diverge → automatically unlocked.
	let savedNoteEntryId = $state<string | null>(null);
	let editingNote      = $state(false);

	// Locked = note already saved to last entry; user must wait for next auto-log
	const noteIsLocked = $derived(
		savedNoteEntryId != null &&
		savedNoteEntryId === $tripEntries[0]?.id &&
		!editingNote
	);

	// Text of the note currently saved in the last entry (shown while locked)
	const lockedNoteText = $derived(
		savedNoteEntryId === $tripEntries[0]?.id
			? ($tripEntries[0]?.notes ?? '')
			: ''
	);

	// Auto-unlock when a new log entry is created (IDs diverge)
	$effect(() => {
		const latestId = $tripEntries[0]?.id;
		if (latestId && savedNoteEntryId && latestId !== savedNoteEntryId) {
			savedNoteEntryId = null;
			quickNoteText    = '';
			editingNote      = false;
		}
	});

	function startEditNote() {
		// Strip the auto-appended [env context] block so user sees only their text
		const raw = $tripEntries[0]?.notes ?? '';
		quickNoteText = raw.replace(/\n\[.*\]$/s, '').trim();
		editingNote = true;
	}

	function cancelEditNote() {
		quickNoteText = '';
		editingNote   = false;
	}

	// Build environmental context string to append to notes
	function buildEnvContext(): string {
		const parts: string[] = [];
		const sog = liveSog(); if (sog != null) parts.push(`SOG ${sog} kn`);
		const wind = liveWind(); if (wind != null) {
			const wdir = liveWindDir();
			parts.push(`TWS ${wind} kn${wdir != null ? ' ' + dirAbbr(wdir) : ''}`);
		}
		if (t?.env_aws_ms != null) {
			const aws = +(t.env_aws_ms * 1.94384).toFixed(1);
			const awa = t.env_awa_rad != null ? t.env_awa_rad * 180 / Math.PI : null;
			parts.push(`AWS ${aws} kn${awa != null ? ' ' + Math.abs(awa).toFixed(0) + '°' + (awa < 0 ? 'P' : 'S') : ''}`);
		}
		const baro = liveBaro(); if (baro != null) parts.push(`${baro.toFixed(0)} hPa`);
		if (t?.env_depth_m != null) parts.push(`${t.env_depth_m.toFixed(1)} m depth`);
		if (t?.batt_main_soc != null) parts.push(`Batt ${(t.batt_main_soc * 100).toFixed(0)}%`);
		return parts.length > 0 ? `[${parts.join(' · ')}]` : '';
	}

	async function saveQuickNote() {
		const note = quickNoteText.trim();
		if (!note || !$activeTrip) return;
		const ctx = editingNote ? '' : buildEnvContext(); // don't re-append ctx on edit
		const fullNote = ctx ? `${note}\n${ctx}` : note;
		const lastEntry = $tripEntries[0];
		if (!lastEntry) return;
		quickNoteSaving = true;
		const { error } = await supabase
			.from('log_entries')
			.update({ notes: fullNote })
			.eq('id', lastEntry.id);
		if (!error) {
			tripEntries.update(es => es.map(e => e.id === lastEntry.id ? { ...e, notes: fullNote } : e));
			savedNoteEntryId = lastEntry.id; // lock until next entry is created
			quickNoteText    = '';
			editingNote      = false;
		}
		quickNoteSaving = false;
	}

	// ── Past trip noted entries (loaded on trip expand) ────────────────────────
	let expandedNotedEntries = $state<Array<{ id: string; logged_at: string; notes: string }>>([]);

	// ── Derived live values ───────────────────────────────────────────────────
	const liveLat   = $derived(() => pts?.[0]?.lat ?? t?.nav_lat ?? null);
	const liveLon   = $derived(() => pts?.[0]?.lon ?? t?.nav_lon ?? null);
	const liveSog   = $derived(() => t?.nav_sog_ms != null ? +(t.nav_sog_ms * 1.94384).toFixed(2) : null);
	const liveCog   = $derived(() => t?.nav_hdg_rad != null ? +(t.nav_hdg_rad * 180 / Math.PI).toFixed(1) : null);
	// True wind calculation via polar vector math.
	// AWA is relative to the bow (heading). The boat's velocity vector is along COG
	// (not heading) — using COG correctly accounts for leeway and current.
	// Leeway angle = COG - HDG.
	// Fallback chain: direct TWS/TWA > calculated from AWS/AWA/SOG+COG > SOG+HDG only
	function calcTrueWind(tel: typeof t): { tws_ms: number; twaRad: number } | null {
		if (!tel) return null;
		if (tel.env_tws_ms != null && tel.env_twa_rad != null)
			return { tws_ms: tel.env_tws_ms, twaRad: tel.env_twa_rad };
		if (tel.env_aws_ms == null || tel.env_awa_rad == null || tel.nav_sog_ms == null) return null;
		// Use COG if available; otherwise fall back to heading (assumes no leeway/current)
		const hdgRad = tel.nav_hdg_rad ?? 0;
		const cogRad = tel.nav_cog_rad ?? hdgRad;
		const leeway = cogRad - hdgRad;   // angle between direction of travel and bow
		// Boat velocity components in the bow-reference frame
		const boatX = tel.nav_sog_ms * Math.cos(leeway);   // along bow
		const boatY = tel.nav_sog_ms * Math.sin(leeway);   // to port/starboard
		// True wind = apparent wind − boat velocity (all in bow frame)
		const twX = tel.env_aws_ms * Math.cos(tel.env_awa_rad) - boatX;
		const twY = tel.env_aws_ms * Math.sin(tel.env_awa_rad) - boatY;
		return { tws_ms: Math.sqrt(twX * twX + twY * twY), twaRad: Math.atan2(twY, twX) };
	}
	const liveWind = $derived((): number | null => {
		const tw = calcTrueWind(t);
		return tw ? +(tw.tws_ms * 1.94384).toFixed(1) : null;
	});
	const liveWindDir = $derived((): number | null => {
		if (t?.nav_hdg_rad == null) return null;
		const tw = calcTrueWind(t);
		if (!tw) return null;
		// TWD = heading + TWA, normalised 0–360°
		return +((((t.nav_hdg_rad + tw.twaRad) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1);
	});
	const liveBaro   = $derived(() => t?.env_pressure_pa != null ? +(t.env_pressure_pa / 100).toFixed(1) : null);
	const liveAirT   = $derived(() => t?.temp_salon   != null ? +(t.temp_salon - 273.15).toFixed(1) : null);
	const liveWaterT = $derived(() => t?.temp_water   != null ? +(t.temp_water - 273.15).toFixed(1) : null);
	// Port / primary engine
	const liveEngOn  = $derived(() => {
		// RPM=0 means engine is off; use > 0 consistent with EngineCard
		if (t?.eng_rpm    != null) return t.eng_rpm    > 0;
		if (t?.eng_alt_v  != null) return t.eng_alt_v  > 13.6;
		if (t?.eng_temp_k != null) return t.eng_temp_k > 323.15;
		return false;
	});
	const liveEngH   = $derived(() => t?.eng_run_sec    != null ? +(t.eng_run_sec    / 3600).toFixed(2) : null);
	// Starboard / secondary engine (only relevant when engine_count === 2)
	const liveEngSbOn = $derived(() => {
		if (t?.eng_sb_rpm    != null) return t.eng_sb_rpm    > 0;
		if (t?.eng_sb_alt_v  != null) return t.eng_sb_alt_v  > 13.6;
		if (t?.eng_sb_temp_k != null) return t.eng_sb_temp_k > 323.15;
		return false;
	});
	const liveEngSbH  = $derived(() => t?.eng_sb_run_sec != null ? +(t.eng_sb_run_sec / 3600).toFixed(2) : null);
	const liveEngSbT  = $derived(() => t?.eng_sb_temp_k  != null ? +(t.eng_sb_temp_k  - 273.15).toFixed(1) : null);
	// Combined: any engine running = motoring (for sail/motor ratio)
	const engineCount = $derived(() => boat?.engine_count ?? 1);
	const anyEngOn    = $derived(() => liveEngOn() || (engineCount() === 2 && liveEngSbOn()));
	const liveEngT   = $derived(() => t?.eng_temp_k   != null ? +(t.eng_temp_k - 273.15).toFixed(1) : null);

	// ── Helpers ───────────────────────────────────────────────────────────────
	function fmtDuration(startIso: string, endIso?: string | null): string {
		const ms = (endIso ? new Date(endIso) : new Date()).getTime() - new Date(startIso).getTime();
		const h  = Math.floor(ms / 3_600_000);
		const m  = Math.floor((ms % 3_600_000) / 60_000);
		return `${h}h ${m}m`;
	}
	function fmtTime(iso: string): string {
		return new Date(iso).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
	}
	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
	}
	function fmtNm(nm: number | null): string {
		return nm != null ? nm.toFixed(1) + ' nm' : '—';
	}
	function fmtSecs(s: number): string {
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}
	function dirAbbr(deg: number | null): string {
		if (deg == null) return '—';
		const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
		return d[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
	}
	// AWA is signed: positive = starboard, negative = port
	function fmtAWA(deg: number | null): string {
		if (deg == null) return '';
		const abs = Math.abs(deg);
		const side = deg < 0 ? 'P' : 'S';
		return `${abs.toFixed(0)}° ${side}`;
	}
	function sailRatio(trip: LogTrip | null): number {
		if (!trip?.total_nm || trip.total_nm === 0) return 0;
		return Math.round(((trip.sail_nm ?? 0) / trip.total_nm) * 100);
	}
	function ratioColor(pct: number): string {
		if (pct >= 70) return 'var(--green)';
		if (pct >= 40) return 'var(--amber)';
		return '#f97316';
	}

	// ── Supabase load ─────────────────────────────────────────────────────────
	async function loadLogbook() {
		if (!boat) return;
		logLoaded.set(false);

		const [tripsRes, entriesRes] = await Promise.all([
			supabase.from('log_trips').select('*').eq('boat_id', boat.id)
				.order('started_at', { ascending: false }),
			supabase.from('log_entries').select('*').eq('boat_id', boat.id)
				.is('trip_id', null).order('logged_at', { ascending: false }).limit(50),
		]);

		const trips = (tripsRes.data ?? []) as LogTrip[];
		allTrips.set(trips);

		const active = trips.find(tr => tr.ended_at == null) ?? null;
		activeTrip.set(active);

		if (active) {
			const { data: entries } = await supabase
				.from('log_entries').select('*').eq('trip_id', active.id)
				.order('logged_at', { ascending: false }).limit(200);
			tripEntries.set((entries ?? []) as LogEntry[]);
			subscribeToActiveTrip(active.id);
		} else {
			tripEntries.set([]);
			unsubscribeTrip();
		}

		logLoaded.set(true);
	}

	// ── Distance tracking ─────────────────────────────────────────────────────
	let lastEntryPos: { lat: number; lon: number } | null = null;

	function calcDistanceSinceLast(lat: number, lon: number): number {
		if (!lastEntryPos) return 0;
		return +(haversine(lastEntryPos.lat, lastEntryPos.lon, lat, lon) / 1852).toFixed(3);
	}

	// ── Engine-hours resolver (live → last DB entry fallback) ────────────────
	// Returns the best available absolute engine-hours counter value.
	// At trip START: tripId is undefined → looks at all boat entries.
	// At trip END:   tripId is set → checks trip entries first, then boat-wide.
	async function resolveEngH(tripId?: string): Promise<number | null> {
		const live = liveEngH();
		if (live != null) return live;
		if (!boat) return null;
		// Try entries of this trip first (trip end scenario)
		if (tripId) {
			const { data } = await supabase.from('log_entries')
				.select('engine_hours').eq('trip_id', tripId)
				.not('engine_hours', 'is', null)
				.order('logged_at', { ascending: false }).limit(1).maybeSingle();
			if (data?.engine_hours != null) return data.engine_hours as number;
		}
		// Fall back to most recent entry for this boat
		const { data } = await supabase.from('log_entries')
			.select('engine_hours').eq('boat_id', boat.id)
			.not('engine_hours', 'is', null)
			.order('logged_at', { ascending: false }).limit(1).maybeSingle();
		return (data?.engine_hours as number | null) ?? null;
	}

	async function recalcFromDB(tripId: string) {
		const { data } = await supabase.from('log_entries')
			.select('distance_nm, engine_on, sog_kn, engine_hours, logged_at')
			.eq('trip_id', tripId).order('logged_at', { ascending: true });
		if (!data?.length) return null;
		const totalNm = +data.reduce((s, e) => s + (e.distance_nm ?? 0), 0).toFixed(3);
		const sailNm  = +data.filter(e => !e.engine_on).reduce((s, e) => s + (e.distance_nm ?? 0), 0).toFixed(3);
		const motorNm = +data.filter(e =>  e.engine_on).reduce((s, e) => s + (e.distance_nm ?? 0), 0).toFixed(3);
		const sogsVal = data.filter(e => e.sog_kn != null).map(e => e.sog_kn as number);
		const avgSog  = sogsVal.length
			? +(sogsVal.reduce((a, b) => a + b, 0) / sogsVal.length).toFixed(2) : null;
		// Time under motor/sail: sum intervals between consecutive entries
		let motorTimeSec = 0, sailTimeSec = 0;
		for (let i = 1; i < data.length; i++) {
			const intervalSec = Math.min(
				Math.round((new Date(data[i].logged_at).getTime() - new Date(data[i-1].logged_at).getTime()) / 1000),
				7200 // cap at 2h
			);
			if (data[i].engine_on) motorTimeSec += intervalSec;
			else sailTimeSec += intervalSec;
		}
		// Prefer absolute VRM engine-hours counter delta; fall back to time-based calc
		const withEng  = data.filter(e => e.engine_hours != null);
		const engHours = withEng.length >= 2
			? +Math.max(0, (withEng.at(-1)!.engine_hours as number) - (withEng[0].engine_hours as number)).toFixed(2)
			: motorTimeSec > 0 ? +(motorTimeSec / 3600).toFixed(2) : null;
		return { totalNm, sailNm, motorNm, avgSog, engHours, motorTimeSec, sailTimeSec };
	}

	async function updateTripTotals(tripId: string, distNm: number, engineOn: boolean, prevLoggedAt: string | null) {
		const current = $activeTrip;
		if (!current) return;

		// Time elapsed since last entry (capped at 2h to avoid gaps)
		let intervalSec = 0;
		if (prevLoggedAt) {
			intervalSec = Math.min(
				Math.round((Date.now() - new Date(prevLoggedAt).getTime()) / 1000),
				7200
			);
		}

		const patch: Partial<LogTrip> = {
			total_nm:     +(((current.total_nm     ?? 0) + distNm).toFixed(3)),
			sail_nm:      +(((current.sail_nm      ?? 0) + (engineOn ? 0 : distNm)).toFixed(3)),
			motor_nm:     +(((current.motor_nm     ?? 0) + (engineOn ? distNm : 0)).toFixed(3)),
			sail_time_s:  ((current.sail_time_s  ?? 0) + (!engineOn ? intervalSec : 0)),
			motor_time_s: ((current.motor_time_s ?? 0) + (engineOn  ? intervalSec : 0)),
		};
		const sog = liveSog();
		if (sog != null && sog > (current.max_sog_kn ?? 0)) patch.max_sog_kn = sog;
		await supabase.from('log_trips').update(patch).eq('id', tripId);
		activeTrip.update(tr => tr ? { ...tr, ...patch } : tr);
	}

	// ── Insert a log entry ────────────────────────────────────────────────────
	async function insertEntry(opts: {
		source: 'auto' | 'manual';
		notes?: string; sails?: string;
		sogOverride?: number; cogOverride?: number;
	}) {
		if (!boat) return;
		const at  = $activeTrip;
		const lat = liveLat(); const lon = liveLon();
		const sog = opts.sogOverride ?? liveSog();
		const cog = opts.cogOverride ?? liveCog();
		const engOn   = anyEngOn();   // true if ANY engine running
		const engSbOn = engineCount() === 2 && liveEngSbOn();
		const distNm = (lat != null && lon != null) ? calcDistanceSinceLast(lat, lon) : 0;
		// Get previous entry's logged_at for time interval calculation
		// tripEntries is sorted newest-first, so index 0 = most recent
		const prevLoggedAt = $tripEntries.length > 0 ? $tripEntries[0].logged_at : null;

		const entry: Omit<LogEntry, 'id' | 'created_at'> = {
			trip_id: at?.id ?? null, boat_id: boat.id,
			logged_at: new Date().toISOString(), lat, lon,
			cog_deg: cog, sog_kn: sog,
			distance_nm: distNm > 0 ? distNm : null,
			engine_on: engOn, engine_rpm: t?.eng_rpm ?? null,
			engine_hours: liveEngH(), engine_temp_c: liveEngT(),
			engine_sb_on: engSbOn, engine_sb_rpm: engineCount() === 2 ? (t?.eng_sb_rpm ?? null) : null,
			engine_sb_hours: engineCount() === 2 ? liveEngSbH() : null,
			engine_sb_temp_c: engineCount() === 2 ? liveEngSbT() : null,
			sails: opts.sails?.trim() || null,
			wind_speed_kn: liveWind(), wind_dir_deg: liveWindDir(),
			apparent_wind_speed_kn: t?.env_aws_ms != null ? +(t.env_aws_ms * 1.94384).toFixed(2) : null,
			apparent_wind_angle_deg: t?.env_awa_rad != null ? +(t.env_awa_rad * 180 / Math.PI).toFixed(1) : null,
			baro_hpa: liveBaro(), air_temp_c: liveAirT(), water_temp_c: liveWaterT(),
			depth_m: t?.env_depth_m != null ? +t.env_depth_m.toFixed(1) : null,
			batt_soc: t?.batt_main_soc != null ? +(t.batt_main_soc * 100).toFixed(0) : null,
			wave_height_m: wave.wave_height_m, wave_period_s: wave.wave_period_s,
			notes: opts.notes?.trim() || null, source: opts.source,
		};
		try {
			const { data } = await supabase.from('log_entries').insert(entry).select().single();
			if (data) {
				tripEntries.update(es => [data as LogEntry, ...es]);
				if (lat != null && lon != null) lastEntryPos = { lat, lon };
				if (at) await updateTripTotals(at.id, distNm, engOn, prevLoggedAt);
				const engTag = engineCount() === 2
					? `[P:${liveEngOn() ? 'on' : 'off'} S:${liveEngSbOn() ? 'on' : 'off'}]`
					: (engOn ? '[eng]' : '[sail]');
				pushLog(`+ ${lat?.toFixed(4) ?? '?'} ${lon?.toFixed(4) ?? '?'}  ${sog?.toFixed(1) ?? '-'} kn  ${engTag}${distNm > 0 ? `  +${distNm.toFixed(2)} nm` : ''}`);
			}
		} catch (err: any) {
			// Network error — queue to IndexedDB
			if (!navigator.onLine) {
				const queuedId = await queueLogEntry(entry, boat.id);
				pushLog(`⚠ Entry queued offline (${queuedId.substring(0, 8)})`);
				const count = await getPendingCount(boat.id);
				pendingCount.set(count);
			} else {
				// Real error, not offline
				console.error('Log entry failed:', err);
				pushLog(`✗ Entry failed: ${err.message}`);
			}
		}
	}

	// ── Start trip ────────────────────────────────────────────────────────────
	async function startTrip() {
		if (!boat || saving) return;
		saving = true;
		const { data } = await supabase.from('log_trips').insert({
			boat_id: boat.id, name: tripName.trim() || null,
			from_port: tripFromPort.trim() || null, to_port: tripToPort.trim() || null,
			started_at: new Date().toISOString(),
			engine_hours_start: await resolveEngH(),
		}).select().single();
		if (data) {
			const trip = data as LogTrip;
			activeTrip.set(trip);
			allTrips.update(ts => [trip, ...ts]);
			tripEntries.set([]); lastEntryPos = null;
			subscribeToActiveTrip(trip.id);
			await insertEntry({ source: 'auto', notes: `Departure from ${tripFromPort || 'unknown'}` });
		}
		saving = false; showTripModal = false;
		tripName = ''; tripFromPort = ''; tripToPort = '';
	}

	// ── End trip ──────────────────────────────────────────────────────────────
	async function endTrip() {
		const at = $activeTrip;
		if (!at || saving) return;
		saving = true;
		await insertEntry({ source: 'auto', notes: `Arrival at ${at.to_port || 'destination'}` });
		const stats = await recalcFromDB(at.id);
		// Prefer start-snapshot delta (most accurate); fall back to entry-based calc
		const engNow    = await resolveEngH(at.id);
		const engDelta  = (engNow != null && at.engine_hours_start != null)
			? +Math.max(0, engNow - at.engine_hours_start).toFixed(2)
			: (stats?.engHours ?? null);
		const patch: Partial<LogTrip> = {
			ended_at: new Date().toISOString(),
			total_nm:     stats?.totalNm   ?? at.total_nm,
			sail_nm:      stats?.sailNm    ?? at.sail_nm,
			motor_nm:     stats?.motorNm   ?? at.motor_nm,
			sail_time_s:  stats?.sailTimeSec  ?? at.sail_time_s  ?? 0,
			motor_time_s: stats?.motorTimeSec ?? at.motor_time_s ?? 0,
			avg_sog_kn:   stats?.avgSog ?? null,
			engine_hours: engDelta,
		};
		await supabase.from('log_trips').update(patch).eq('id', at.id);
		activeTrip.update(tr => tr ? { ...tr, ...patch } : tr);
		const finished = { ...(at as LogTrip), ...patch };
		allTrips.update(ts => ts.map(t => t.id === at.id ? finished : t));
		activeTrip.set(null); tripEntries.set([]); unsubscribeTrip();
		saving = false;
	}

	// ── Manual entry ──────────────────────────────────────────────────────────
	async function submitManualEntry() {
		if (saving) return;
		saving = true;
		await insertEntry({
			source: 'manual', notes: entryNotes, sails: entrySails,
			sogOverride: entryManualSOG ? +entryManualSOG : undefined,
			cogOverride: entryManualCOG ? +entryManualCOG : undefined,
		});
		saving = false; showEntryModal = false;
		entryNotes = ''; entrySails = ''; entryManualSOG = ''; entryManualCOG = '';
	}

	// ── Reverse geocoding ─────────────────────────────────────────────────────
	async function reverseGeocode(lat: number, lon: number): Promise<string> {
		try {
			const r = await fetch(
				`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=en`,
				{ headers: { 'User-Agent': 'SUKI-Dashboard-Pro/1.0 sailing@suki.boat', 'Accept-Language': 'en' } }
			);
			if (!r.ok) throw new Error('');
			const j = await r.json(); const a = j.address ?? {};
			return a.bay ?? a.sea ?? a.body_of_water ?? a.island ?? a.archipelago ??
			       a.village ?? a.town ?? a.city_district ?? a.city ??
			       a.county ?? j.name ?? `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
		} catch {
			return `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
		}
	}

	function buildWeatherSummary(): string {
		const parts: string[] = [];
		const w = liveWind(); const wd = liveWindDir();
		if (w != null)              parts.push(`Wind ${w.toFixed(0)} kn ${dirAbbr(wd)}`);
		if (wave.wave_height_m != null) parts.push(`Wave ${wave.wave_height_m} m`);
		if (wave.wave_period_s  != null) parts.push(`${wave.wave_period_s} s`);
		if (liveBaro()  != null)    parts.push(`${liveBaro()} hPa`);
		if (liveAirT()  != null)    parts.push(`Air ${liveAirT()}°C`);
		if (liveWaterT() != null)   parts.push(`Water ${liveWaterT()}°C`);
		return parts.join(' · ');
	}

	// ── Auto-log every 120 s (browser supplements server when tab is open) ──────
	// Trip creation + auto-stop is handled entirely server-side (log-position Edge Function).
	// The browser only logs extra entries when the tab is open, and shows the toggle.
	function startAutoLog() {
		autoLogTimer = setInterval(() => {
			if ($activeTrip) insertEntry({ source: 'auto' });
		}, 120_000);
	}

	// ── All-time statistics ───────────────────────────────────────────────────
	const stats = $derived(() => {
		const trips = $allTrips.filter(tr => tr.ended_at != null);
		if (!trips.length) return null;
		const totalNm  = trips.reduce((s, t) => s + (t.total_nm ?? 0), 0);
		const sailNm   = trips.reduce((s, t) => s + (t.sail_nm  ?? 0), 0);
		const motorNm  = trips.reduce((s, t) => s + (t.motor_nm ?? 0), 0);
		const engHours = trips.reduce((s, t) => s + (t.engine_hours ?? 0), 0);
		const maxSog   = Math.max(...trips.map(t => t.max_sog_kn ?? 0));
		const sailPct  = totalNm > 0 ? Math.round(sailNm / totalNm * 100) : 0;
		return { totalNm, sailNm, motorNm, engHours, maxSog, sailPct, tripCount: trips.length };
	});

	// ── Init ──────────────────────────────────────────────────────────────────
	$effect(() => {
		const b = boat;
		if (b) {
			loadLogbook();
			untrack(() => startAutoLog());
		}
		return () => { clearInterval(autoLogTimer); };
	});

	// ── Offline listener + sync ──────────────────────────────────────────────────
	$effect(() => {
		const unsub = subscribeToOnline(async (online) => {
			isOnline.set(online);
			if (online && boat) {
				// Auto-sync pending entries when coming back online
				syncInProgress.set(true);
				try {
					const { synced, failed } = await syncPendingEntries(supabase, boat.id);
					if (synced > 0) {
						pushLog(`✓ Synced ${synced} queued entries`);
					}
					if (failed > 0) {
						pushLog(`✗ ${failed} entries still pending`);
					}
					const remaining = await getPendingCount(boat.id);
					pendingCount.set(remaining);
				} catch (err: any) {
					console.error('[offline] Sync error:', err);
				} finally {
					syncInProgress.set(false);
				}
			}
		});
		return unsub;
	});

	// ── Initialize pending count ──────────────────────────────────────────────────
	$effect.pre(async () => {
		if (boat) {
			const count = await getPendingCount(boat.id);
			pendingCount.set(count);
		}
	});

	onDestroy(() => {
		clearInterval(autoLogTimer);
		unsubscribeTrip();
		expandedMapInst?.remove();
	});

	const at      = $derived($activeTrip);
	const trips   = $derived($allTrips);
	const entries = $derived($tripEntries);
	const loaded  = $derived($logLoaded);
	const isAdmin = $derived(role === 'admin');
</script>

<svelte:head><title>Logbook · SUKI PRO</title></svelte:head>

<div class="log-page">

	<!-- ── Offline warning ──────────────────────────────────────────────────── -->
	{#if !$isOnline}
		<div class="offline-warning">
			🌐 <strong>Offline</strong> — log entries will be queued locally and synced when you reconnect
		</div>
	{/if}

	<!-- ── Sync progress ───────────────────────────────────────────────────── -->
	{#if $syncInProgress}
		<div class="sync-progress">
			<span class="spinner"></span> Syncing {$pendingCount} queued entries…
		</div>
	{/if}

	<!-- ── Active trip banner ───────────────────────────────────────────────── -->
	{#if at}
	{@const pct = sailRatio(at)}
	<div class="trip-banner">
		<div class="trip-banner-top">
			<div class="trip-banner-title">
				<span class="trip-dot active"></span>
				<span class="trip-name">{at.name ?? 'Current trip'}</span>
				{#if at.from_port || at.to_port}
					<span class="trip-route">{at.from_port ?? '?'} → {at.to_port ?? '?'}</span>
				{/if}
			</div>
			<span class="trip-duration">{fmtDuration(at.started_at)}</span>
		</div>

		<div class="ratio-section">
			<div class="ratio-bar-wrap">
				<div class="ratio-bar">
					<div class="ratio-sail" style="width:{pct}%; background:{ratioColor(pct)}"></div>
					<div class="ratio-motor" style="width:{100-pct}%"></div>
				</div>
			</div>
			<div class="ratio-labels">
				<span class="ratio-label sail">Sail {fmtNm(at.sail_nm)} ({pct}%){#if (at.sail_time_s ?? 0) > 0} · {fmtSecs(at.sail_time_s ?? 0)}{/if}</span>
				<span class="ratio-label motor">Motor {fmtNm(at.motor_nm)} ({100-pct}%){#if (at.motor_time_s ?? 0) > 0} · {fmtSecs(at.motor_time_s ?? 0)}{/if}</span>
				<span class="ratio-label total">{fmtNm(at.total_nm)}</span>
			</div>
		</div>

		<div class="trip-snapshot">
			{#if liveSog() != null}
				<div class="snap-item"><span class="snap-val">{liveSog()}</span><span class="snap-lbl">kn SOG</span></div>
			{/if}
			{#if liveWind() != null}
				<div class="snap-item"><span class="snap-val">{liveWind()}</span><span class="snap-lbl">kn TWS</span></div>
			{/if}
			{#if wave.wave_height_m != null}
				<div class="snap-item"><span class="snap-val">{wave.wave_height_m}</span><span class="snap-lbl">m wave</span></div>
			{/if}
			{#if liveEngH() != null && at.engine_hours_start != null}
				{@const motorH = +Math.max(0, liveEngH()! - at.engine_hours_start).toFixed(2)}
				<div class="snap-item" class:eng-on={anyEngOn()}>
					<span class="snap-val">{motorH.toFixed(1)}</span><span class="snap-lbl">motor h</span>
				</div>
			{:else if liveEngH() != null}
				<div class="snap-item" class:eng-on={anyEngOn()}>
					<span class="snap-val">{liveEngH()?.toFixed(0)}</span><span class="snap-lbl">eng h total</span>
				</div>
			{/if}
			{#if at.max_sog_kn}
				<div class="snap-item"><span class="snap-val">{at.max_sog_kn.toFixed(1)}</span><span class="snap-lbl">max kn</span></div>
			{/if}
		</div>

		{#if isAdmin}
		<div class="trip-actions">
			<button class="btn-entry" onclick={() => { showEntryModal = true; }}>+ Log entry</button>
			<button class="btn-end"   onclick={endTrip} disabled={saving}>End trip</button>
		</div>
		{/if}
	</div>

	{:else if loaded && isAdmin}
	<div class="start-cta">
		<svg viewBox="0 0 20 20" width="36" height="36" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:4px">
			<circle cx="10" cy="4.5" r="1.8"/>
			<line x1="10" y1="6.3" x2="10" y2="16"/>
			<line x1="5.5" y1="9.5" x2="14.5" y2="9.5"/>
			<path d="M5.5 16 a4.5 3.5 0 0 0 9 0"/>
		</svg>
		<div class="start-text">No active trip</div>
		<button class="btn-start" onclick={() => { showTripModal = true; }}>Start trip</button>
	</div>
	{:else if !loaded}
	<div class="log-loading">Loading logbook…</div>
	{/if}

	<!-- ── Auto-trip status bar ────────────────────────────────────────────── -->
	{#if isAdmin}
	{#if autoEnabled}
	{@const srvConfirming = !!(cfg?.auto_fast_since)}
	<div class="auto-bar"
		class:auto-watching={!$activeTrip}
		class:auto-recording={!!$activeTrip}>
		<div class="auto-bar-left">
			<span class="auto-dot"
				class:dot-idle={!$activeTrip && !srvConfirming}
				class:dot-watching={!$activeTrip && srvConfirming}
				class:dot-recording={!!$activeTrip}></span>
			{#if $activeTrip}
				<span class="auto-status">Auto-trip recording · server stops after 15 min below 1.5 kn</span>
			{:else if srvConfirming}
				<span class="auto-status">Movement detected · confirming…</span>
			{:else}
				<span class="auto-status">Watching for movement ≥ 1.5 kn</span>
			{/if}
		</div>
		<button class="auto-toggle-btn" onclick={() => setAutoEnabled(false)}>Off</button>
	</div>
	{:else}
	<div class="auto-bar auto-disabled">
		<span class="auto-status">Auto-trip detection: off</span>
		<button class="auto-toggle-btn" onclick={() => setAutoEnabled(true)}>On</button>
	</div>
	{/if}
	{/if}

	<!-- ── Server-entry terminal (shows realtime entries logged by the server) ── -->
	{#if autoEnabled && $activeTrip && terminalLines.length > 0}
	<div class="terminal">
		<div class="terminal-hdr">
			<span class="terminal-title"><span class="terminal-dot"></span>SERVER LOG</span>
			<span class="terminal-meta">{terminalLines.length} / {MAX_LOG}</span>
		</div>
		<div class="terminal-body">
			{#each terminalLines as line, i}
				<div class="terminal-line" class:terminal-line-fresh={i === 0}>{line}</div>
			{/each}
		</div>
	</div>
	{/if}

	<!-- ── Quick note field (active trip) ─────────────────────────────────── -->
	{#if $activeTrip && $tripEntries.length > 0}
	<div class="quick-note-area">
		{#if noteIsLocked}
			<!-- Note saved — locked until next log entry is created -->
			<div class="note-locked">
				<p class="note-locked-text">{lockedNoteText}</p>
				<div class="note-locked-actions">
					<button class="quick-note-btn" onclick={startEditNote}>✏ Edit note</button>
					<span class="note-locked-hint">New note available after next log entry (~2 min)</span>
				</div>
			</div>
		{:else}
			<!-- Free to write a new note (or editing existing) -->
			<textarea class="quick-note-input" bind:value={quickNoteText}
				placeholder={editingNote ? 'Edit your note…' : 'Write a note… (current conditions will be appended)'}
				rows="2"></textarea>
			<div class="note-btn-row">
				<button class="quick-note-btn" onclick={saveQuickNote}
					disabled={quickNoteSaving || !quickNoteText.trim()}>
					{quickNoteSaving ? 'Saving…' : editingNote ? '✓ Save changes' : '+ Add note'}
				</button>
				{#if editingNote}
				<button class="note-cancel-btn" onclick={cancelEditNote}>Cancel</button>
				{/if}
			</div>
		{/if}
	</div>
	{/if}

	<!-- ── Log entries (active trip) ──────────────────────────────────────── -->
	{#if entries.length > 0}
	{@const visibleEntries = showAllActiveEntries ? entries : entries.slice(0, 5)}
	<div class="section-header">
		<span class="section-title">Entries · {entries.length}</span>
		{#if entries.length > 5}
		<button class="show-all-btn" onclick={() => { showAllActiveEntries = !showAllActiveEntries; }}>
			{showAllActiveEntries ? 'Show less' : `Show all ${entries.length}`}
		</button>
		{/if}
	</div>
	<div class="entry-list">
		{#each visibleEntries as e (e.id)}
		<div class="entry-row" class:auto={e.source === 'auto'}>
			<div class="entry-time">
				<span class="entry-hhmm">{fmtTime(e.logged_at)}</span>
				<span class="entry-date">{fmtDate(e.logged_at)}</span>
				{#if e.source === 'auto'}<span class="entry-auto-tag">auto</span>{/if}
			</div>
			<div class="entry-body">
				<div class="entry-nav">
					{#if e.sog_kn != null}<span class="entry-chip">{e.sog_kn.toFixed(1)} kn</span>{/if}
					{#if e.cog_deg != null}<span class="entry-chip">{dirAbbr(e.cog_deg)}</span>{/if}
					{#if e.engine_rpm != null}<span class="entry-chip eng">P {e.engine_rpm} rpm{e.engine_temp_c != null ? ` · ${e.engine_temp_c.toFixed(0)}°C` : ''}</span>{/if}
								{#if e.engine_sb_rpm != null}<span class="entry-chip eng">S {e.engine_sb_rpm} rpm{e.engine_sb_temp_c != null ? ` · ${e.engine_sb_temp_c.toFixed(0)}°C` : ''}</span>{/if}
								{#if e.engine_on && e.engine_rpm == null && e.engine_sb_rpm == null}<span class="entry-chip eng">engine on</span>{/if}
					{#if e.sails}<span class="entry-chip sail">{e.sails}</span>{/if}
					{#if e.distance_nm != null && e.distance_nm > 0}
						<span class="entry-chip dist">+{e.distance_nm.toFixed(1)} nm</span>
					{/if}
				</div>
				{@render entryEnv(e)}
				{#if e.notes}<p class="entry-notes">{e.notes}</p>{/if}
			</div>
		</div>
		{/each}
	</div>
	{/if}

	<!-- ── All-time statistics ─────────────────────────────────────────────── -->
	{#if stats()}
	{@const s = stats()!}
	<div class="section-header">
		<span class="section-title">All-time · {s.tripCount} trip{s.tripCount === 1 ? '' : 's'}</span>
	</div>
	<div class="stats-grid">
		<div class="stat-card"><span class="stat-val">{s.totalNm.toFixed(0)}</span><span class="stat-lbl">nm sailed</span></div>
		<div class="stat-card">
			<div class="stat-ratio"><div class="ratio-bar mini">
				<div class="ratio-sail" style="width:{s.sailPct}%; background:{ratioColor(s.sailPct)}"></div>
				<div class="ratio-motor" style="width:{100-s.sailPct}%"></div>
			</div></div>
			<span class="stat-val">{s.sailPct}%</span><span class="stat-lbl">under sail</span>
		</div>
		<div class="stat-card"><span class="stat-val">{s.sailNm.toFixed(0)}</span><span class="stat-lbl">nm sail</span></div>
		<div class="stat-card"><span class="stat-val">{s.motorNm.toFixed(0)}</span><span class="stat-lbl">nm motor</span></div>
		<div class="stat-card"><span class="stat-val">{s.engHours.toFixed(0)}</span><span class="stat-lbl">engine hours</span></div>
		<div class="stat-card"><span class="stat-val">{s.maxSog.toFixed(1)}</span><span class="stat-lbl">max kn ever</span></div>
	</div>
	{/if}

	<!-- ── Past trips ─────────────────────────────────────────────────────── -->
	{#if trips.filter(tr => tr.ended_at != null).length > 0}

	<!-- Filter + sort + selection controls -->
	<div class="filter-row">
		<div class="filter-tabs">
			{#each (['week', 'month', 'year', 'all'] as FilterRange[]) as r}
				<button class="filter-tab" class:active={filterRange === r} onclick={() => { filterRange = r; }}>
					{r === 'week' ? '7d' : r === 'month' ? '30d' : r === 'year' ? '1y' : 'All'}
				</button>
			{/each}
		</div>
		<div class="filter-right">
			<button class="sort-btn" onclick={() => { sortDesc = !sortDesc; }}>{sortDesc ? '↓' : '↑'}</button>
			{#if isAdmin}
			<button class="select-btn" class:active={selectionMode}
				onclick={() => { selectionMode = !selectionMode; if (!selectionMode) selectedTripIds = new Set(); }}>
				Select
			</button>
			{/if}
		</div>
	</div>

	<!-- Selection action bar -->
	{#if selectionMode && isAdmin}
	<div class="selection-bar">
		<div class="selection-bar-left">
			<button class="sel-action-btn" onclick={selectAll}>All</button>
			<button class="sel-action-btn" onclick={clearSelection}>None</button>
			<span class="sel-count">{selectedTripIds.size} selected</span>
		</div>
		<button class="sel-delete-btn" disabled={selectedTripIds.size === 0 || saving}
			onclick={deleteSelected}>
			Delete ({selectedTripIds.size})
		</button>
	</div>
	{/if}

	<div class="past-trips">
		{#each groupedTrips() as yg (yg.year)}
		{@const yearCollapsed = collapsedYears.has(yg.year)}
		<div class="year-group">
			<button class="year-header" onclick={() => toggleYear(yg.year)}>
				<span class="year-label">{yg.year}</span>
				<span class="year-stats">{yg.tripCount} trip{yg.tripCount === 1 ? '' : 's'} · {yg.totalNm.toFixed(0)} nm</span>
				<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-left:auto">
					{#if yearCollapsed}<polyline points="2,4 6,8 10,4"/>{:else}<polyline points="2,8 6,4 10,8"/>{/if}
				</svg>
			</button>
			{#if !yearCollapsed}
			{#each yg.months as mg (`${mg.year}-${mg.month}`)}
			{@const monthKey = `${mg.year}-${mg.month}`}
			{@const monthCollapsed = collapsedMonths.has(monthKey)}
			<div class="month-group">
				<button class="month-header" onclick={() => toggleMonth(monthKey)}>
					<span class="month-label">{mg.label}</span>
					<span class="month-stats">{mg.tripCount} trip{mg.tripCount === 1 ? '' : 's'} · {mg.totalNm.toFixed(0)} nm</span>
					<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-left:auto">
						{#if monthCollapsed}<polyline points="2,4 6,8 10,4"/>{:else}<polyline points="2,8 6,4 10,8"/>{/if}
					</svg>
				</button>
				{#if !monthCollapsed}
				{#each mg.trips as trip (trip.id)}
		{@const pct = sailRatio(trip)}
		{@const isExpanded = expandedTripId === trip.id}
		{@const isSelected = selectedTripIds.has(trip.id)}
		<div class="past-trip-card" class:expanded={isExpanded} class:selected={isSelected}>

			<!-- Clickable header row -->
			<div class="past-trip-header" onclick={() => !selectionMode && toggleTripExpand(trip.id)}
				role="button" tabindex="0"
				onkeydown={(e) => e.key === 'Enter' && !selectionMode && toggleTripExpand(trip.id)}>

				{#if selectionMode}
				<!-- Selection checkbox -->
				<button class="trip-checkbox" onclick={(e) => { e.stopPropagation(); toggleSelect(trip.id); }}
					aria-label={isSelected ? 'Deselect' : 'Select'}>
					{#if isSelected}
					<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="rgba(0,200,255,.15)"/>
						<polyline points="4,8 7,11 12,5"/>
					</svg>
					{:else}
					<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="var(--border)" stroke-width="1.5" stroke-linecap="round">
						<rect x="1.5" y="1.5" width="13" height="13" rx="2.5"/>
					</svg>
					{/if}
				</button>
				{/if}

				<div class="past-trip-header-left">
					<span class="past-trip-name">{trip.name ?? 'Unnamed trip'}</span>
					{#if trip.from_port || trip.to_port}
						<span class="past-trip-route">{trip.from_port ?? '?'} → {trip.to_port ?? '?'}</span>
					{/if}
				</div>
				<div class="past-trip-header-right">
					<span class="past-trip-dates">{fmtDate(trip.started_at)}</span>
					<span class="expand-icon">
						<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							{#if isExpanded}
							<polyline points="2,8 6,4 10,8"/>
							{:else}
							<polyline points="2,4 6,8 10,4"/>
							{/if}
						</svg>
					</span>
				</div>
			</div>

			<!-- Stats row -->
			<div class="past-ratio">
				<div class="ratio-bar mini" style="flex:1">
					<div class="ratio-sail" style="width:{pct}%; background:{ratioColor(pct)}"></div>
					<div class="ratio-motor" style="width:{100-pct}%"></div>
				</div>
				<span class="past-ratio-lbl">Sail {pct}% · {fmtNm(trip.total_nm)}</span>
			</div>
			<div class="past-stats">
				<span class="past-chip past-chip-dur">{fmtDuration(trip.started_at, trip.ended_at)}</span>
				{#if trip.avg_sog_kn != null}<span class="past-chip">avg {trip.avg_sog_kn.toFixed(1)} kn</span>{/if}
				{#if trip.max_sog_kn != null}<span class="past-chip">max {trip.max_sog_kn.toFixed(1)} kn</span>{/if}
				{#if trip.sail_nm != null && trip.sail_nm > 0}
				<span class="past-chip past-chip-sail">
					<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;flex-shrink:0">
						<path d="M7 2 L7 11 L2 11 Q7 8 7 2Z"/>
						<line x1="2" y1="11" x2="12" y2="11"/>
					</svg>
					{trip.sail_nm.toFixed(1)} nm
				</span>
				{/if}
				{#if trip.motor_nm != null && trip.motor_nm > 0}
				<span class="past-chip past-chip-eng">
					<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;flex-shrink:0">
						<circle cx="7" cy="7" r="3"/>
						<line x1="7" y1="1" x2="7" y2="3.5"/>
						<line x1="7" y1="10.5" x2="7" y2="13"/>
						<line x1="1" y1="7" x2="3.5" y2="7"/>
						<line x1="10.5" y1="7" x2="13" y2="7"/>
					</svg>
					{trip.motor_nm.toFixed(1)} nm
				</span>
				{/if}
				{#if trip.engine_hours != null && trip.engine_hours > 0}
				<span class="past-chip past-chip-eng">
					<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="vertical-align:-1px;flex-shrink:0">
						<circle cx="7" cy="7" r="5.5"/>
						<polyline points="7,3.5 7,7 9.5,7"/>
					</svg>
					{trip.engine_hours.toFixed(1)} h
				</span>
				{/if}
			</div>
			{#if trip.notes}<p class="past-trip-notes">{trip.notes}</p>{/if}

			<!-- ── Expanded section ───────────────────────────────────────── -->
			{#if isExpanded}
			<div class="expanded-entries">

				<!-- Map -->
				<div class="trip-map-wrap">
					<div bind:this={expandedMapEl} class="trip-map-el"></div>
					<div class="trip-map-dark" aria-hidden="true"></div>
					{#if expandedLoading}
					<div class="trip-map-overlay">Loading track…</div>
					{:else if expandedMapPositions.length === 0}
					<div class="trip-map-overlay">No GPS positions recorded</div>
					{/if}
					<div class="trip-map-controls">
						<button class="trip-map-btn" onclick={() => expandedMapInst?.zoomIn()} aria-label="Zoom in">+</button>
						<button class="trip-map-btn" onclick={() => expandedMapInst?.zoomOut()} aria-label="Zoom out">−</button>
						<button class="trip-map-btn trip-map-btn-center" onclick={centerTripMap} aria-label="Fit track">
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

				<!-- Interactive trip charts with shared time slider -->
				<!-- {#key} re-mounts the component each time a different trip is expanded,
				     re-triggering CSS animations cleanly -->
				{#key expandedTripId}
				{#if chartPoints.length >= 2}
				<div class="charts-bleed">
					<TripCharts points={chartPoints} />
				</div>
				{/if}
				{/key}

				<!-- First + last entries -->
				{#if expandedLoading}
				<div class="expanded-loading">Loading entries…</div>
				{:else if expandedEntries.length > 0 && !showAllEntries}
				<div class="endpoint-list">
					{#each expandedEntries as e, i (e.id)}
					<div class="endpoint-row">
						<span class="ep-label" class:ep-start={i === 0} class:ep-end={i === expandedEntries.length - 1 && expandedEntries.length > 1}>
							{i === 0 ? 'Departure' : 'Arrival'}
						</span>
						<div class="endpoint-body">
							<div class="endpoint-time">{fmtDate(e.logged_at)} {fmtTime(e.logged_at)}</div>
							<div class="entry-nav" style="margin-bottom:4px">
								{#if e.sog_kn != null}<span class="entry-chip">{e.sog_kn.toFixed(1)} kn</span>{/if}
								{#if e.cog_deg != null}<span class="entry-chip">{dirAbbr(e.cog_deg)}</span>{/if}
								{#if e.engine_rpm != null}<span class="entry-chip eng">P {e.engine_rpm} rpm{e.engine_temp_c != null ? ` · ${e.engine_temp_c.toFixed(0)}°C` : ''}</span>{/if}
								{#if e.engine_sb_rpm != null}<span class="entry-chip eng">S {e.engine_sb_rpm} rpm{e.engine_sb_temp_c != null ? ` · ${e.engine_sb_temp_c.toFixed(0)}°C` : ''}</span>{/if}
								{#if e.engine_on && e.engine_rpm == null && e.engine_sb_rpm == null}<span class="entry-chip eng">engine on</span>{/if}
								{#if e.sails}<span class="entry-chip sail">{e.sails}</span>{/if}
								{#if e.distance_nm != null && e.distance_nm > 0}<span class="entry-chip dist">+{e.distance_nm.toFixed(1)} nm</span>{/if}
							</div>
							{@render entryEnv(e)}
							{#if e.notes}<p class="entry-notes" style="margin:4px 0 0">{e.notes}</p>{/if}
						</div>
					</div>
					{/each}
				</div>

				{#if expandedEntryCount > expandedEntries.length}
				<button class="show-all-btn" onclick={() => loadAllEntries(trip.id)}>
					<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
						<line x1="3" y1="5" x2="13" y2="5"/>
						<line x1="3" y1="8" x2="13" y2="8"/>
						<line x1="3" y1="11" x2="9" y2="11"/>
					</svg>
					Show all {expandedEntryCount} entries
				</button>
				{/if}

				{:else if showAllEntries}
				{#if allEntriesLoading}
				<div class="expanded-loading">Loading all entries…</div>
				{:else}
				<div class="expanded-header">
					<span class="section-title">All entries · {expandedAllEntries.length}</span>
					<button class="show-all-btn" style="margin-top:0" onclick={() => { showAllEntries = false; }}>Show less</button>
				</div>
				<div class="entry-list">
					{#each expandedAllEntries as e (e.id)}
					<div class="entry-row" class:auto={e.source === 'auto'}>
						<div class="entry-time">
							<span class="entry-hhmm">{fmtTime(e.logged_at)}</span>
							<span class="entry-date">{fmtDate(e.logged_at)}</span>
							{#if e.source === 'auto'}<span class="entry-auto-tag">auto</span>{/if}
						</div>
						<div class="entry-body">
							<div class="entry-nav">
								{#if e.sog_kn != null}<span class="entry-chip">{e.sog_kn.toFixed(1)} kn</span>{/if}
								{#if e.cog_deg != null}<span class="entry-chip">{dirAbbr(e.cog_deg)}</span>{/if}
								{#if e.engine_rpm != null}<span class="entry-chip eng">P {e.engine_rpm} rpm{e.engine_temp_c != null ? ` · ${e.engine_temp_c.toFixed(0)}°C` : ''}</span>{/if}
								{#if e.engine_sb_rpm != null}<span class="entry-chip eng">S {e.engine_sb_rpm} rpm{e.engine_sb_temp_c != null ? ` · ${e.engine_sb_temp_c.toFixed(0)}°C` : ''}</span>{/if}
								{#if e.engine_on && e.engine_rpm == null && e.engine_sb_rpm == null}<span class="entry-chip eng">engine on</span>{/if}
								{#if e.sails}<span class="entry-chip sail">{e.sails}</span>{/if}
								{#if e.distance_nm != null && e.distance_nm > 0}<span class="entry-chip dist">+{e.distance_nm.toFixed(1)} nm</span>{/if}
							</div>
							{@render entryEnv(e)}
							{#if e.notes}<p class="entry-notes">{e.notes}</p>{/if}
						</div>
					</div>
					{/each}
				</div>
				{/if}
				{/if}

				<!-- Notes from log entries -->
				{#if expandedNotedEntries.length > 0}
				<div class="trip-notes-section">
					<div class="section-label" style="margin-bottom:6px">Notes</div>
					{#each expandedNotedEntries as n (n.id)}
					<div class="trip-note-row">
						<span class="trip-note-time">{fmtDate(n.logged_at)} {fmtTime(n.logged_at)}</span>
						<p class="trip-note-text">{n.notes}</p>
					</div>
					{/each}
				</div>
				{/if}

				<!-- Edit + delete (inside expanded — safe from accidental tap) -->
				{#if isAdmin && !selectionMode}
				<div class="trip-expanded-actions">
					<button class="trip-action-btn trip-action-edit" onclick={(e) => openEditTrip(trip, e)}>
						<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<path d="M11.5 2.5 a1.5 1.5 0 0 1 2.1 2.1 L5 13 l-3 1 1-3 8.5-8.5z"/>
						</svg>
						Edit trip
					</button>
					{#if mergeCandidateFor(trip)}
					<button class="trip-action-btn trip-action-merge" onclick={(e) => mergeWithPrevious(trip, e)}>
						<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<line x1="8" y1="1" x2="8" y2="9"/>
							<polyline points="5,6 8,9 11,6"/>
							<line x1="8" y1="15" x2="8" y2="9"/>
						</svg>
						Merge with previous
					</button>
					{/if}
					<button class="trip-action-btn trip-action-del" onclick={(e) => deleteTripSingle(trip, e)}>
						<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="2,4 14,4"/>
							<path d="M5 4 V2.5 a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4"/>
							<rect x="3" y="4" width="10" height="9" rx="1.5"/>
							<line x1="6.5" y1="7" x2="6.5" y2="11"/>
							<line x1="9.5" y1="7" x2="9.5" y2="11"/>
						</svg>
						Delete trip
					</button>
				</div>
				{/if}

			</div>
			{/if}
		</div>
		{/each}
			{/if}
			</div>
			{/each}
			{/if}
		</div>
		{/each}

		{#if groupedTrips().length === 0}
		<div class="no-trips">No trips in this period.</div>
		{/if}
	</div>
	{/if}
</div>

<!-- ── Start trip modal ──────────────────────────────────────────────────── -->
{#if showTripModal}
<div class="modal-backdrop" onclick={() => { showTripModal = false; }}>
<div class="modal" onclick={(e) => e.stopPropagation()}>
	<div class="modal-title">Start new trip</div>
	<label class="modal-label">Trip name (optional)
		<input class="modal-input" bind:value={tripName} placeholder="e.g. Palma → Menorca" />
	</label>
	<label class="modal-label">From port
		<input class="modal-input" bind:value={tripFromPort} placeholder="Departure port" />
	</label>
	<label class="modal-label">To port (optional)
		<input class="modal-input" bind:value={tripToPort} placeholder="Destination port" />
	</label>
	<div class="modal-actions">
		<button class="btn-cancel" onclick={() => { showTripModal = false; }}>Cancel</button>
		<button class="btn-primary" onclick={startTrip} disabled={saving}>{saving ? 'Starting…' : 'Start trip'}</button>
	</div>
</div>
</div>
{/if}

<!-- ── Edit trip modal ───────────────────────────────────────────────────── -->
{#if editingTrip}
<div class="modal-backdrop" onclick={() => { editingTrip = null; }}>
<div class="modal" onclick={(e) => e.stopPropagation()}>
	<div class="modal-title">Edit trip</div>
	<label class="modal-label">Trip name
		<input class="modal-input" bind:value={editName} placeholder="Trip name" />
	</label>
	<label class="modal-label">From port
		<input class="modal-input" bind:value={editFromPort} placeholder="Departure port" />
	</label>
	<label class="modal-label">To port
		<input class="modal-input" bind:value={editToPort} placeholder="Destination port" />
	</label>
	<label class="modal-label">Notes
		<textarea class="modal-textarea" bind:value={editNotes} placeholder="Trip notes…" rows="2"></textarea>
	</label>
	<div class="modal-actions">
		<button class="btn-cancel" onclick={() => { editingTrip = null; }}>Cancel</button>
		<button class="btn-primary" onclick={saveEditTrip} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
	</div>
</div>
</div>
{/if}

<!-- ── Manual entry modal ────────────────────────────────────────────────── -->
{#if showEntryModal}
<div class="modal-backdrop" onclick={() => { showEntryModal = false; }}>
<div class="modal" onclick={(e) => e.stopPropagation()}>
	<div class="modal-title">Log entry</div>
	<div class="entry-preview">
		{#if liveLat() != null}<span class="prev-chip">{liveLat()?.toFixed(4)}° {liveLon()?.toFixed(4)}°</span>{/if}
		{#if liveSog() != null}<span class="prev-chip">{liveSog()} kn</span>{/if}
		{#if liveWind() != null}<span class="prev-chip">{liveWind()} kn wind</span>{/if}
		{#if wave.wave_height_m != null}<span class="prev-chip">{wave.wave_height_m} m wave</span>{/if}
		{#if anyEngOn()}<span class="prev-chip eng">{engineCount() === 2 ? `P:${liveEngOn()?'on':'off'} S:${liveEngSbOn()?'on':'off'}` : 'Engine on'}</span>{/if}
	</div>
	<label class="modal-label">Sails set
		<input class="modal-input" bind:value={entrySails} placeholder="e.g. Full main + genoa" />
	</label>
	<label class="modal-label">Notes
		<textarea class="modal-textarea" bind:value={entryNotes} placeholder="Observations, course changes, events…" rows="3"></textarea>
	</label>
	<div class="modal-actions">
		<button class="btn-cancel" onclick={() => { showEntryModal = false; }}>Cancel</button>
		<button class="btn-primary" onclick={submitManualEntry} disabled={saving}>{saving ? 'Saving…' : 'Save entry'}</button>
	</div>
</div>
</div>
{/if}

<!-- ── Env data snippet (reused in entry lists) ───────────────────────────── -->
{#snippet entryEnv(e: LogEntry)}
{#if e.wind_speed_kn != null || e.apparent_wind_speed_kn != null || e.wave_height_m != null || e.baro_hpa != null || e.air_temp_c != null || e.water_temp_c != null || e.depth_m != null || e.batt_soc != null}
<div class="entry-env">
	{#if e.wind_speed_kn != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="flex-shrink:0">
			<path d="M1 4.5h6.5a2 2 0 0 0 0-3"/><path d="M1 7.5h8.5a2 2 0 0 0 0-3"/>
			<path d="M1 10.5h5a2 2 0 0 0 0-3"/>
		</svg>
		TWS {e.wind_speed_kn.toFixed(0)} kn {dirAbbr(e.wind_dir_deg)}
	</span>
	{/if}
	{#if e.apparent_wind_speed_kn != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="flex-shrink:0">
			<path d="M1 4.5h6.5a2 2 0 0 0 0-3"/><path d="M1 7.5h8.5a2 2 0 0 0 0-3"/>
			<path d="M1 10.5h5a2 2 0 0 0 0-3"/>
		</svg>
		AWS {e.apparent_wind_speed_kn.toFixed(0)} kn{e.apparent_wind_angle_deg != null ? ` · ${fmtAWA(e.apparent_wind_angle_deg)}` : ''}
	</span>
	{/if}
	{#if e.wave_height_m != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="flex-shrink:0">
			<path d="M1 7 C2.5 5 4 9 5.5 7 C7 5 8.5 9 10 7 C11 6 12 6.5 13 6.5"/>
			<path d="M1 10.5 C2.5 8.5 4 12.5 5.5 10.5 C7 8.5 8.5 12.5 10 10.5 C11 9.5 12 10 13 10"/>
		</svg>
		{e.wave_height_m.toFixed(1)} m{e.wave_period_s != null ? ` · ${e.wave_period_s.toFixed(0)}s` : ''}
	</span>
	{/if}
	{#if e.baro_hpa != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="flex-shrink:0">
			<circle cx="7" cy="8" r="4.5"/>
			<path d="M7 8 L9 5.5"/>
			<line x1="3.8" y1="11" x2="4.7" y2="10.1"/>
			<line x1="9.6" y1="10.8" x2="10.3" y2="10"/>
		</svg>
		{e.baro_hpa.toFixed(0)} hPa
	</span>
	{/if}
	{#if e.air_temp_c != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="flex-shrink:0">
			<circle cx="7" cy="10.5" r="2"/><line x1="7" y1="8.5" x2="7" y2="3"/>
			<line x1="7" y1="4.5" x2="9" y2="4.5"/>
			<line x1="7" y1="6.5" x2="9" y2="6.5"/>
		</svg>
		{e.air_temp_c.toFixed(0)}°C air{e.water_temp_c != null ? ` · ${e.water_temp_c.toFixed(0)}°C water` : ''}
	</span>
	{:else if e.water_temp_c != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="flex-shrink:0">
			<circle cx="7" cy="10.5" r="2"/><line x1="7" y1="8.5" x2="7" y2="3"/>
			<line x1="7" y1="4.5" x2="9" y2="4.5"/>
			<line x1="7" y1="6.5" x2="9" y2="6.5"/>
		</svg>
		{e.water_temp_c.toFixed(0)}°C water
	</span>
	{/if}
	{#if e.depth_m != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="flex-shrink:0">
			<line x1="7" y1="1" x2="7" y2="13"/><path d="M4 10 L7 13 L10 10"/>
		</svg>
		{e.depth_m.toFixed(1)} m
	</span>
	{/if}
	{#if e.batt_soc != null}
	<span class="entry-env-item">
		<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
			<rect x="1" y="3.5" width="10" height="7" rx="1.5"/><line x1="11" y1="6" x2="13" y2="6"/><line x1="11" y1="8" x2="13" y2="8"/>
		</svg>
		{e.batt_soc.toFixed(0)}%
	</span>
	{/if}
</div>
{/if}
{/snippet}

<style>
	.log-page {
		display: flex; flex-direction: column; gap: 12px;
		padding-bottom: 24px;
	}
	.log-loading { font-size: 13px; color: var(--muted); padding: 20px 0; text-align: center; }

	/* ── Offline indicators ───────────────────────────────────────────────────── */
	.offline-warning {
		background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3);
		border-radius: 8px; padding: 12px 14px;
		font-size: 13px; color: var(--red); font-weight: 500;
	}
	.sync-progress {
		background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3);
		border-radius: 8px; padding: 12px 14px;
		font-size: 13px; color: var(--blue); display: flex; align-items: center; gap: 8px;
	}
	.spinner {
		display: inline-block; width: 11px; height: 11px;
		border: 2px solid rgba(59, 130, 246, 0.3); border-top-color: var(--blue);
		border-radius: 50%; animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* ── Trip banner ──────────────────────────────────────────────────────── */
	.trip-banner {
		background: var(--card); border: 1px solid var(--border); border-radius: 10px;
		padding: 14px;
	}
	.trip-banner-top {
		display: flex; justify-content: space-between; align-items: flex-start;
		margin-bottom: 12px;
	}
	.trip-banner-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.trip-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.trip-dot.active { background: var(--green); animation: pulse-live 2s ease-in-out infinite; }
	@keyframes pulse-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
	.trip-name { font-size: 15px; font-weight: 700; }
	.trip-route { font-size: 12px; color: var(--muted); }
	.trip-duration { font-size: 12px; color: var(--muted); white-space: nowrap; flex-shrink: 0; }

	.ratio-section { margin-bottom: 10px; }
	.ratio-bar-wrap { margin-bottom: 5px; }
	.ratio-bar {
		height: 8px; border-radius: 4px; overflow: hidden;
		background: var(--border); display: flex;
	}
	.ratio-bar.mini { height: 5px; border-radius: 3px; }
	.ratio-sail  { height: 100%; transition: width 0.4s; }
	.ratio-motor { height: 100%; background: #6b7280; flex: 1; }
	.ratio-labels { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
	.ratio-label { white-space: nowrap; }
	.ratio-label.total { margin-left: auto; font-weight: 600; color: var(--text); }

	.trip-snapshot {
		display: flex; gap: 12px; flex-wrap: wrap;
		padding: 10px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
		margin-bottom: 10px;
	}
	.snap-item { display: flex; flex-direction: column; align-items: center; min-width: 44px; }
	.snap-item.eng-on .snap-val { color: var(--amber); }
	.snap-val { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
	.snap-lbl { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

	.trip-actions { display: flex; gap: 8px; }
	.btn-entry {
		flex: 1; padding: 9px 12px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 7px; color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer;
	}
	.btn-entry:hover { background: rgba(0,200,255,.08); border-color: var(--accent); }
	.btn-end {
		flex: 1; padding: 9px 12px; background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3);
		border-radius: 7px; color: var(--red); font-size: 13px; font-weight: 600; cursor: pointer;
	}
	.btn-end:hover { background: rgba(239,68,68,.2); }
	.btn-end:disabled { opacity: 0.5; cursor: default; }

	.start-cta {
		display: flex; flex-direction: column; align-items: center; gap: 8px;
		padding: 28px 0; background: var(--card); border: 1px solid var(--border); border-radius: 10px;
	}
	.start-text { font-size: 14px; color: var(--muted); }
	.btn-start {
		padding: 10px 28px; background: var(--accent); color: #000;
		border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer;
	}
	.btn-start:hover { opacity: 0.9; }

	/* ── Section headers ──────────────────────────────────────────────────── */
	.section-header {
		display: flex; justify-content: space-between; align-items: center;
	}
	.section-title {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.6px; color: var(--muted);
	}

	/* ── Log entries ──────────────────────────────────────────────────────── */
	.entry-list { display: flex; flex-direction: column; gap: 0; }
	.entry-row {
		display: flex; gap: 10px; padding: 10px 0;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
	}
	.entry-row:last-child { border-bottom: none; }
	.entry-row.auto { opacity: 0.8; }
	.entry-time {
		display: flex; flex-direction: column; align-items: flex-end;
		min-width: 46px; flex-shrink: 0; gap: 2px; padding-top: 1px;
	}
	.entry-hhmm { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
	.entry-date { font-size: 9px; color: var(--muted); }
	.entry-auto-tag {
		font-size: 8px; color: var(--muted); background: var(--card2);
		border: 1px solid var(--border); border-radius: 3px; padding: 0 3px;
	}
	.entry-body { flex: 1; min-width: 0; }
	.entry-nav  { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
	.entry-chip {
		font-size: 11px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 4px; padding: 1px 6px; white-space: nowrap;
	}
	.entry-chip.eng  { color: var(--amber); border-color: rgba(251,191,36,.3); }
	.entry-chip.sail { color: var(--accent); border-color: rgba(0,200,255,.3); }
	.entry-chip.dist { color: var(--green); border-color: rgba(0,220,130,.3); }
	.entry-env { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 3px; }
	.entry-env-item {
		display: flex; align-items: center; gap: 3px;
		font-size: 11px; color: var(--muted);
	}
	.entry-notes { font-size: 12px; color: var(--text); margin: 0; line-height: 1.4; }

	/* ── Stats grid ───────────────────────────────────────────────────────── */
	.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
	.stat-card {
		background: var(--card); border: 1px solid var(--border); border-radius: 8px;
		padding: 12px 10px; display: flex; flex-direction: column; align-items: center; gap: 4px;
	}
	.stat-ratio { width: 100%; margin-bottom: 4px; }
	.stat-val { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
	.stat-lbl { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

	/* ── Past trips ───────────────────────────────────────────────────────── */
	.past-trips { display: flex; flex-direction: column; gap: 8px; }
	.past-trip-card {
		background: var(--card); border: 1px solid var(--border); border-radius: 8px;
		padding: 12px; transition: border-color 0.2s;
		overflow: hidden;  /* clip charts to rounded card border */
	}
	.past-trip-card.expanded { border-color: rgba(0,200,255,.2); }
	.past-trip-card.selected { border-color: rgba(0,200,255,.4); background: rgba(0,200,255,.04); }
	.past-trip-name  { font-size: 14px; font-weight: 600; }
	.past-trip-dates { font-size: 11px; color: var(--muted); white-space: nowrap; }
	.past-trip-route { font-size: 11px; color: var(--muted); display: block; }
	.past-ratio { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
	.past-ratio-lbl { font-size: 11px; color: var(--muted); white-space: nowrap; }
	.past-stats { display: flex; gap: 5px; flex-wrap: wrap; }
	.past-chip {
		font-size: 11px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 4px; padding: 2px 7px;
	}
	.past-chip-dur {
		font-weight: 600; background: rgba(0,200,255,.08); border-color: rgba(0,200,255,.25);
		color: var(--accent);
	}
	.past-chip-eng {
		background: rgba(255,160,50,.08); border-color: rgba(255,160,50,.3);
		color: #ffaa44;
	}
	.past-chip-sail {
		background: rgba(34,197,94,.08); border-color: rgba(34,197,94,.3);
		color: #4ade80;
	}
	.past-trip-notes { font-size: 12px; color: var(--muted); margin: 8px 0 0; }

	/* ── Quick note field ── */
	.quick-note-area {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px;
		background: var(--card2);
		border-radius: 8px;
		border: 1px solid var(--border);
	}
	.quick-note-input {
		width: 100%;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text);
		font-size: 13px;
		font-family: inherit;
		resize: none;
		outline: none;
		line-height: 1.4;
		transition: border-color 0.2s;
	}
	.quick-note-input:focus { border-color: var(--accent); }
	.quick-note-input::placeholder { color: var(--muted); font-size: 12px; }
	.quick-note-btn {
		padding: 6px 14px;
		background: rgba(0,200,255,0.1);
		border: 1px solid rgba(0,200,255,0.3);
		border-radius: 6px;
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
		white-space: nowrap;
	}
	.quick-note-btn:disabled { opacity: 0.4; cursor: default; }
	.quick-note-btn:not(:disabled):hover { background: rgba(0,200,255,0.2); }

	.note-btn-row {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: flex-end;
	}
	.note-cancel-btn {
		padding: 6px 12px;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.note-cancel-btn:hover { color: var(--text); }

	/* Locked state (note saved, waiting for next entry) */
	.note-locked {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.note-locked-text {
		font-size: 13px;
		color: var(--text);
		line-height: 1.4;
		margin: 0;
		white-space: pre-line;
		padding: 8px 10px;
		background: rgba(0,200,255,0.05);
		border: 1px solid rgba(0,200,255,0.15);
		border-radius: 6px;
	}
	.note-locked-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.note-locked-hint {
		font-size: 11px;
		color: var(--muted);
		font-style: italic;
	}

	/* ── Past trip notes list ── */
	.trip-notes-section {
		padding: 10px 0 4px;
		border-top: 1px solid var(--border);
		margin-top: 8px;
	}
	.trip-note-row {
		margin-bottom: 8px;
	}
	.trip-note-time {
		font-size: 10px;
		color: var(--muted);
		display: block;
		margin-bottom: 2px;
	}
	.trip-note-text {
		font-size: 12px;
		color: var(--text);
		line-height: 1.4;
		margin: 0;
		white-space: pre-line;   /* preserve newlines from env context block */
	}

	/* Trip header row */
	.past-trip-header {
		display: flex; align-items: flex-start; gap: 8px;
		margin-bottom: 8px; cursor: pointer; user-select: none;
	}
	.past-trip-header:hover .past-trip-name { color: var(--accent); }
	.past-trip-header-left { display: flex; flex-direction: column; gap: 2px; flex: 1; }
	.past-trip-header-right {
		display: flex; align-items: center; gap: 4px; flex-shrink: 0;
	}
	.expand-icon { color: var(--muted); display: flex; align-items: center; }

	/* Edit / delete icon buttons */
	/* Expanded-section action buttons (edit / delete) */
	.trip-expanded-actions {
		display: flex; gap: 8px; padding: 12px 12px 4px; border-top: 1px solid var(--border);
		margin-top: 8px;
	}
	.trip-action-btn {
		display: flex; align-items: center; gap: 6px;
		padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
		border: 1px solid var(--border); background: var(--card2); color: var(--muted);
		transition: all 0.15s;
	}
	.trip-action-btn:hover { color: var(--text); border-color: var(--text); }
	.trip-action-del:hover   { color: var(--red);   border-color: rgba(239,68,68,.4);  background: rgba(239,68,68,.06); }
	.trip-action-merge:hover { color: var(--amber); border-color: rgba(234,179,8,.4); background: rgba(234,179,8,.06); }

	/* Selection checkbox */
	.trip-checkbox {
		width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; padding: 0; flex-shrink: 0;
	}

	/* ── Modals ───────────────────────────────────────────────────────────── */
	.modal-backdrop {
		position: fixed; inset: 0; background: rgba(0,0,0,0.6);
		display: flex; align-items: flex-end; justify-content: center;
		z-index: 500;
	}
	.modal {
		background: var(--card); border: 1px solid var(--border);
		border-radius: 14px 14px 0 0;
		padding: 20px 16px calc(20px + env(safe-area-inset-bottom));
		width: 100%; max-width: 500px;
		display: flex; flex-direction: column; gap: 12px;
	}
	.modal-title { font-size: 16px; font-weight: 700; }
	.modal-label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
	.modal-input {
		background: var(--card2); border: 1px solid var(--border); border-radius: 7px;
		padding: 9px 11px; color: var(--text); font-size: 14px;
	}
	.modal-input:focus { outline: none; border-color: var(--accent); }
	.modal-textarea {
		background: var(--card2); border: 1px solid var(--border); border-radius: 7px;
		padding: 9px 11px; color: var(--text); font-size: 14px; resize: vertical;
		font-family: inherit;
	}
	.modal-textarea:focus { outline: none; border-color: var(--accent); }
	.modal-actions { display: flex; gap: 8px; margin-top: 4px; }
	.btn-cancel {
		flex: 1; padding: 10px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 8px; color: var(--text); font-size: 14px; cursor: pointer;
	}
	.btn-primary {
		flex: 2; padding: 10px; background: var(--accent); border: none;
		border-radius: 8px; color: #000; font-size: 14px; font-weight: 700; cursor: pointer;
	}
	.btn-primary:disabled { opacity: 0.5; cursor: default; }

	.entry-preview {
		display: flex; gap: 5px; flex-wrap: wrap;
		padding: 8px; background: var(--card2); border: 1px solid var(--border); border-radius: 7px;
	}
	.prev-chip { font-size: 12px; background: var(--border); border-radius: 4px; padding: 2px 7px; }
	.prev-chip.eng { color: var(--amber); }

	/* ── Auto-trip status bar ─────────────────────────────────────────────── */
	.auto-bar {
		display: flex; justify-content: space-between; align-items: center;
		padding: 8px 12px; border-radius: 8px;
		background: var(--card); border: 1px solid var(--border);
		font-size: 12px; gap: 8px;
	}
	.auto-bar.auto-watching  { border-color: rgba(251,191,36,.35); background: rgba(251,191,36,.05); }
	.auto-bar.auto-recording { border-color: rgba(34,197,94,.35);  background: rgba(34,197,94,.05); }
	.auto-bar.auto-countdown { border-color: rgba(249,115,22,.4);  background: rgba(249,115,22,.06); }
	.auto-bar.auto-disabled  { opacity: 0.55; }
	.auto-bar-left { display: flex; align-items: center; gap: 8px; }
	.auto-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--muted); }
	.auto-dot.dot-idle      { opacity: 0.5; }
	.auto-dot.dot-watching  { background: var(--amber); animation: pulse-live 2s ease-in-out infinite; }
	.auto-dot.dot-recording { background: var(--green); animation: pulse-live 2s ease-in-out infinite; }
	.auto-dot.dot-countdown { background: #f97316; }
	.auto-status { color: var(--muted); line-height: 1.3; }
	.auto-toggle-btn {
		font-size: 11px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 5px; padding: 4px 10px; cursor: pointer; color: var(--text); flex-shrink: 0;
	}
	.auto-toggle-btn:hover { background: var(--border); }

	/* ── Filter + sort row ────────────────────────────────────────────────── */
	.filter-row {
		display: flex; justify-content: space-between; align-items: center;
		margin-top: 16px;
	}
	.filter-tabs { display: flex; gap: 4px; }
	.filter-tab {
		font-size: 11px; padding: 4px 10px; border-radius: 5px;
		border: 1px solid var(--border); background: var(--card2);
		color: var(--muted); cursor: pointer;
	}
	.filter-tab.active {
		background: rgba(0,200,255,.12); border-color: var(--accent);
		color: var(--accent); font-weight: 600;
	}
	.filter-right { display: flex; gap: 4px; }
	.sort-btn, .select-btn {
		font-size: 11px; padding: 4px 10px; border-radius: 5px;
		border: 1px solid var(--border); background: var(--card2);
		color: var(--muted); cursor: pointer;
	}
	.sort-btn:hover, .select-btn:hover { border-color: var(--accent); color: var(--accent); }
	.select-btn.active { background: rgba(0,200,255,.12); border-color: var(--accent); color: var(--accent); }

	/* ── Selection bar ────────────────────────────────────────────────────── */
	.selection-bar {
		display: flex; justify-content: space-between; align-items: center;
		padding: 6px 10px; border-radius: 7px;
		background: rgba(0,200,255,.06); border: 1px solid rgba(0,200,255,.2);
		gap: 8px;
	}
	.selection-bar-left { display: flex; align-items: center; gap: 6px; }
	.sel-action-btn {
		font-size: 11px; padding: 3px 8px; border-radius: 4px;
		border: 1px solid var(--border); background: var(--card2);
		color: var(--muted); cursor: pointer;
	}
	.sel-action-btn:hover { color: var(--accent); border-color: var(--accent); }
	.sel-count { font-size: 11px; color: var(--muted); }
	.sel-delete-btn {
		font-size: 11px; padding: 4px 12px; border-radius: 5px;
		border: 1px solid rgba(239,68,68,.3); background: rgba(239,68,68,.08);
		color: var(--red); cursor: pointer; font-weight: 600;
	}
	.sel-delete-btn:hover { background: rgba(239,68,68,.16); }
	.sel-delete-btn:disabled { opacity: 0.4; cursor: default; }

	/* ── Expanded trip section ────────────────────────────────────────────── */
	.expanded-entries {
		margin-top: 10px; padding-top: 10px;
		border-top: 1px solid var(--border);
	}
	/* Break TripCharts out of the 12px card padding so charts span full width */
	.charts-bleed {
		margin: 0 -12px;
	}
	.expanded-header {
		display: flex; justify-content: space-between; align-items: center;
		margin-bottom: 6px;
	}
	.expanded-loading { font-size: 12px; color: var(--muted); padding: 8px 0; text-align: center; }
	.no-trips { font-size: 13px; color: var(--muted); text-align: center; padding: 16px 0; }

	/* ── Trip map ─────────────────────────────────────────────────────────── */
	.trip-map-wrap {
		position: relative; height: 200px; background: #0a1520;
		border-radius: 7px; overflow: hidden; margin-bottom: 10px;
	}
	.trip-map-el { width: 100%; height: 100%; }
	/* Tile darkening via a simple rgba div (avoids CSS filter stacking-context issues) */
	.trip-map-dark {
		position: absolute; inset: 0; z-index: 300;
		background: rgba(0, 0, 0, 0.18); pointer-events: none;
		border-radius: 7px;
	}
	.trip-map-overlay {
		position: absolute; inset: 0; z-index: 800;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px; color: var(--muted);
		background: rgba(8,16,28,.85);
	}
	.trip-map-controls {
		position: absolute; top: 8px; right: 8px;
		display: flex; flex-direction: column; gap: 4px; z-index: 1000;
	}
	.trip-map-btn {
		width: 28px; height: 28px;
		background: rgba(8,16,28,.82); border: 1px solid rgba(255,255,255,.15);
		border-radius: 6px; color: var(--text); font-size: 16px; font-weight: 500;
		display: flex; align-items: center; justify-content: center;
		cursor: pointer; padding: 0;
	}
	.trip-map-btn:hover { background: rgba(0,200,255,.18); border-color: rgba(0,200,255,.4); }
	.trip-map-btn-center { margin-top: 4px; color: #00c8ff; }

	/* ── Endpoint entries (first + last) ──────────────────────────────────── */
	.endpoint-list { display: flex; flex-direction: column; gap: 0; margin-bottom: 8px; }
	.endpoint-row {
		display: flex; gap: 10px; padding: 8px 0;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
	}
	.endpoint-row:last-child { border-bottom: none; }
	.ep-label {
		font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
		min-width: 52px; flex-shrink: 0; padding-top: 2px; color: var(--muted);
	}
	.ep-label.ep-start { color: var(--green); }
	.ep-label.ep-end   { color: var(--accent); }
	.endpoint-body { flex: 1; min-width: 0; }
	.endpoint-time { font-size: 11px; color: var(--muted); margin-bottom: 4px; }

	.show-all-btn {
		display: flex; align-items: center; gap: 6px;
		width: 100%; padding: 8px 0; font-size: 12px; color: var(--accent);
		background: none; border: none; border-top: 1px solid var(--border);
		cursor: pointer; margin-top: 4px;
	}
	.show-all-btn:hover { color: var(--text); }

	/* ── Year / Month grouping ────────────────────────────────────────────── */
	.year-group { display: flex; flex-direction: column; gap: 0; }
	.year-header {
		display: flex; align-items: center; gap: 8px;
		padding: 10px 4px; width: 100%;
		background: none; border: none; border-bottom: 1px solid var(--border);
		color: var(--text); cursor: pointer; font-size: 15px; font-weight: 700;
		text-align: left;
	}
	.year-header:hover { color: var(--accent); }
	.year-stats { font-size: 12px; color: var(--muted); font-weight: 400; }

	.month-group { display: flex; flex-direction: column; gap: 6px; padding: 6px 0; }
	.month-header {
		display: flex; align-items: center; gap: 8px;
		padding: 5px 6px; width: 100%;
		background: none; border: none; border-radius: 5px;
		color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 600;
		text-align: left;
	}
	.month-header:hover { background: var(--card2); color: var(--text); }
	.month-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
	.month-stats { font-size: 11px; color: var(--muted); font-weight: 400; }

	/* ── Wind & baro charts ───────────────────────────────────────────────── */
	.chart-section {
		background: var(--card2); border: 1px solid var(--border);
		border-radius: 7px; padding: 10px 10px 6px;
		margin-bottom: 10px;
	}
	.chart-block { min-height: 0; }
	.chart-label {
		display: flex; align-items: center; gap: 5px;
		font-size: 10px; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.5px; color: var(--accent); margin-bottom: 4px;
	}

	/* ── Auto-log terminal ────────────────────────────────────────────────── */
	.terminal {
		background: #030a03; border: 1px solid rgba(0,220,130,.22);
		border-radius: 8px; overflow: hidden;
		font-family: 'SF Mono','Fira Code','Menlo','Monaco',monospace;
	}
	.terminal-hdr {
		display: flex; justify-content: space-between; align-items: center;
		padding: 5px 10px; background: rgba(0,220,130,.07);
		border-bottom: 1px solid rgba(0,220,130,.14);
	}
	.terminal-title {
		display: flex; align-items: center; gap: 6px;
		font-size: 10px; font-weight: 700; letter-spacing: 1px; color: var(--green);
	}
	.terminal-dot {
		width: 6px; height: 6px; border-radius: 50%; background: var(--green);
		animation: pulse-live 2s ease-in-out infinite;
	}
	.terminal-meta { font-size: 10px; color: rgba(0,220,130,.4); }
	.terminal-body { padding: 7px 10px; display: flex; flex-direction: column; gap: 1px; }
	.terminal-line {
		font-size: 11px; color: rgba(100,220,150,.55);
		white-space: pre; overflow: hidden; text-overflow: ellipsis; line-height: 1.65;
	}
	.terminal-line.terminal-line-fresh { color: #7effa0; }
</style>
