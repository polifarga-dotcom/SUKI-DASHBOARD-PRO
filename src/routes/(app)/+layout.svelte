<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { telemetry, dataStale } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { authStore } from '$lib/stores/auth.js';
	import { dataAge, fmtLatLon, ms2knNum } from '$lib/utils/units.js';
	import StatusBar from '$lib/components/layout/StatusBar.svelte';

	let { children, data } = $props();

	const tabs = [
		{
			href: '/vessel', label: 'Vessel',
			icon: `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2" y="13" width="16" height="3" rx="1.5"/>
				<path d="M5 13 L10 3 L15 13"/>
				<line x1="10" y1="3" x2="10" y2="10"/>
			</svg>`
		},
		{
			href: '/anchor', label: 'Anker',
			icon: `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="10" cy="4.5" r="1.8"/>
				<line x1="10" y1="6.3" x2="10" y2="16"/>
				<line x1="5.5" y1="9.5" x2="14.5" y2="9.5"/>
				<path d="M5.5 16 a4.5 3.5 0 0 0 9 0"/>
			</svg>`
		},
		{
			href: '/settings', label: 'Settings',
			icon: `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
				<line x1="3" y1="6" x2="17" y2="6"/>
				<circle cx="7" cy="6" r="2" fill="var(--card)"/>
				<line x1="3" y1="14" x2="17" y2="14"/>
				<circle cx="13" cy="14" r="2" fill="var(--card)"/>
			</svg>`
		},
	];

	let pollTimer: ReturnType<typeof setInterval>;
	let clockTimer: ReturnType<typeof setInterval>;
	let clockStr = $state('--:--');

	function updateClock() {
		const now = new Date();
		const h = now.getUTCHours().toString().padStart(2, '0');
		const m = now.getUTCMinutes().toString().padStart(2, '0');
		clockStr = `${h}:${m} UTC`;
	}

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
		updateClock();
		fetchTelemetry();
		fetchAnchorConfig();
		pollTimer = setInterval(fetchTelemetry, 3000);
		clockTimer = setInterval(updateClock, 10000);
	});

	onDestroy(() => {
		clearInterval(pollTimer);
		clearInterval(clockTimer);
	});

	const currentPath = $derived(page.url.pathname);
	const t = $derived($telemetry);
	const stale = $derived($dataStale);

	const gpsStr = $derived(() => {
		if (!t?.nav_lat || !t?.nav_lon) return null;
		return fmtLatLon(t.nav_lat, t.nav_lon);
	});

	const sogKn = $derived(() => {
		if (t?.nav_sog_ms == null) return null;
		const kn = ms2knNum(t.nav_sog_ms);
		return kn.toFixed(1) + ' kn';
	});
</script>

<div class="app-shell">
	<!-- Header -->
	<header class="app-header">
		<div class="header-left">
			<img src="/logo.png" alt="SUKI" class="vessel-logo" />
			<span class="vessel-sub">Neel 47 · DD4704</span>
		</div>
		<div class="header-center">
			{#if gpsStr()}
				<span class="gps-val">{gpsStr()}</span>
			{/if}
			{#if sogKn()}
				<span class="sog-val">{sogKn()}</span>
			{/if}
		</div>
		<div class="header-right">
			<span class="clock">{clockStr}</span>
			<span class="conn-dot" class:stale title={stale ? 'Keine Daten' : 'Live'}></span>
		</div>
	</header>

	<!-- Tab navigation -->
	<nav class="tab-bar">
		{#each tabs as tab}
			<a
				href={tab.href}
				class="tab-item"
				class:active={currentPath.startsWith(tab.href)}
			>
				<span class="tab-icon">{@html tab.icon}</span>
			</a>
		{/each}
		<button class="tab-item tab-signout" onclick={signOut} title="Abmelden">
			<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M13 3h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3"/>
				<polyline points="9 14 13 10 9 6"/>
				<line x1="13" y1="10" x2="3" y2="10"/>
			</svg>
		</button>
	</nav>

	<!-- Status bar -->
	<StatusBar />

	<!-- Content -->
	<main class="content">
		{@render children()}
	</main>
</div>

<style>
	.app-shell {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	/* ── Header ── */
	.app-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		/* height grows to fit safe-area + content; never below --header-h */
		min-height: var(--header-h);
		height: auto;
		padding: calc(env(safe-area-inset-top) + 8px) 16px 8px;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		gap: 8px;
	}

	.header-left {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex-shrink: 0;
	}
	.vessel-logo {
		height: 24px;
		width: auto;
		display: block;
		align-self: flex-start;
		object-fit: contain;
		max-width: 160px;
	}
	.vessel-sub {
		font-size: 10px;
		color: var(--muted);
		letter-spacing: 0.5px;
	}

	.header-center {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
		overflow: hidden;
	}
	.gps-val {
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.sog-val {
		font-size: 11px;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
	}

	.header-right {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex-shrink: 0;
	}
	.clock {
		font-size: 11px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.conn-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--green);
		animation: pulse-live 2s ease-in-out infinite;
	}
	.conn-dot.stale {
		background: var(--amber);
		animation: none;
	}
	@keyframes pulse-live {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	/* ── Tab bar ── */
	.tab-bar {
		display: flex;
		background: var(--card);
		border-bottom: 1px solid var(--border);
		height: 48px;
		flex-shrink: 0;
	}

	.tab-item {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #555;
		transition: color 0.15s, background 0.15s;
		text-decoration: none;
		border-bottom: 2px solid transparent;
	}
	.tab-item.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
		background: rgba(0, 200, 255, 0.06);
	}
	.tab-item:hover:not(.active) { color: var(--text); }

	.tab-icon { display: flex; align-items: center; line-height: 0; }

	.tab-signout {
		flex: 0 0 48px;
	}
	.tab-signout:hover { color: var(--red); }

	/* ── Content ── */
	.content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 12px;
		padding-bottom: calc(12px + env(safe-area-inset-bottom));
	}
</style>
