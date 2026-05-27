<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';

	let pw = $state('');
	let pw2 = $state('');
	let loading = $state(false);
	let error = $state('');

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		error = '';

		if (pw.length < 8) {
			error = 'Passwort muss mindestens 8 Zeichen haben.';
			return;
		}
		if (pw !== pw2) {
			error = 'Passwörter stimmen nicht überein.';
			return;
		}

		loading = true;

		const { error: updateError } = await supabase.auth.updateUser({ password: pw });
		if (updateError) {
			error = updateError.message;
			loading = false;
			return;
		}

		// Clear force_password_change flag
		const { data: { session } } = await supabase.auth.getSession();
		if (session) {
			await supabase
				.from('user_roles')
				.update({ force_password_change: false })
				.eq('user_id', session.user.id);
		}

		authStore.clearPasswordChange();
		goto('/vessel');
	}
</script>

<svelte:head><title>Passwort ändern · SUKI PRO</title></svelte:head>

<main>
	<div class="wrap">
		<div class="logo">
			<span class="logo-suki">SUKI</span><span class="logo-pro">PRO</span>
		</div>

		<h1>Passwort setzen</h1>
		<p class="hint">Bitte lege beim ersten Login ein neues Passwort fest.</p>

		<form onsubmit={handleSubmit} class="form">
			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

			<div class="field">
				<label for="pw">Neues Passwort</label>
				<input
					id="pw"
					type="password"
					bind:value={pw}
					placeholder="min. 8 Zeichen"
					required
					autocomplete="new-password"
				/>
			</div>

			<div class="field">
				<label for="pw2">Passwort bestätigen</label>
				<input
					id="pw2"
					type="password"
					bind:value={pw2}
					placeholder="Wiederholung"
					required
					autocomplete="new-password"
				/>
			</div>

			<button type="submit" class="btn btn-primary w-full" disabled={loading}>
				{loading ? 'Speichere…' : 'Passwort speichern'}
			</button>
		</form>
	</div>
</main>

<style>
	main {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg);
		padding: 24px;
	}
	.wrap { width: 100%; max-width: 360px; }
	.logo {
		text-align: center;
		font-size: 28px;
		font-weight: 800;
		letter-spacing: 2px;
		margin-bottom: 24px;
	}
	.logo-suki { color: var(--accent); }
	.logo-pro { color: var(--text); font-size: 14px; font-weight: 400; letter-spacing: 4px; margin-left: 4px; }
	h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
	.hint { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
	.form { display: flex; flex-direction: column; gap: 16px; }
	.field { display: flex; flex-direction: column; gap: 6px; }
	label { font-size: 13px; color: var(--muted); font-weight: 500; }
	.w-full { width: 100%; }
</style>
