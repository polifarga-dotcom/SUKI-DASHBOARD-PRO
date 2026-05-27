<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';
	import { k2c, fmtRuntime, rigColor } from '$lib/utils/units.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const rigMax = $derived(() => {
		const p = t?.rig_port ?? null;
		const s = t?.rig_sb ?? null;
		if (p == null && s == null) return null;
		return Math.max(p ?? 0, s ?? 0);
	});
	const rc = $derived(rigColor(rigMax()));
</script>

<div class="card">
	<div class="title">Motor &amp; Rigg</div>
	<div class="grid">
		<ValueCell label="Drehzahl"   value={t?.eng_rpm != null ? t.eng_rpm.toFixed(0) : null} unit="RPM" />
		<ValueCell label="Kühlwasser" value={k2c(t?.eng_temp_k ?? null)} />
		<ValueCell label="Laufzeit"   value={fmtRuntime(t?.eng_run_sec ?? null)} />
		<ValueCell label="Lichtm."    value={t?.eng_alt_v != null ? t.eng_alt_v.toFixed(1) : null} unit="V" />
		<ValueCell label="Rigg BB"    value={t?.rig_port != null ? (t.rig_port / 9806.65).toFixed(2) : null} unit="t" color={rc} />
		<ValueCell label="Rigg SB"    value={t?.rig_sb != null ? (t.rig_sb / 9806.65).toFixed(2) : null} unit="t" color={rc} />
	</div>
</div>

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
	.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
</style>
