<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';
	import { anchorConfig } from '$lib/stores/anchor.js';

	let { data } = $props();

	// ── Auth ──────────────────────────────────────────────────────────────────
	const userEmail  = $derived($authStore.session?.user?.email ?? '—');
	const userRole   = $derived($authStore.roleData?.role ?? '—');
	const currentUid = $derived($authStore.session?.user?.id ?? '');
	const isAdmin    = $derived(userRole === 'admin');
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
	let addPassword  = $state('');
	let addRole      = $state<'viewer' | 'admin'>('viewer');
	let addLoading   = $state(false);
	let addError     = $state('');
	let addSuccess   = $state(false);
	let deleteTarget = $state<AppUser | null>(null);
	let actionBusy   = $state<string>(''); // userId of in-flight action

	async function loadUsers() {
		usersLoading = true;
		usersError = '';
		const { data: result, error } = await supabase.functions.invoke('manage-users', {
			method: 'GET',
		});
		usersLoading = false;
		if (error || result?.error) {
			usersError = result?.error ?? error?.message ?? 'Fehler beim Laden';
			return;
		}
		users = result as AppUser[];
	}

	async function addUser() {
		addError = '';
		addSuccess = false;
		if (!addEmail || !addPassword) { addError = 'E-Mail und Passwort erforderlich'; return; }
		if (addPassword.length < 8) { addError = 'Passwort min. 8 Zeichen'; return; }
		addLoading = true;
		const { data: result, error } = await supabase.functions.invoke('manage-users', {
			method: 'POST',
			body: { email: addEmail, password: addPassword, role: addRole },
		});
		addLoading = false;
		if (error || result?.error) { addError = result?.error ?? error?.message ?? 'Fehler'; return; }
		addEmail = ''; addPassword = ''; addRole = 'viewer';
		addSuccess = true;
		setTimeout(() => { addSuccess = false; }, 3000);
		await loadUsers();
	}

	async function setUserRole(userId: string, newRole: 'admin' | 'viewer') {
		actionBusy = userId;
		await supabase.functions.invoke('manage-users', {
			method: 'PATCH',
			body: { userId, role: newRole },
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
			body: { userId: deleteTarget.id },
		});
		deleteTarget = null;
		actionBusy = '';
		await loadUsers();
	}

	function fmtDate(iso: string | null): string {
		if (!iso) return 'Nie';
		return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
	}

	// ── Notification settings ─────────────────────────────────────────────────
	let notifSaving = $state(false);
	let notifSaved  = $state(false);

	type TestState = 'idle' | 'sending' | 'ok' | 'err';
	let tgTest = $state<TestState>('idle');
	let poTest = $state<TestState>('idle');

	let tgToken      = $state('');
	let tgChats      = $state('');
	let poToken      = $state('');
	let poKeys       = $state('');
	let alarmDelay   = $state(10);
	let cloudEnabled = $state(true);

	$effect(() => {
		if (cfg) {
			tgToken      = cfg.telegram_token      ?? '';
			tgChats      = cfg.telegram_chat_ids   ?? '';
			poToken      = cfg.pushover_app_token  ?? '';
			poKeys       = cfg.pushover_user_keys  ?? '';
			alarmDelay   = cfg.alarm_delay_s       ?? 10;
			cloudEnabled = cfg.cloud_enabled       ?? true;
		}
	});

	async function saveNotifications() {
		notifSaving = true;
		const { data: row } = await supabase
			.from('anchor_config')
			.update({
				telegram_token:      tgToken  || null,
				telegram_chat_ids:   tgChats  || null,
				pushover_app_token:  poToken  || null,
				pushover_user_keys:  poKeys   || null,
				alarm_delay_s:       alarmDelay,
				cloud_enabled:       cloudEnabled,
			})
			.eq('id', 1).select().single();
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
		if (pw.length < 8) { pwError = 'Min. 8 Zeichen'; return; }
		if (pw !== pw2)    { pwError = 'Passwörter stimmen nicht überein'; return; }
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

	onMount(() => {
		if (isAdmin) loadUsers();
	});
</script>

<svelte:head><title>Settings · SUKI PRO</title></svelte:head>

<div class="settings">

	<!-- ── User management (admin only) ── -->
	{#if isAdmin}
	<section class="card">
		<div class="section-head">
			<h2>Benutzer</h2>
			<button class="icon-btn" onclick={loadUsers} disabled={usersLoading} title="Neu laden">
				<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M16 10a6 6 0 1 1-1-3.2"/><path d="M16 4v3h-3"/>
				</svg>
			</button>
		</div>

		{#if usersError}
			<div class="alert alert-error">{usersError}</div>
		{/if}

		{#if usersLoading}
			<div class="loading-hint">Lädt…</div>
		{:else}
			<div class="user-list">
				{#each users as u (u.id)}
					<div class="user-row">
						<div class="user-main">
							<span class="user-email">{u.email}</span>
							<div class="user-meta">
								<span class="user-date">Anmeldung: {fmtDate(u.last_sign_in_at)}</span>
								{#if u.force_password_change}
									<span class="tag tag-warn">PW ausstehend</span>
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
								title="Rolle umschalten"
							>
								{u.role ?? '—'}
							</button>
							<!-- PW reset -->
							<button class="icon-btn" title="Passwort-Reset erzwingen"
								disabled={actionBusy === u.id + '_pw' || u.force_password_change}
								onclick={() => resetUserPw(u.id)}>
								<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
									<rect x="4" y="9" width="12" height="8" rx="1.5"/>
									<path d="M7 9V6a3 3 0 0 1 6 0v3"/>
								</svg>
							</button>
							<!-- Delete -->
							{#if u.id !== currentUid}
							<button class="icon-btn danger" title="Nutzer löschen"
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

		<!-- Add user form -->
		<div class="add-user">
			<div class="add-title">Neuen Nutzer anlegen</div>
			{#if addError}<div class="alert alert-error">{addError}</div>{/if}
			{#if addSuccess}<div class="alert alert-info">Nutzer angelegt. Initiales Passwort muss geändert werden.</div>{/if}
			<div class="field">
				<label for="add-email">E-Mail</label>
				<input id="add-email" type="email" bind:value={addEmail} placeholder="neu@example.com" autocomplete="off" />
			</div>
			<div class="field">
				<label for="add-pw">Temporäres Passwort</label>
				<input id="add-pw" type="password" bind:value={addPassword} placeholder="min. 8 Zeichen" autocomplete="new-password" />
			</div>
			<div class="role-row">
				<label>Rolle</label>
				<div class="role-picker">
					<button class="role-opt" class:sel={addRole === 'viewer'} onclick={() => { addRole = 'viewer'; }}>Viewer</button>
					<button class="role-opt" class:sel={addRole === 'admin'}  onclick={() => { addRole = 'admin'; }}>Admin</button>
				</div>
			</div>
			<button class="btn btn-primary" onclick={addUser} disabled={addLoading || !addEmail || !addPassword}>
				{addLoading ? 'Erstelle…' : 'Nutzer hinzufügen'}
			</button>
		</div>
	</section>
	{/if}

	<!-- ── Delete confirmation modal ── -->
	{#if deleteTarget}
	<div class="modal-backdrop" role="dialog" aria-modal="true">
		<div class="modal">
			<div class="modal-title">Nutzer löschen?</div>
			<div class="modal-body">{deleteTarget.email}</div>
			<div class="modal-hint">Dieser Vorgang kann nicht rückgängig gemacht werden.</div>
			<div class="modal-actions">
				<button class="btn btn-ghost" onclick={() => { deleteTarget = null; }}>Abbrechen</button>
				<button class="btn btn-danger" onclick={confirmDelete}>Löschen</button>
			</div>
		</div>
	</div>
	{/if}

	<!-- ── Alarm & Cloud ── -->
	<section class="card">
		<h2>Alarm & Verbindung</h2>
		<div class="field-group">
			<div class="field-row">
				<span class="field-label">Alarm-Verzögerung</span>
				<span class="field-val">{alarmDelay} s</span>
			</div>
			<div class="slider-controls">
				<button class="step-btn" onclick={() => { alarmDelay = Math.max(5, alarmDelay - 5); }}>−</button>
				<input type="range" min="5" max="120" step="5" bind:value={alarmDelay} />
				<button class="step-btn" onclick={() => { alarmDelay = Math.min(120, alarmDelay + 5); }}>+</button>
			</div>
		</div>
		<div class="toggle-row">
			<div>
				<div class="field-label">Cloud Bridge</div>
				<div class="field-sub">HiveMQ Publish (Starlink-Daten sparen)</div>
			</div>
			<button class="toggle-btn" class:on={cloudEnabled}
				aria-label="Cloud Bridge {cloudEnabled ? 'deaktivieren' : 'aktivieren'}"
				onclick={() => { cloudEnabled = !cloudEnabled; }}>
				<span class="knob"></span>
			</button>
		</div>
	</section>

	<!-- ── Telegram ── -->
	<section class="card">
		<h2>Telegram Alarm</h2>
		<div class="form-fields">
			<div class="field">
				<label for="tg-token">Bot Token</label>
				<input id="tg-token" type="text" bind:value={tgToken} placeholder="123456789:AABBCCdd…" autocomplete="off" />
			</div>
			<div class="field">
				<label for="tg-chats">Chat IDs (kommagetrennt)</label>
				<input id="tg-chats" type="text" bind:value={tgChats} placeholder="-1001234567890,987654321" autocomplete="off" />
			</div>
		</div>
		<button class="btn btn-ghost test-btn" onclick={() => sendTestNotification('telegram')}
			disabled={tgTest === 'sending' || !tgToken}>
			{tgTest === 'sending' ? 'Sende…' : tgTest === 'ok' ? '✓ Gesendet' : tgTest === 'err' ? '✗ Fehler' : 'Testnachricht senden'}
		</button>
	</section>

	<!-- ── Pushover ── -->
	<section class="card">
		<h2>Pushover Alarm</h2>
		<div class="form-fields">
			<div class="field">
				<label for="po-token">App Token</label>
				<input id="po-token" type="text" bind:value={poToken} placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi" autocomplete="off" />
			</div>
			<div class="field">
				<label for="po-keys">User Keys (kommagetrennt)</label>
				<input id="po-keys" type="text" bind:value={poKeys} placeholder="uQiRzpo4DXghDmr9QzzfQu,…" autocomplete="off" />
			</div>
		</div>
		<button class="btn btn-ghost test-btn" onclick={() => sendTestNotification('pushover')}
			disabled={poTest === 'sending' || !poToken}>
			{poTest === 'sending' ? 'Sende…' : poTest === 'ok' ? '✓ Gesendet' : poTest === 'err' ? '✗ Fehler' : 'Testnachricht senden'}
		</button>
	</section>

	<button class="btn btn-primary save-btn" onclick={saveNotifications} disabled={notifSaving}>
		{notifSaving ? 'Speichere…' : notifSaved ? '✓ Gespeichert' : 'Alarm-Einstellungen speichern'}
	</button>

	<!-- ── Konto ── -->
	<section class="card">
		<h2>Konto</h2>
		<div class="info-row"><span class="lbl">E-Mail</span><span>{userEmail}</span></div>
		<div class="info-row"><span class="lbl">Rolle</span><span class="role-badge">{userRole}</span></div>
	</section>

	<!-- ── Passwort ändern ── -->
	<section class="card">
		<h2>Passwort ändern</h2>
		<form onsubmit={changePassword} class="form-fields">
			{#if pwError}<div class="alert alert-error">{pwError}</div>{/if}
			{#if pwSuccess}<div class="alert alert-info">Passwort geändert.</div>{/if}
			<div class="field">
				<label for="pw">Neues Passwort</label>
				<input id="pw" type="password" bind:value={pw} placeholder="min. 8 Zeichen" autocomplete="new-password" />
			</div>
			<div class="field">
				<label for="pw2">Bestätigen</label>
				<input id="pw2" type="password" bind:value={pw2} placeholder="Wiederholung" autocomplete="new-password" />
			</div>
			<button type="submit" class="btn btn-ghost" disabled={pwLoading}>
				{pwLoading ? 'Speichere…' : 'Passwort speichern'}
			</button>
		</form>
	</section>

	<!-- ── System ── -->
	<section class="card">
		<h2>System</h2>
		<p class="sys-info">Supabase: <code>mtcmxrmykvthybwrlnvz.supabase.co</code><br />Region: eu-central-1</p>
		<button class="btn btn-danger mt" onclick={signOut}>Abmelden</button>
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

	/* Add user form */
	.add-user {
		margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);
		display: flex; flex-direction: column; gap: 10px;
	}
	.add-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; }
	.role-row { display: flex; align-items: center; justify-content: space-between; }
	.role-row label { font-size: 12px; color: var(--muted); }
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

	/* ── Toggle / slider ── */
	.toggle-btn {
		width: 44px; height: 26px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 13px; position: relative; transition: background 0.2s, border-color 0.2s;
		padding: 0; cursor: pointer; flex-shrink: 0;
	}
	.toggle-btn.on { background: var(--green); border-color: var(--green); }
	.knob {
		position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
		background: var(--text); border-radius: 50%; transition: transform 0.2s; display: block;
	}
	.toggle-btn.on .knob { transform: translateX(18px); }

	.field-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
	.field-row   { display: flex; justify-content: space-between; align-items: center; }
	.field-label { font-size: 13px; color: var(--muted); }
	.field-val   { font-size: 13px; font-weight: 600; color: var(--text); }
	.field-sub   { font-size: 11px; color: var(--muted); margin-top: 2px; }
	.toggle-row  { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid var(--border); }

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

	/* ── Notifications ── */
	.form-fields { display: flex; flex-direction: column; gap: 10px; }
	.field       { display: flex; flex-direction: column; gap: 5px; }
	.field label { font-size: 12px; color: var(--muted); }
	.test-btn    { width: 100%; margin-top: 10px; font-size: 12px; }
	.save-btn    { width: 100%; }

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
	.sys-info { font-size: 13px; color: var(--muted); line-height: 1.6; }
	code { font-size: 12px; color: var(--accent); }
	.mt  { margin-top: 12px; }
</style>
