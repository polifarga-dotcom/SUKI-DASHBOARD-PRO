<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { telemetry, dataStale } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { authStore } from '$lib/stores/auth.js';
	import { myBoats, currentBoat, boatRole, boatRoles } from '$lib/stores/boat.js';
	import { dataAge, fmtLatLon, ms2knNum } from '$lib/utils/units.js';
	import StatusBar from '$lib/components/layout/StatusBar.svelte';
	import type { Boat } from '$lib/types.js';

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
			href: '/anchor', label: 'Anchor',
			icon: `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="10" cy="4.5" r="1.8"/>
				<line x1="10" y1="6.3" x2="10" y2="16"/>
				<line x1="5.5" y1="9.5" x2="14.5" y2="9.5"/>
				<path d="M5.5 16 a4.5 3.5 0 0 0 9 0"/>
			</svg>`
		},
		{
			href: '/weather', label: 'Weather',
			icon: `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="8" cy="7" r="2.8"/>
				<line x1="8" y1="1.5" x2="8" y2="3"/>
				<line x1="8" y1="11" x2="8" y2="12.5"/>
				<line x1="2.5" y1="3.5" x2="3.5" y2="4.5"/>
				<line x1="12.5" y1="3.5" x2="13.5" y2="4.5"/>
				<line x1="1.5" y1="7" x2="3" y2="7"/>
				<line x1="13" y1="7" x2="14.5" y2="7"/>
				<path d="M8 12.5 Q9 10.5 11 11 Q11.5 9 13.5 9.5 Q15.5 9.5 15.5 11.5 Q17 11.5 17.5 13 Q18 14.5 16.5 15 H7 Q5.5 14.5 8 12.5Z"/>
			</svg>`
		},
		{
			href: '/logbook', label: 'Log',
			icon: `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<rect x="4" y="2" width="12" height="16" rx="1.5"/>
				<line x1="7" y1="6" x2="13" y2="6"/>
				<line x1="7" y1="9" x2="13" y2="9"/>
				<line x1="7" y1="12" x2="10" y2="12"/>
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

	let pollTimer:  ReturnType<typeof setInterval>;
	let clockTimer: ReturnType<typeof setInterval>;
	let clockStr       = $state('--:--');
	let boatPickerOpen = $state(false);

	function updateClock() {
		const now = new Date();
		const h = now.getUTCHours().toString().padStart(2, '0');
		const m = now.getUTCMinutes().toString().padStart(2, '0');
		clockStr = `${h}:${m} UTC`;
	}

	async function fetchTelemetry() {
		const boat = $currentBoat;
		if (!boat) { dataStale.set(true); return; }
		const { data: row, error } = await supabase
			.from('telemetry')
			.select('*')
			.eq('boat_id', boat.id)
			.single();
		if (row && !error) {
			telemetry.set(row);
			dataStale.set(dataAge(row.updated_at));
		} else {
			dataStale.set(true);
		}
	}

	async function fetchAnchorConfig(boatId: string) {
		const { data: row } = await supabase
			.from('anchor_config')
			.select('*')
			.eq('boat_id', boatId)
			.single();
		if (row) anchorConfig.set(row);
	}

	async function switchBoat(boat: Boat) {
		currentBoat.set(boat);
		localStorage.setItem('currentBoatId', boat.id);
		boatPickerOpen = false;
		anchorConfig.set(null);
		telemetry.set(null);
		dataStale.set(true);
		await fetchAnchorConfig(boat.id);
		await fetchTelemetry();
		// Update role for the new boat
		const m = (data.memberships as unknown as { role: string; boats: { id: string } | null }[])
			.find(m => m.boats?.id === boat.id);
		boatRole.set((m?.role as 'admin' | 'viewer') ?? 'viewer');
	}

	async function signOut() {
		await supabase.auth.signOut();
		authStore.clear();
		goto('/login');
	}

	onMount(() => {
		updateClock();

		// Populate stores from load() data (already authenticated + boats loaded)
		const memberships = data.memberships as unknown as { role: string; boats: Boat | null }[];
		const boats = memberships.map(m => m.boats).filter(Boolean) as Boat[];
		myBoats.set(boats);

		// Build role map for every boat
		const roleMap: Record<string, 'admin' | 'viewer'> = {};
		for (const m of memberships) {
			if (m.boats?.id) roleMap[m.boats.id] = m.role as 'admin' | 'viewer';
		}
		boatRoles.set(roleMap);

		// Restore last active boat from localStorage or default to first
		const savedId = typeof localStorage !== 'undefined' ? localStorage.getItem('currentBoatId') : null;
		const active  = boats.find(b => b.id === savedId) ?? boats[0];

		if (active) {
			currentBoat.set(active);
			const m = memberships.find(m => m.boats?.id === active.id);
			boatRole.set((m?.role as 'admin' | 'viewer') ?? 'viewer');
			fetchAnchorConfig(active.id);
		}

		fetchTelemetry();
		pollTimer  = setInterval(fetchTelemetry, 3000);
		clockTimer = setInterval(updateClock, 10000);
	});

	onDestroy(() => {
		clearInterval(pollTimer);
		clearInterval(clockTimer);
	});

	const currentPath = $derived(page.url.pathname);
	const t           = $derived($telemetry);
	const stale       = $derived($dataStale);
	const boats       = $derived($myBoats);
	const activeBoat  = $derived($currentBoat);
	const roles       = $derived($boatRoles);

	const gpsStr = $derived(() => {
		if (!t?.nav_lat || !t?.nav_lon) return null;
		return fmtLatLon(t.nav_lat, t.nav_lon);
	});

	const sogKn = $derived(() => {
		if (t?.nav_sog_ms == null) return null;
		const kn = ms2knNum(t.nav_sog_ms);
		if (kn == null) return null;
		return kn.toFixed(1) + ' kn';
	});
</script>

<div class="app-shell">
	<!-- Header -->
	<header class="app-header">
		<div class="header-left">
			<button class="boat-btn" onclick={() => (boatPickerOpen = !boatPickerOpen)}>
				<img src="/logo.png" alt="logo" class="vessel-logo-sm" />
				<div class="boat-btn-text">
					<span class="boat-name">{activeBoat?.name ?? '—'}</span>
					<span class="boat-role-tag" class:master={roles[activeBoat?.id ?? ''] === 'admin'}>
						{roles[activeBoat?.id ?? ''] === 'admin' ? 'master' : 'crew'}
					</span>
				</div>
				<svg width="10" height="10" viewBox="0 0 10 10" class:open={boatPickerOpen}>
					<path d="M1 3 L5 7 L9 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
				</svg>
			</button>
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
			<span class="conn-dot" class:stale title={stale ? 'No data' : 'Live'}></span>
		</div>

		<!-- Boat picker — inside header so position:absolute top:100% anchors correctly -->
		{#if boatPickerOpen}
		<div class="boat-picker">
			{#each boats as boat (boat.id)}
			<button
				class="boat-picker-item"
				class:active={boat.id === activeBoat?.id}
				onclick={() => switchBoat(boat)}
			>
				<span class="picker-name">{boat.name}</span>
				<div class="picker-right">
					<span class="picker-role" class:master={roles[boat.id] === 'admin'}>
						{roles[boat.id] === 'admin' ? 'master' : 'crew'}
					</span>
					{#if boat.id === activeBoat?.id}<span class="check">✓</span>{/if}
				</div>
			</button>
			{/each}
			<div class="picker-divider"></div>
			<button class="boat-picker-add" onclick={() => { boatPickerOpen = false; goto('/onboarding'); }}>
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
					<line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/>
				</svg>
				Add boat
			</button>
		</div>
		{/if}
	</header>

	<!-- Tab navigation -->
	<nav class="tab-bar">
		{#each tabs as tab (tab.href)}
			<a
				href={tab.href}
				class="tab-item"
				class:active={currentPath.startsWith(tab.href)}
			>
				<span class="tab-icon">{@html tab.icon}</span>
			</a>
		{/each}
		<button class="tab-item tab-signout" onclick={signOut} title="Sign out">
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
	.app-shell { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }

	/* ── Header ── */
	.app-header {
		display: flex; align-items: center; justify-content: space-between;
		min-height: var(--header-h); height: auto;
		padding: calc(env(safe-area-inset-top) + 8px) 16px 8px;
		background: var(--bg); border-bottom: 1px solid var(--border);
		flex-shrink: 0; gap: 8px; position: relative;
	}
	.header-left { display: flex; flex-direction: column; gap: 1px; flex-shrink: 0; }

	/* Boat switcher */
	.boat-btn {
		display: flex; align-items: center; gap: 7px;
		background: none; border: 1px solid var(--border); border-radius: 8px;
		padding: 5px 8px 5px 6px; cursor: pointer; color: var(--text);
	}
	.boat-btn:hover { background: var(--card2); }
	.vessel-logo-sm { height: 20px; width: auto; display: block; object-fit: contain; max-width: 80px; flex-shrink: 0; }
	.boat-btn-text { display: flex; flex-direction: column; gap: 1px; align-items: flex-start; }
	.boat-name { font-size: 13px; font-weight: 600; line-height: 1.1; white-space: nowrap; }
	.boat-role-tag {
		font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
		color: var(--muted); line-height: 1;
	}
	.boat-role-tag.master { color: var(--accent); }
	svg.open { transform: rotate(180deg); }

	/* Boat picker dropdown */
	.boat-picker {
		position: absolute; top: 100%; left: 12px;
		background: var(--card); border: 1px solid var(--border); border-radius: 10px;
		z-index: 200; box-shadow: 0 4px 20px rgba(0,0,0,0.5); min-width: 190px; overflow: hidden;
	}
	.boat-picker-item {
		display: flex; justify-content: space-between; align-items: center;
		width: 100%; padding: 11px 14px; background: none; border: none;
		color: var(--text); font-size: 14px; cursor: pointer; text-align: left; gap: 8px;
	}
	.boat-picker-item:hover { background: var(--card2); }
	.boat-picker-item.active .picker-name { color: var(--accent); }
	.picker-name { flex: 1; font-weight: 500; }
	.picker-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
	.picker-role {
		font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
		color: var(--muted); background: var(--card2); border: 1px solid var(--border);
		border-radius: 3px; padding: 2px 5px;
	}
	.picker-role.master { color: var(--accent); border-color: rgba(0,200,255,.3); background: rgba(0,200,255,.07); }
	.check { color: var(--accent); font-size: 12px; }
	.picker-divider { height: 1px; background: var(--border); margin: 2px 0; }
	.boat-picker-add {
		display: flex; align-items: center; gap: 8px;
		width: 100%; padding: 10px 14px; background: none; border: none;
		color: var(--muted); font-size: 13px; cursor: pointer; text-align: left;
	}
	.boat-picker-add:hover { color: var(--text); background: var(--card2); }

	.header-center {
		flex: 1; display: flex; flex-direction: column; align-items: center;
		gap: 1px; overflow: hidden;
	}
	.gps-val { font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
	.sog-val { font-size: 11px; color: var(--accent); font-variant-numeric: tabular-nums; }
	.header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
	.clock { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
	.conn-dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: var(--green); animation: pulse-live 2s ease-in-out infinite;
	}
	.conn-dot.stale { background: var(--amber); animation: none; }
	@keyframes pulse-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

	/* ── Tab bar ── */
	.tab-bar {
		display: flex; background: var(--card);
		border-bottom: 1px solid var(--border); height: 48px; flex-shrink: 0;
	}
	.tab-item {
		flex: 1; display: flex; align-items: center; justify-content: center;
		color: #555; transition: color 0.15s, background 0.15s;
		text-decoration: none; border-bottom: 2px solid transparent;
	}
	.tab-item.active {
		color: var(--accent); border-bottom-color: var(--accent);
		background: rgba(0, 200, 255, 0.06);
	}
	.tab-item:hover:not(.active) { color: var(--text); }
	.tab-icon { display: flex; align-items: center; line-height: 0; }
	.tab-signout { flex: 0 0 48px; }
	.tab-signout:hover { color: var(--red); }

	/* ── Content ── */
	.content {
		flex: 1; overflow-y: auto; overflow-x: hidden;
		padding: 12px;
		padding-bottom: calc(12px + env(safe-area-inset-bottom));
	}
</style>
