<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import { fmtSOC, fmtV, fmtA, fmtW, socColor } from '$lib/utils/units.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const soc     = $derived(t?.batt_main_soc ?? null);
	const pctNum  = $derived(soc == null ? 0 : soc * 100);
	const color   = $derived(socColor(soc));
</script>

<div class="card">
	<div class="card-head">
		<span class="title">Battery</span>
		<span class="mode">{t?.batt_main_mode ?? '—'}</span>
	</div>

	<div class="soc-row">
		<div class="soc-val" style="color:{color}">{fmtSOC(soc)}</div>
		<div class="soc-bar-wrap">
			<div class="soc-bar" style="width:{pctNum}%; background:{color}"></div>
		</div>
	</div>

	<div class="metrics">
		<ValueCell label="Voltage"    value={t?.batt_main_v != null ? t.batt_main_v.toFixed(1) : null} unit="V" />
		<ValueCell label="Current"       value={t?.batt_main_a != null ? (t.batt_main_a >= 0 ? '+' : '') + t.batt_main_a.toFixed(1) : null} unit="A" />
		<ValueCell label="Power"    value={t?.batt_main_w != null ? t.batt_main_w.toFixed(0) : null} unit="W" />
	</div>

	<div class="divider"></div>

	<div class="eng-row">
		<span class="eng-label">Starter battery</span>
		<span class="eng-vals">
			{fmtV(t?.batt_eng_v ?? null)} ·
			{fmtSOC(t?.batt_eng_soc ?? null)}
		</span>
	</div>
</div>

<style>
	.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.mode { font-size: 12px; color: var(--accent); }

	.soc-row { margin-bottom: 12px; }
	.soc-val { font-size: 36px; font-weight: 800; line-height: 1; margin-bottom: 8px; }
	.soc-bar-wrap { height: 8px; background: var(--card2); border-radius: 4px; overflow: hidden; }
	.soc-bar { height: 100%; border-radius: 4px; transition: width 0.5s ease, background 0.3s; }

	.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
	.divider { height: 1px; background: var(--border); margin: 12px 0; }

	.eng-row { display: flex; justify-content: space-between; font-size: 12px; }
	.eng-label { color: var(--muted); }
	.eng-vals { color: var(--text); }
</style>
