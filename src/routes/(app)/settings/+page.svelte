<script lang="ts">
	import { goto } from '$app/navigation';
	import { version } from '$app/environment';
	import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { currentBoat, isBoatAdmin, boatRole } from '$lib/stores/boat.js';

	// ── Auth ──────────────────────────────────────────────────────────────────
	const userEmail    = $derived($authStore.session?.user?.email ?? '—');
	const currentUid   = $derived($authStore.session?.user?.id ?? '');
	const userRole     = $derived($boatRole ?? '—');
	const isAdmin      = $derived($isBoatAdmin);
	const isSuperAdmin = $derived(userEmail === 'polifarga@gmail.com');
	const cfg        = $derived($anchorConfig);

	// ── User management (admin only) ──────────────────────────────────────────
	interface AppUser {
		id: string;
		email: string;
		role: 'admin' | 'viewer' | null;
		force_password_change: boolean;
		last_sign_in_at: string | null;
		created_at: string;
	}

	let users        = $state<AppUser[]>([]);
	let usersLoading = $state(false);
	let usersError   = $state('');
	let addEmail     = $state('');
	let addRole      = $state<'viewer' | 'admin'>('viewer');
	let addLoading          = $state(false);
	let addError            = $state('');
	let addSuccess          = $state(false);
	let addSuccessEmailSent = $state(true);
	let deleteTarget = $state<AppUser | null>(null);
	let actionBusy   = $state<string>('');

	async function loadUsers() {
		const boatId = $currentBoat?.id;
		if (!boatId) return;
		usersLoading = true;
		usersError = '';
		const { data: result, error } = await supabase.functions.invoke('manage-users', {
			method: 'GET',
			headers: { 'x-boat-id': boatId },
		});
		usersLoading = false;
		if (error || result?.error) {
			usersError = result?.error ?? error?.message ?? 'Failed to load';
			return;
		}
		users = result as AppUser[];
	}

	async function addUser() {
		addError = '';
		addSuccess = false;
		if (!addEmail) { addError = 'Email required'; return; }
		addLoading = true;
		const appUrl = window.location.hostname === 'localhost'
			? 'https://suki-dashboard-pro.pages.dev'
			: window.location.origin;
		const { data: result, error } = await supabase.functions.invoke('manage-users', {
			method: 'POST',
			body: { email: addEmail, role: addRole, boat_id: $currentBoat?.id, redirectTo: appUrl },
		});
		addLoading = false;
		if (error || result?.error) { addError = result?.error ?? error?.message ?? 'Error'; return; }
		addEmail = ''; addRole = 'viewer';
		addSuccess = true;
		addSuccessEmailSent = result?.emailSent ?? true;
		setTimeout(() => { addSuccess = false; }, 5000);
		await loadUsers();
	}

	async function setUserRole(userId: string, newRole: 'admin' | 'viewer') {
		actionBusy = userId;
		await supabase.functions.invoke('manage-users', {
			method: 'PATCH',
			body: { userId, role: newRole, boat_id: $currentBoat?.id },
		});
		actionBusy = '';
		await loadUsers();
	}

	async function resetUserPw(userId: string) {
		actionBusy = userId + '_pw';
		await supabase.functions.invoke('manage-users', {
			method: 'PATCH',
			body: { userId, force_password_change: true },
		});
		actionBusy = '';
		await loadUsers();
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		actionBusy = deleteTarget.id + '_del';
		await supabase.functions.invoke('manage-users', {
			method: 'DELETE',
			body: { userId: deleteTarget.id, boat_id: $currentBoat?.id },
		});
		deleteTarget = null;
		actionBusy = '';
		await loadUsers();
	}

	function fmtDate(iso: string | null): string {
		if (!iso) return 'Never';
		return new Date(iso).toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: '2-digit' });
	}

	// ── Notification settings ─────────────────────────────────────────────────
	let notifSaving = $state(false);
	let notifSaved  = $state(false);

	type TestState = 'idle' | 'sending' | 'ok' | 'err';
	let tgTest = $state<TestState>('idle');
	let poTest = $state<TestState>('idle');

	let tgToken    = $state('');
	let tgChats    = $state('');
	let poToken    = $state('');
	let poKeys     = $state('');
	let alarmDelay = $state(10);

	// ── Shelly Cloud ─────────────────────────────────────────────────────────
	let shellyServer  = $state('');
	let shellyKey     = $state('');
	let shellySaving  = $state(false);
	let shellySaved   = $state(false);
	let shellyTest    = $state<TestState>('idle');
	let shellyTestMsg = $state('');

	// ── Victron VRM ───────────────────────────────────────────────────────────
	let vrmToken          = $state('');
	let vrmInstallationId = $state('');
	let vrmSaving         = $state(false);
	let vrmSaved          = $state(false);
	let vrmTest           = $state<TestState>('idle');
	let vrmTestMsg        = $state('');
	interface VRMInstallation { idSite: number; name: string; }
	let vrmInstallations  = $state<VRMInstallation[]>([]);
	let vrmDiscovering    = $state(false);

	// ── Garmin InReach ────────────────────────────────────────────────────────
	let inreachId       = $state('');
	let inreachPassword = $state('');
	let inreachSaving   = $state(false);
	let inreachSaved    = $state(false);
	let inreachTest     = $state<TestState>('idle');
	let inreachTestMsg  = $state('');

	$effect(() => {
		if (cfg) {
			tgToken    = cfg.telegram_token        ?? '';
			tgChats    = cfg.telegram_chat_ids     ?? '';
			poToken    = cfg.pushover_app_token    ?? '';
			poKeys     = cfg.pushover_user_keys    ?? '';
			alarmDelay = cfg.alarm_delay_s         ?? 10;
			shellyServer      = cfg.shelly_cloud_server    ?? '';
			shellyKey         = cfg.shelly_cloud_auth_key  ?? '';
			vrmToken          = cfg.vrm_api_token           ?? '';
			vrmInstallationId = cfg.vrm_installation_id != null ? String(cfg.vrm_installation_id) : '';
			inreachId         = cfg.inreach_mapshare_id       ?? '';
			inreachPassword   = cfg.inreach_mapshare_password ?? '';
		}
	});

	// Load crew list whenever admin access is confirmed
	$effect(() => {
		if (isAdmin) loadUsers();
	});

	async function saveShelly() {
		const boatId = $currentBoat?.id;
		if (!boatId) return;
		shellySaving = true;
		const { data: row } = await supabase
			.from('anchor_config')
			.update({
				shelly_cloud_server:   shellyServer || null,
				shelly_cloud_auth_key: shellyKey    || null,
			})
			.eq('boat_id', boatId).select().single();
		shellySaving = false;
		if (row) {
			anchorConfig.set(row);
			shellySaved = true;
			setTimeout(() => { shellySaved = false; }, 2000);
		}
	}

	async function testShelly() {
		if (!shellyServer || !shellyKey) return;
		shellyTest = 'sending';
		shellyTestMsg = '';
		try {
			const url = `https://${shellyServer}/interface/device/list?auth_key=${shellyKey}`;
			const res = await fetch(url);
			const json = await res.json();

			// Try multiple response formats the Shelly Cloud API may return
			const ds = json?.data?.devices_status;
			const da = json?.data?.devices;
			const dr = json?.devices;

			function countDevs(d: unknown): number | null {
				if (!d) return null;
				if (Array.isArray(d)) return d.length;
				if (typeof d === 'object') return Object.keys(d).length;
				return null;
			}

			const n = countDevs(ds) ?? countDevs(da) ?? countDevs(dr);
			if (n !== null) {
				shellyTestMsg = `${n} device${n !== 1 ? 's' : ''} found`;
				shellyTest = 'ok';
			} else if (json?.isok === false) {
				shellyTestMsg = json?.errors?.[0]?.message ?? json?.errors?.[0] ?? 'Auth error';
				shellyTest = 'err';
			} else {
				const dataKeys = Object.keys(json?.data ?? {}).join(', ') || '(empty)';
				shellyTestMsg = `data: {${dataKeys}}`;
				shellyTest = 'err';
			}
		} catch (e: unknown) {
			shellyTestMsg = e instanceof Error ? e.message : 'Connection error';
			shellyTest = 'err';
		}
		setTimeout(() => { shellyTest = 'idle'; shellyTestMsg = ''; }, 6000);
	}

	async function discoverVRMInstallations() {
		if (!vrmToken) return;
		vrmDiscovering = true;
		vrmTestMsg = ''; vrmTest = 'idle';
		try {
			const { data, error: fnErr } = await supabase.functions.invoke('vrm-proxy', {
				body: { action: 'discover', token: vrmToken },
			});
			if (fnErr || data?.error) {
				vrmTestMsg = data?.error ?? fnErr?.message ?? 'Error';
				vrmTest = 'err';
			} else {
				vrmInstallations = (data?.records ?? []).map((r: Record<string, unknown>) => ({
					idSite: r.idSite,
					name: r.name ?? `Site ${r.idSite}`,
				}));
				if (vrmInstallations.length === 1) vrmInstallationId = String(vrmInstallations[0].idSite);
			}
		} catch {
			vrmTestMsg = 'Connection error'; vrmTest = 'err';
		}
		vrmDiscovering = false;
	}

	async function testVRM() {
		if (!vrmToken || !vrmInstallationId) return;
		vrmTest = 'sending'; vrmTestMsg = '';
		try {
			const { data, error: fnErr } = await supabase.functions.invoke('vrm-proxy', {
				body: { token: vrmToken, installation_id: Number(vrmInstallationId) },
			});
			if (fnErr || data?.error) {
				vrmTestMsg = data?.error ?? fnErr?.message ?? 'Error';
				vrmTest = 'err'; return;
			}
			const attrs: unknown[] = data?.records ?? [];
			const hasBatt  = attrs.some((a: unknown) => (a as {dbusPath: string}).dbusPath === '/Dc/0/Soc');
			const hasSolar = attrs.some((a: unknown) => (a as {dbusPath: string}).dbusPath === '/Yield/Power');
			const tankCnt  = attrs.filter((a: unknown) => (a as {dbusPath: string}).dbusPath === '/Level').length;
			const parts: string[] = [];
			if (hasBatt)     parts.push('Battery');
			if (hasSolar)    parts.push('Solar');
			if (tankCnt > 0) parts.push(`${tankCnt} tank${tankCnt !== 1 ? 's' : ''}`);
			vrmTestMsg = `${attrs.length} attribute${attrs.length !== 1 ? 's' : ''}${parts.length ? ' · ' + parts.join(', ') : ''}`;
			vrmTest = 'ok';
		} catch (e: unknown) {
			vrmTestMsg = e instanceof Error ? e.message : 'Connection error';
			vrmTest = 'err';
		}
		setTimeout(() => { vrmTest = 'idle'; vrmTestMsg = ''; }, 8000);
	}

	async function saveVRM() {
		const boatId = $currentBoat?.id;
		if (!boatId) return;
		vrmSaving = true;
		const { data: row } = await supabase
			.from('anchor_config')
			.update({
				vrm_api_token:       vrmToken       || null,
				vrm_installation_id: vrmInstallationId ? Number(vrmInstallationId) : null,
			})
			.eq('boat_id', boatId).select().single();
		vrmSaving = false;
		if (row) {
			anchorConfig.set(row);
			vrmSaved = true;
			setTimeout(() => { vrmSaved = false; }, 2000);
		}
	}

	async function saveInReach() {
		const boatId = $currentBoat?.id;
		if (!boatId) return;
		inreachSaving = true;
		const { data: row } = await supabase
			.from('anchor_config')
			.update({
				inreach_mapshare_id:       inreachId       || null,
				inreach_mapshare_password: inreachPassword || null,
			})
			.eq('boat_id', boatId).select().single();
		inreachSaving = false;
		if (row) {
			anchorConfig.set(row);
			inreachSaved = true;
			setTimeout(() => { inreachSaved = false; }, 2000);
		}
	}

	async function testInReach() {
		if (!inreachId) return;
		inreachTest = 'sending'; inreachTestMsg = '';
		try {
			let qs = `id=${encodeURIComponent(inreachId)}&hours=24`;
			if (inreachPassword) qs += `&password=${encodeURIComponent(inreachPassword)}`;
			const res = await fetch(
				`${PUBLIC_SUPABASE_URL}/functions/v1/inreach-proxy?${qs}`,
				{ headers: { 'apikey': PUBLIC_SUPABASE_ANON_KEY } }
			);
			const data = await res.json();
			if (data?.ok) {
				const n = data.count ?? 0;
				const latest = data.points?.[0];
				const age = latest ? Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 60_000) : null;
				inreachTestMsg = `${n} point${n !== 1 ? 's' : ''}${age !== null ? ` · last ${age} min ago` : ''}`;
				inreachTest = 'ok';
			} else {
				inreachTestMsg = data?.error ?? 'No data returned';
				inreachTest = 'err';
			}
		} catch (e: unknown) {
			inreachTestMsg = e instanceof Error ? e.message : 'Connection error';
			inreachTest = 'err';
		}
		setTimeout(() => { inreachTest = 'idle'; inreachTestMsg = ''; }, 8000);
	}

	async function saveNotifications() {
		const boatId = $currentBoat?.id;
		if (!boatId) return;
		notifSaving = true;
		const { data: row } = await supabase
			.from('anchor_config')
			.update({
				telegram_token:     tgToken  || null,
				telegram_chat_ids:  tgChats  || null,
				pushover_app_token: poToken  || null,
				pushover_user_keys: poKeys   || null,
				alarm_delay_s:      alarmDelay,
			})
			.eq('boat_id', boatId).select().single();
		notifSaving = false;
		if (row) {
			anchorConfig.set(row);
			notifSaved = true;
			setTimeout(() => { notifSaved = false; }, 2000);
		}
	}

	async function sendTestNotification(channel: 'telegram' | 'pushover') {
		const set = channel === 'telegram'
			? (v: TestState) => { tgTest = v; }
			: (v: TestState) => { poTest = v; };
		set('sending');
		const { error } = await supabase.from('relay_commands').insert({
			device: 'notification_test', channel, desired_state: 1,
		});
		set(error ? 'err' : 'ok');
		setTimeout(() => set('idle'), 3000);
	}

	// ── Password change ───────────────────────────────────────────────────────
	let pw = $state(''); let pw2 = $state('');
	let pwLoading = $state(false); let pwError = $state(''); let pwSuccess = $state(false);

	async function changePassword(e: SubmitEvent) {
		e.preventDefault();
		pwError = ''; pwSuccess = false;
		if (pw.length < 8) { pwError = 'Min. 8 characters'; return; }
		if (pw !== pw2)    { pwError = "Passwords don't match"; return; }
		pwLoading = true;
		const { error } = await supabase.auth.updateUser({ password: pw });
		pwLoading = false;
		if (error) { pwError = error.message; return; }
		pwSuccess = true; pw = ''; pw2 = '';
	}

	async function signOut() {
		await supabase.auth.signOut();
		authStore.clear();
		goto('/login');
	}
