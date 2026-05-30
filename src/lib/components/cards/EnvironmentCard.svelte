<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';
	import { k2c, ms2kn, rad2degStr, fmtDepth, fmtPressure, pressureColor } from '$lib/utils/units.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const pressColor = $derived(pressureColor(t?.env_pressure_pa ?? null));
</script>

<div class="card">
	<div class="title">Environment</div>
	<div class="grid">
		<ValueCell label="Depth"    value={fmtDepth(t?.env_depth_m ?? null)} />
		<ValueCell label="AWS"      value={ms2kn(t?.env_aws_ms ?? null)} unit="kn" />
		<ValueCell label="AWA"      value={rad2degStr(t?.env_awa_rad ?? null)} />
		<ValueCell label="Pressure" value={fmtPressure(t?.env_pressure_pa ?? null)} color={pressColor} />
		<ValueCell label="Water"    value={k2c(t?.temp_water ?? null)} />
	</div>
</div>

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
	.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
	@media (max-width: 380px) { .grid { grid-template-columns: repeat(2, 1fr); } }
</style>
