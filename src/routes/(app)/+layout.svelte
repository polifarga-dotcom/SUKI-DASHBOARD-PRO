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
	import VRMFetcher from '$lib/services/VRMFetcher.svelte';
	import type { Boat } from '$lib/types.js';

	let { children, data } = $props();

	let isSuperAdmin = $state(false);

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

	// Generation counter — incremented on every boat switch.
	// Each in-flight fetchTelemetry captures its generation at call time and
	// silently discards the result if a newer generation has started.
	// This prevents a slow response for boat A from overwriting boat B's data.
	let fetchGen = 0;

	function updateClock() {
		const now = new Date();
		const h = now.getUTCHours().toString().padStart(2, '0');
		const m = now.getUTCMinutes().toString().padStart(2, '0');
		clockStr = `${h}:${m} UTC`;
	}

	// Counter to throttle anchor_config refresh (every ~30s, not every 3s)
	let _anchorPollCount = 0;

	async function fetchTelemetry() {
		const boat = $currentBoat;
		const gen  = fetchGen;                          // snapshot at call time
		if (!boat) { dataStale.set(true); return; }
		const { data: row, error } = await supabase
			.from('telemetry')
			.select('*')
			.eq('boat_id', boat.id)
			.single();
		if (gen !== fetchGen) return;                   // stale — boat switched mid-flight
		if (row && !error) {
			telemetry.set(row);
			dataStale.set(dataAge(row.updated_at));
		} else {
			dataStale.set(true);
		}

		// Refresh anchor_config every ~30 s (every 10th telemetry poll at 3s interval).
		// This ensures the logbook's checkAutoTrip() always sees a fresh `active` flag,
		// even when the user sets the anchor from a different device or tab.
		_anchorPollCount++;
		if (_anchorPollCount % 10 === 0) {
			fetchAnchorConfig(boat.id).catch(() => {});
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
		fetchGen++;                                     // invalidate any in-flight fetches
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

		// iOS PWA: JS timers are suspended in background, so autoRefreshToken may
		// miss its scheduled refresh. When the app comes back to the foreground,
		// proactively refresh the session so subsequent edge-function calls carry
		// a valid JWT instead of the expired one.
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) supabase.auth.refreshSession();
		});

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

	// Superadmin check via direct store subscription — most reliable approach.
	// authStore is populated by root layout's onAuthStateChange.
	onMount(() => {
		const unsub = authStore.subscribe(async (state) => {
			const uid = state.session?.user?.id;
			if (uid) {
				const { data: roleRow } = await supabase
					.from('user_roles')
					.select('is_superadmin')
					.eq('user_id', uid)
					.single();
				isSuperAdmin = roleRow?.is_superadmin === true;
			} else {
				isSuperAdmin = false;
			}
		});
		return unsub;
	});

	const currentPath = $derived(page.url.pathname);
	const t           = $derived($telemetry);

	// ── Telegram migration banner ────────────────────────────────────────────
	let showTgMigrationBanner = $state(false);
	let tgMigrationModal = $state(false);
	let tgMigrationDone = $state(false);

	$effect(() => {
		const cfg = $anchorConfig;
		const boatId = $currentBoat?.id;
		if (!cfg || !boatId) return;
		const sessionKey = `tg_migration_skipped_${boatId}`;
		const skippedThisSession = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(sessionKey) === '1';
		showTgMigrationBanner = !!(
			cfg.telegram_token &&
			cfg.telegram_migration_done !== true &&
			!skippedThisSession
		);
	});

	function skipTgMigration() {
		const boatId = $currentBoat?.id;
		if (boatId) sessionStorage.setItem(`tg_migration_skipped_${boatId}`, '1');
		showTgMigrationBanner = false;
	}

	async function completeTgMigration() {
		const boatId = $currentBoat?.id;
		if (!boatId) return;
		// Pre-register existing chat IDs as subscribers via app bot
		const cfg = $anchorConfig;
		if (cfg?.telegram_chat_ids && cfg?.telegram_token) {
			const ids = cfg.telegram_chat_ids.split(',').map((s: string) => s.trim()).filter(Boolean);
			for (const chatId of ids) {
				await supabase.from('telegram_subscribers').upsert({
					boat_id: boatId, chat_id: chatId, label: null,
				}, { onConflict: 'boat_id,chat_id' });
			}
		}
		// Mark migration done
		await supabase.from('anchor_config')
			.update({ telegram_migration_done: true })
			.eq('boat_id', boatId);
		anchorConfig.update(c => c ? { ...c, telegram_migration_done: true } : c);
		tgMigrationDone = true;
		setTimeout(() => {
			showTgMigrationBanner = false;
			tgMigrationModal = false;
			tgMigrationDone = false;
		}, 3000);
	}
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

<VRMFetcher />

