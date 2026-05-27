<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import { fmtW, joule2kwh } from '$lib/utils/units.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const panels = $derived([
		{ id: '277', w: t?.solar_p277 ?? null },
		{ id: '279', w: t?.solar_p279 ?? null },
		{ id: '289', w: t?.solar_p289 ?? null },
		{ id: '290', w: t?.solar_p290 ?? null },
		{ id: '292', w: t?.solar_p292 ?? null },
	]);

	const total = $derived(t?.solar_total_w ?? null);
	const maxW = $derived(() => {
		const vals = panels.filter(p => p.w != null).map(p => p.w!);
		return vals.length ? Math.max(...vals, 1) : 1;
	});
</script>

<div class="card">
	<div class="card-head">
		<span class="title">Solar</span>
		<span class="total" class:active={total != null && total > 0}>
			{fmtW(total)}
		</span>
	</div>

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
				<div class="panel-id">{p.id}</div>
			</div>
		{/each}
	</div>

	<div class="divider"></div>

	<div class="yield-row">
		<div>
			<div class="label">Heute</div>
			<div class="val">{joule2kwh(t?.solar_yield_today_j ?? null)}</div>
		</div>
		<div>
			<div class="label">Gestern</div>
			<div class="val">{joule2kwh(t?.solar_yield_yesterday_j ?? null)}</div>
		</div>
	</div>
</div>

<style>
	.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.total { font-size: 20px; font-weight: 700; color: var(--muted); }
	.total.active { color: var(--amber); }

	.panels {
		display: flex;
		gap: 6px;
		height: 80px;
		align-items: flex-end;
		margin-bottom: 4px;
	}
	.panel { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
	.panel-bar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; }
	.panel-bar {
		width: 100%;
		background: var(--amber);
		border-radius: 3px 3px 0 0;
		min-height: 2px;
		transition: height 0.5s ease;
	}
	.panel-val { font-size: 10px; color: var(--text); margin-top: 2px; }
	.panel-id { font-size: 9px; color: var(--muted); }

	.divider { height: 1px; background: var(--border); margin: 10px 0; }

	.yield-row { display: flex; gap: 24px; }
	.label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.val { font-size: 15px; font-weight: 600; margin-top: 2px; }
</style>
