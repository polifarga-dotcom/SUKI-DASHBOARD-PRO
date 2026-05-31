<script lang="ts">
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
		// waves (null if marine data unavailable at this location)
		waveH:  number | null;
		waveP:  number | null;
		waveD:  number | null;
		swellH: number | null;
	};

	let hours     = $state<WxHour[]>([]);
	let loaded    = $state(false);
	let stale     = $state(false);
	let updatedAt = $state<Date | null>(null);
	let pollTimer: ReturnType<typeof setInterval>;

	const cfg = $derived($anchorConfig);
	const pts = $derived($inreachPoints);

	// Position: prefer InReach latest fix, fallback to anchor coords
	const pos = $derived(
		pts?.[0]
			? { lat: pts[0].lat, lon: pts[0].lon }
			: (cfg?.lat && cfg?.lon ? { lat: cfg.lat, lon: cfg.lon } : null)
	);

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

	function wmoEmoji(code: number): string {
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

	// ── Moon phase ─────────────────────────────────────────────────────────────
	const REF_NEW_MOON = new Date('2000-01-06T18:14:00Z').getTime();
	const SYNODIC_MS   = 29.530588853 * 86400000;

	type MoonInfo = { illumination: number; emoji: string; name: string; bright: boolean };

	function moonPhase(date: Date): MoonInfo {
		const elapsed = date.getTime() - REF_NEW_MOON;
		const frac    = ((elapsed % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS / SYNODIC_MS;
		const illum   = Math.round((1 - Math.cos(2 * Math.PI * frac)) / 2 * 100);

		let name: string;
		let emoji: string;
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

	// Next 3 nights (22:00 local) — computed reactively
	const moonNights = $derived(() => {
		const today = new Date(); today.setHours(0,0,0,0);
		return Array.from({ length: 3 }, (_, i) => {
			const d = new Date(today);
			d.setDate(today.getDate() + i);
			d.setHours(22, 0, 0, 0);
			const label = i === 0 ? 'Tonight'
				: i === 1 ? 'Tomorrow night'
				: new Date(today.getTime() + i * 86400000)
					.toLocaleDateString('en', { weekday: 'long' }) + ' night';
			return { label, phase: moonPhase(d) };
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
					`&wind_speed_unit=kn&forecast_days=2&timezone=auto`
				),
				fetch(
					`https://marine-api.open-meteo.com/v1/marine` +
					`?latitude=${p.lat}&longitude=${p.lon}` +
					`&hourly=wave_height,wave_period,wave_direction,swell_wave_height` +
					`&forecast_days=2&timezone=auto`
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
					waveH:  mhr?.wave_height[i]       != null ? Math.round((mhr.wave_height[i] as number) * 10) / 10 : null,
					waveP:  mhr?.wave_period[i]       != null ? Math.round(mhr.wave_period[i] as number) : null,
					waveD:  mhr?.wave_direction[i]    != null ? Math.round(mhr.wave_direction[i] as number) : null,
					swellH: mhr?.swell_wave_height[i] != null ? Math.round((mhr.swell_wave_height[i] as number) * 10) / 10 : null,
				}))
				.filter(h => {
					const ms = new Date(h.time).getTime();
					const hr = new Date(h.time).getHours();
					return ms >= cutoff && hr % 3 === 0;
				})
				.slice(0, 17);

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
	$effect(() => {
		const p = pos;
		if (!p) { loaded = true; return; }
		loaded = false;
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
			Weather · 48 h
		</span>
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
			<div class="wx-now-wind">
				<svg class="wx-arrow" style="transform: rotate({now.dir}deg)"
					viewBox="0 0 12 18" width="22" height="22" fill="currentColor">
					<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
				</svg>
				<span class="wx-now-speed" style="color:{windColor(now.wind)}">{now.wind}</span>
				<span class="wx-now-unit">kn</span>
				<span class="wx-now-sep">·</span>
				<span class="wx-now-gusts">G {now.gusts} kn</span>
				<span class="wx-now-sep">·</span>
				<span class="wx-now-dir">{dirAbbr(now.dir)}</span>
			</div>
			<div class="wx-now-right">
				<div class="wx-now-cond">
					<span class="wx-now-emoji">{wmoEmoji(now.wmo)}</span>
					<span class="wx-now-temp">{now.temp}°C</span>
					{#if now.precip > 0}<span class="wx-now-precip">{now.precip}%</span>{/if}
				</div>
				{#if now.waveH != null}
				<div class="wx-now-wave">
					<!-- wave icon -->
					<svg viewBox="0 0 16 10" width="14" height="9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
						<path d="M1 7 Q3 3 5 7 Q7 11 9 7 Q11 3 13 7 Q14 9 15 7"/>
					</svg>
					<span style="color:{waveColor(now.waveH)}">{now.waveH} m</span>
					{#if now.waveP != null}<span class="wx-wave-dim">{now.waveP} s</span>{/if}
					{#if now.swellH != null && now.swellH >= 0.1}
						<span class="wx-wave-dim">· swell {now.swellH} m</span>
					{/if}
				</div>
				{/if}
			</div>
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
					<span class="wx-icon">{wmoEmoji(h.wmo)}</span>
					<svg class="wx-arrow" style="transform: rotate({h.dir}deg)"
						viewBox="0 0 12 18" width="13" height="13" fill="currentColor">
						<path d="M6 0 L11.5 15 L6 11 L0.5 15 Z"/>
					</svg>
					<span class="wx-wspd" style="color:{windColor(h.wind)}">{h.wind}</span>
					<span class="wx-wunit">kn</span>
					<span class="wx-gust">G{h.gusts}</span>
					<span class="wx-wdir">{dirAbbr(h.dir)}</span>
					<span class="wx-temp">{h.temp}°</span>
					{#if h.waveH != null}
						<span class="wx-wave-cell" style="color:{waveColor(h.waveH)}">{h.waveH}m</span>
					{:else}
						<span class="wx-wave-cell"></span>
					{/if}
					{#if h.precip > 0}<span class="wx-precip">{h.precip}%</span>{/if}
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
		display: flex; justify-content: space-between; align-items: center;
		margin-bottom: 10px;
	}
	.wx-title {
		display: flex; align-items: center; gap: 5px;
		font-size: 13px; font-weight: 600; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.5px;
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

	/* Current */
	.wx-now {
		display: flex; justify-content: space-between; align-items: flex-start;
		padding: 10px 12px; margin: 0 -12px;
		background: var(--card2); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
	}
	.wx-now-wind { display: flex; align-items: center; gap: 6px; }
	.wx-arrow { flex-shrink: 0; color: var(--muted); }
	.wx-now-speed { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
	.wx-now-unit  { font-size: 12px; color: var(--muted); }
	.wx-now-sep   { color: var(--border); }
	.wx-now-gusts { font-size: 12px; color: var(--muted); }
	.wx-now-dir   { font-size: 13px; font-weight: 600; }
	.wx-now-right { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
	.wx-now-cond  { display: flex; align-items: center; gap: 6px; }
	.wx-now-emoji { font-size: 18px; line-height: 1; }
	.wx-now-temp  { font-size: 15px; font-weight: 600; }
	.wx-now-precip{ font-size: 11px; color: #60a5fa; }
	.wx-now-wave  { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; }
	.wx-wave-dim  { font-size: 10px; color: var(--muted); font-weight: 400; }

	/* Forecast */
	.wx-forecast { margin: 0 -12px; max-height: 280px; overflow-y: auto; }
	.wx-day-sep {
		font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
		color: var(--muted); padding: 6px 12px 3px; border-top: 1px solid var(--border);
	}
	.wx-day-sep:first-child { border-top: none; }

	.wx-row {
		display: grid;
		grid-template-columns: 36px 18px 16px 28px 20px 32px 38px 24px 34px auto;
		align-items: center; gap: 4px;
		padding: 5px 12px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
		font-size: 12px; font-variant-numeric: tabular-nums;
	}
	.wx-row:last-child { border-bottom: none; }
	.wx-time      { color: var(--muted); }
	.wx-icon      { font-size: 13px; text-align: center; }
	.wx-wspd      { font-weight: 700; text-align: right; }
	.wx-wunit     { font-size: 10px; color: var(--muted); }
	.wx-gust      { font-size: 11px; color: var(--muted); }
	.wx-wdir      { font-size: 11px; color: var(--text); }
	.wx-temp      { color: var(--muted); text-align: right; }
	.wx-wave-cell { font-size: 11px; font-weight: 600; }
	.wx-precip    { font-size: 10px; color: #60a5fa; }

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
