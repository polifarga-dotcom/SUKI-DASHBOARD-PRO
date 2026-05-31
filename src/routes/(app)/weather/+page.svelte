<script lang="ts">
	import WeatherCard from '$lib/components/cards/WeatherCard.svelte';
	import InReachCard from '$lib/components/cards/InReachCard.svelte';
</script>

<svelte:head><title>Weather · SUKI PRO</title></svelte:head>

<div class="grid">
	<WeatherCard />
	<div class="inreach-wrap"><InReachCard /></div>
</div>

<style>
	.grid {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* InReach map spans full width */
	.inreach-wrap { width: 100%; }
</style>
