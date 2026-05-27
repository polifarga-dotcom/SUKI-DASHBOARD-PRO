<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';

	let email = $state('');
	let password = $state('');
	let loading = $state(false);
	let error = $state('');

	async function handleLogin(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		loading = true;

		const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });

		if (authError) {
			error = authError.message;
			loading = false;
			return;
		}

		if (data.session) {
			authStore.setSession(data.session);

			// Check force_password_change
			const { data: roleData } = await supabase
				.from('user_roles')
				.select('role, force_password_change')
				.eq('user_id', data.session.user.id)
				.single();

			authStore.setRole(roleData);

			if (roleData?.force_password_change) {
				goto('/change-password');
			} else {
				goto('/vessel');
			}
		}

		loading = false;
	}
</script>

<svelte:head><title>Login · SUKI PRO</title></svelte:head>

<main>
	<div class="login-wrap">
		<div class="logo">
			<span class="logo-suki">SUKI</span>
			<span class="logo-pro">PRO</span>
		</div>
		<p class="subtitle">Neel 47 · Dashboard</p>

		<form onsubmit={handleLogin} class="form">
			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

			<div class="field">
				<label for="email">E-Mail</label>
				<input
					id="email"
					type="email"
					bind:value={email}
					placeholder="deine@email.de"
					required
					autocomplete="email"
				/>
			</div>

			<div class="field">
				<label for="password">Passwort</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					placeholder="••••••••"
					required
					autocomplete="current-password"
				/>
			</div>

			<button type="submit" class="btn btn-primary w-full" disabled={loading}>
				{loading ? 'Anmelden…' : 'Anmelden'}
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

	.login-wrap {
		width: 100%;
		max-width: 360px;
	}

	.logo {
		text-align: center;
		margin-bottom: 4px;
		font-size: 36px;
		font-weight: 800;
		letter-spacing: 2px;
	}

	.logo-suki { color: var(--accent); }
	.logo-pro {
		color: var(--text);
		font-size: 18px;
		font-weight: 400;
		letter-spacing: 4px;
		margin-left: 4px;
	}

	.subtitle {
		text-align: center;
		color: var(--muted);
		font-size: 13px;
		margin-bottom: 32px;
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label {
		font-size: 13px;
		color: var(--muted);
		font-weight: 500;
	}

	.w-full { width: 100%; }
</style>
