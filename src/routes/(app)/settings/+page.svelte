<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { telemetry } from '$lib/stores/telemetry.js';

	let { data } = $props();

	// Password change
	let pw = $state('');
	let pw2 = $state('');
	let pwLoading = $state(false);
	let pwError = $state('');
	let pwSuccess = $state(false);

	// Notification save state
	let notifSaving = $state(false);
	let notifSaved = $state(false);

	// Test notification state
	type TestState = 'idle' | 'sending' | 'ok' | 'err';
	let tgTest  = $state<TestState>('idle');
	let poTest  = $state<TestState>('idle');

	const userEmail = $derived($authStore.session?.user?.email ?? '—');
	const userRole = $derived($authStore.roleData?.role ?? '—');
	const cfg = $derived($anchorConfig);
	const t = $derived($telemetry);

	// Notification fields (editable local copies)
	let tgToken = $state('');
	let tgChats = $state('');
	let poToken = $state('');
	let poKeys  = $state('');
	let alarmDelay = $state(10);
	let cloudEnabled = $state(true);

	// Init local state from store
	$effect(() => {
		if (cfg) {
			tgToken = cfg.telegram_token ?? '';
			tgChats = cfg.telegram_chat_ids ?? '';
			poToken = cfg.pushover_app_token ?? '';
			poKeys  = cfg.pushover_user_keys ?? '';
			alarmDelay = cfg.alarm_delay_s ?? 10;
			cloudEnabled = cfg.cloud_enabled ?? true;
		}
	});

	async function changePassword(e: SubmitEvent) {
		e.preventDefault();
		pwError = '';
		pwSuccess = false;
		if (pw.length < 8) { pwError = 'Min. 8 Zeichen'; return; }
		if (pw !== pw2) { pwError = 'Passwörter stimmen nicht überein'; return; }
		pwLoading = true;
		const { error } = await supabase.auth.updateUser({ password: pw });
		pwLoading = false;
		if (error) { pwError = error.message; return; }
		pwSuccess = true;
		pw = ''; pw2 = '';
	}

	async function saveNotifications() {
		notifSaving = true;
		const { data: row } = await supabase
			.from('anchor_config')
			.update({
				telegram_token: tgToken || null,
				telegram_chat_ids: tgChats || null,
				pushover_app_token: poToken || null,
				pushover_user_keys: poKeys || null,
				alarm_delay_s: alarmDelay,
				cloud_enabled: cloudEnabled
			})
			.eq('id', 1)
			.select()
			.single();
		notifSaving = false;
		if (row) {
			anchorConfig.set(row);
			notifSaved = true;
			setTimeout(() => { notifSaved = false; }, 2000);
		}
	}

	async function sendTestNotification(channel: 'telegram' | 'pushover') {
		const setter = channel === 'telegram' ? (v: TestState) => { tgTest = v; } : (v: TestState) => { poTest = v; };
		setter('sending');
		const { error } = await supabase.from('relay_commands').insert({
			device: 'notification_test', channel, desired_state: 1
		});
		setter(error ? 'err' : 'ok');
		setTimeout(() => setter('idle'), 3000);
	}

	async function toggleRelay(device: string, channel: string, current: 0 | 1 | null | undefined) {
		const newState = current === 1 ? 0 : 1;
		await supabase.from('relay_commands').insert({ device, channel, desired_state: newState });
	}

	async function signOut() {
		await supabase.auth.signOut();
		authStore.clear();
		goto('/login');
	}
</script>

<svelte:head><title>Settings · SUKI PRO</title></svelte:head>

