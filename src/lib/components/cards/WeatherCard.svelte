<script lang="ts">
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { inreachPoints } from '$lib/stores/inreach.js';

	type WxHour = {
		time: string;
		temp: number;
		wind: number;
		gusts: number;
		dir: number;
		precip: number;
		wmo: number;
	};

	let hours   = $state<WxHour[]>([]);
	let loaded  = $state(false);
	let stale   = $state(false);
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
		// Treat ISO string as local (Open-Meteo with timezone=auto returns local time)
		const [y, mo, d] = iso.split('T')[0].split('-').map(Number);
		const t = new Date(y, mo - 1, d);
		const today = new Date(); today.setHours(0,0,0,0);
		const tom   = new Date(today); tom.setDate(today.getDate() + 1);
		if (t.getTime() === today.getTime()) return 'Today';
		if (t.getTime() === tom.getTime())   return 'Tomorrow';
		return t.toLocaleDateString('en', { weekday: 'long' });
	}

	// ── Fetch ─────────────────────────────────────────────────────────────────
	async function fetchWeather(p: { lat: number; lon: number }) {
		try {
			const r = await fetch(
				`https://api.open-meteo.com/v1/forecast` +
				`?latitude=${p.lat}&longitude=${p.lon}` +
				`&hourly=temperature_2m,precipitation_probability,weathercode,windspeed_10m,windgusts_10m,winddirection_10m` +
				`&wind_speed_unit=kn&forecast_days=2&timezone=auto`
			);
			if (!r.ok) throw new Error('http ' + r.status);
			const j = await r.json();

			const cutoff = Date.now() - 30 * 60_000; // include up to 30 min ago
			hours = (j.hourly.time as string[])
				.map((t, i) => ({
					time:   t,
					temp:   Math.round(j.hourly.temperature_2m[i]),
					wind:   Math.round(j.hourly.windspeed_10m[i]),
					gusts:  Math.round(j.hourly.windgusts_10m[i]),
					dir:    Math.round(j.hourly.winddirection_10m[i]),
					precip: j.hourly.precipitation_probability?.[i] ?? 0,
					wmo:    j.hourly.weathercode[i],
				}))
				.filter(h => {
					const ms = new Date(h.time).getTime();
					const hr = new Date(h.time).getHours();
					return ms >= cutoff && hr % 3 === 0;
				})
				.slice(0, 17); // current 3h slot + 16 future = ~48 h

			stale     = false;
			updatedAt = new Date();
		} catch {
			stale = true;
		}
		loaded = true;
	}

	// ── Reactive fetch ────────────────────────────────────────────────────────
	$effect(() => {
		const p = pos; // sync read — tracked by effect
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
		<!-- ── Current conditions ─────────────────────────────────────────── -->
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
			<div class="wx-now-cond">
				<span class="wx-now-emoji">{wmoEmoji(now.wmo)}</span>
				<span class="wx-now-temp">{now.temp}°C</span>
				{#if now.precip > 0}<span class="wx-now-precip">{now.precip}%</span>{/if}
			</div>
		</div>

		<!-- ── Forecast rows ─────────────────────────────────────────────── -->
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
					{#if h.precip > 0}<span class="wx-precip">{h.precip}%</span>{/if}
				</div>
			{/each}
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

	/* Current conditions */
	.wx-now {
		display: flex; justify-content: space-between; align-items: center;
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
	.wx-now-cond  { display: flex; align-items: center; gap: 6px; }
	.wx-now-emoji { font-size: 18px; line-height: 1; }
	.wx-now-temp  { font-size: 15px; font-weight: 600; }
	.wx-now-precip{ font-size: 11px; color: #60a5fa; }

	/* Forecast */
	.wx-forecast {
		margin: 0 -12px;
		max-height: 280px; overflow-y: auto;
	}
	.wx-day-sep {
		font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
		color: var(--muted); padding: 6px 12px 3px;
		border-top: 1px solid var(--border);
	}
	.wx-day-sep:first-child { border-top: none; }

	.wx-row {
		display: grid;
		grid-template-columns: 36px 18px 16px 28px 20px 32px 38px 24px auto;
		align-items: center; gap: 4px;
		padding: 5px 12px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
		font-size: 12px; font-variant-numeric: tabular-nums;
	}
	.wx-row:last-child { border-bottom: none; }
	.wx-time  { color: var(--muted); }
	.wx-icon  { font-size: 13px; text-align: center; }
	.wx-wspd  { font-weight: 700; text-align: right; }
	.wx-wunit { font-size: 10px; color: var(--muted); }
	.wx-gust  { font-size: 11px; color: var(--muted); }
	.wx-wdir  { font-size: 11px; color: var(--text); }
	.wx-temp  { color: var(--muted); text-align: right; }
	.wx-precip{ font-size: 10px; color: #60a5fa; }

	/* Footer */
	.wx-source {
		font-size: 9px; color: var(--muted); opacity: 0.5;
		text-align: right; padding: 5px 0 4px;
	}
</style>
