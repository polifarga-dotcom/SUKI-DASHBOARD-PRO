<script lang="ts">
	import type { Telemetry, VRMData } from '$lib/types.js';
	import { fmtV, fmtA, fmtW } from '$lib/utils/units.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';

	// VRM SOC is 0–100 (percent). Telemetry fallback SOC is 0–1 (fraction).
	// This card normalises everything to 0–100 for display.
	function socPct(soc: number | null, fromVRM: boolean): number | null {
		if (soc == null) return null;
		return fromVRM ? soc : soc * 100;
	}
	function socColor(pct: number | null): string {
		if (pct == null) return 'var(--muted)';
		if (pct > 50) return 'var(--green)';
		if (pct > 20) return 'var(--amber)';
		return 'var(--red)';
	}

	interface Props { vrm: VRMData | null; t: Telemetry | null; }
	let { vrm, t }: Props = $props();

	// Use VRM batteries when available; fall back to SignalK telemetry immediately
	const primary = $derived(vrm?.batteries[0] ?? (
		t?.batt_main_v != null || t?.batt_main_soc != null ? {
			name: 'Main Battery',
			soc: t?.batt_main_soc ?? null,
			v:   t?.batt_main_v   ?? null,
			a:   t?.batt_main_a   ?? null,
			w:   t?.batt_main_w   ?? null,
			time_to_go_s: null,
			consumed_ah: null,
			temp_c: null,
			instance: 0,
		} : null
	));
	const secondary = $derived(vrm?.batteries.slice(1) ?? []);

	// isVRM is true only when primary actually came from vrm.batteries
	// (not from the telemetry fallback). This ensures correct SOC unit handling:
	// VRM SOC = 0–100, telemetry SOC = 0–1 fraction.
	const isVRM = $derived(vrm != null && (vrm.batteries.length > 0));
	const v     = $derived(primary?.v   ?? null);
	const a     = $derived(primary?.a   ?? null);
	const w     = $derived(primary?.w   ?? null);
	const ttg   = $derived(primary?.time_to_go_s ?? null);

	// Normalise to 0–100 for display
	const pctNum   = $derived(socPct(primary?.soc ?? null, isVRM));
	const hasSoc   = $derived(pctNum != null);
	const color    = $derived(socColor(pctNum));

	const bigVal   = $derived(
		hasSoc      ? Math.round(pctNum!) + '%'
		: v != null ? v.toFixed(1) + ' V'
		: '—'
	);
	const bigColor = $derived(hasSoc ? color : 'var(--amber)');

	const fmtSigned = (x: number | null) =>
		x == null ? null : (x >= 0 ? '+' : '') + x.toFixed(1);

	function ttgStr(s: number | null): string | null {
		if (s == null || s <= 0) return null;
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}

	const isCharging    = $derived((a ?? 0) > 0.5);
	const isDischarging = $derived((a ?? 0) < -0.5);

	const battStatus = $derived(
		isCharging    ? 'Charging' :
		isDischarging ? 'Discharging' :
		'Idle'
	);
</script>