<div class="settings">

	<!-- Relay / Switches -->
	<section class="card">
		<h2>Schalter</h2>
		<div class="relay-list">
			{#each [
				{ device: 'victron_relay', channel: '0', label: 'Water Heater',  state: t?.relay_0    },
				{ device: 'victron_relay', channel: '1', label: 'Anchor Light',   state: t?.relay_1    },
				{ device: 'shelly', channel: '108', label: 'Hecklicht',           state: t?.shelly_108 },
				{ device: 'shelly', channel: '102', label: 'Ambientelicht',       state: t?.shelly_102 },
				{ device: 'shelly', channel: '118', label: 'Wasserpumpe',         state: t?.shelly_118 },
			] as r}
				<div class="relay-row">
					<span class="relay-label">{r.label}</span>
					<button
						class="toggle-btn"
						class:on={r.state === 1}
						aria-label="{r.label} {r.state === 1 ? 'aus' : 'ein'}schalten"
						onclick={() => toggleRelay(r.device, r.channel, r.state)}
					>
						<span class="knob"></span>
					</button>
				</div>
			{/each}
		</div>
	</section>

	<!-- Alarm delay + Cloud bridge -->
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
			<button
				class="toggle-btn"
				class:on={cloudEnabled}
				aria-label="Cloud Bridge {cloudEnabled ? 'deaktivieren' : 'aktivieren'}"
				onclick={() => { cloudEnabled = !cloudEnabled; }}
			>
				<span class="knob"></span>
			</button>
		</div>
	</section>

	<!-- Telegram -->
	<section class="card">
		<h2>Telegram Alarm</h2>
		<div class="form-fields">
			<div class="field">
				<label for="tg-token">Bot Token</label>
				<input id="tg-token" type="text" bind:value={tgToken} placeholder="123456789:AABBCCdd..." autocomplete="off" />
			</div>
			<div class="field">
				<label for="tg-chats">Chat IDs (kommagetrennt, max. 5)</label>
				<input id="tg-chats" type="text" bind:value={tgChats} placeholder="-1001234567890,987654321,…" autocomplete="off" />
			</div>
		</div>
		<button class="btn btn-ghost test-btn" onclick={() => sendTestNotification('telegram')}
			disabled={tgTest === 'sending' || !tgToken}>
			{tgTest === 'sending' ? 'Sende…' : tgTest === 'ok' ? '✓ Gesendet' : tgTest === 'err' ? '✗ Fehler' : 'Testnachricht senden'}
		</button>
	</section>

	<!-- Pushover -->
	<section class="card">
		<h2>Pushover Alarm</h2>
		<div class="form-fields">
			<div class="field">
				<label for="po-token">App Token</label>
				<input id="po-token" type="text" bind:value={poToken} placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi" autocomplete="off" />
			</div>
			<div class="field">
				<label for="po-keys">User Keys (kommagetrennt, max. 5)</label>
				<input id="po-keys" type="text" bind:value={poKeys} placeholder="uQiRzpo4DXghDmr9QzzfQu,…" autocomplete="off" />
			</div>
		</div>
		<button class="btn btn-ghost test-btn" onclick={() => sendTestNotification('pushover')}
			disabled={poTest === 'sending' || !poToken}>
			{poTest === 'sending' ? 'Sende…' : poTest === 'ok' ? '✓ Gesendet' : poTest === 'err' ? '✗ Fehler' : 'Testnachricht senden'}
		</button>
	</section>

	<!-- Save notifications button -->
	<button class="btn btn-primary save-btn" onclick={saveNotifications} disabled={notifSaving}>
		{notifSaving ? 'Speichere…' : notifSaved ? '✓ Gespeichert' : 'Alarm-Einstellungen speichern'}
	</button>

	<!-- Account -->
	<section class="card">
		<h2>Konto</h2>
		<div class="info-row"><span class="lbl">E-Mail</span><span>{userEmail}</span></div>
		<div class="info-row"><span class="lbl">Rolle</span><span class="role-badge">{userRole}</span></div>
	</section>

	<!-- Password change -->
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

	<!-- System -->
	<section class="card">
		<h2>System</h2>
		<p class="sys-info">
			Supabase: <code>mtcmxrmykvthybwrlnvz.supabase.co</code><br />
			Region: eu-central-1
		</p>
		<button class="btn btn-danger mt" onclick={signOut}>Abmelden</button>
	</section>

</div>

<style>
	.settings { display: flex; flex-direction: column; gap: 12px; padding-bottom: 24px; }

	section h2 {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.8px;
		margin-bottom: 12px;
	}

	/* Relay list */
	.relay-list { display: flex; flex-direction: column; gap: 0; }
	.relay-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.relay-row:last-child { border-bottom: none; }
	.relay-label { font-size: 14px; }

	/* Test button */
	.test-btn { width: 100%; margin-top: 10px; font-size: 12px; }

	/* iOS-style toggle */
	.toggle-btn {
		width: 44px;
		height: 26px;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 13px;
		position: relative;
		transition: background 0.2s, border-color 0.2s;
		padding: 0;
		cursor: pointer;
		flex-shrink: 0;
	}
	.toggle-btn.on { background: var(--green); border-color: var(--green); }
	.knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 18px;
		height: 18px;
		background: var(--text);
		border-radius: 50%;
		transition: transform 0.2s;
		display: block;
	}
	.toggle-btn.on .knob { transform: translateX(18px); }

	/* Alarm delay + cloud */
	.field-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
	.field-row { display: flex; justify-content: space-between; align-items: center; }
	.field-label { font-size: 13px; color: var(--muted); }
	.field-val { font-size: 13px; font-weight: 600; color: var(--text); }
	.field-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
	.toggle-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}

	.slider-controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.step-btn {
		width: 36px;
		height: 36px;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text);
		font-size: 18px;
		font-weight: 300;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: border-color 0.15s;
	}
	.step-btn:active { border-color: var(--accent); color: var(--accent); }

	input[type="range"] {
		flex: 1;
		-webkit-appearance: none;
		appearance: none;
		height: 4px;
		background: var(--border);
		border-radius: 2px;
		outline: none;
	}
	input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		border: 3px solid var(--bg);
		box-shadow: 0 0 0 2px var(--accent);
	}

	/* Telegram / Pushover fields */
	.form-fields { display: flex; flex-direction: column; gap: 10px; }
	.field { display: flex; flex-direction: column; gap: 5px; }
	.field label { font-size: 12px; color: var(--muted); }

	/* Save button */
	.save-btn { width: 100%; }

	/* Account */
	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		font-size: 14px;
	}
	.info-row:last-child { border-bottom: none; }
	.lbl { color: var(--muted); }
	.role-badge {
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	/* System */
	.sys-info { font-size: 13px; color: var(--muted); line-height: 1.6; }
	code { font-size: 12px; color: var(--accent); }
	.mt { margin-top: 12px; }
</style>
