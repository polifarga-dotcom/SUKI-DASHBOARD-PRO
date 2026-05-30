<script lang="ts">
	import { onDestroy } from 'svelte';
	import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { inreachPoints, inreachStale } from '$lib/stores/inreach.js';
	import type { InReachPoint } from '$lib/types.js';

	let pollTimer: ReturnType<typeof setInterval>;
	let loaded = $state(false);

	const cfg = $derived($anchorConfig);
	const pts  = $derived($inreachPoints);

	const latest  = $derived<InReachPoint | null>(pts?.[0] ?? null);
	const hasData = $derived(!!cfg?.inreach_mapshare_id);

	// ── Data age ──────────────────────────────────────────────────────────────
	function ageStr(ts: string): string {
		if (!ts) return '—';
		const diff = Date.now() - new Date(ts).getTime();
		const min  = Math.floor(diff / 60_000);
		if (min < 1)   return 'just now';
		if (min < 60)  return `${min} min ago`;
		const h = Math.floor(min / 60);
		if (h  < 24)   return `${h} h ago`;
		return `${Math.floor(h / 24)} d ago`;
	}

	// ── Format lat/lon ────────────────────────────────────────────────────────
	function fmtDeg(deg: number, pos: string, neg: string): string {
		const dir = deg >= 0 ? pos : neg;
		const abs = Math.abs(deg);
		const d   = Math.floor(abs);
		const m   = ((abs - d) * 60).toFixed(3);
		return `${d}° ${m}′ ${dir}`;
	}
	function fmtCoord(lat: number, lon: number): string {
		return `${fmtDeg(lat,'N','S')}  ${fmtDeg(lon,'E','W')}`;
	}

	// ── Course arrow (Unicode) ────────────────────────────────────────────────
	function courseArrow(deg: number | null): string {
		if (deg === null) return '';
		const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
		return arrows[Math.round(deg / 45) % 8];
	}

	// ── Fetch ─────────────────────────────────────────────────────────────────
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

	$effect(() => {
		if (!hasData) { loaded = true; return; }
		fetchInReach();
		clearInterval(pollTimer);
		pollTimer = setInterval(fetchInReach, 10 * 60_000); // every 10 min
	});

	onDestroy(() => clearInterval(pollTimer));
</script>

{#if hasData && (loaded === false || (pts !== null && pts.length > 0) || $inreachStale)}
<div class="card inreach-card" class:emergency={latest?.in_emergency}>

	<div class="card-header">
		<span class="card-title">
			<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="10" cy="10" r="8"/>
				<path d="M10 6v4l3 2"/>
			</svg>
			{latest?.device_name ?? 'InReach'}
		</span>
		<span class="card-age" class:stale={$inreachStale}>
			{#if $inreachStale}No signal{:else if latest}{ageStr(latest.timestamp)}{:else}—{/if}
		</span>
	</div>

	{#if latest?.in_emergency}
	<div class="emergency-banner">🚨 EMERGENCY ACTIVE</div>
	{/if}

	{#if latest}
	<div class="inreach-grid">
		<!-- Position -->
		<div class="ir-item full">
			<span class="ir-label">Position</span>
			<span class="ir-val coord">{fmtCoord(latest.lat, latest.lon)}</span>
		</div>

		<!-- Speed -->
		{#if latest.speed_kn !== null}
		<div class="ir-item">
			<span class="ir-label">Speed</span>
			<span class="ir-val">{latest.speed_kn.toFixed(1)} kn</span>
		</div>
		{/if}

		<!-- Course -->
		{#if latest.course_deg !== null}
		<div class="ir-item">
			<span class="ir-label">Course</span>
			<span class="ir-val">{courseArrow(latest.course_deg)} {Math.round(latest.course_deg)}°</span>
		</div>
		{/if}

		<!-- Track count -->
		{#if pts && pts.length > 1}
		<div class="ir-item">
			<span class="ir-label">Track</span>
			<span class="ir-val">{pts.length} points</span>
		</div>
		{/if}

		<!-- Last message -->
		{#if latest.message}
		<div class="ir-item full">
			<span class="ir-label">Last message</span>
			<span class="ir-val message">"{latest.message}"</span>
		</div>
		{/if}
	</div>
	{:else if !loaded}
	<div class="ir-loading">Connecting to InReach…</div>
	{:else}
	<div class="ir-loading">No position data in the last 24 h</div>
	{/if}

</div>
{/if}

<style>
	.inreach-card {
		border-color: var(--border);
		transition: border-color 0.3s;
	}
	.inreach-card.emergency {
		border-color: var(--red);
		box-shadow: 0 0 0 1px var(--red);
	}

	.card-header {
		display: flex; justify-content: space-between; align-items: center;
		margin-bottom: 10px;
	}
	.card-title {
		display: flex; align-items: center; gap: 5px;
		font-size: 11px; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.8px; color: var(--muted);
	}
	.card-age {
		font-size: 10px; color: var(--muted);
	}
	.card-age.stale { color: var(--amber); }

	.emergency-banner {
		background: rgba(239,68,68,.15); border: 1px solid var(--red);
		color: var(--red); border-radius: 6px; padding: 6px 10px;
		font-size: 12px; font-weight: 700; text-align: center;
		margin-bottom: 10px; letter-spacing: 0.5px;
	}

	.inreach-grid {
		display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
	}
	.ir-item {
		display: flex; flex-direction: column; gap: 2px;
		background: var(--card2); border-radius: 6px; padding: 7px 9px;
	}
	.ir-item.full { grid-column: 1 / -1; }
	.ir-label {
		font-size: 9px; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.6px; color: var(--muted);
	}
	.ir-val {
		font-size: 13px; font-variant-numeric: tabular-nums; color: var(--text);
	}
	.ir-val.coord { font-size: 11px; line-height: 1.4; }
	.ir-val.message {
		font-size: 12px; font-style: italic; color: var(--accent);
		white-space: pre-wrap; word-break: break-word;
	}

	.ir-loading {
		font-size: 12px; color: var(--muted); text-align: center; padding: 12px 0;
	}
</style>
