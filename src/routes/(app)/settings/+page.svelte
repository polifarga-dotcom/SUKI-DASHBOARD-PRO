<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';

	let { data } = $props();

	let pw = $state('');
	let pw2 = $state('');
	let pwLoading = $state(false);
	let pwError = $state('');
	let pwSuccess = $state(false);

	const userEmail = $derived($authStore.session?.user?.email ?? '—');
	const userRole = $derived($authStore.roleData?.role ?? '—');

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

	async function signOut() {
		await supabase.auth.signOut();
		authStore.clear();
		goto('/login');
	}
</script>

<svelte:head><title>Settings · SUKI PRO</title></svelte:head>

<div class="settings">
	<section class="card">
		<h2>Konto</h2>
		<div class="info-row"><span class="label">E-Mail</span><span>{userEmail}</span></div>
		<div class="info-row"><span class="label">Rolle</span><span class="role">{userRole}</span></div>
	</section>

	<section class="card">
		<h2>Passwort ändern</h2>
		<form onsubmit={changePassword} class="form">
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

	<section class="card">
		<h2>System</h2>
		<p class="muted-text">
			Supabase: <code>mtcmxrmykvthybwrlnvz.supabase.co</code><br />
			Region: eu-central-1
		</p>
		<button class="btn btn-danger mt" onclick={signOut}>Abmelden</button>
	</section>
</div>

<style>
	.settings { display: flex; flex-direction: column; gap: 12px; }
	section h2 { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
	.info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
	.info-row:last-child { border-bottom: none; }
	.label { color: var(--muted); }
	.role { background: var(--card2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
	.form { display: flex; flex-direction: column; gap: 12px; }
	.field { display: flex; flex-direction: column; gap: 6px; }
	.field label { font-size: 13px; color: var(--muted); }
	.muted-text { font-size: 13px; color: var(--muted); line-height: 1.6; }
	code { font-size: 12px; color: var(--accent); }
	.mt { margin-top: 12px; }
</style>
