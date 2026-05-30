<script lang="ts">
	import { telemetry, dataStale } from '$lib/stores/telemetry.js';
	import BatteryCard from '$lib/components/cards/BatteryCard.svelte';
	import SolarCard from '$lib/components/cards/SolarCard.svelte';
	import EnvironmentCard from '$lib/components/cards/EnvironmentCard.svelte';
	import EngineCard from '$lib/components/cards/EngineCard.svelte';
	import RigCard from '$lib/components/cards/RigCard.svelte';
	import ShellyCard from '$lib/components/cards/ShellyCard.svelte';
	import VRMCard from '$lib/components/cards/VRMCard.svelte';
	import InReachCard from '$lib/components/cards/InReachCard.svelte';
</script>

<svelte:head><title>Vessel · SUKI PRO</title></svelte:head>

{#if $dataStale}
	<div class="stale-banner">No live data available</div>
{/if}

<div class="grid">
	<BatteryCard t={$telemetry} />
	<SolarCard t={$telemetry} />
	<EnvironmentCard t={$telemetry} />
	<EngineCard t={$telemetry} />
	<RigCard t={$telemetry} />
	<ShellyCard />
	<VRMCard />
	<div class="inreach-wrap"><InReachCard /></div>
</div>

<style>
	.stale-banner {
		background: #1a0a0a;
		border: 1px solid var(--amber);
		color: var(--amber);
		border-radius: 8px;
		padding: 8px 12px;
		font-size: 12px;
		text-align: center;
		margin-bottom: 12px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 12px;
	}

	/* InReach card spans full width (has a map inside) */
	.inreach-wrap { grid-column: 1 / -1; }

	@media (max-width: 480px) {
		.grid { grid-template-columns: 1fr; }
	}
</style>
