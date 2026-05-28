<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';
	import { k2c, fmtRuntime } from '$lib/utils/units.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();
</script>

<div class="card">
	<div class="title">Motor</div>
	<div class="grid">
		<ValueCell label="Drehzahl"   value={t?.eng_rpm != null ? t.eng_rpm.toFixed(0) : null} unit="RPM" />
		<ValueCell label="Kühlwasser" value={k2c(t?.eng_temp_k ?? null)} />
		<ValueCell label="Laufzeit"   value={fmtRuntime(t?.eng_run_sec ?? null)} />
		<ValueCell label="Lichtm."    value={t?.eng_alt_v != null ? t.eng_alt_v.toFixed(1) : null} unit="V" />
	</div>
</div>

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
	.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
</style>
