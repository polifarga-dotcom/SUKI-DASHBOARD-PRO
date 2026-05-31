<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { supabase } from '$lib/supabase.js';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { vrmData } from '$lib/stores/vrm.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { currentBoat, boatRole } from '$lib/stores/boat.js';
	import { inreachPoints } from '$lib/stores/inreach.js';
	import { latestWave } from '$lib/stores/weather.js';
	import { activeTrip, tripEntries, allTrips, logLoaded } from '$lib/stores/logbook.js';
	import { haversine } from '$lib/utils/geo.js';
	import type { LogEntry, LogTrip } from '$lib/types.js';

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
	let showPastTrips   = $state(false);
	let saving          = $state(false);
	let autoLogTimer:    ReturnType<typeof setInterval>;
	let autoCheckTimer:  ReturnType<typeof setInterval>;

	// ── Auto-trip engine state ────────────────────────────────────────────────
	const SOG_TRIP_KN      = 1.5;
	const CONFIRM_START_MS = 1  * 60_000;   // must move 1 min → auto-start
	const CONFIRM_STOP_MS  = 15 * 60_000;   // must be slow 15 min → auto-stop

	type AutoMode = 'idle' | 'watching' | 'recording' | 'countdown';
	// Persist across page navigations / app restarts
	let autoEnabled = $state(
		typeof localStorage !== 'undefined'
			? localStorage.getItem('autoTripEnabled') !== 'false'
			: true
	);
	let autoMode         = $state<AutoMode>('idle');
	let fastSince        = $state<number | null>(null);
	let slowSince        = $state<number | null>(null);
	let isAutoTrip       = $state(false);
	let countdownMinutes = $state(15);

	// ── Cerbo-offline VRM fallback (plain vars — not rendered) ────────────────
	// When Cerbo SOG drops to null, we wait 90 s then check if the VRM GPS
	// position has moved > 100 m. If so, the boat is still underway.
	let cerboLossTime: number | null = null;
	let vrmPosAtLoss: { lat: number; lon: number } | null = null;
	const VRM_FALLBACK_WAIT_MS = 90_000;
	const VRM_MOVE_THRESHOLD_M = 100;

	// ── Terminal log (live feed while auto-recording) ─────────────────────────
	const MAX_LOG = 10;
	let terminalLines = $state<string[]>([]);
	function pushLog(msg: string) {
		const ts = new Date().toLocaleTimeString('en', {
			hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
		});
		terminalLines = [`${ts}  ${msg}`, ...terminalLines].slice(0, MAX_LOG);
	}

	// Write back to localStorage whenever autoEnabled changes
	$effect(() => {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('autoTripEnabled', String(autoEnabled));
		}
	});

	// ── Trip modal form ───────────────────────────────────────────────────────
	let tripName      = $state('');
	let tripFromPort  = $state('');
	let tripToPort    = $state('');

	// ── Manual entry form (pre-filled from live data) ─────────────────────────
	let entryNotes    = $state('');
	let entrySails    = $state('');
	let entryManualSOG = $state<string>('');
	let entryManualCOG = $state<string>('');

	// ── Derived live values ───────────────────────────────────────────────────
	const liveLat   = $derived(() => pts?.[0]?.lat ?? t?.nav_lat ?? null);
	const liveLon   = $derived(() => pts?.[0]?.lon ?? t?.nav_lon ?? null);
	const liveSog   = $derived(() => t?.nav_sog_ms != null ? +(t.nav_sog_ms * 1.94384).toFixed(2) : null);
	const liveCog   = $derived(() => t?.nav_hdg_rad != null ? +(t.nav_hdg_rad * 180 / Math.PI).toFixed(1) : null);
	const liveWind  = $derived(() => t?.env_tws_ms  != null ? +(t.env_tws_ms * 1.94384).toFixed(1) : null);
	// True wind direction = heading + TWA (in degrees)
	const liveWindDir = $derived(() => {
		if (t?.nav_hdg_rad == null || t?.env_twa_rad == null) return null;
		return +((((t.nav_hdg_rad + t.env_twa_rad) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1);
	});
	const liveBaro   = $derived(() => t?.env_pressure_pa != null ? +(t.env_pressure_pa / 100).toFixed(1) : null);
	const liveAirT   = $derived(() => t?.temp_salon   != null ? +(t.temp_salon - 273.15).toFixed(1) : null);
	const liveWaterT = $derived(() => t?.temp_water   != null ? +(t.temp_water - 273.15).toFixed(1) : null);
	const liveEngOn  = $derived(() => (t?.eng_rpm ?? 0) > 200);
	const liveEngH   = $derived(() => t?.eng_run_sec  != null ? +(t.eng_run_sec / 3600).toFixed(2) : null);
	const liveEngT   = $derived(() => t?.eng_temp_k   != null ? +(t.eng_temp_k - 273.15).toFixed(1) : null);

	// ── Helpers ───────────────────────────────────────────────────────────────
	function fmtDuration(startIso: string, endIso?: string | null): string {
		const ms   = (endIso ? new Date(endIso) : new Date()).getTime() - new Date(startIso).getTime();
		const h    = Math.floor(ms / 3_600_000);
		const m    = Math.floor((ms % 3_600_000) / 60_000);
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

	function dirAbbr(deg: number | null): string {
		if (deg == null) return '—';
		const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
		return d[Math.round(deg / 22.5) % 16];
	}

	// Sailing vs motor ratio (0–100, sail %)
	function sailRatio(trip: LogTrip | null): number {
		if (!trip?.total_nm || trip.total_nm === 0) return 0;
		const sail = trip.sail_nm ?? 0;
		return Math.round((sail / trip.total_nm) * 100);
	}

	// Color for ratio bar: green = sail, orange = motor
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
			supabase
				.from('log_trips')
				.select('*')
				.eq('boat_id', boat.id)
				.order('started_at', { ascending: false }),
			supabase
				.from('log_entries')
				.select('*')
				.eq('boat_id', boat.id)
				.is('trip_id', null)
				.order('logged_at', { ascending: false })
				.limit(50),
		]);

		const trips = (tripsRes.data ?? []) as LogTrip[];
		allTrips.set(trips);

		const active = trips.find(tr => tr.ended_at == null) ?? null;
		activeTrip.set(active);

		if (active) {
			// Limit to 200 most-recent entries — trips with 60 s tracking can
			// accumulate 1 440 rows/day; full history is queried at trip end.
			const { data: entries } = await supabase
				.from('log_entries')
				.select('*')
				.eq('trip_id', active.id)
				.order('logged_at', { ascending: false })
				.limit(200);
			tripEntries.set((entries ?? []) as LogEntry[]);
		} else {
			tripEntries.set([]);
		}

		logLoaded.set(true);
	}

	// ── Distance tracking (nm since last entry) ───────────────────────────────
	let lastEntryPos: { lat: number; lon: number } | null = null;

	function calcDistanceSinceLast(lat: number, lon: number): number {
		if (!lastEntryPos) return 0;
		const m  = haversine(lastEntryPos.lat, lastEntryPos.lon, lat, lon);
		return +(m / 1852).toFixed(3);
	}

	// Final accurate distance + stats from all DB entries (used at trip end)
	async function recalcFromDB(tripId: string) {
		const { data } = await supabase
			.from('log_entries')
			.select('distance_nm, engine_on, sog_kn, engine_hours, logged_at')
			.eq('trip_id', tripId)
			.order('logged_at', { ascending: true });
		if (!data?.length) return null;

		const totalNm = +data.reduce((s, e) => s + (e.distance_nm ?? 0), 0).toFixed(3);
		const sailNm  = +data.filter(e => !e.engine_on).reduce((s, e) => s + (e.distance_nm ?? 0), 0).toFixed(3);
		const motorNm = +data.filter(e => e.engine_on).reduce( (s, e) => s + (e.distance_nm ?? 0), 0).toFixed(3);

		const sogsVal = data.filter(e => e.sog_kn != null).map(e => e.sog_kn as number);
		const avgSog  = sogsVal.length
			? +(sogsVal.reduce((a, b) => a + b, 0) / sogsVal.length).toFixed(2)
			: null;

		const withEng  = data.filter(e => e.engine_hours != null);
		const engHours = withEng.length >= 2
			? +Math.max(0, (withEng.at(-1)!.engine_hours as number) - (withEng[0].engine_hours as number)).toFixed(2)
			: null;

		return { totalNm, sailNm, motorNm, avgSog, engHours };
	}

	// Update running trip totals (sail_nm / motor_nm) based on new entry
	async function updateTripTotals(tripId: string, distNm: number, engineOn: boolean) {
		const current = $activeTrip;
		if (!current) return;

		const patch: Partial<LogTrip> = {
			total_nm:  +(((current.total_nm ?? 0) + distNm).toFixed(3)),
			sail_nm:   +(((current.sail_nm  ?? 0) + (engineOn ? 0 : distNm)).toFixed(3)),
			motor_nm:  +(((current.motor_nm ?? 0) + (engineOn ? distNm : 0)).toFixed(3)),
		};

		const sog = liveSog();
		if (sog != null) {
			const currentMax = current.max_sog_kn ?? 0;
			if (sog > currentMax) patch.max_sog_kn = sog;
		}

		await supabase.from('log_trips').update(patch).eq('id', tripId);
		activeTrip.update(tr => tr ? { ...tr, ...patch } : tr);
	}

	// ── Insert a log entry ────────────────────────────────────────────────────
	async function insertEntry(opts: {
		source: 'auto' | 'manual';
		notes?: string;
		sails?: string;
		sogOverride?: number;
		cogOverride?: number;
	}) {
		if (!boat) return;
		const at    = $activeTrip;
		const lat   = liveLat();
		const lon   = liveLon();
		const sog   = opts.sogOverride ?? liveSog();
		const cog   = opts.cogOverride ?? liveCog();
		const engOn = liveEngOn();

		const distNm = (lat != null && lon != null) ? calcDistanceSinceLast(lat, lon) : 0;

		const entry: Omit<LogEntry, 'id' | 'created_at'> = {
			trip_id:       at?.id ?? null,
			boat_id:       boat.id,
			logged_at:     new Date().toISOString(),
			lat, lon,
			cog_deg:       cog,
			sog_kn:        sog,
			distance_nm:   distNm > 0 ? distNm : null,
			engine_on:     engOn,
			engine_rpm:    t?.eng_rpm ?? null,
			engine_hours:  liveEngH(),
			engine_temp_c: liveEngT(),
			sails:         opts.sails?.trim() || null,
			wind_speed_kn: liveWind(),
			wind_dir_deg:  liveWindDir(),
			baro_hpa:      liveBaro(),
			air_temp_c:    liveAirT(),
			water_temp_c:  liveWaterT(),
			wave_height_m: wave.wave_height_m,
			wave_period_s: wave.wave_period_s,
			notes:         opts.notes?.trim() || null,
			source:        opts.source,
		};

		const { data } = await supabase.from('log_entries').insert(entry).select().single();

		if (data) {
			tripEntries.update(es => [data as LogEntry, ...es]);
			if (lat != null && lon != null) lastEntryPos = { lat, lon };
			if (at && distNm > 0) await updateTripTotals(at.id, distNm, engOn);
			pushLog(`+ entry  ${lat?.toFixed(4) ?? '?'}° ${lon?.toFixed(4) ?? '?'}°  ${sog?.toFixed(1) ?? '—'} kn  ${engOn ? '⚙ engine' : '⛵ sail'}${distNm > 0 ? `  +${distNm.toFixed(2)} nm` : ''}`);
		}
	}

	// ── Start trip ────────────────────────────────────────────────────────────
	async function startTrip() {
		if (!boat || saving) return;
		saving = true;
		const { data } = await supabase
			.from('log_trips')
			.insert({
				boat_id:    boat.id,
				name:       tripName.trim() || null,
				from_port:  tripFromPort.trim() || null,
				to_port:    tripToPort.trim() || null,
				started_at: new Date().toISOString(),
			})
			.select()
			.single();

		if (data) {
			const trip = data as LogTrip;
			activeTrip.set(trip);
			allTrips.update(ts => [trip, ...ts]);
			tripEntries.set([]);
			lastEntryPos = null;
			// First entry: departure
			await insertEntry({ source: 'auto', notes: `Departure from ${tripFromPort || 'unknown'}` });
		}
		saving = false;
		showTripModal = false;
		tripName = ''; tripFromPort = ''; tripToPort = '';
	}

	// ── End trip ──────────────────────────────────────────────────────────────
	async function endTrip() {
		const at = $activeTrip;
		if (!at || saving) return;
		saving = true;
		await insertEntry({ source: 'auto', notes: `Arrival at ${at.to_port || 'destination'}` });

		// Recalculate all distances accurately from DB (avoids floating-point
		// drift from incremental updates during 60-second tracking)
		const stats = await recalcFromDB(at.id);

		const patch: Partial<LogTrip> = {
			ended_at:     new Date().toISOString(),
			total_nm:     stats?.totalNm ?? at.total_nm,
			sail_nm:      stats?.sailNm  ?? at.sail_nm,
			motor_nm:     stats?.motorNm ?? at.motor_nm,
			avg_sog_kn:   stats?.avgSog  ?? null,
			engine_hours: stats?.engHours ?? null,
		};
		await supabase.from('log_trips').update(patch).eq('id', at.id);
		activeTrip.update(tr => tr ? { ...tr, ...patch } : tr);

		const finished = { ...(at as LogTrip), ...patch };
		allTrips.update(ts => ts.map(t => t.id === at.id ? finished : t));
		activeTrip.set(null);
		tripEntries.set([]);
		saving = false;
	}

	// ── Manual entry ──────────────────────────────────────────────────────────
	async function submitManualEntry() {
		if (saving) return;
		saving = true;
		await insertEntry({
			source: 'manual',
			notes:  entryNotes,
			sails:  entrySails,
			sogOverride: entryManualSOG ? +entryManualSOG : undefined,
			cogOverride: entryManualCOG ? +entryManualCOG : undefined,
		});
		saving = false;
		showEntryModal = false;
		entryNotes = ''; entrySails = ''; entryManualSOG = ''; entryManualCOG = '';
	}

	// ── Reverse geocoding (Nominatim / OSM — free, no key) ───────────────────
	async function reverseGeocode(lat: number, lon: number): Promise<string> {
		try {
			const r = await fetch(
				`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=en`,
				{ headers: {
					'User-Agent': 'SUKI-Dashboard-Pro/1.0 sailing@suki.boat',
					'Accept-Language': 'en',
				} }
			);
			if (!r.ok) throw new Error('');
			const j = await r.json();
			const a = j.address ?? {};
			// Prefer maritime/coastal names; fall back to town/city
			return a.bay ?? a.sea ?? a.body_of_water ?? a.island ?? a.archipelago ??
			       a.village ?? a.town ?? a.city_district ?? a.city ??
			       a.county ?? j.name ??
			       `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
		} catch {
			return `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
		}
	}

	// ── Weather summary string for auto-entries ───────────────────────────────
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

	// ── Auto-trip: start ──────────────────────────────────────────────────────
	async function autoStartTrip() {
		if ($activeTrip || !boat) return;
		const lat = liveLat(); const lon = liveLon();
		const place = (lat != null && lon != null) ? await reverseGeocode(lat, lon) : null;
		const wx    = buildWeatherSummary();

		const { data } = await supabase
			.from('log_trips')
			.insert({
				boat_id:    boat.id,
				name:       place ?? 'Auto trip',
				from_port:  place,
				started_at: new Date().toISOString(),
				notes:      wx || null,
			})
			.select().single();

		if (data) {
			const trip = data as LogTrip;
			isAutoTrip = true;
			terminalLines = [];   // fresh log for new trip
			pushLog(`▶▶ Auto-trip started · ${place ?? 'position recorded'}`);
			activeTrip.set(trip);
			allTrips.update(ts => [trip, ...ts]);
			tripEntries.set([]);
			lastEntryPos = null;
			await insertEntry({
				source: 'auto',
				notes: [place ? `Departure from ${place}` : 'Departure', wx].filter(Boolean).join(' · '),
			});
		}
	}

	// ── Auto-trip: stop ───────────────────────────────────────────────────────
	async function autoStopTrip(reason: string) {
		const at = $activeTrip;
		if (!at) return;
		const lat = liveLat(); const lon = liveLon();
		const place = (lat != null && lon != null) ? await reverseGeocode(lat, lon) : null;
		pushLog(`■ Auto-trip stopped · ${place ?? 'unknown'} · ${reason}`);
		const wx    = buildWeatherSummary();

		await insertEntry({
			source: 'auto',
			notes: [[place ? `Arrival at ${place}` : 'Arrival', wx].filter(Boolean).join(' · '), `(${reason})`].join(' '),
		});

		// Final accurate stats recalculated from all DB entries
		const stats = await recalcFromDB(at.id);

		const patch: Partial<LogTrip> = {
			ended_at:     new Date().toISOString(),
			to_port:      place,
			name:         at.from_port && place ? `${at.from_port} → ${place}` : (at.name ?? 'Auto trip'),
			total_nm:     stats?.totalNm ?? at.total_nm,
			sail_nm:      stats?.sailNm  ?? at.sail_nm,
			motor_nm:     stats?.motorNm ?? at.motor_nm,
			avg_sog_kn:   stats?.avgSog  ?? null,
			engine_hours: stats?.engHours ?? null,
		};
		await supabase.from('log_trips').update(patch).eq('id', at.id);
		const finished = { ...(at as LogTrip), ...patch };
		allTrips.update(ts => ts.map(t => t.id === at.id ? finished : t));
		activeTrip.set(null);
		tripEntries.set([]);
		isAutoTrip       = false;
		autoMode         = 'idle';
		slowSince        = null;
		fastSince        = null;
		countdownMinutes = 15;
		cerboLossTime    = null;
		vrmPosAtLoss     = null;
	}

	// ── Auto-trip: check (runs every 30 s) ────────────────────────────────────
	async function checkAutoTrip() {
		if (!autoEnabled || !boat) return;
		const now      = Date.now();
		const sog      = liveSog();
		const anchorOn = $anchorConfig?.active ?? false;
		const trip     = $activeTrip;
		const v        = vrm;   // VRM snapshot for offline fallback

		// Anchor alarm activated → stop auto trip immediately
		if (anchorOn && isAutoTrip && trip) {
			pushLog(`⚓ Anchor alarm active — stopping trip`);
			await autoStopTrip('anchor alarm set');
			return;
		}

		// ── Determine movement ────────────────────────────────────────────────
		let moving = sog != null && sog >= SOG_TRIP_KN;

		// Cerbo offline fallback: if Cerbo has no SOG data (sog === null) and
		// a trip is active, check VRM GPS displacement as a proxy.
		// • First 90 s: give Cerbo benefit of the doubt (temporary outage)
		// • After 90 s: compare VRM GPS positions; > 100 m → still underway
		if (sog === null && isAutoTrip && trip) {
			if (v?.gps_lat != null && v?.gps_lon != null) {
				if (cerboLossTime === null) {
					// Mark when Cerbo went offline and snapshot VRM position
					cerboLossTime = now;
					vrmPosAtLoss  = { lat: v.gps_lat, lon: v.gps_lon };
					pushLog(`📡 Cerbo offline — monitoring VRM GPS`);
					moving = true;   // benefit of the doubt for first window
				} else if (now - cerboLossTime < VRM_FALLBACK_WAIT_MS) {
					moving = true;   // still within grace period
				} else {
					// 90 s elapsed — measure VRM displacement
					const dist = haversine(vrmPosAtLoss!.lat, vrmPosAtLoss!.lon, v.gps_lat, v.gps_lon);
					// Refresh baseline for the next check cycle
					vrmPosAtLoss  = { lat: v.gps_lat, lon: v.gps_lon };
					cerboLossTime = now;
					if (dist > VRM_MOVE_THRESHOLD_M) {
						moving = true;
						pushLog(`📡 VRM GPS +${Math.round(dist)} m — still underway`);
					} else {
						pushLog(`📡 VRM GPS +${Math.round(dist)} m — possibly stopped`);
					}
				}
			} else {
				// No VRM GPS available — treat same as "no data" (start countdown)
				if (cerboLossTime === null) pushLog(`📡 Cerbo offline — no VRM GPS fallback`);
				cerboLossTime ??= now;
			}
		} else if (sog !== null && cerboLossTime !== null) {
			// Cerbo came back online — clear fallback state
			cerboLossTime = null;
			vrmPosAtLoss  = null;
			pushLog(`✅ Cerbo back online`);
		}

		// ── State machine ─────────────────────────────────────────────────────
		if (moving) {
			slowSince        = null;
			countdownMinutes = 15;

			if (!trip) {
				if (fastSince == null) {
					fastSince = now;
					const sogStr = sog != null ? `${sog.toFixed(1)} kn` : 'VRM GPS';
					pushLog(`▶ ${sogStr} — confirming movement…`);
				}
				autoMode = 'watching';
				if (now - fastSince >= CONFIRM_START_MS) {
					autoMode  = 'recording';
					fastSince = null;
					pushLog(`▶▶ Confirmed — launching auto-trip`);
					await autoStartTrip();
				}
			} else if (isAutoTrip) {
				autoMode = 'recording';
				const lat     = liveLat(); const lon = liveLon();
				const wind    = liveWind(); const windDir = liveWindDir();
				const sogDisp = sog != null ? `${sog.toFixed(1)} kn` : `VRM GPS`;
				pushLog(
					`◉ ${sogDisp}  ${lat?.toFixed(4) ?? '?'}° ${lon?.toFixed(4) ?? '?'}°` +
					(wind != null ? `  💨 ${wind.toFixed(0)} kn ${windDir != null ? dirAbbr(windDir) : ''}` : '')
				);
			}

		} else {
			fastSince = null;

			if (trip && isAutoTrip) {
				if (slowSince == null) {
					slowSince = now;
					pushLog(`⚠ Speed < ${SOG_TRIP_KN} kn — auto-stop in ${countdownMinutes} min`);
				}
				const elapsed = now - slowSince;
				countdownMinutes = Math.max(0, Math.ceil((CONFIRM_STOP_MS - elapsed) / 60_000));
				autoMode = 'countdown';
				pushLog(`⏱ ${countdownMinutes} min to stop  ${sog?.toFixed(1) ?? '0.0'} kn`);
				if (elapsed >= CONFIRM_STOP_MS) {
					await autoStopTrip('< 1.5 kn for 15 min');
				}
			} else if (!trip) {
				autoMode  = 'idle';
				fastSince = null;
			}
		}
	}

	// ── Auto-log every 60 seconds ─────────────────────────────────────────────
	function startAutoLog() {
		// 60-second position/weather snapshot while any trip is running
		autoLogTimer = setInterval(() => {
			if ($activeTrip) insertEntry({ source: 'auto' });
		}, 60_000);

		// Auto-trip detection every 30 s
		autoCheckTimer = setInterval(checkAutoTrip, 30_000);
		checkAutoTrip();  // immediate first check
	}

	// ── All-time statistics ───────────────────────────────────────────────────
	const stats = $derived(() => {
		const trips = $allTrips.filter(tr => tr.ended_at != null);
		if (!trips.length) return null;
		const totalNm    = trips.reduce((s, t) => s + (t.total_nm ?? 0), 0);
		const sailNm     = trips.reduce((s, t) => s + (t.sail_nm  ?? 0), 0);
		const motorNm    = trips.reduce((s, t) => s + (t.motor_nm ?? 0), 0);
		const engHours   = trips.reduce((s, t) => s + (t.engine_hours ?? 0), 0);
		const maxSog     = Math.max(...trips.map(t => t.max_sog_kn ?? 0));
		const sailPct    = totalNm > 0 ? Math.round(sailNm / totalNm * 100) : 0;
		return { totalNm, sailNm, motorNm, engHours, maxSog, sailPct, tripCount: trips.length };
	});

	// ── Init ──────────────────────────────────────────────────────────────────
	// NOTE: startAutoLog() → checkAutoTrip() reads liveSog / $anchorConfig /
	// $activeTrip synchronously. Wrapping with untrack() prevents those stores
	// from becoming dependencies of this effect (which would cause the entire
	// logbook to re-mount on every 3-second telemetry update).
	$effect(() => {
		const b = boat;
		if (b) {
			loadLogbook();
			untrack(() => startAutoLog());
		}
		return () => { clearInterval(autoLogTimer); clearInterval(autoCheckTimer); };
	});

	onDestroy(() => { clearInterval(autoLogTimer); clearInterval(autoCheckTimer); });

	const at    = $derived($activeTrip);
	const trips = $derived($allTrips);
	const entries = $derived($tripEntries);
	const loaded  = $derived($logLoaded);
	const isAdmin = $derived(role === 'admin');
