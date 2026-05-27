<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import TankBar from '$lib/components/ui/TankBar.svelte';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();
</script>

<div class="card">
	<div class="title">Tanks</div>
	<div class="tanks">
		<TankBar label="Frischwasser" ratio={t?.tank_fw ?? null} warn={0.3} danger={0.15} />
		<TankBar label="Diesel" ratio={t?.tank_dsl ?? null} warn={0.25} danger={0.1} />
		<TankBar label="Schwarzwasser (Bug)" ratio={t?.tank_bwm ?? null} warn={0.7} danger={0.85} />
		<TankBar label="Schwarzwasser (Heck)" ratio={t?.tank_bwg ?? null} warn={0.7} danger={0.85} />
	</div>
</div>

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
	.tanks { display: flex; flex-direction: column; gap: 10px; }
</style>