<div class="card">
	<div class="card-head">
		<span class="title">Battery</span>
		{#if primary?.name}
			<span class="hint">{primary.name}</span>
		{/if}
	</div>

	{#if primary == null}
		<div class="no-data">No battery data</div>
	{:else}
		<!-- SOC bar + big value + status -->
		<div class="soc-row">
			<div class="soc-head">
				<div class="soc-val" style="color:{bigColor}">{bigVal}</div>
				{#if hasSoc}
					<div class="batt-status" style="color:{battStatus === 'Charging' ? 'var(--green)' : battStatus === 'Discharging' ? 'var(--amber)' : 'var(--muted)'}">
						{battStatus}
					</div>
				{/if}
			</div>
			{#if hasSoc}
				<div class="soc-bar-wrap">
					<div class="soc-bar" style="width:{pctNum}%; background:{color}"></div>
				</div>
			{/if}
		</div>

		<!-- V / A / W -->
		{#if hasSoc}
			<div class="metrics cols3">
				<ValueCell label="Voltage" value={v != null ? v.toFixed(2) : null} unit="V" />
				<ValueCell label="Current" value={fmtSigned(a)} unit="A" />
				<ValueCell label="Power"   value={w != null ? w.toFixed(0) : null} unit="W" />
			</div>
		{:else if a != null || w != null}
			<div class="metrics cols2">
				<ValueCell label="Current" value={fmtSigned(a)} unit="A" />
				<ValueCell label="Power"   value={w != null ? w.toFixed(0) : null} unit="W" />
			</div>
		{/if}

		<!-- Time to go -->
		{#if ttgStr(ttg)}
			<div class="ttg">⏱ {ttgStr(ttg)} remaining</div>
		{/if}

		<!-- Secondary batteries -->
		{#if secondary.length > 0}
			<div class="divider"></div>
			{#each secondary as batt}
				{@const bsoc = socPct(batt.soc, true)}
				{@const bcol = socColor(bsoc)}
				<div class="sec-row">
					<span class="sec-name">{batt.name}</span>
					<div class="sec-right">
						{#if bsoc != null}
							<span class="sec-soc" style="color:{bcol}">{Math.round(bsoc!)}%</span>
							<div class="sec-bar-wrap">
								<div class="sec-bar" style="width:{bsoc}%; background:{bcol}"></div>
							</div>
						{/if}
						{#if batt.v != null}
							<span class="sec-v">{batt.v.toFixed(2)} V</span>
						{/if}
						{#if batt.a != null}
							<span class="sec-a" class:c-charge={batt.a > 0.5} class:c-discharge={batt.a < -0.5}>
								{batt.a >= 0 ? '+' : ''}{batt.a.toFixed(1)} A
							</span>
						{/if}
					</div>
				</div>
			{/each}
		{/if}
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
	.hint {
		font-size: 11px;
		color: var(--muted);
		opacity: 0.6;
	}

	.soc-row { margin-bottom: 12px; }
	.soc-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-bottom: 8px;
	}
	.soc-val {
		font-size: 36px;
		font-weight: 800;
		line-height: 1;
	}
	.batt-status {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.3px;
	}
	.soc-bar-wrap {
		height: 8px;
		background: var(--card2);
		border-radius: 4px;
		overflow: hidden;
	}
	.soc-bar {
		height: 100%;
		border-radius: 4px;
		transition: width 0.5s ease, background 0.3s;
	}

	.metrics { display: grid; gap: 8px; margin-top: 4px; }
	.cols3   { grid-template-columns: repeat(3, 1fr); }
	.cols2   { grid-template-columns: repeat(2, 1fr); }

	.ttg {
		font-size: 11px;
		color: var(--muted);
		margin-top: 8px;
	}

	.divider { height: 1px; background: var(--border); margin: 12px 0; }

	/* Secondary batteries */
	.sec-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 7px;
	}
	.sec-name {
		font-size: 12px;
		color: var(--muted);
		min-width: 90px;
		flex-shrink: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sec-right {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
	}
	.sec-soc {
		font-size: 12px;
		font-weight: 700;
		min-width: 34px;
		text-align: right;
		flex-shrink: 0;
	}
	.sec-bar-wrap {
		flex: 1;
		height: 5px;
		background: var(--card2);
		border-radius: 3px;
		overflow: hidden;
	}
	.sec-bar {
		height: 100%;
		border-radius: 3px;
		transition: width 0.5s ease;
	}
	.sec-v {
		font-size: 11px;
		color: var(--muted);
		flex-shrink: 0;
	}
	.sec-a {
		font-size: 11px;
		color: var(--muted);
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}
	.sec-a.c-charge    { color: var(--green); }
	.sec-a.c-discharge { color: var(--amber); }

	.no-data {
		font-size: 13px;
		color: var(--muted);
		text-align: center;
		padding: 12px 0 4px;
	}
</style>
