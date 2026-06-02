<script lang="ts">
	import { onMount } from 'svelte';
	import type { Telemetry } from '$lib/types.js';
	import type { VRMData } from '$lib/types.js';
	import { fmtW, joule2kwh } from '$lib/utils/units.js';
	import { supabase } from '$lib/supabase.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { currentBoat } from '$lib/stores/boat.js';
	import { parseVRMDiagnostics, MPPT_STATE } from '$lib/utils/vrm.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	// ── VRM Data ──────────────────────────────────────────────────────────────────
	let vrmData = $state<VRMData | null>(null);
	let vrmError = $state('');
	const cfg = $derived($anchorConfig);
	function apiReady() { return !!(cfg?.vrm_api_token && cfg?.vrm_installation_id); }

	async function fetchVRM() {
		if (!apiReady()) return;
		const boatId = $currentBoat?.id;
		let { data: json, error: fnErr } = await supabase.functions.invoke('vrm-proxy', {
			body: { boat_id: boatId },
		});
		if (fnErr) {
			const { error: refreshErr } = await supabase.auth.refreshSession();
			if (!refreshErr) {
				({ data: json, error: fnErr } = await supabase.functions.invoke('vrm-proxy', {
					body: { boat_id: boatId },
				}));
			}
		}
		if (fnErr) { vrmError = fnErr.message; return; }
		const parsed = parseVRMDiagnostics(json?.records ?? []);
		vrmData = parsed;
		vrmError = '';
	}

	onMount(() => {
		if (apiReady()) fetchVRM();
		const interval = setInterval(fetchVRM, 60000);
		return () => clearInterval(interval);
	});

	// ── Colors & Helpers ──────────────────────────────────────────────────────────
	const SOLAR_C = '#f5c842';
	function mpptStateColor(st: number | null) {
		if (st == null) return 'var(--muted)';
		if (st === 5) return 'var(--green)';
		if (st === 4) return 'var(--accent)';
		if (st === 3) return '#f5c842';
		if (st === 0) return 'var(--muted)';
		return 'var(--amber)';
	}
	function mpptStateLabel(st: number | null) { return st != null ? (MPPT_STATE[st] ?? `St.${st}`) : ''; }
	function mpptShortName(name: string) {
		return name
			.replace(/^BlueSolar Charger MPPT /i, 'BlueSolar ')
			.replace(/^SmartSolar Charger MPPT /i, 'SmartSolar ')
			.replace(/^BlueSolar Charger /i, 'BlueSolar ')
			.replace(/^SmartSolar Charger /i, 'SmartSolar ')
			.replace(/^Victron Energy /i, '')
			.replace(/^Victron /i, '');
	}
	function fmtC(v: number) { return `${v.toFixed(1)} °C`; }

	const mpptMaxW = $derived(vrmData ? Math.max(100, ...vrmData.mpptsArr.map(m => m.power_w)) : 100);

	// ── Total power (from plugin or server.py) ────────────────────────────────────
	const total = $derived(t?.solar_total_w ?? null);

	// ── Named MPPT columns (Victron VRM device IDs — SUKI-specific) ─────────────
	// These are only populated when server.py is running on the Cerbo and the
	// VRM installation uses these specific device IDs. Other boats will have all
	// nulls here and will see just the total + yield instead.
	const panels = $derived([
		{ label: '277', w: t?.solar_p277 ?? null },
		{ label: '279', w: t?.solar_p279 ?? null },
		{ label: '289', w: t?.solar_p289 ?? null },
		{ label: '290', w: t?.solar_p290 ?? null },
		{ label: '292', w: t?.solar_p292 ?? null },
	]);

	// Show bar chart only when at least one named MPPT column has data
	const hasMppts = $derived(panels.some(p => p.w != null));

	const maxW = $derived(() => {
		if (!hasMppts) return 1;
		const vals = panels.filter(p => p.w != null).map(p => p.w!);
		return vals.length ? Math.max(...vals, 1) : 1;
	});

	// ── Yield (server.py Cerbo-exclusive columns) ─────────────────────────────────
	const yieldToday = $derived(t?.solar_yield_today_j     ?? null);
	const yieldYest  = $derived(t?.solar_yield_yesterday_j ?? null);
	const hasYield   = $derived(yieldToday != null || yieldYest != null);

	// ── Current (amps from server.py) ─────────────────────────────────────────────
	const totalA = $derived(t?.solar_total_a ?? null);

	const hasAnyData = $derived(total != null || hasMppts || hasYield);
</script>

