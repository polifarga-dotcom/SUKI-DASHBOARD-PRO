<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import { fmtW, joule2kwh } from '$lib/utils/units.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

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

	{#if hasMppts}
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