</script>

<svelte:head><title>Settings · SUKI PRO</title></svelte:head>

<div class="settings">

	<!-- ── Crew management (admin only) ── -->
	{#if isAdmin}
	<section class="card">
		<div class="section-head">
			<h2>Crew</h2>
			<button class="icon-btn" onclick={loadUsers} disabled={usersLoading} title="Refresh">
				<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M16 10a6 6 0 1 1-1-3.2"/><path d="M16 4v3h-3"/>
				</svg>
			</button>
		</div>

		{#if usersError}
			<div class="alert alert-error">{usersError}</div>
		{/if}

		{#if usersLoading}
			<div class="loading-hint">Loading…</div>
		{:else}
			<div class="user-list">
				{#each users as u (u.id)}
					<div class="user-row">
						<div class="user-main">
							<span class="user-email">{u.email}</span>
							<div class="user-meta">
								<span class="user-date">Last login: {fmtDate(u.last_sign_in_at)}</span>
								{#if u.force_password_change}
									<span class="tag tag-warn">PW pending</span>
								{/if}
							</div>
						</div>
						<div class="user-actions">
							<!-- Role toggle -->
							<button
								class="role-btn"
								class:admin={u.role === 'admin'}
								onclick={() => setUserRole(u.id, u.role === 'admin' ? 'viewer' : 'admin')}
								disabled={actionBusy === u.id || u.id === currentUid}
								title="Toggle role"
							>
								{u.role ?? '—'}
							</button>
							<!-- PW reset -->
							<button class="icon-btn" title="Force password reset"
								disabled={actionBusy === u.id + '_pw' || u.force_password_change}
								onclick={() => resetUserPw(u.id)}>
								<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
									<rect x="4" y="9" width="12" height="8" rx="1.5"/>
									<path d="M7 9V6a3 3 0 0 1 6 0v3"/>
								</svg>
							</button>
							<!-- Delete -->
							{#if u.id !== currentUid}
							<button class="icon-btn danger" title="Remove user"
								disabled={actionBusy === u.id + '_del'}
								onclick={() => { deleteTarget = u; }}>
								<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="5 7 6 17 14 17 15 7"/><line x1="3" y1="7" x2="17" y2="7"/>
									<path d="M8 7V5h4v2"/>
								</svg>
							</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Add crew member form -->
		<div class="add-user">
			<div class="add-title">Add crew member</div>
			{#if addError}<div class="alert alert-error">{addError}</div>{/if}
			{#if addSuccess}
				<div class="alert alert-info">
					{#if addSuccessEmailSent}
						Invitation sent. The user will receive an email with a login link.
					{:else}
						User added to boat. They already have an account and will see this boat on next login.
					{/if}
				</div>
			{/if}
			<div class="field">
				<label for="add-email">Email</label>
				<input id="add-email" type="email" bind:value={addEmail} placeholder="new@example.com" autocomplete="off" />
			</div>
			<div class="role-row">
				<span class="role-lbl">Role</span>
				<div class="role-picker">
					<button class="role-opt" class:sel={addRole === 'viewer'} onclick={() => { addRole = 'viewer'; }}>Viewer</button>
					<button class="role-opt" class:sel={addRole === 'admin'}  onclick={() => { addRole = 'admin'; }}>Admin</button>
				</div>
			</div>
			<button class="btn btn-primary" onclick={addUser} disabled={addLoading || !addEmail}>
				{addLoading ? 'Adding…' : 'Add member'}
			</button>
		</div>
	</section>
	{/if}

	<!-- ── Delete confirmation modal ── -->
	{#if deleteTarget}
	<div class="modal-backdrop" role="dialog" aria-modal="true">
		<div class="modal">
			<div class="modal-title">Remove user?</div>
			<div class="modal-body">{deleteTarget.email}</div>
			<div class="modal-hint">This action cannot be undone.</div>
			<div class="modal-actions">
				<button class="btn btn-ghost" onclick={() => { deleteTarget = null; }}>Cancel</button>
				<button class="btn btn-danger" onclick={confirmDelete}>Remove</button>
			</div>
		</div>
	</div>
	{/if}

	<!-- ── Alarm ── -->
	<section class="card">
		<h2>Alarm</h2>
		<div class="setup-hint">
			Time between detecting anchor drift and sending the first alert.
			<strong>10 s</strong> is a good default — raise to 30–60 s if swell causes false alarms.
		</div>
		<div class="field-group">
			<div class="field-row">
				<span class="field-label">Alarm delay</span>
				<span class="field-val">{alarmDelay} s</span>
			</div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => { alarmDelay = Math.max(5, alarmDelay - 5); }}>−</button>
				<input type="range" min="5" max="120" step="5" bind:value={alarmDelay} />
				<button class="step-btn" onclick={() => { alarmDelay = Math.min(120, alarmDelay + 5); }}>+</button>
			</div>
		</div>
	</section>

	<!-- ── Telegram ── -->
	<section class="card">
		<h2>Telegram Notifications</h2>
		<div class="setup-hint">
			<strong>1. Create a bot:</strong> Open Telegram → search <code>@BotFather</code> → send <code>/newbot</code> → follow the steps → copy the token.<br>
			<strong>2. Find your Chat ID:</strong> Start a chat with your bot, then open<br>
			<code>api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> in a browser. Your Chat ID appears as <code>"id": 123456789</code>.<br>
			For a <strong>group</strong>: add the bot to the group first, send a message, then check getUpdates — group IDs start with <code>-100…</code>.
		</div>
		<div class="form-fields">
			<div class="field">
				<label for="tg-token">Bot Token</label>
				<input id="tg-token" type="text" bind:value={tgToken} placeholder="123456789:AABBCCdd…" autocomplete="off" />
				<span class="field-hint">From @BotFather — format: numbers:letters</span>
			</div>
			<div class="field">
				<label for="tg-chats">Chat IDs (comma-separated)</label>
				<input id="tg-chats" type="text" bind:value={tgChats} placeholder="-1001234567890,987654321" autocomplete="off" />
				<span class="field-hint">Personal chats: positive number · Groups: negative number starting with -100</span>
			</div>
		</div>
		<button class="btn btn-ghost test-btn" onclick={() => sendTestNotification('telegram')}
			disabled={tgTest === 'sending' || !tgToken}>
			{tgTest === 'sending' ? 'Sending…' : tgTest === 'ok' ? '✓ Sent' : tgTest === 'err' ? '✗ Error' : 'Send test message'}
		</button>
	</section>

	<!-- ── Pushover ── -->
	<section class="card">
		<h2>Pushover Notifications</h2>
		<div class="setup-hint">
			Create a free account at <strong>pushover.net</strong>, install the app on your phone, then:<br>
			<strong>App Token:</strong> <code>pushover.net/apps/build</code> → Create Application → copy the <em>API Token</em>.<br>
			<strong>User Key:</strong> Shown on your Pushover dashboard at <code>pushover.net</code> (top of the page, 30-character code).<br>
			Multiple recipients: comma-separate their User Keys.
		</div>
		<div class="form-fields">
			<div class="field">
				<label for="po-token">App Token</label>
				<input id="po-token" type="text" bind:value={poToken} placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi" autocomplete="off" />
				<span class="field-hint">30-character code from pushover.net/apps/build</span>
			</div>
			<div class="field">
				<label for="po-keys">User Keys (comma-separated)</label>
				<input id="po-keys" type="text" bind:value={poKeys} placeholder="uQiRzpo4DXghDmr9QzzfQu,…" autocomplete="off" />
				<span class="field-hint">Each recipient's User Key from their Pushover dashboard</span>
			</div>
		</div>
		<button class="btn btn-ghost test-btn" onclick={() => sendTestNotification('pushover')}
			disabled={poTest === 'sending' || !poToken}>
			{poTest === 'sending' ? 'Sending…' : poTest === 'ok' ? '✓ Sent' : poTest === 'err' ? '✗ Error' : 'Send test message'}
		</button>
	</section>

	<button class="btn btn-primary save-btn" onclick={saveNotifications} disabled={notifSaving}>
		{notifSaving ? 'Saving…' : notifSaved ? '✓ Saved' : 'Save notification settings'}
	</button>

	<!-- ── Shelly Cloud ── -->
	<section class="card">
		<h2>Shelly Cloud</h2>
		<div class="setup-hint">
			Log in at <strong>home.shelly.cloud</strong> (same account as the Shelly app).<br>
			Click your <strong>name / avatar</strong> in the top-right corner → <em>Settings</em>:<br>
			<strong>Server URL:</strong> listed under <em>Cloud server</em> — copy only the hostname (e.g. <code>shelly-12-eu.shelly.cloud</code>).<br>
			<strong>Auth Key:</strong> same Settings page → <em>Authorization cloud key</em> → click <em>Generate key</em> if empty, then copy it.
		</div>
		<div class="form-fields">
			<div class="field">
				<label for="sh-server">Server URL</label>
				<input id="sh-server" type="text" bind:value={shellyServer}
					placeholder="shelly-12-eu.shelly.cloud" autocomplete="off" spellcheck="false" />
				<span class="field-hint">Hostname only — no https:// prefix</span>
			</div>
			<div class="field">
				<label for="sh-key">Auth Key</label>
				<input id="sh-key" type="password" bind:value={shellyKey}
					placeholder="Authorization cloud key" autocomplete="off" />
				<span class="field-hint">Long alphanumeric key from home.shelly.cloud → Settings</span>
			</div>
		</div>
		<div class="shelly-actions">
			<button class="btn btn-ghost test-btn shelly-test" onclick={testShelly}
				disabled={shellyTest === 'sending' || !shellyServer || !shellyKey}>
				{shellyTest === 'sending' ? 'Testing…'
				 : shellyTest === 'ok'      ? `✓ ${shellyTestMsg}`
				 : shellyTest === 'err'     ? `✗ ${shellyTestMsg}`
				 : 'Test connection'}
			</button>
			<button class="btn btn-primary" onclick={saveShelly} disabled={shellySaving}>
				{shellySaving ? 'Saving…' : shellySaved ? '✓ Saved' : 'Save'}
			</button>
		</div>
	</section>

	<!-- ── Victron VRM ── -->
	<section class="card">
		<h2>Victron VRM</h2>
		<div class="setup-hint">
			Log in at <strong>vrm.victronenergy.com</strong> — your Cerbo GX must be connected and visible there.<br>
			<strong>API Token:</strong> top-right avatar menu → <em>Preferences</em> → <em>API Tokens</em> → <em>Add token</em> → copy immediately (shown only once).<br>
			<strong>Installation ID:</strong> visible in the page URL after <code>/installation/</code> — e.g. <code>vrm.victronenergy.com/installation/<em>123456</em>/dashboard</code>. Or click <strong>Discover</strong> to find it automatically after entering the token.
		</div>
		<div class="form-fields">
			<div class="field">
				<label for="vrm-token">API Token</label>
				<input id="vrm-token" type="password" bind:value={vrmToken}
					placeholder="VRM Portal → Preferences → API Tokens" autocomplete="off" />
				<span class="field-hint">Paste immediately after generating — it cannot be retrieved again</span>
			</div>
			<div class="field">
				<label for="vrm-site">Installation ID</label>
				<div class="vrm-site-row">
					{#if vrmInstallations.length > 1}
						<select id="vrm-site" class="vrm-select" bind:value={vrmInstallationId}>
							<option value="">— Select —</option>
							{#each vrmInstallations as inst}
								<option value={String(inst.idSite)}>{inst.name} ({inst.idSite})</option>
							{/each}
						</select>
					{:else}
						<input id="vrm-site" type="text" bind:value={vrmInstallationId}
							placeholder="e.g. 123456" inputmode="numeric" autocomplete="off" />
					{/if}
					<button class="btn btn-ghost vrm-discover-btn" onclick={discoverVRMInstallations}
						disabled={vrmDiscovering || !vrmToken}>
						{vrmDiscovering ? '…' : 'Discover'}
					</button>
				</div>
				{#if vrmInstallations.length === 1}
					<span class="vrm-found">{vrmInstallations[0].name}</span>
				{/if}
			</div>
		</div>
		<div class="shelly-actions">
			<button class="btn btn-ghost test-btn shelly-test" onclick={testVRM}
				disabled={vrmTest === 'sending' || !vrmToken || !vrmInstallationId}>
				{vrmTest === 'sending' ? 'Testing…'
				 : vrmTest === 'ok'    ? `✓ ${vrmTestMsg}`
				 : vrmTest === 'err'   ? `✗ ${vrmTestMsg}`
				 : 'Test connection'}
			</button>
			<button class="btn btn-primary" onclick={saveVRM} disabled={vrmSaving}>
				{vrmSaving ? 'Saving…' : vrmSaved ? '✓ Saved' : 'Save'}
			</button>
		</div>
	</section>

	<!-- ── Garmin InReach ── -->
	<section class="card">
		<h2>Garmin InReach</h2>
		<div class="setup-hint">
			Log in at <strong>explore.garmin.com</strong> → <em>InReach</em> → <em>Social</em> → <em>MapShare</em> → enable MapShare.<br>
			Your <strong>MapShare ID</strong> is the name at the end of your share URL:<br>
			<code>share.garmin.com/Feed/Share/<em>YourName</em></code> — enter only <em>YourName</em>.<br>
			Set a <strong>password</strong> on the same page under <em>MapShare Password</em> if you want a private feed.
		</div>
		<div class="form-fields">
			<div class="field">
				<label for="inreach-id">MapShare ID</label>
				<input id="inreach-id" type="text" bind:value={inreachId}
					placeholder="YourName"
					autocomplete="off" spellcheck="false" />
				<span class="field-hint">The name after share.garmin.com/Feed/Share/ in your MapShare link</span>
			</div>
			<div class="field">
				<label for="inreach-pw">MapShare Password <span class="optional">(optional)</span></label>
				<input id="inreach-pw" type="password" bind:value={inreachPassword}
					placeholder="Leave empty if feed is public" autocomplete="off" />
				<span class="field-hint">Only needed if you set a password under MapShare Settings on explore.garmin.com</span>
			</div>
		</div>
		<div class="shelly-actions">
			<button class="btn btn-ghost test-btn shelly-test" onclick={testInReach}
				disabled={inreachTest === 'sending' || !inreachId}>
				{inreachTest === 'sending' ? 'Testing…'
				 : inreachTest === 'ok'    ? `✓ ${inreachTestMsg}`
				 : inreachTest === 'err'   ? `✗ ${inreachTestMsg}`
				 : 'Test feed'}
			</button>
			<button class="btn btn-primary" onclick={saveInReach} disabled={inreachSaving}>
				{inreachSaving ? 'Saving…' : inreachSaved ? '✓ Saved' : 'Save'}
			</button>
		</div>
	</section>

	<!-- ── Account ── -->
	<section class="card">
		<h2>Account</h2>
		<div class="info-row"><span class="lbl">Email</span><span>{userEmail}</span></div>
		<div class="info-row"><span class="lbl">Role</span><span class="role-badge">{userRole}</span></div>
	</section>

	<!-- ── Change Password ── -->
	<section class="card">
		<h2>Change Password</h2>
		<form onsubmit={changePassword} class="form-fields">
			{#if pwError}<div class="alert alert-error">{pwError}</div>{/if}
			{#if pwSuccess}<div class="alert alert-info">Password changed.</div>{/if}
			<div class="field">
				<label for="pw">New password</label>
				<input id="pw" type="password" bind:value={pw} placeholder="min. 8 characters" autocomplete="new-password" />
			</div>
			<div class="field">
				<label for="pw2">Confirm</label>
				<input id="pw2" type="password" bind:value={pw2} placeholder="Repeat" autocomplete="new-password" />
			</div>
			<button type="submit" class="btn btn-ghost" disabled={pwLoading}>
				{pwLoading ? 'Saving…' : 'Save password'}
			</button>
		</form>
	</section>

	<!-- ── System ── -->
	<section class="card">
		<h2>System</h2>
		<div class="info-row"><span class="lbl">Build</span><span class="build-ver">{version}</span></div>
		{#if isSuperAdmin}
		<div class="info-row"><span class="lbl">Supabase</span><code>mtcmxrmykvthybwrlnvz</code></div>
		{/if}
		<button class="btn btn-danger mt" onclick={signOut}>Sign out</button>
	</section>

</div>

<style>
	.settings { display: flex; flex-direction: column; gap: 12px; padding-bottom: 24px; }

	section h2 {
		font-size: 11px; font-weight: 600; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 12px;
	}

	/* ── User management ── */
	.section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
	.section-head h2 { margin-bottom: 0; }

	.loading-hint { font-size: 13px; color: var(--muted); padding: 8px 0; }

	.user-list { display: flex; flex-direction: column; border-top: 1px solid var(--border); }
	.user-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: 10px 0; border-bottom: 1px solid var(--border); gap: 8px;
	}
	.user-row:last-child { border-bottom: none; }

	.user-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
	.user-email { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.user-meta  { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.user-date  { font-size: 11px; color: var(--muted); }
	.tag { font-size: 9px; padding: 1px 5px; border-radius: 3px; }
	.tag-warn { background: rgba(245,158,11,.15); color: var(--amber); border: 1px solid rgba(245,158,11,.3); }

	.user-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

	.role-btn {
		font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
		padding: 3px 8px; border-radius: 4px; cursor: pointer;
		background: var(--card2); border: 1px solid var(--border); color: var(--muted);
		transition: all 0.15s;
	}
	.role-btn.admin { border-color: var(--accent); color: var(--accent); background: rgba(0,200,255,.08); }
	.role-btn:disabled { opacity: 0.5; cursor: default; }

	.icon-btn {
		width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
		background: var(--card2); border: 1px solid var(--border); border-radius: 6px;
		color: var(--muted); cursor: pointer; transition: border-color 0.15s, color 0.15s;
		flex-shrink: 0;
	}
	.icon-btn:hover:not(:disabled) { border-color: var(--text); color: var(--text); }
	.icon-btn.danger:hover:not(:disabled) { border-color: var(--red); color: var(--red); }
	.icon-btn:disabled { opacity: 0.4; cursor: default; }

	/* Add crew form */
	.add-user {
		margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);
		display: flex; flex-direction: column; gap: 10px;
	}
	.add-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; }
	.role-row { display: flex; align-items: center; justify-content: space-between; }
	.role-lbl { font-size: 12px; color: var(--muted); }
	.role-picker { display: flex; gap: 4px; }
	.role-opt {
		padding: 4px 12px; border-radius: 5px; font-size: 12px; font-weight: 500; cursor: pointer;
		background: var(--card2); border: 1px solid var(--border); color: var(--muted);
		transition: all 0.15s;
	}
	.role-opt.sel { background: rgba(0,200,255,.12); border-color: var(--accent); color: var(--accent); }

	/* Delete modal */
	.modal-backdrop {
		position: fixed; inset: 0; z-index: 9000;
		background: rgba(0,0,0,.65); display: flex; align-items: center; justify-content: center; padding: 24px;
	}
	.modal {
		background: var(--card); border: 1px solid var(--border); border-radius: 12px;
		padding: 20px; width: 100%; max-width: 320px; display: flex; flex-direction: column; gap: 8px;
	}
	.modal-title { font-size: 15px; font-weight: 700; }
	.modal-body  { font-size: 13px; color: var(--accent); word-break: break-all; }
	.modal-hint  { font-size: 12px; color: var(--muted); }
	.modal-actions { display: flex; gap: 8px; margin-top: 8px; }
	.modal-actions .btn { flex: 1; }

	/* ── Slider ── */
	.field-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px; }
	.field-row   { display: flex; justify-content: space-between; align-items: center; }
	.field-label { font-size: 13px; color: var(--muted); }
	.field-val   { font-size: 13px; font-weight: 600; color: var(--text); }

	.slider-controls { display: flex; align-items: center; gap: 8px; }
	.step-btn {
		width: 36px; height: 36px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 8px; color: var(--text); font-size: 18px; font-weight: 300; cursor: pointer;
		display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: border-color 0.15s;
	}
	.step-btn:active { border-color: var(--accent); color: var(--accent); }

	input[type="range"] {
		flex: 1; -webkit-appearance: none; appearance: none;
		height: 4px; background: var(--border); border-radius: 2px; outline: none;
	}
	input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none; appearance: none;
		width: 24px; height: 24px; border-radius: 50%;
		background: var(--accent); cursor: pointer;
		border: 3px solid var(--bg); box-shadow: 0 0 0 2px var(--accent);
	}

	/* ── Notifications + Shelly ── */
	.form-fields { display: flex; flex-direction: column; gap: 10px; }
	.field       { display: flex; flex-direction: column; gap: 5px; }
	.field label { font-size: 12px; color: var(--muted); }
	.test-btn    { width: 100%; margin-top: 10px; font-size: 12px; }
	.save-btn    { width: 100%; }

	.shelly-actions { display: flex; gap: 8px; margin-top: 10px; }
	.shelly-test    { flex: 1; margin-top: 0; }

	/* ── Account ── */
	.info-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 14px;
	}
	.info-row:last-child { border-bottom: none; }
	.lbl { color: var(--muted); }
	.role-badge {
		background: var(--card2); border: 1px solid var(--border); border-radius: 4px;
		padding: 2px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
	}

	/* ── System ── */
	.build-ver { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
	code { font-size: 12px; color: var(--accent); }
	.mt  { margin-top: 12px; }

	/* ── VRM ── */
	.vrm-site-row { display: flex; gap: 6px; }
	.vrm-site-row input { flex: 1; }
	.vrm-select {
		flex: 1; background: var(--card2); border: 1px solid var(--border); border-radius: 8px;
		color: var(--text); font-size: 14px; padding: 10px 12px; outline: none;
	}
	.vrm-discover-btn { flex-shrink: 0; margin-top: 0; padding: 0 14px; height: 44px; font-size: 13px; }
	.vrm-found { font-size: 12px; color: var(--green); margin-top: 2px; }
	.field-hint { font-size: 10px; color: var(--muted); opacity: 0.7; }
	.optional   { font-size: 10px; color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; }

	/* ── Setup hints ── */
	.setup-hint {
		font-size: 12px; color: var(--muted); line-height: 1.55;
		border-left: 2px solid var(--border);
		padding: 7px 10px; border-radius: 0 6px 6px 0;
		background: rgba(255,255,255,.02);
		margin-bottom: 14px;
	}
	.setup-hint strong { color: var(--text); font-weight: 600; }
	.setup-hint code {
		font-family: 'SF Mono','Menlo','Monaco',monospace;
		font-size: 11px; color: var(--accent);
		background: rgba(0,200,255,.08); border-radius: 3px; padding: 0 4px;
	}
	.setup-hint em { font-style: normal; color: var(--accent); }
</style>
