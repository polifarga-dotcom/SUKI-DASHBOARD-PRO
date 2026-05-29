<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { parseVRMDiagnostics } from '$lib/utils/vrm.js';
	import type { VRMData } from '$lib/types.js';

	const VRM_BASE = 'https://vrmapi.victronenergy.com/v2';

	let data = $state<VRMData | null>(null);
	let error = $state('');
	let pollTimer: ReturnType<typeof setInterval>;

	const cfg = $derived($anchorConfig);

	function apiReady() {
		return cfg?.vrm_api_token && cfg?.vrm_installation_id;
	}

	async function fetchVRM() {
		if (!apiReady()) return;
		const token = cfg!.vrm_api_token!;
		const id    = cfg!.vrm_installation_id!;
		try {
			const res = await fetch(
				`${VRM_BASE}/installations/${id}/diagnostics?count=1000`,
				{ headers: { 'X-Authorization': `Token ${token}` } }
			);
			if (!res.ok) { error = `HTTP ${res.status}`; return; }
			const json = await res.json();
			const attrs: unknown[] = json?.records ?? [];
			data  = parseVRMDiagnostics(attrs);
			error = '';
		} catch (e) {
			error = String(e);
		}
	}

	onMount(() => {
		fetchVRM();
		pollTimer = setInterval(fetchVRM, 60_000);
	});
	onDestroy(() => clearInterval(pollTimer));

	// Helpers
	function pct(v: number | null) { return v != null ? Math.round(v) : null; }
	function fmtW(v: number | null) {
		if (v == null) return '—';
		return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} kW` : `${Math.round(v)} W`;
	}
	function fmtWh(v: number | null) {
		if (v == null) return '—';
		return v >= 1000 ? `${(v / 1000).toFixed(2)} kWh` : `${Math.round(v)} Wh`;
	}
	function ageStr(ts: number | null) {
		if (!ts) return '';
		const s = Math.floor(Date.now() / 1000) - ts;
		if (s < 90)  return 'Gerade eben';
		if (s < 3600) return `Vor ${Math.floor(s / 60)} Min.`;
		return `Vor ${Math.floor(s / 3600)} Std.`;
	}
	function socColor(soc: number | null) {
		if (soc == null) return 'var(--muted)';
		if (soc > 50) return 'var(--green)';
		if (soc > 20) return 'var(--amber)';
		return 'var(--red)';
	}
</script>

{#if apiReady()}
<div class="card">
	<div class="title-row">
		<span class="title">Victron VRM</span>
		{#if data?.last_ts}
			<span class="age" class:stale={(Date.now()/1000 - data.last_ts) > 180}>{ageStr(data.last_ts)}</span>
		{/if}
	</div>

	{#if error}
		<div class="err">{error}</div>
	{:else if !data}
		<div class="empty">Verbinde mit VRM…</div>
	{:else}
		<!-- Battery -->
		{#if data.battery_soc != null}
		<div class="section-label">Batterie</div>
		<div class="soc-row">
			<div class="soc-bar-wrap">
				<div class="soc-bar" style="width:{pct(data.battery_soc)}%; background:{socColor(data.battery_soc)}"></div>
			</div>
			<span class="soc-val" style="color:{socColor(data.battery_soc)}">{pct(data.battery_soc)} %</span>
		</div>
		<div class="stat-row">
			{#if data.battery_v != null}<span class="stat">{data.battery_v.toFixed(1)} V</span>{/if}
			{#if data.battery_a != null}<span class="stat">{data.battery_a.toFixed(1)} A</span>{/if}
			{#if data.battery_w != null}<span class="stat">{fmtW(data.battery_w)}</span>{/if}
		</div>
		{/if}

		<!-- Solar -->
		{#if data.solar_w != null || data.solar_yield_today_wh != null}
		<div class="section-label">Solar</div>
		<div class="stat-row">
			{#if data.solar_w != null}<span class="stat hi">{fmtW(data.solar_w)}</span>{/if}
			{#if data.solar_yield_today_wh != null}<span class="stat muted">Heute {fmtWh(data.solar_yield_today_wh)}</span>{/if}
		</div>
		{/if}

		<!-- Tanks -->
		{#if data.tanks.length > 0}
		<div class="section-label">Tanks</div>
		{#each data.tanks as tank}
			<div class="tank-row">
				<span class="tank-name">{tank.name}</span>
				<div class="tank-bar-wrap">
					<div class="tank-bar" style="width:{Math.round(tank.level)}%"></div>
				</div>
				<span class="tank-pct">{Math.round(tank.level)} %</span>
			</div>
		{/each}
		{/if}

		<!-- GPS -->
		{#if data.gps_lat != null && data.gps_lon != null}
		<div class="section-label">GPS</div>
		<div class="stat-row">
			<span class="stat muted">{data.gps_lat.toFixed(5)}° {data.gps_lon.toFixed(5)}°</span>
		</div>
		{/if}
	{/if}
</div>
{/if}

<style>
	.title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.age { font-size: 11px; color: var(--muted); }
	.age.stale { color: var(--amber); }
	.empty, .err { font-size: 13px; color: var(--muted); }
	.err { color: var(--red); }

	.section-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 10px 0 4px; }
	.section-label:first-of-type { margin-top: 0; }

	/* SOC bar */
	.soc-row { display: flex; align-items: center; gap: 8px; }
	.soc-bar-wrap { flex: 1; height: 8px; background: var(--card2); border-radius: 4px; overflow: hidden; }
	.soc-bar { height: 100%; border-radius: 4px; transition: width 0.4s; }
	.soc-val { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 42px; text-align: right; }

	/* Stat row */
	.stat-row { display: flex; gap: 10px; flex-wrap: wrap; }
	.stat { font-size: 13px; font-variant-numeric: tabular-nums; }
	.stat.hi { color: var(--accent); font-weight: 600; }
	.stat.muted { color: var(--muted); }

	/* Tank bars */
	.tank-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
	.tank-name { font-size: 12px; color: var(--muted); min-width: 70px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tank-bar-wrap { flex: 1; height: 6px; background: var(--card2); border-radius: 3px; overflow: hidden; }
	.tank-bar { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.4s; }
	.tank-pct { font-size: 12px; color: var(--muted); min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
</style>
