<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { authStore } from '$lib/stores/auth.js';

	type Mode = 'signin' | 'signup';

	let mode      = $state<Mode>('signin');
	let email     = $state('');
	let password  = $state('');
	let password2 = $state('');
	let loading   = $state(false);
	let error     = $state('');
	let signupDone = $state(false);   // email confirmation pending

	function switchMode(m: Mode) {
		mode = m; error = ''; signupDone = false;
		password = ''; password2 = '';
	}

	async function handleSignIn(e: SubmitEvent) {
		e.preventDefault();
		error = ''; loading = true;

		const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });

		if (authError) { error = authError.message; loading = false; return; }

		if (data.session) {
			authStore.setSession(data.session);

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

	async function handleSignUp(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (password.length < 8)    { error = 'Password must be at least 8 characters'; return; }
		if (password !== password2) { error = "Passwords don't match"; return; }
		loading = true;

		const { data, error: authError } = await supabase.auth.signUp({
			email,
			password,
			options: { emailRedirectTo: `${window.location.origin}/vessel` },
		});

		loading = false;
		if (authError) { error = authError.message; return; }

		if (data.session) {
			// Email confirmation disabled — logged in immediately
			authStore.setSession(data.session);
			goto('/onboarding');
		} else {
			// Email confirmation required — show success state
			signupDone = true;
		}
	}
</script>

<svelte:head><title>Login · SUKI PRO</title></svelte:head>

<main class="login-page">

	<!-- Boat illustration background -->
	<div class="boat-bg" aria-hidden="true">
		<img src="/boat.png" alt="" class="boat-img" />
	</div>

	<!-- Gradient vignette -->
	<div class="vignette" aria-hidden="true"></div>

	<!-- Content -->
	<div class="login-wrap">
		<div class="logo-area">
			<img src="/logo.png" alt="SUKI" class="logo-img" />
			<p class="tagline">Neel 47 · Rostock</p>
		</div>

		<div class="form-card">

			<!-- Mode tabs -->
			<div class="tabs">
				<button class="tab" class:active={mode === 'signin'} onclick={() => switchMode('signin')}>Sign in</button>
				<button class="tab" class:active={mode === 'signup'} onclick={() => switchMode('signup')}>Create account</button>
			</div>

			{#if signupDone}
				<!-- Confirmation pending -->
				<div class="signup-done">
					<div class="done-icon">✉️</div>
					<div class="done-title">Check your email</div>
					<div class="done-body">
						We sent a confirmation link to <strong>{email}</strong>.<br>
						Click it to activate your account, then sign in.
					</div>
					<button class="btn-link" onclick={() => { signupDone = false; switchMode('signin'); }}>
						Back to sign in
					</button>
				</div>

			{:else if mode === 'signin'}
				<form onsubmit={handleSignIn}>
					{#if error}<div class="alert alert-error">{error}</div>{/if}
					<div class="field">
						<label for="email">Email</label>
						<input id="email" type="email" bind:value={email}
							placeholder="you@example.com" required autocomplete="email" />
					</div>
					<div class="field">
						<label for="password">Password</label>
						<input id="password" type="password" bind:value={password}
							placeholder="••••••••" required autocomplete="current-password" />
					</div>
					<button type="submit" class="btn btn-primary submit-btn" disabled={loading}>
						{loading ? 'Signing in…' : 'Sign in'}
					</button>
				</form>

			{:else}
				<form onsubmit={handleSignUp}>
					{#if error}<div class="alert alert-error">{error}</div>{/if}
					<div class="field">
						<label for="su-email">Email</label>
						<input id="su-email" type="email" bind:value={email}
							placeholder="you@example.com" required autocomplete="email" />
					</div>
					<div class="field">
						<label for="su-pw">Password</label>
						<input id="su-pw" type="password" bind:value={password}
							placeholder="min. 8 characters" required autocomplete="new-password" />
					</div>
					<div class="field">
						<label for="su-pw2">Confirm password</label>
						<input id="su-pw2" type="password" bind:value={password2}
							placeholder="Repeat password" required autocomplete="new-password" />
					</div>
					<button type="submit" class="btn btn-primary submit-btn" disabled={loading}>
						{loading ? 'Creating account…' : 'Create account'}
					</button>
				</form>
			{/if}

		</div>
	</div>

</main>

<style>
	.login-page {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: #000000;
		padding:
			calc(env(safe-area-inset-top) + 32px)
			24px
			calc(env(safe-area-inset-bottom) + 32px);
		overflow: hidden;
		position: relative;
	}

	/* ── Boat background ── */
	.boat-bg {
		position: absolute;
		bottom: -4%;
		right: -8%;
		width: 90%;
		max-width: 480px;
		pointer-events: none;
		user-select: none;
	}
	.boat-img {
		width: 100%;
		height: auto;
		display: block;
		opacity: 0.32;
		filter: brightness(1.3);
	}

	/* Radial vignette */
	.vignette {
		position: absolute;
		inset: 0;
		background: radial-gradient(
			ellipse 120% 80% at 30% 40%,
			rgba(0,0,0,0.0) 0%,
			rgba(0,0,0,0.45) 55%,
			rgba(0,0,0,0.75) 100%
		);
		pointer-events: none;
	}

	/* ── Content ── */
	.login-wrap {
		width: 100%;
		max-width: 340px;
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	/* Logo */
	.logo-area {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}
	.logo-img  { height: 52px; width: auto; display: block; }
	.tagline   { font-size: 11px; color: var(--muted); letter-spacing: 3px; text-transform: uppercase; }

	/* Form card */
	.form-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px;
		padding: 20px 24px 24px;
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}

	/* Tabs */
	.tabs {
		display: flex;
		background: rgba(255,255,255,0.05);
		border-radius: 8px;
		padding: 3px;
		gap: 2px;
	}
	.tab {
		flex: 1; padding: 7px 0; border-radius: 6px; border: none;
		background: none; color: var(--muted); font-size: 13px; font-weight: 500;
		cursor: pointer; transition: all 0.15s;
	}
	.tab.active {
		background: rgba(255,255,255,0.1); color: var(--text);
	}

	/* Fields */
	.field        { display: flex; flex-direction: column; gap: 6px; }
	label         { font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: 0.3px; }
	.submit-btn   { width: 100%; margin-top: 4px; padding: 12px; font-size: 15px; font-weight: 600; letter-spacing: 0.3px; border-radius: 10px; }

	/* Signup done state */
	.signup-done {
		display: flex; flex-direction: column; align-items: center;
		gap: 10px; padding: 8px 0; text-align: center;
	}
	.done-icon  { font-size: 32px; line-height: 1; }
	.done-title { font-size: 16px; font-weight: 700; }
	.done-body  { font-size: 13px; color: var(--muted); line-height: 1.5; }
	.btn-link   {
		margin-top: 4px; background: none; border: none;
		color: var(--accent); font-size: 13px; cursor: pointer; text-decoration: underline;
	}
</style>
