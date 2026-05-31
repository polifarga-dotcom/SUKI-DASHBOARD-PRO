<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import { fmtSOC, fmtV, fmtA, fmtW, socColor } from '$lib/utils/units.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	// ── House bank (SignalK instance 0) ──────────────────────────────────────────
	const soc = $derived(t?.batt_main_soc ?? null);
	const v   = $derived(t?.batt_main_v   ?? null);
	const a   = $derived(t?.batt_main_a   ?? null);
	const w   = $derived(t?.batt_main_w   ?? null);

	const hasSoc  = $derived(soc != null);
	const pctNum  = $derived(soc != null ? soc * 100 : 0);
	const color   = $derived(socColor(soc));

	// Primary display: SOC when available, voltage otherwise (common when no
	// battery monitor is configured in SignalK — e.g. engine-only alternator).
	const bigVal   = $derived(
		hasSoc          ? fmtSOC(soc)
		: v != null     ? v.toFixed(1) + ' V'
		: '—'
	);
	const bigColor = $derived(hasSoc ? color : 'var(--amber)');

	// Metrics row: show V/A/W when SOC is the big value;
	// show only A/W when voltage is already the big value.
	const hasMetrics = $derived(hasSoc || a != null || w != null);

	const fmtSigned = (x: number | null) =>
		x == null ? null : (x >= 0 ? '+' : '') + x.toFixed(1);

	// ── Second battery (SignalK instance 1) ───────────────────────────────────────
	// Filter out ghost/disconnected readings (< 1 V — occasional noise from
	// Victron when no sensor is attached to instance 1).
	const engV    = $derived(t?.batt_eng_v   ?? null);
	const engSoc  = $derived(t?.batt_eng_soc ?? null);
	const engA    = $derived(t?.batt_eng_a   ?? null);
	const showEng = $derived(engV != null && engV > 1);
</script>

<div class="card">
	<div class="card-head">
		<span class="title">Battery</span>
		{#if !hasSoc && v != null}
			<span class="hint">voltage only</span>
		{/if}
	</div>

	<!-- Primary value: SOC or voltage -->
	<div class="soc-row">
		<div class="soc-val" style="color:{bigColor}">{bigVal}</div>
		{#if hasSoc}
			<div class="soc-bar-wrap">
				<div class="soc-bar" style="width:{pctNum}%; background:{color}"></div>
			</div>
		{/if}
	</div>

	<!-- Metrics grid (adapts to available data) -->
	{#if hasMetrics}
		{#if hasSoc}
			<!-- Full row: V / A / W -->
			<div class="metrics cols3">
				<ValueCell label="Voltage" value={v != null ? v.toFixed(1) : null} unit="V" />
				<ValueCell label="Current" value={fmtSigned(a)} unit="A" />
				<ValueCell label="Power"   value={w != null ? w.toFixed(0) : null} unit="W" />
			</div>
		{:else}
			<!-- Voltage is the big value; show only A / W if present -->
			<div class="metrics cols2">
				<ValueCell label="Current" value={fmtSigned(a)} unit="A" />
				<ValueCell label="Power"   value={w != null ? w.toFixed(0) : null} unit="W" />
			</div>
		{/if}
	{/if}

	<!-- Second battery row (starter / engine bank) -->
	{#if showEng}
		<div class="divider"></div>
		<div class="eng-row">
			<span class="eng-label">Starter / Engine</span>
			<span class="eng-vals">
				{fmtV(engV)}{#if engSoc != null}&nbsp;·&nbsp;{fmtSOC(engSoc)}{/if}{#if engA != null}&nbsp;·&nbsp;{fmtSigned(engA)} A{/if}
			</span>
		</div>
	{/if}

	<!-- No data at all -->
	{#if v == null && soc == null}
		<div class="no-data">No battery data</div>
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
	.soc-val {
		font-size: 36px;
		font-weight: 800;
		line-height: 1;
		margin-bottom: 8px;
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

	.metrics { display: grid; gap: 8px; }
	.cols3   { grid-template-columns: repeat(3, 1fr); }
	.cols2   { grid-template-columns: repeat(2, 1fr); }

	.divider { height: 1px; background: var(--border); margin: 12px 0; }

	.eng-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 12px;
	}
	.eng-label { color: var(--muted); }
	.eng-vals  { color: var(--text); }

	.no-data {
		font-size: 13px;
		color: var(--muted);
		text-align: center;
		padding: 12px 0 4px;
	}
</style>