</script>

<svelte:head><title>Logbook · SUKI PRO</title></svelte:head>

<div class="log-page">

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

		<!-- Sailing vs motor ratio bar -->
		<div class="ratio-section">
			<div class="ratio-bar-wrap">
				<div class="ratio-bar">
					<div class="ratio-sail" style="width:{pct}%; background:{ratioColor(pct)}"></div>
					<div class="ratio-motor" style="width:{100-pct}%"></div>
				</div>
			</div>
			<div class="ratio-labels">
				<span class="ratio-label sail">⛵ {fmtNm(at.sail_nm)} sail ({pct}%)</span>
				<span class="ratio-label motor">⚙️ {fmtNm(at.motor_nm)} motor ({100-pct}%)</span>
				<span class="ratio-label total">∑ {fmtNm(at.total_nm)}</span>
			</div>
		</div>

		<!-- Current snapshot row -->
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
			{#if liveEngH() != null}
				<div class="snap-item" class:eng-on={liveEngOn()}>
					<span class="snap-val">{liveEngH()?.toFixed(1)}</span><span class="snap-lbl">eng hrs</span>
				</div>
			{/if}
			{#if at.max_sog_kn}
				<div class="snap-item"><span class="snap-val">{at.max_sog_kn.toFixed(1)}</span><span class="snap-lbl">max kn</span></div>
			{/if}
		</div>

		<!-- Actions -->
		{#if isAdmin}
		<div class="trip-actions">
			<button class="btn-entry" onclick={() => { showEntryModal = true; }}>+ Log entry</button>
			<button class="btn-end"   onclick={endTrip} disabled={saving}>End trip</button>
		</div>
		{/if}
	</div>

	{:else if loaded && isAdmin}
	<!-- ── No active trip → start CTA ─────────────────────────────────────── -->
	<div class="start-cta">
		<div class="start-icon">⚓</div>
		<div class="start-text">No active trip</div>
		<button class="btn-start" onclick={() => { showTripModal = true; }}>Start trip</button>
	</div>
	{:else if !loaded}
	<div class="log-loading">Loading logbook…</div>
	{/if}

	<!-- ── Auto-trip status bar ────────────────────────────────────────────── -->
	{#if isAdmin}
	{#if autoEnabled}
	<div class="auto-bar"
		class:auto-watching={autoMode === 'watching'}
		class:auto-recording={autoMode === 'recording'}
		class:auto-countdown={autoMode === 'countdown'}>
		<div class="auto-bar-left">
			<span class="auto-dot" class:dot-idle={autoMode === 'idle'} class:dot-watching={autoMode === 'watching'} class:dot-recording={autoMode === 'recording'} class:dot-countdown={autoMode === 'countdown'}></span>
			{#if autoMode === 'idle'}
				<span class="auto-status">Auto-trip: watching for movement ≥ {SOG_TRIP_KN} kn</span>
			{:else if autoMode === 'watching'}
				<span class="auto-status">Moving · auto-start in ~{CONFIRM_START_MS / 60_000} min…</span>
			{:else if autoMode === 'recording'}
				<span class="auto-status">Auto-trip recording</span>
			{:else if autoMode === 'countdown'}
				<span class="auto-status">⏱ Speed below {SOG_TRIP_KN} kn · auto-stop in {countdownMinutes} min</span>
			{/if}
		</div>
		<button class="auto-toggle-btn" onclick={() => { autoEnabled = false; autoMode = 'idle'; }}>Off</button>
	</div>
	{:else}
	<div class="auto-bar auto-disabled">
		<span class="auto-status">Auto-trip detection: off</span>
		<button class="auto-toggle-btn" onclick={() => { autoEnabled = true; checkAutoTrip(); }}>On</button>
	</div>
	{/if}
	{/if}

	<!-- ── Auto-log terminal (visible while recording) ───────────────────── -->
	{#if autoEnabled && isAutoTrip && terminalLines.length > 0}
	<div class="terminal">
		<div class="terminal-hdr">
			<span class="terminal-title">
				<span class="terminal-dot"></span>AUTO LOG
			</span>
			<span class="terminal-meta">{terminalLines.length} / {MAX_LOG} lines</span>
		</div>
		<div class="terminal-body">
			{#each terminalLines as line, i}
				<div class="terminal-line" class:terminal-line-fresh={i === 0}>{line}</div>
			{/each}
		</div>
	</div>
	{/if}

	<!-- ── Log entries (active trip) ──────────────────────────────────────── -->
	{#if entries.length > 0}
	<div class="section-header">
		<span class="section-title">Entries · {entries.length}</span>
	</div>
	<div class="entry-list">
		{#each entries as e (e.id)}
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
					{#if e.engine_rpm != null}<span class="entry-chip eng">⚙ {e.engine_rpm} rpm{e.engine_temp_c != null ? ` · ${e.engine_temp_c.toFixed(0)}°C` : ''}</span>{/if}
					{#if e.sails}<span class="entry-chip sail">{e.sails}</span>{/if}
					{#if e.distance_nm != null && e.distance_nm > 0}
						<span class="entry-chip dist">+{e.distance_nm.toFixed(1)} nm</span>
					{/if}
				</div>
				<div class="entry-env">
					{#if e.wind_speed_kn != null}
						<span class="entry-env-item">💨 {e.wind_speed_kn.toFixed(0)} kn {dirAbbr(e.wind_dir_deg)}</span>
					{/if}
					{#if e.wave_height_m != null}
						<span class="entry-env-item">🌊 {e.wave_height_m} m</span>
					{/if}
					{#if e.baro_hpa != null}
						<span class="entry-env-item">📊 {e.baro_hpa.toFixed(0)} hPa</span>
					{/if}
					{#if e.air_temp_c != null}
						<span class="entry-env-item">🌡 {e.air_temp_c.toFixed(0)}°</span>
					{/if}
				</div>
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
		<div class="stat-card">
			<span class="stat-val">{s.totalNm.toFixed(0)}</span>
			<span class="stat-lbl">nm sailed</span>
		</div>
		<div class="stat-card">
			<!-- Sail ratio bar (all-time) -->
			<div class="stat-ratio">
				<div class="ratio-bar mini">
					<div class="ratio-sail" style="width:{s.sailPct}%; background:{ratioColor(s.sailPct)}"></div>
					<div class="ratio-motor" style="width:{100-s.sailPct}%"></div>
				</div>
			</div>
			<span class="stat-val">{s.sailPct}%</span>
			<span class="stat-lbl">under sail</span>
		</div>
		<div class="stat-card">
			<span class="stat-val">{s.sailNm.toFixed(0)}</span>
			<span class="stat-lbl">nm sail</span>
		</div>
		<div class="stat-card">
			<span class="stat-val">{s.motorNm.toFixed(0)}</span>
			<span class="stat-lbl">nm motor</span>
		</div>
		<div class="stat-card">
			<span class="stat-val">{s.engHours.toFixed(0)}</span>
			<span class="stat-lbl">engine hours</span>
		</div>
		<div class="stat-card">
			<span class="stat-val">{s.maxSog.toFixed(1)}</span>
			<span class="stat-lbl">max kn ever</span>
		</div>
	</div>
	{/if}

	<!-- ── Past trips ─────────────────────────────────────────────────────── -->
	{#if trips.filter(tr => tr.ended_at != null).length > 0}
	<div class="section-header" style="margin-top:16px">
		<span class="section-title">Past trips</span>
		<button class="btn-toggle" onclick={() => { showPastTrips = !showPastTrips; }}>
			{showPastTrips ? 'Hide' : 'Show'}
		</button>
	</div>

	{#if showPastTrips}
	<div class="past-trips">
		{#each trips.filter(tr => tr.ended_at != null) as trip (trip.id)}
		{@const pct = sailRatio(trip)}
		<div class="past-trip-card">
			<div class="past-trip-header">
				<span class="past-trip-name">{trip.name ?? 'Unnamed trip'}</span>
				<span class="past-trip-dates">{fmtDate(trip.started_at)} – {trip.ended_at ? fmtDate(trip.ended_at) : '?'}</span>
			</div>
			{#if trip.from_port || trip.to_port}
				<span class="past-trip-route">{trip.from_port ?? '?'} → {trip.to_port ?? '?'}</span>
			{/if}
			<div class="past-ratio">
				<div class="ratio-bar mini">
					<div class="ratio-sail" style="width:{pct}%; background:{ratioColor(pct)}"></div>
					<div class="ratio-motor" style="width:{100-pct}%"></div>
				</div>
				<span class="past-ratio-lbl">⛵ {pct}% · {fmtNm(trip.total_nm)}</span>
			</div>
			<div class="past-stats">
				{#if trip.avg_sog_kn != null}<span class="past-chip">avg {trip.avg_sog_kn.toFixed(1)} kn</span>{/if}
				{#if trip.max_sog_kn != null}<span class="past-chip">max {trip.max_sog_kn.toFixed(1)} kn</span>{/if}
				{#if trip.engine_hours != null}<span class="past-chip">⚙ {trip.engine_hours.toFixed(1)} h</span>{/if}
				<span class="past-chip">{fmtDuration(trip.started_at, trip.ended_at)}</span>
			</div>
			{#if trip.notes}<p class="past-trip-notes">{trip.notes}</p>{/if}
		</div>
		{/each}
	</div>
	{/if}
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
		<button class="btn-primary" onclick={startTrip} disabled={saving}>
			{saving ? 'Starting…' : 'Start trip'}
		</button>
	</div>
</div>
</div>
{/if}

<!-- ── Manual entry modal ────────────────────────────────────────────────── -->
{#if showEntryModal}
<div class="modal-backdrop" onclick={() => { showEntryModal = false; }}>
<div class="modal" onclick={(e) => e.stopPropagation()}>
	<div class="modal-title">Log entry</div>

	<!-- Pre-filled snapshot -->
	<div class="entry-preview">
		{#if liveLat() != null}<span class="prev-chip">{liveLat()?.toFixed(4)}° {liveLon()?.toFixed(4)}°</span>{/if}
		{#if liveSog() != null}<span class="prev-chip">{liveSog()} kn</span>{/if}
		{#if liveWind() != null}<span class="prev-chip">💨 {liveWind()} kn</span>{/if}
		{#if wave.wave_height_m != null}<span class="prev-chip">🌊 {wave.wave_height_m} m</span>{/if}
		{#if liveEngOn()}<span class="prev-chip eng">⚙ Engine on</span>{/if}
	</div>

	<label class="modal-label">Sails set
		<input class="modal-input" bind:value={entrySails} placeholder="e.g. Full main + genoa" />
	</label>
	<label class="modal-label">Notes
		<textarea class="modal-textarea" bind:value={entryNotes} placeholder="Observations, course changes, events…" rows="3"></textarea>
	</label>
	<div class="modal-actions">
		<button class="btn-cancel" onclick={() => { showEntryModal = false; }}>Cancel</button>
		<button class="btn-primary" onclick={submitManualEntry} disabled={saving}>
			{saving ? 'Saving…' : 'Save entry'}
		</button>
	</div>
</div>
</div>
{/if}

<style>
	.log-page {
		display: flex; flex-direction: column; gap: 12px;
		padding-bottom: 24px;
	}
	.log-loading { font-size: 13px; color: var(--muted); padding: 20px 0; text-align: center; }

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

	/* Ratio bar */
	.ratio-section { margin-bottom: 10px; }
	.ratio-bar-wrap { margin-bottom: 5px; }
	.ratio-bar {
		height: 8px; border-radius: 4px; overflow: hidden;
		background: var(--border); display: flex;
	}
	.ratio-bar.mini { height: 5px; border-radius: 3px; }
	.ratio-sail  { height: 100%; transition: width 0.4s; }
	.ratio-motor { height: 100%; background: #6b7280; flex: 1; }
	.ratio-labels {
		display: flex; gap: 10px; flex-wrap: wrap;
		font-size: 11px; color: var(--muted);
	}
	.ratio-label { white-space: nowrap; }
	.ratio-label.total { margin-left: auto; font-weight: 600; color: var(--text); }

	/* Snapshot row */
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

	/* Start CTA */
	.start-cta {
		display: flex; flex-direction: column; align-items: center; gap: 10px;
		padding: 32px 0; background: var(--card); border: 1px solid var(--border);
		border-radius: 10px;
	}
	.start-icon { font-size: 32px; }
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
	.btn-toggle {
		font-size: 11px; color: var(--accent); background: none; border: none; cursor: pointer; padding: 0;
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
	.entry-hhmm { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
	.entry-date { font-size: 9px; color: var(--muted); }
	.entry-auto-tag { font-size: 8px; color: var(--muted); background: var(--card2); border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; }

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
	.entry-env-item { font-size: 11px; color: var(--muted); }
	.entry-notes { font-size: 12px; color: var(--text); margin: 0; line-height: 1.4; }

	/* ── Stats grid ───────────────────────────────────────────────────────── */
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
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
		padding: 12px;
	}
	.past-trip-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 2px; }
	.past-trip-name  { font-size: 14px; font-weight: 600; }
	.past-trip-dates { font-size: 11px; color: var(--muted); white-space: nowrap; }
	.past-trip-route { font-size: 11px; color: var(--muted); display: block; margin-bottom: 8px; }
	.past-ratio { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
	.past-ratio-lbl { font-size: 11px; color: var(--muted); white-space: nowrap; }
	.past-stats { display: flex; gap: 5px; flex-wrap: wrap; }
	.past-chip {
		font-size: 11px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 4px; padding: 2px 7px;
	}
	.past-trip-notes { font-size: 12px; color: var(--muted); margin: 8px 0 0; }

	/* ── Modals ───────────────────────────────────────────────────────────── */
	.modal-backdrop {
		position: fixed; inset: 0; background: rgba(0,0,0,0.6);
		display: flex; align-items: flex-end; justify-content: center;
		z-index: 500; padding: 0;
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

	/* Entry modal preview */
	.entry-preview {
		display: flex; gap: 5px; flex-wrap: wrap;
		padding: 8px; background: var(--card2); border: 1px solid var(--border); border-radius: 7px;
	}
	.prev-chip {
		font-size: 12px; background: var(--border); border-radius: 4px; padding: 2px 7px;
	}
	.prev-chip.eng { color: var(--amber); }

	/* ── Auto-trip status bar ─────────────────────────────────────────────── */
	.auto-bar {
		display: flex; justify-content: space-between; align-items: center;
		padding: 8px 12px; border-radius: 8px;
		background: var(--card); border: 1px solid var(--border);
		font-size: 12px; gap: 8px;
	}
	.auto-bar.auto-watching  { border-color: rgba(251,191,36,.35); background: rgba(251,191,36,.05); }
	.auto-bar.auto-recording { border-color: rgba(34,197,94,.35);  background: rgba(34,197,94,.05);  }
	.auto-bar.auto-countdown { border-color: rgba(249,115,22,.4);  background: rgba(249,115,22,.06); }
	.auto-bar.auto-disabled  { opacity: 0.55; }
	.auto-bar-left { display: flex; align-items: center; gap: 8px; }
	.auto-dot {
		width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
		background: var(--muted);
	}
	.auto-dot.dot-idle      { background: var(--muted); opacity: 0.5; }
	.auto-dot.dot-watching  { background: var(--amber); animation: pulse-live 2s ease-in-out infinite; }
	.auto-dot.dot-recording { background: var(--green); animation: pulse-live 2s ease-in-out infinite; }
	.auto-dot.dot-countdown { background: #f97316; }
	.auto-status { color: var(--muted); line-height: 1.3; }
	.auto-toggle-btn {
		font-size: 11px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 5px; padding: 4px 10px; cursor: pointer; color: var(--text);
		flex-shrink: 0;
	}
	.auto-toggle-btn:hover { background: var(--border); }

	/* ── Auto-log terminal ───────────────────────────────────────────────────── */
	.terminal {
		background: #030a03;
		border: 1px solid rgba(0, 220, 130, 0.22);
		border-radius: 8px;
		overflow: hidden;
		font-family: 'SF Mono', 'Fira Code', 'Menlo', 'Monaco', monospace;
	}
	.terminal-hdr {
		display: flex; justify-content: space-between; align-items: center;
		padding: 5px 10px;
		background: rgba(0, 220, 130, 0.07);
		border-bottom: 1px solid rgba(0, 220, 130, 0.14);
	}
	.terminal-title {
		display: flex; align-items: center; gap: 6px;
		font-size: 10px; font-weight: 700; letter-spacing: 1px;
		color: var(--green);
	}
	.terminal-dot {
		width: 6px; height: 6px; border-radius: 50%;
		background: var(--green);
		animation: pulse-live 2s ease-in-out infinite;
	}
	.terminal-meta { font-size: 10px; color: rgba(0, 220, 130, 0.4); }
	.terminal-body {
		padding: 7px 10px;
		display: flex; flex-direction: column; gap: 1px;
	}
	.terminal-line {
		font-size: 11px;
		color: rgba(100, 220, 150, 0.55);
		white-space: pre;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.65;
	}
	.terminal-line.terminal-line-fresh {
		color: #7effa0;
	}
</style>