<div class="card">
	<div class="card-head">
		<span class="title">Solar</span>
		<div class="head-right">
			{#if totalA != null}
				<span class="sub-val">{totalA.toFixed(1)} A</span>
			{/if}
			<span class="total" class:active={total != null && total > 0}>
				{fmtW(total)}
			</span>
		</div>
	</div>

	{#if vrmData?.mpptsArr.length}
		<!-- VRM Solar Chargers: Horizontal List Layout -->
		<div class="solar-items">
			{#each vrmData.mpptsArr as mppt}
				<div class="solar-item">
					<!-- Left: Name + Badges -->
					<div class="item-left">
						<div class="item-name">{mpptShortName(mppt.name)}</div>
						<div class="item-badges">
							<span class="state-badge" style="--state-color: {mpptStateColor(mppt.state)}">
								{mpptStateLabel(mppt.state)}
							</span>
							{#if mppt.pv_v != null}
								<span class="pv-val">{mppt.pv_v.toFixed(1)}V</span>
							{/if}
						</div>
					</div>
					<!-- Middle: Power + Bar -->
					<div class="item-power">
						<div class="power-number">{fmtW(mppt.power_w)}</div>
						<div class="power-track">
							<div class="power-fill" style="width: {Math.min(100, (mppt.power_w / mpptMaxW) * 100)}%"></div>
						</div>
					</div>
					<!-- Right: Yields -->
					<div class="item-yields">
						<div class="yield-col">
							<div class="yield-label">Today</div>
							<div class="yield-val">{mppt.yield_today_wh ? (mppt.yield_today_wh / 1000).toFixed(2) : '—'} kWh</div>
						</div>
						<div class="yield-col">
							<div class="yield-label">Total</div>
							<div class="yield-val">{mppt.yield_total_kwh ? mppt.yield_total_kwh.toFixed(1) : '—'} MWh</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{:else if hasMppts}
		<!-- Per-MPPT bar chart (Victron Cerbo with server.py, named by VRM device ID) -->
		<div class="panels">
			{#each panels as p}
				<div class="panel">
					<div class="panel-bar-wrap">
						<div
							class="panel-bar"
							style="height:{p.w != null ? (p.w / maxW()) * 100 : 0}%"
						></div>
					</div>
					<div class="panel-val">{p.w != null ? p.w.toFixed(0) : '—'}</div>
					<div class="panel-id">{p.label}</div>
				</div>
			{/each}
		</div>
	{:else if !hasAnyData}
		<div class="no-data">No solar data</div>
	{/if}

	{#if hasYield}
		<div class="divider"></div>
		<div class="yield-row">
			{#if yieldToday != null}
				<div>
					<div class="label">Today</div>
					<div class="val">{joule2kwh(yieldToday)}</div>
				</div>
			{/if}
			{#if yieldYest != null}
				<div>
					<div class="label">Yesterday</div>
					<div class="val">{joule2kwh(yieldYest)}</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.card-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
	}
	.title {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.head-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.sub-val {
		font-size: 13px;
		color: var(--muted);
	}
	.total {
		font-size: 20px;
		font-weight: 700;
		color: var(--muted);
	}
	.total.active { color: var(--amber); }

	.panels {
		display: flex;
		gap: 6px;
		height: 80px;
		align-items: flex-end;
		margin-bottom: 4px;
	}
	.panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
	}
	.panel-bar-wrap {
		flex: 1;
		width: 100%;
		display: flex;
		align-items: flex-end;
	}
	.panel-bar {
		width: 100%;
		background: var(--amber);
		border-radius: 3px 3px 0 0;
		min-height: 2px;
		transition: height 0.5s ease;
	}
	.panel-val { font-size: 10px; color: var(--text); margin-top: 2px; }
	.panel-id  { font-size: 9px;  color: var(--muted); }

	/* ─ Solar Chargers: Horizontal List ──────────────────────────────────── */
	.solar-items {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 4px;
	}

	.solar-item {
		display: grid;
		grid-template-columns: 110px 1fr 130px;
		gap: 16px;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.solar-item:last-child { border-bottom: none; }

	.item-left {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.item-name {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.item-badges {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: center;
	}
	.state-badge {
		font-size: 10px;
		padding: 2px 5px;
		border-radius: 3px;
		background: var(--state-color);
		color: var(--surface);
		font-weight: 600;
	}
	.pv-val {
		font-size: 10px;
		color: var(--muted);
	}

	.item-power {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.power-number {
		font-size: 14px;
		font-weight: 700;
		color: var(--amber);
	}
	.power-track {
		height: 6px;
		background: var(--border);
		border-radius: 3px;
		overflow: hidden;
	}
	.power-fill {
		height: 100%;
		background: var(--amber);
		transition: width 0.3s ease;
	}

	.item-yields {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
	.yield-col {
		text-align: right;
	}
	.yield-label {
		font-size: 10px;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 2px;
	}
	.yield-val {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}

	.no-data {
		font-size: 13px;
		color: var(--muted);
		text-align: center;
		padding: 12px 0 4px;
	}

	.divider { height: 1px; background: var(--border); margin: 10px 0; }

	.yield-row { display: flex; gap: 24px; }
	.label {
		font-size: 11px;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.val { font-size: 15px; font-weight: 600; margin-top: 2px; }
</style>