<div class="app-shell">
	<!-- Header -->
	<header class="app-header">
		<div class="header-left">
			<button class="boat-btn" onclick={() => (boatPickerOpen = !boatPickerOpen)}>
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
			{#if isSuperAdmin}
			<a href="/admin" class="admin-btn" class:active={currentPath.startsWith('/admin')} title="Admin">
				<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="7" cy="6" r="2.2"/>
					<path d="M2 16.5c0-2.8 2-4.5 5-4.5s5 1.7 5 4.5"/>
					<circle cx="15" cy="7.5" r="1.8"/>
					<path d="M13 16.5c0-1.8 .8-3 2-3.5"/>
				</svg>
				<span class="admin-label">Admin</span>
			</a>
			{/if}
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

	<!-- ── Telegram migration banner ── -->
	{#if showTgMigrationBanner}
	<div class="tg-banner">
		<span class="tg-banner-text">⚡ SUKI now uses a shared Telegram bot — no more manual token setup.</span>
		<div class="tg-banner-actions">
			<button class="tg-banner-btn primary" onclick={() => { tgMigrationModal = true; }}>Migrate now</button>
			<button class="tg-banner-btn ghost" onclick={skipTgMigration}>Skip</button>
		</div>
	</div>
	{/if}

	<!-- ── Migration modal ── -->
	{#if tgMigrationModal}
	<div class="tg-modal-overlay" onclick={() => { tgMigrationModal = false; }}>
		<div class="tg-modal" onclick={(e) => e.stopPropagation()}>
			{#if tgMigrationDone}
				<div class="tg-modal-done">✅ Migration complete! You can remove the old bot token in Settings.</div>
			{:else}
				<h3>Switch to @SukiProBot</h3>
				<p class="tg-modal-desc">
					Your existing subscribers will be pre-registered automatically.
					Each person needs to tap the link once to activate the new bot.
				</p>
				{#if $anchorConfig?.plugin_api_key}
				<a class="btn btn-primary tg-modal-link"
					href="https://t.me/SukiProBot?start={$anchorConfig.plugin_api_key}"
					target="_blank" rel="noopener">
					Open @SukiProBot in Telegram
				</a>
				{/if}
				<div class="tg-modal-footer">
					<button class="btn btn-primary" onclick={completeTgMigration}>Done — mark as migrated</button>
					<button class="btn btn-ghost" onclick={() => { tgMigrationModal = false; skipTgMigration(); }}>Skip for now</button>
				</div>
			{/if}
		</div>
	</div>
	{/if}
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
	.header-right { display: flex; flex-direction: row; align-items: center; gap: 10px; flex-shrink: 0; }
	.admin-btn {
		display: flex; align-items: center;
		color: #444; text-decoration: none;
		opacity: 0.5; transition: opacity 0.15s, color 0.15s;
	}
	.admin-btn:hover, .admin-btn.active { opacity: 1; color: var(--accent); }
	.admin-label { display: none; }
	.clock { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
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

	/* ── Telegram migration banner ── */
	.tg-banner {
		position: fixed; bottom: 56px; left: 0; right: 0; z-index: 900;
		background: linear-gradient(135deg, #1a2a3a, #0d1f2d);
		border-top: 1px solid rgba(0,200,255,0.3);
		padding: 10px 14px; display: flex; align-items: center;
		gap: 10px; flex-wrap: wrap;
		box-shadow: 0 -2px 12px rgba(0,0,0,0.4);
	}
	.tg-banner-text { flex: 1; font-size: 12px; color: var(--text); line-height: 1.4; }
	.tg-banner-actions { display: flex; gap: 6px; flex-shrink: 0; }
	.tg-banner-btn {
		padding: 5px 12px; border-radius: 8px; border: none; cursor: pointer;
		font-size: 12px; font-weight: 500;
	}
	.tg-banner-btn.primary { background: var(--accent, #00c8ff); color: #000; }
	.tg-banner-btn.ghost { background: rgba(255,255,255,0.1); color: var(--text); }

	/* ── Telegram migration modal ── */
	.tg-modal-overlay {
		position: fixed; inset: 0; z-index: 1000;
		background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
		padding: 20px;
	}
	.tg-modal {
		background: var(--card); border: 1px solid var(--border); border-radius: 16px;
		padding: 24px; max-width: 360px; width: 100%;
	}
	.tg-modal h3 { font-size: 16px; font-weight: 600; margin: 0 0 10px; }
	.tg-modal-desc { font-size: 13px; color: var(--muted); margin: 0 0 16px; line-height: 1.5; }
	.tg-modal-link { display: block; text-align: center; text-decoration: none; margin-bottom: 16px; font-size: 13px; }
	.tg-modal-footer { display: flex; flex-direction: column; gap: 8px; }
	.tg-modal-footer .btn { font-size: 13px; }
	.tg-modal-done { font-size: 14px; color: #4caf50; text-align: center; padding: 12px 0; }
</style>
