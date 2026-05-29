<script lang="ts">
	import { telemetry, dataStale } from '$lib/stores/telemetry.js';
	import BatteryCard from '$lib/components/cards/BatteryCard.svelte';
	import SolarCard from '$lib/components/cards/SolarCard.svelte';
	import TanksCard from '$lib/components/cards/TanksCard.svelte';
	import EnvironmentCard from '$lib/components/cards/EnvironmentCard.svelte';
	import EngineCard from '$lib/components/cards/EngineCard.svelte';
	import RigCard from '$lib/components/cards/RigCard.svelte';
	import RelayCard from '$lib/components/cards/RelayCard.svelte';
	import ShellyCard from '$lib/components/cards/ShellyCard.svelte';
</script>

<svelte:head><title>Vessel · SUKI PRO</title></svelte:head>

{#if $dataStale}
	<div class="stale-banner">Keine aktuellen Daten — Cerbo offline oder nicht erreichbar</div>
{/if}

<div class="grid">
	<BatteryCard t={$telemetry} />
	<SolarCard t={$telemetry} />
	<TanksCard t={$telemetry} />
	<EnvironmentCard t={$telemetry} />
	<EngineCard t={$telemetry} />
	<RigCard t={$telemetry} />
	<RelayCard t={$telemetry} />
	<ShellyCard />
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

	@media (max-width: 480px) {
		.grid { grid-template-columns: 1fr; }
	}
</style>
