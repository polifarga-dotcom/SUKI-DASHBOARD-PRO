<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';
	import { k2c, ms2kn, rad2degStr, fmtDepth, fmtPressure, pressureColor } from '$lib/utils/units.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const pressColor = $derived(pressureColor(t?.env_pressure_pa ?? null));
</script>

<div class="card">
	<div class="title">Umgebung &amp; Navigation</div>
	<div class="grid">
		<ValueCell label="Tiefe"       value={fmtDepth(t?.env_depth_m ?? null)} />
		<ValueCell label="AWS"         value={ms2kn(t?.env_aws_ms ?? null)} unit="kn" />
		<ValueCell label="AWA"         value={rad2degStr(t?.env_awa_rad ?? null)} />
		<ValueCell label="Druck"       value={fmtPressure(t?.env_pressure_pa ?? null)} color={pressColor} />
		<ValueCell label="Salon"       value={k2c(t?.temp_salon ?? null)} />
		<ValueCell label="Kühlschrank" value={k2c(t?.temp_fridge ?? null)} />
		<ValueCell label="Technik"     value={k2c(t?.temp_tech ?? null)} />
		<ValueCell label="Wasser"      value={k2c(t?.temp_water ?? null)} />
		<ValueCell label="AMA SB"      value={k2c(t?.temp_amasb ?? null)} />
		<ValueCell label="AMA BB"      value={k2c(t?.temp_amabb ?? null)} />
	</div>
</div>

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
	.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
	@media (max-width: 380px) { .grid { grid-template-columns: repeat(2, 1fr); } }
</style>
