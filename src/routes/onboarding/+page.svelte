<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';

	// ── Step: 1 = name boat, 2 = configure APIs ───────────────────────────────
	let step = $state(1);

	// Step 1 — boat name
	let boatName  = $state('');
	let s1Loading = $state(false);
	let s1Error   = $state('');
	let createdBoatId = $state('');

	// Step 2 — API credentials (optional, skippable)
	let vrmToken      = $state('');
	let vrmSiteId     = $state('');
	let shellyServer  = $state('');
	let shellyKey     = $state('');
	let s2Loading     = $state(false);
	let s2Error       = $state('');

	async function createBoat() {
		s1Error = '';
		if (!boatName.trim()) { s1Error = 'Please enter a boat name'; return; }
		s1Loading = true;

		// Get current user
		const { data: { user } } = await supabase.auth.getUser();
		if (!user) { s1Error = 'Not authenticated'; s1Loading = false; return; }

		// Create boat
		const { data: boat, error: boatErr } = await supabase
			.from('boats')
			.insert({ name: boatName.trim(), created_by: user.id })
			.select()
			.single();

		if (boatErr || !boat) {
			s1Error = boatErr?.message ?? 'Failed to create boat';
			s1Loading = false;
			return;
		}

		// Add current user as admin member
		const { error: memberErr } = await supabase
			.from('boat_members')
			.insert({ boat_id: boat.id, user_id: user.id, role: 'admin' });

		if (memberErr) {
			s1Error = memberErr.message;
			s1Loading = false;
			return;
		}

		// Create anchor_config row with defaults
		await supabase.from('anchor_config').insert({
			boat_id: boat.id,
			active: false,
			radius_m: 50,
			chain_length_m: 30,
			bearing_deg: 0,
			alarm_delay_s: 30,
			alarming: false,
			cloud_enabled: false,
		});

		createdBoatId = boat.id;
		s1Loading = false;
		step = 2;
	}

	async function saveAndFinish() {
		if (!createdBoatId) { goto('/vessel'); return; }
		s2Error = '';

		// Only save if at least one API credential was entered
		const hasCreds = vrmToken || shellyServer;
		if (hasCreds) {
			s2Loading = true;
			const patch: Record<string, unknown> = {};
			if (vrmToken)     patch.vrm_api_token       = vrmToken;
			if (vrmSiteId)    patch.vrm_installation_id = Number(vrmSiteId) || null;
			if (shellyServer) patch.shelly_cloud_server  = shellyServer;
			if (shellyKey)    patch.shelly_cloud_auth_key = shellyKey;

			const { error } = await supabase
				.from('anchor_config')
				.update(patch)
				.eq('boat_id', createdBoatId);

			s2Loading = false;
			if (error) { s2Error = error.message; return; }
		}

		goto('/vessel');
	}
</script>

<svelte:head><title>Welcome · SUKI PRO</title></svelte:head>

<div class="ob-shell">
	<div class="ob-card">

		{#if step === 1}
		<!-- ── Step 1: Create boat ─────────────────────────────── -->
		<div class="ob-logo">
			<img src="/logo.png" alt="SUKI PRO" class="logo-img" />
		</div>
		<h1 class="ob-title">Welcome to SUKI PRO</h1>
		<p class="ob-sub">Start by giving your boat a name.</p>

		{#if s1Error}
			<div class="ob-error">{s1Error}</div>
		{/if}

		<div class="field">
			<label for="boat-name">Boat name</label>
			<input
				id="boat-name"
				type="text"
				bind:value={boatName}
				placeholder="e.g. Suki, Wanderer, Blue Horizon…"
				autocomplete="off"
				onkeydown={(e) => { if (e.key === 'Enter') createBoat(); }}
			/>
		</div>

		<button class="btn btn-primary" onclick={createBoat} disabled={s1Loading || !boatName.trim()}>
			{s1Loading ? 'Creating…' : 'Create boat →'}
		</button>

		{:else}
		<!-- ── Step 2: Optional API credentials ───────────────── -->
		<h1 class="ob-title">Connect data sources</h1>
		<p class="ob-sub">Optional — you can configure these later in Settings.</p>

		{#if s2Error}
			<div class="ob-error">{s2Error}</div>
		{/if}

		<div class="api-section">
			<div class="api-label">Victron VRM</div>
			<div class="field">
				<label for="vrm-token">API Token</label>
				<input id="vrm-token" type="password" bind:value={vrmToken}
					placeholder="VRM Portal → Preferences → Access Tokens" autocomplete="off" />
			</div>
			<div class="field">
				<label for="vrm-site">Installation ID</label>
				<input id="vrm-site" type="text" bind:value={vrmSiteId}
					placeholder="e.g. 123456" inputmode="numeric" autocomplete="off" />
			</div>
		</div>

		<div class="api-section">
			<div class="api-label">Shelly Cloud</div>
			<div class="field">
				<label for="sh-server">Server URL</label>
				<input id="sh-server" type="text" bind:value={shellyServer}
					placeholder="shelly-12-eu.shelly.cloud" autocomplete="off" />
			</div>
			<div class="field">
				<label for="sh-key">Auth Key</label>
				<input id="sh-key" type="password" bind:value={shellyKey}
					placeholder="Authorization cloud key" autocomplete="off" />
			</div>
		</div>

		<div class="ob-actions">
			<button class="btn btn-ghost" onclick={() => goto('/vessel')} disabled={s2Loading}>
				Skip
			</button>
			<button class="btn btn-primary" onclick={saveAndFinish} disabled={s2Loading}>
				{s2Loading ? 'Saving…' : 'Finish →'}
			</button>
		</div>
		{/if}

	</div>
</div>

<style>
	.ob-shell {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: var(--bg);
	}

	.ob-card {
		width: 100%;
		max-width: 400px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ob-logo {
		display: flex;
		justify-content: center;
		margin-bottom: 8px;
	}
	.logo-img {
		height: 48px;
		width: auto;
		object-fit: contain;
	}

	.ob-title {
		font-size: 22px;
		font-weight: 700;
		text-align: center;
		margin: 0;
	}
	.ob-sub {
		font-size: 14px;
		color: var(--muted);
		text-align: center;
		margin: 0;
	}

	.ob-error {
		background: rgba(239,68,68,.12);
		border: 1px solid rgba(239,68,68,.3);
		color: var(--red);
		border-radius: 8px;
		padding: 10px 14px;
		font-size: 13px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field label {
		font-size: 12px;
		color: var(--muted);
	}

	.btn {
		height: 48px;
		border-radius: 10px;
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
		border: none;
		transition: opacity 0.15s;
	}
	.btn:disabled { opacity: 0.5; cursor: default; }
	.btn-primary {
		background: var(--accent);
		color: #000;
		width: 100%;
	}
	.btn-ghost {
		background: var(--card2);
		border: 1px solid var(--border);
		color: var(--text);
	}

	.api-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 14px;
	}
	.api-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.8px;
	}

	.ob-actions {
		display: flex;
		gap: 10px;
	}
	.ob-actions .btn-ghost {
		flex: 0 0 100px;
	}
	.ob-actions .btn-primary {
		flex: 1;
	}
</style>
