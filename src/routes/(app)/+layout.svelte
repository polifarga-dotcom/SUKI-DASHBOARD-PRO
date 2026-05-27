<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { telemetry, dataStale } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { authStore } from '$lib/stores/auth.js';
	import { dataAge } from '$lib/utils/units.js';
	import StatusBar from '$lib/components/layout/StatusBar.svelte';

	let { children, data } = $props();

	const tabs = [
		{ href: '/vessel', label: 'Vessel' },
		{ href: '/anchor', label: 'Anker' },
		{ href: '/settings', label: 'Settings' }
	];

	let pollTimer: ReturnType<typeof setInterval>;

	async function fetchTelemetry() {
		const { data: row, error } = await supabase
			.from('telemetry')
			.select('*')
			.eq('id', 1)
			.single();
		if (row && !error) {
			telemetry.set(row);
			dataStale.set(dataAge(row.updated_at));
		} else {
			dataStale.set(true);
		}
	}

	async function fetchAnchorConfig() {
		const { data: row } = await supabase
			.from('anchor_config')
			.select('*')
			.eq('id', 1)
			.single();
		if (row) anchorConfig.set(row);
	}

	async function signOut() {
		await supabase.auth.signOut();
		authStore.clear();
		goto('/login');
	}

	onMount(() => {
		fetchTelemetry();
		fetchAnchorConfig();
		pollTimer = setInterval(fetchTelemetry, 3000);
	});

	onDestroy(() => clearInterval(pollTimer));

	const currentPath = $derived(page.url.pathname);
</script>

<div class="app-shell">
	<StatusBar />

	<main class="content">
		{@render children()}
	</main>

	<nav class="tab-bar">
		{#each tabs as tab}
			<a
				href={tab.href}
				class="tab-item"
				class:active={currentPath.startsWith(tab.href)}
			>
				{tab.label}
			</a>
		{/each}
		<button class="tab-item tab-signout" onclick={signOut} title="Abmelden">⏻</button>
	</nav>
</div>

<style>
	.app-shell {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	.content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 12px;
		padding-bottom: calc(12px + env(safe-area-inset-bottom));
	}

	.tab-bar {
		display: flex;
		background: var(--card);
		border-top: 1px solid var(--border);
		height: var(--tab-h);
		padding-bottom: env(safe-area-inset-bottom);
		flex-shrink: 0;
	}

	.tab-item {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
		transition: color 0.15s;
		text-decoration: none;
	}

	.tab-item.active { color: var(--accent); }
	.tab-item:hover { color: var(--text); }

	.tab-signout {
		max-width: 48px;
		font-size: 16px;
		color: var(--muted);
	}
	.tab-signout:hover { color: var(--red); }
</style>
