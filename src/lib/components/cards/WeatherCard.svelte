<script lang="ts">
	import { telemetry } from '$lib/stores/telemetry.js';
	import { vrmData } from '$lib/stores/vrm.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { inreachPoints } from '$lib/stores/inreach.js';
	import { latestWave } from '$lib/stores/weather.js';

	type WxHour = {
		time:   string;
		temp:   number;
		wind:   number;
		gusts:  number;
		dir:    number;
		precip: number;
		wmo:    number;
		// sea state (null if marine data unavailable at this location)
		waveH:  number | null;   // wave height m
		waveP:  number | null;   // wave period s
		waveD:  number | null;   // wave direction °
		swellH: number | null;   // swell height m
		swellD: number | null;   // swell direction °
	};

	let hours     = $state<WxHour[]>([]);
	let loaded    = $state(false);
	let stale     = $state(false);
	let updatedAt = $state<Date | null>(null);
	let pollTimer: ReturnType<typeof setInterval>;

	const t   = $derived($telemetry);
	const vrm = $derived($vrmData);
	const cfg = $derived($anchorConfig);
	const pts = $derived($inreachPoints);

	// GPS priority for weather position:
	// 1. Cerbo (live, ~3 s updates via SignalK/telemetry)
	// 2. VRM   (60 s polling — same GPS receiver, cloud path)
	// 3. Garmin InReach (10–15 min polling — last resort)
	//
	// Use PRIMITIVE derived values as intermediates so Svelte 5 can memoize by
	// value equality. If we derived `pos` as an object directly from `t`, a new
	// object reference would be produced on every telemetry tick (every 3 s) even
	// when the coordinates haven't moved. That caused the $effect below to re-run,
	// set loaded=false, and flash "Connecting…" every 3 s → layout height change →
	// iOS Safari scroll reset → InReach map visible briefly at wrong position.
	const posLat = $derived(
		t?.nav_lat   != null ? t.nav_lat   :
		vrm?.gps_lat != null ? vrm.gps_lat :
		pts?.[0]?.lat ?? null
	);
	const posLon = $derived(
		t?.nav_lon   != null ? t.nav_lon   :
		vrm?.gps_lon != null ? vrm.gps_lon :
		pts?.[0]?.lon ?? null
	);
	// pos is only recreated when the primitive values actually change
	const pos = $derived(posLat != null && posLon != null ? { lat: posLat, lon: posLon } : null);

	// ── Reverse geocoding — location name in card header ─────────────────────
	// Rounded to 2 decimal places (~1 km) so Nominatim is not queried on every
	// GPS micro-jitter tick. The boat needs to move ~500 m to trigger a new fetch.
	const posLatRnd = $derived(posLat != null ? Math.round(posLat * 100) / 100 : null);
	const posLonRnd = $derived(posLon != null ? Math.round(posLon * 100) / 100 : null);

	let locationName = $state<string | null>(null);

	async function fetchLocationName(lat: number, lon: number) {
		try {
			const res = await fetch(
				`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en`,
				{ headers: { 'User-Agent': 'SUKI-Dashboard-Pro/1.0' } }
			);
			if (!res.ok) return;
			const data = await res.json();
			const addr  = data.address ?? {};
			// Settlement: city > town > village > municipality > county > state > sea name
			const place   = addr.city || addr.town || addr.village || addr.municipality
			              || addr.county || addr.state || data.name || null;
			const country = addr.country_code ? addr.country_code.toUpperCase() : null;
			locationName  = place && country ? `${place}, ${country}` : (place ?? country ?? null);
		} catch { /* non-essential — ignore silently */ }
	}

	$effect(() => {
		const lat = posLatRnd;
		const lon = posLonRnd;
		if (lat == null || lon == null) return;
		fetchLocationName(lat, lon);
	});

	// ── Helpers ───────────────────────────────────────────────────────────────
	function windColor(kn: number): string {
		if (kn < 11) return 'var(--green)';
		if (kn < 22) return 'var(--amber)';
		if (kn < 34) return '#f97316';
		return 'var(--red)';
	}

	function waveColor(m: number | null): string {
		if (m == null) return 'var(--muted)';
		if (m < 0.5) return 'var(--green)';
		if (m < 1.5) return 'var(--amber)';
		if (m < 3.0) return '#f97316';
		return 'var(--red)';
	}

	// Calculate sunrise/sunset altitude (considering horizon elevation and refraction)
	function sunAltRad(jd: number, latRad: number, lonRad: number): number {
		const T  = (jd - 2_451_545.0) / 36_525.0;
		const L  = ((280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360 + 360) % 360;
		const M  = ((357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360 + 360) % 360;
		const MM = M * D2R;
		const e  = 1 - 0.002556 * T;
		const C  = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(MM)
		         + (0.019993 - 0.000101 * T) * Math.sin(2 * MM)
		         + 0.000029 * Math.sin(3 * MM);
		const sunLon = (L + C) * D2R;
		const sunLat = Math.asin(0.39782 * Math.sin(sunLon));
		const gm     = gmstRad(jd);
		const ha     = gm + lonRad - 0.0057183 - Math.atan2(Math.cos(sunLon) * Math.sin(0.00569), Math.cos(sunLon) * Math.cos(sunLat) * Math.sin(0.00569) + Math.tan(sunLat) * Math.cos(latRad) * Math.sin(0.00569));
		return Math.asin(Math.sin(latRad) * Math.sin(sunLat) + Math.cos(latRad) * Math.cos(sunLat) * Math.cos(ha));
	}

	// Check if sun is above horizon (day: alt > 0, night: alt < 0)
	function isSunUp(time: string, p: { lat: number; lon: number }): boolean {
		if (!p) return true;  // fallback to day
		const date = new Date(time);
		const jd = toJD(date);
		const alt = sunAltRad(jd, p.lat * D2R, p.lon * D2R);
		return alt > -0.0087;  // ~0.5° below horizon (twilight threshold)
	}

	function wmoEmoji(code: number, time?: string, p?: { lat: number; lon: number }): string {
		// At night (sun below horizon), show moon instead of sun
		if (time && p && !isSunUp(time, p)) {
			const date = new Date(time);
			const ph = moonPhase(date);
			return ph.emoji;
		}

		// Daytime: show weather condition
		if (code === 0)  return '☀️';
		if (code <= 3)   return '⛅';
		if (code <= 48)  return '🌫';
		if (code <= 55)  return '🌦';
		if (code <= 67)  return '🌧';
		if (code <= 77)  return '❄️';
		if (code <= 82)  return '🌦';
		if (code <= 86)  return '🌨';
		return '⛈';
	}

	function dirAbbr(deg: number): string {
		const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
		return d[Math.round(deg / 22.5) % 16];
	}

	function waveLabel(m: number | null): string {
		if (m == null) return '—';
		if (m < 0.5) return 'Smooth';
		if (m < 1.25) return 'Slight';
		if (m < 2.5) return 'Moderate';
		if (m < 4.0) return 'Rough';
		return 'Very Rough';
	}

	// Visual indicator: number of wave icons to show height
	function waveHeightIndicator(m: number | null): number {
		if (m == null) return 0;
		if (m < 0.5) return 1;
		if (m < 1.25) return 1;
		if (m < 2.5) return 2;
		if (m < 4.0) return 3;
		return 4;
	}

	function fmtHour(iso: string): string { return iso.slice(11, 16); }

	function dayLabel(iso: string): string {
		const [y, mo, d] = iso.split('T')[0].split('-').map(Number);
		const t = new Date(y, mo - 1, d);
		const today = new Date(); today.setHours(0,0,0,0);
		const tom   = new Date(today); tom.setDate(today.getDate() + 1);
		if (t.getTime() === today.getTime()) return 'Today';
		if (t.getTime() === tom.getTime())   return 'Tomorrow';
		return t.toLocaleDateString('en', { weekday: 'long' });
	}

	// ── Moon phase + rise/set (Meeus Ch. 47, truncated — ±5 min accuracy) ──────
	const D2R = Math.PI / 180;
	const REF_NEW_MOON = new Date('2000-01-06T18:14:00Z').getTime();
	const SYNODIC_MS   = 29.530588853 * 86400000;

	type MoonInfo = {
		illumination: number; emoji: string; name: string; bright: boolean;
		rise: Date | null; set: Date | null;
	};

	function toJD(date: Date): number {
		return date.getTime() / 86_400_000 + 2_440_587.5;
	}

	// Moon geocentric RA/Dec from Julian Date (largest Meeus terms, ~0.3° accuracy)
	function moonRADec(jd: number): { ra: number; dec: number } {
		const T  = (jd - 2_451_545.0) / 36_525.0;
		const Lm = ((218.3164477 + 481_267.88123421 * T) % 360 + 360) % 360;
		const Dp = ((297.8501921 + 445_267.1114034  * T) % 360 + 360) % 360;
		const M  = ((357.5291092 +  35_999.0502909  * T) % 360 + 360) % 360;
		const Mm = ((134.9633964 + 477_198.8675055  * T) % 360 + 360) % 360;
		const F  = (( 93.2720950 + 483_202.0175233  * T) % 360 + 360) % 360;

		const dL = 6.2888 * Math.sin(Mm * D2R)
		         + 1.2740 * Math.sin((2*Dp - Mm) * D2R)
		         + 0.6583 * Math.sin(2*Dp * D2R)
		         + 0.2136 * Math.sin(2*Mm * D2R)
		         - 0.1851 * Math.sin(M  * D2R)
		         - 0.1143 * Math.sin(2*F * D2R)
		         + 0.0588 * Math.sin((2*Dp - 2*Mm) * D2R)
		         + 0.0572 * Math.sin((2*Dp - M - Mm) * D2R)
		         + 0.0533 * Math.sin((2*Dp + Mm) * D2R)
		         + 0.0459 * Math.sin((2*Dp - M) * D2R)
		         + 0.0410 * Math.sin((Mm - M) * D2R);

		const dB = 5.1282 * Math.sin(F  * D2R)
		         + 0.2806 * Math.sin((Mm + F) * D2R)
		         + 0.2777 * Math.sin((Mm - F) * D2R)
		         + 0.1732 * Math.sin((2*Dp - F) * D2R)
		         + 0.0554 * Math.sin((2*Dp - Mm + F) * D2R)
		         + 0.0463 * Math.sin((2*Dp - Mm - F) * D2R)
		         + 0.0326 * Math.sin((2*Dp + F) * D2R);

		const lon = (Lm + dL) * D2R;
		const lat = dB * D2R;
		const eps = (23.439291111 - 0.013004167 * T) * D2R;  // obliquity

		return {
			ra:  Math.atan2(Math.sin(lon) * Math.cos(eps) - Math.tan(lat) * Math.sin(eps), Math.cos(lon)),
			dec: Math.asin(Math.sin(lat) * Math.cos(eps) + Math.cos(lat) * Math.sin(eps) * Math.sin(lon)),
		};
	}

	function gmstRad(jd: number): number {
		const T   = (jd - 2_451_545.0) / 36_525.0;
		const deg = ((280.46061837 + 360.98564736629 * (jd - 2_451_545.0) + 0.000387933 * T * T) % 360 + 360) % 360;
		return deg * D2R;
	}

	function moonAltRad(jd: number, latRad: number, lonRad: number): number {
		const { ra, dec } = moonRADec(jd);
		const ha = gmstRad(jd) + lonRad - ra;
		return Math.asin(Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha));
	}

	// Search 36 h window for moonrise (findRise=true) or moonset.
	// Starts at startDate (UTC), steps every 10 min.
	function findMoonEvent(startDate: Date, lat: number, lon: number, findRise: boolean): Date | null {
		const latRad = lat * D2R;
		const lonRad = lon * D2R;
		const H0     = -0.8 * D2R;   // horizon altitude (refraction + mean parallax)
		const STEP   = 10;            // minutes
		const WINDOW = 36 * 60;       // minutes

		let prevAlt: number | null = null;

		for (let m = 0; m <= WINDOW; m += STEP) {
			const jd  = toJD(new Date(startDate.getTime() + m * 60_000));
			const alt = moonAltRad(jd, latRad, lonRad) - H0;

			if (prevAlt !== null) {
				if (findRise && prevAlt < 0 && alt >= 0) {
					const frac = -prevAlt / (alt - prevAlt);
					return new Date(startDate.getTime() + (m - STEP + frac * STEP) * 60_000);
				}
				if (!findRise && prevAlt >= 0 && alt < 0) {
					const frac = prevAlt / (prevAlt - alt);
					return new Date(startDate.getTime() + (m - STEP + frac * STEP) * 60_000);
				}
			}
			prevAlt = alt;
		}
		return null;
	}

	function fmtLocalTime(date: Date): string {
		return date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
	}

	function moonPhase(date: Date): { illumination: number; emoji: string; name: string; bright: boolean } {
		const frac  = ((date.getTime() - REF_NEW_MOON) % SYNODIC_MS + SYNODIC_MS) % SYNODIC_MS / SYNODIC_MS;
		const illum = Math.round((1 - Math.cos(2 * Math.PI * frac)) / 2 * 100);
		let name: string, emoji: string;
		if      (frac < 0.03 || frac > 0.97) { name = 'New Moon';        emoji = '🌑'; }
		else if (frac < 0.22)                 { name = 'Waxing Crescent'; emoji = '🌒'; }
		else if (frac < 0.28)                 { name = 'First Quarter';   emoji = '🌓'; }
		else if (frac < 0.47)                 { name = 'Waxing Gibbous';  emoji = '🌔'; }
		else if (frac < 0.53)                 { name = 'Full Moon';       emoji = '🌕'; }
		else if (frac < 0.72)                 { name = 'Waning Gibbous';  emoji = '🌖'; }
		else if (frac < 0.78)                 { name = 'Last Quarter';    emoji = '🌗'; }
		else                                  { name = 'Waning Crescent'; emoji = '🌘'; }
		return { illumination: illum, emoji, name, bright: illum > 30 };
	}

	// Next 3 nights — moon phase + rise/set times (position-dependent)
	const moonNights = $derived(() => {
		const p     = pos;   // reactive: recalculates when position changes
		const today = new Date(); today.setHours(0, 0, 0, 0);
		return Array.from({ length: 3 }, (_, i) => {
			const midnight = new Date(today); midnight.setDate(today.getDate() + i);
			const evening  = new Date(midnight); evening.setHours(22, 0, 0, 0);
			const label = i === 0 ? 'Tonight'
				: i === 1 ? 'Tomorrow night'
				: midnight.toLocaleDateString('en', { weekday: 'long' }) + ' night';

			// Search from noon on day i so we capture events in the late afternoon
			// through the following morning (36 h window covers full night)
			const searchStart = new Date(midnight); searchStart.setHours(12, 0, 0, 0);
			// Convert to UTC midnight-equivalent for the algorithm
			const searchUTC = new Date(Date.UTC(
				searchStart.getFullYear(), searchStart.getMonth(), searchStart.getDate(),
				searchStart.getHours(), 0, 0, 0
			));

			const rise = p ? findMoonEvent(searchUTC, p.lat, p.lon, true)  : null;
			const set  = p ? findMoonEvent(searchUTC, p.lat, p.lon, false) : null;

			return { label, phase: moonPhase(evening), rise, set };
		});
	});

	// ── Fetch ─────────────────────────────────────────────────────────────────
	async function fetchWeather(p: { lat: number; lon: number }) {
		try {
			// Fetch wind forecast + marine waves in parallel
			const [windRes, marineRes] = await Promise.all([
				fetch(
					`https://api.open-meteo.com/v1/forecast` +
					`?latitude=${p.lat}&longitude=${p.lon}` +
					`&hourly=temperature_2m,precipitation_probability,weathercode,windspeed_10m,windgusts_10m,winddirection_10m` +
					`&wind_speed_unit=kn&forecast_days=3&timezone=auto`
				),
				fetch(
					`https://marine-api.open-meteo.com/v1/marine` +
					`?latitude=${p.lat}&longitude=${p.lon}` +
					`&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_direction` +
					`&forecast_days=3&timezone=auto`
				).catch(() => null),
			]);

			if (!windRes.ok) throw new Error('wind http ' + windRes.status);
			const wj = await windRes.json();

			// Marine API may fail for inland positions — degrade gracefully
			let mhr: Record<string, (number | null)[]> | null = null;
			if (marineRes?.ok) {
				try {
					const mj = await marineRes.json();
					mhr = mj?.hourly ?? null;
				} catch { /* ignore */ }
			}

			const cutoff = Date.now() - 30 * 60_000;
			hours = (wj.hourly.time as string[])
				.map((t, i) => ({
					time:   t,
					temp:   Math.round(wj.hourly.temperature_2m[i]),
					wind:   Math.round(wj.hourly.windspeed_10m[i]),
					gusts:  Math.round(wj.hourly.windgusts_10m[i]),
					dir:    Math.round(wj.hourly.winddirection_10m[i]),
					precip: wj.hourly.precipitation_probability?.[i] ?? 0,
					wmo:    wj.hourly.weathercode[i],
					waveH:  mhr?.wave_height[i]           != null ? Math.round((mhr.wave_height[i] as number) * 10) / 10 : null,
					waveP:  mhr?.wave_period[i]           != null ? Math.round(mhr.wave_period[i] as number) : null,
					waveD:  mhr?.wave_direction[i]        != null ? Math.round(mhr.wave_direction[i] as number) : null,
					swellH: mhr?.swell_wave_height[i]     != null ? Math.round((mhr.swell_wave_height[i] as number) * 10) / 10 : null,
					swellD: mhr?.swell_wave_direction[i]  != null ? Math.round(mhr.swell_wave_direction[i] as number) : null,
				}))
				.filter(h => {
					const ms = new Date(h.time).getTime();
					const hr = new Date(h.time).getHours();
					return ms >= cutoff && hr % 3 === 0;
				})
				.slice(0, 25);   // current slot + 24 × 3h = 72 h

			// Publish current wave snapshot to shared store (logbook reads it)
			if (hours.length > 0) {
				latestWave.set({
					wave_height_m:  hours[0].waveH,
					wave_period_s:  hours[0].waveP,
					wave_dir_deg:   hours[0].waveD,
					swell_height_m: hours[0].swellH,
					fetched_at:     new Date().toISOString(),
				});
			}

			stale     = false;
			updatedAt = new Date();
		} catch {
			stale = true;
		}
		loaded = true;
	}

	// ── Reactive fetch ────────────────────────────────────────────────────────
	// pos only changes when coordinates genuinely change (primitive memoization
	// above). Do NOT set loaded=false here — initial loaded=false (from $state)
	// handles "Connecting…" on first render; resetting it on refetch would
	// collapse the card height and cause an iOS scroll flash.
	$effect(() => {
		const p = pos;
		if (!p) return;
		fetchWeather(p);
		clearInterval(pollTimer);
		pollTimer = setInterval(() => fetchWeather(p), 30 * 60_000);
		return () => clearInterval(pollTimer);
	});
</script>

{#if pos}
<div class="card wx-card">

	<!-- Header -->
	<div class="wx-header">
		<div class="wx-header-left">
			<span class="wx-title">
				<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="10" cy="10" r="4"/>
					<line x1="10" y1="1" x2="10" y2="3"/>
					<line x1="10" y1="17" x2="10" y2="19"/>
					<line x1="1" y1="10" x2="3" y2="10"/>
					<line x1="17" y1="10" x2="19" y2="10"/>
					<line x1="3.5" y1="3.5" x2="5" y2="5"/>
					<line x1="15" y1="15" x2="16.5" y2="16.5"/>
					<line x1="3.5" y1="16.5" x2="5" y2="15"/>
					<line x1="15" y1="5" x2="16.5" y2="3.5"/>
				</svg>
				Weather · 72 h
			</span>
			{#if locationName}
				<span class="wx-location">{locationName}</span>
			{/if}
		</div>
		<span class="wx-meta">
			{#if updatedAt}
				{updatedAt.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
				<span class="wx-dot"></span>
			{:else if stale}
				<span class="wx-dot stale"></span>
			{/if}
		</span>
	</div>

	{#if !loaded}
		<div class="wx-empty">Connecting…</div>

	{:else if stale && hours.length === 0}
		<div class="wx-empty">Weather data unavailable</div>

	{:else if hours.length > 0}
		<!-- ── Current conditions ──────────────────────────────────────── -->
		{@const now = hours[0]}
		<div class="wx-now">
			<!-- Top row: wind | weather -->
			<div class="wx-now-top">
				<div class="wx-now-wind">
					<div class="wx-wind-arrow-box">
						<svg class="wx-arrow-large" style="transform: rotate({now.dir}deg)"
							viewBox="0 0 12 18" width="32" height="32" fill="currentColor">
							<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
						</svg>
						<span class="wx-wind-dir-label">{dirAbbr(now.dir)}</span>
					</div>
					<div class="wx-wind-data">
						<div class="wx-wind-speed-row">
							<span class="wx-now-speed" style="color:{windColor(now.wind)}">{now.wind}</span>
							<span class="wx-now-unit">kn</span>
						</div>
						<div class="wx-wind-gusts-row">
							<span class="wx-wind-label">Gusts:</span>
							<span class="wx-wind-gusts">{now.gusts} kn</span>
						</div>
					</div>
				</div>
				<div class="wx-now-cond">
					<span class="wx-now-emoji">{wmoEmoji(now.wmo, now.time, pos)}</span>
					<span class="wx-now-temp">{now.temp}°C</span>
					{#if now.precip > 0}<span class="wx-now-precip">{now.precip}%</span>{/if}
				</div>
			</div>
			<!-- Sea-state row (only when marine data available) -->
			{#if now.waveH != null}
			<div class="wx-now-sea">
				<!-- Wave section with direction arrow -->
				<div class="wx-sea-item-box">
					<div class="wx-wave-arrow-box">
						<svg class="wx-arrow-wave"
							style="transform: rotate({now.waveD ?? 0}deg); color: {waveColor(now.waveH)}"
							viewBox="0 0 12 18" width="28" height="28" fill="currentColor">
							<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
						</svg>
						<span class="wx-wave-dir-label">{dirAbbr(now.waveD ?? 0)}</span>
					</div>
					<div class="wx-wave-data">
						<div class="wx-wave-height-row">
							<span class="wx-wave-height" style="color:{waveColor(now.waveH)}">{now.waveH} m</span>
							<span class="wx-wave-state" style="color:{waveColor(now.waveH)}">{waveLabel(now.waveH)}</span>
						</div>
						<div class="wx-wave-visual">
							{#each Array(waveHeightIndicator(now.waveH)) as _, i}
								<svg viewBox="0 0 16 10" width="12" height="8" fill="none"
									stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
									style="color: {waveColor(now.waveH)}; opacity: {1 - i * 0.15}">
									<path d="M1 7 Q3 3 5 7 Q7 11 9 7 Q11 3 13 7 Q14 9 15 7"/>
								</svg>
							{/each}
						</div>
						{#if now.waveP != null}
						<span class="wx-wave-period">Period: {now.waveP}s</span>
						{/if}
					</div>
				</div>

				<!-- Swell section (if present) -->
				{#if now.swellH != null && now.swellH >= 0.1}
				<div class="wx-sea-item-box wx-swell">
					<div class="wx-wave-arrow-box">
						<svg class="wx-arrow-wave"
							style="transform: rotate({now.swellD ?? 0}deg); color: {waveColor(now.swellH)}; opacity: 0.6;"
							viewBox="0 0 12 18" width="24" height="24" fill="currentColor">
							<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
						</svg>
						<span class="wx-wave-dir-label">{dirAbbr(now.swellD ?? 0)}</span>
					</div>
					<div class="wx-wave-data">
						<div class="wx-wave-height-row">
							<span class="wx-swell-label">Swell</span>
							<span class="wx-wave-height" style="color:{waveColor(now.swellH)}; opacity: 0.7;">{now.swellH} m</span>
						</div>
					</div>
				</div>
				{/if}
			</div>
			{/if}
		</div>

		<!-- ── Forecast rows ──────────────────────────────────────────── -->
		<div class="wx-forecast">
			{#each hours.slice(1) as h, i}
				{@const prev = hours.slice(1)[i - 1]}
				{#if !prev || dayLabel(h.time) !== dayLabel(prev.time)}
					<div class="wx-day-sep">{dayLabel(h.time)}</div>
				{/if}
				<div class="wx-row">
					<span class="wx-time">{fmtHour(h.time)}</span>
					<span class="wx-icon">{wmoEmoji(h.wmo, h.time, pos)}</span>
					<!-- Wind: bigger arrow with color -->
					<svg class="wx-arrow-forecast" style="transform: rotate({h.dir}deg); color: {windColor(h.wind)}"
						viewBox="0 0 12 18" width="15" height="15" fill="currentColor">
						<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
					</svg>
					<span class="wx-wspd" style="color:{windColor(h.wind)}">{h.wind}</span>
					<span class="wx-wunit">kn</span>
					<span class="wx-gust">G{h.gusts}</span>
					<span class="wx-temp">{h.temp}°</span>

					<!-- Sea state: compact wave display with arrows -->
					<div class="wx-sea-compact">
						{#if h.waveH != null}
							<div class="wx-wave-forecast-item" style="color: {waveColor(h.waveH)}">
								<svg style="transform: rotate({h.waveD ?? 0}deg)"
									viewBox="0 0 12 18" width="11" height="11" fill="currentColor">
									<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
								</svg>
								<span>{h.waveH}m</span>
							</div>
						{/if}
						{#if h.swellH != null && h.swellH >= 0.1}
							<div class="wx-swell-forecast-item" style="color: {waveColor(h.swellH)}">
								<svg style="transform: rotate({h.swellD ?? 0}deg)"
									viewBox="0 0 12 18" width="9" height="9" fill="currentColor">
									<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
								</svg>
								<span>{h.swellH}m</span>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<!-- ── Moon nights ────────────────────────────────────────────── -->
		<div class="wx-moon-section">
			<div class="wx-section-label">Night visibility</div>
			<div class="wx-moon-rows">
				{#each moonNights() as n}
				<div class="wx-moon-row" class:bright={n.phase.bright}>
					<span class="wx-moon-emoji">{n.phase.emoji}</span>
					<div class="wx-moon-info">
						<span class="wx-moon-label">{n.label}</span>
						<span class="wx-moon-name">{n.phase.name}</span>
						<span class="wx-moon-times">
							{n.rise ? fmtLocalTime(n.rise) : '—'} – {n.set ? fmtLocalTime(n.set) : '—'}
						</span>
					</div>
					<div class="wx-moon-right">
						<div class="wx-illum-bar">
							<div class="wx-illum-fill" style="width:{n.phase.illumination}%"></div>
						</div>
						<span class="wx-illum-pct">{n.phase.illumination}%</span>
					</div>
				</div>
				{/each}
			</div>
		</div>

		<div class="wx-source">Open-Meteo · {pos.lat.toFixed(2)}° {pos.lon.toFixed(2)}°</div>
	{/if}

</div>
{/if}

<style>
	.wx-card { padding-bottom: 0; }

	/* Header */
	.wx-header {
		display: flex; justify-content: space-between; align-items: flex-start;
		margin-bottom: 10px;
	}
	.wx-header-left {
		display: flex; flex-direction: column; gap: 2px;
	}
	.wx-title {
		display: flex; align-items: center; gap: 5px;
		font-size: 13px; font-weight: 600; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.5px;
	}
	.wx-location {
		font-size: 11px; color: var(--muted); opacity: 0.75;
		padding-left: 2px;
	}
	.wx-meta {
		display: flex; align-items: center; gap: 5px;
		font-size: 10px; color: var(--muted);
	}
	.wx-dot {
		width: 6px; height: 6px; border-radius: 50%; background: var(--green);
		animation: pulse-live 2s ease-in-out infinite;
	}
	.wx-dot.stale { background: var(--amber); animation: none; }
	@keyframes pulse-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

	.wx-empty { font-size: 13px; color: var(--muted); padding-bottom: 4px; }

	/* Current conditions */
	.wx-now {
		display: flex; flex-direction: column; gap: 0;
		margin: 0 -12px;
		background: var(--card2); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
	}
	.wx-now-top {
		display: flex; justify-content: space-between; align-items: center;
		padding: 10px 12px;
	}
	.wx-now-wind {
		display: flex; align-items: center; gap: 14px;
	}
	.wx-wind-arrow-box {
		display: flex; flex-direction: column; align-items: center; gap: 4px;
		flex-shrink: 0;
	}
	.wx-arrow { flex-shrink: 0; color: var(--muted); }
	.wx-arrow-large { color: var(--amber); }
	.wx-wind-dir-label {
		font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
		color: var(--text);
	}
	.wx-wind-data {
		display: flex; flex-direction: column; gap: 3px;
	}
	.wx-wind-speed-row {
		display: flex; align-items: baseline; gap: 4px;
	}
	.wx-now-speed { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
	.wx-now-unit  { font-size: 12px; color: var(--muted); }
	.wx-wind-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
	.wx-wind-gusts-row {
		display: flex; align-items: baseline; gap: 3px;
	}
	.wx-wind-gusts { font-size: 12px; color: var(--muted); font-weight: 600; }
	.wx-now-sep   { color: var(--border); }
	.wx-now-gusts { font-size: 12px; color: var(--muted); }
	.wx-now-dir   { font-size: 13px; font-weight: 600; }
	.wx-now-cond  { display: flex; align-items: center; gap: 6px; }
	.wx-now-emoji { font-size: 18px; line-height: 1; }
	.wx-now-temp  { font-size: 15px; font-weight: 600; }
	.wx-now-precip{ font-size: 11px; color: #60a5fa; }
	/* Sea-state row (wave + swell) */
	.wx-now-sea {
		display: flex; gap: 16px; padding: 8px 12px;
		border-top: 1px solid var(--border);
	}
	.wx-sea-item-box {
		display: flex; align-items: center; gap: 10px;
		flex: 1;
	}
	.wx-sea-item-box.wx-swell {
		opacity: 0.8;
		border-left: 1px solid var(--border);
		padding-left: 12px;
	}
	.wx-wave-arrow-box {
		display: flex; flex-direction: column; align-items: center; gap: 3px;
		flex-shrink: 0;
	}
	.wx-arrow-wave { flex-shrink: 0; }
	.wx-wave-dir-label {
		font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
	}
	.wx-wave-data {
		display: flex; flex-direction: column; gap: 4px;
	}
	.wx-wave-height-row {
		display: flex; align-items: baseline; gap: 6px;
	}
	.wx-wave-height {
		font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;
	}
	.wx-wave-state {
		font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
	}
	.wx-swell-label {
		font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px;
	}
	.wx-wave-visual {
		display: flex; gap: 2px; align-items: center;
	}
	.wx-wave-period {
		font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px;
	}

	/* Forecast */
	.wx-forecast { margin: 0 -12px; max-height: 360px; overflow-y: auto; }
	.wx-day-sep {
		font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
		color: var(--muted); padding: 6px 12px 3px; border-top: 1px solid var(--border);
	}
	.wx-day-sep:first-child { border-top: none; }

	.wx-row {
		display: grid;
		grid-template-columns: 36px 18px 1fr 28px 18px 36px 22px 1fr;
		align-items: center; gap: 5px;
		padding: 5px 12px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
		font-size: 12px; font-variant-numeric: tabular-nums;
	}
	.wx-row:last-child { border-bottom: none; }
	.wx-time  { color: var(--muted); }
	.wx-icon  { font-size: 13px; text-align: center; }

	/* Wind compact display */
	.wx-wind-compact {
		display: flex; align-items: center; gap: 3px;
		justify-self: start;
	}
	.wx-arrow-forecast { flex-shrink: 0; }
	.wx-wspd  { font-weight: 700; }
	.wx-wunit { font-size: 10px; color: var(--muted); }
	.wx-gust  { font-size: 11px; color: var(--muted); }
	.wx-temp  { color: var(--muted); text-align: right; }

	/* Sea compact display — direction arrow + height */
	.wx-sea-compact {
		display: flex; gap: 6px; justify-self: end;
		align-items: center;
	}
	.wx-wave-forecast-item,
	.wx-swell-forecast-item {
		display: flex; gap: 2px; align-items: center;
		font-size: 11px; font-weight: 600;
	}
	.wx-swell-forecast-item { opacity: 0.7; }

	/* Moon section */
	.wx-moon-section { padding: 10px 0 4px; border-top: 1px solid var(--border); }
	.wx-section-label {
		font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
		color: var(--muted); margin-bottom: 7px;
	}
	.wx-moon-rows { display: flex; flex-direction: column; gap: 5px; }
	.wx-moon-row {
		display: flex; align-items: center; gap: 10px;
		padding: 6px 8px; border-radius: 6px;
		background: var(--card2); border: 1px solid var(--border);
	}
	.wx-moon-row.bright {
		border-color: rgba(251,191,36,.3);
		background: rgba(251,191,36,.05);
	}
	.wx-moon-emoji { font-size: 18px; line-height: 1; flex-shrink: 0; }
	.wx-moon-info  { flex: 1; min-width: 0; }
	.wx-moon-label { display: block; font-size: 12px; font-weight: 600; white-space: nowrap; }
	.wx-moon-name  { display: block; font-size: 10px; color: var(--muted); }
	.wx-moon-times {
		display: block; font-size: 10px; color: var(--muted);
		font-variant-numeric: tabular-nums; margin-top: 1px;
	}
.wx-moon-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
	.wx-illum-bar  {
		width: 44px; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden;
	}
	.wx-illum-fill { height: 100%; background: #fbbf24; border-radius: 2px; }
	.wx-illum-pct  {
		font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums;
		min-width: 28px; text-align: right;
	}

	/* Footer */
	.wx-source {
		font-size: 9px; color: var(--muted); opacity: 0.5;
		text-align: right; padding: 5px 0 4px;
	}
</style>
