<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { boatIconSettingsSvg, BOAT_ICON_LABELS } from '$lib/utils/boatIcons.js';

	// ── Step: 1 = name boat, 2 = configure APIs ───────────────────────────────
	let step = $state(1);

	// Step 1 — boat name + unit preferences
	let boatName     = $state('');
	let unitSystem   = $state<'metric' | 'imperial'>('metric');
	let timeFormat   = $state<'24h' | '12h'>('24h');
	let boatIcon     = $state('monohull');
	let s1Loading    = $state(false);
	let s1Error      = $state('');
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

		// Use edge function — service role bypasses RLS; JWT is auto-attached by SDK
		const { data: result, error: fnErr } = await supabase.functions.invoke('create-boat', {
			body: {
				name: boatName.trim(),
				unit_system: unitSystem,
				time_format: timeFormat,
				boat_icon: boatIcon,
			},
		});

		if (fnErr || !result?.ok) {
			s1Error = result?.error ?? fnErr?.message ?? 'Failed to create boat';
			s1Loading = false;
			return;
		}

		createdBoatId = result.boatId;
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

		<!-- Unit preferences -->
		<div class="pref-section">
			<h2>Preferred Units</h2>
			<div class="radio-group">
				<label>
					<input type="radio" name="units" value="metric" bind:group={unitSystem} />
					Metric (m, °C)
				</label>
				<label>
					<input type="radio" name="units" value="imperial" bind:group={unitSystem} />
					Imperial (feet, °F)
				</label>
			</div>
		</div>

		<!-- Time format -->
		<div class="pref-section">
			<h2>Time Format</h2>
			<div class="radio-group">
				<label>
					<input type="radio" name="time" value="24h" bind:group={timeFormat} />
					24-hour (14:30)
				</label>
				<label>
					<input type="radio" name="time" value="12h" bind:group={timeFormat} />
					12-hour (2:30 PM)
				</label>
			</div>
		</div>

		<!-- Boat icon -->
		<div class="pref-section">
			<h2>Boat Type</h2>
			<div class="icon-grid">
				{#each Object.entries(BOAT_ICON_LABELS) as [key, label]}
				<button
					class="icon-btn"
					class:selected={boatIcon === key}
					onclick={() => boatIcon = key}
					type="button"
				>
					<span class="icon-svg">{@html boatIconSettingsSvg(key)}</span>
					<span class="icon-label">{label}</span>
				</button>
				{/each}
			</div>
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

	.pref-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px 14px;
	}
	.pref-section h2 {
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin: 0 0 4px;
	}

	.radio-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.radio-group label {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		font-size: 13px;
		color: var(--text);
		padding: 4px;
	}
	.radio-group input[type='radio'] {
		cursor: pointer;
		width: 14px;
		height: 14px;
		margin: 0;
	}

	.icon-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 8px;
	}
	.icon-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 10px 4px 8px;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--card2);
		cursor: pointer;
		color: var(--muted);
		transition: border-color 0.15s, color 0.15s, background 0.15s;
	}
	.icon-btn:hover { border-color: var(--accent); color: var(--text); }
	.icon-btn.selected {
		border-color: var(--accent);
		background: rgba(0, 200, 255, 0.08);
		color: var(--accent);
	}
	.icon-svg { display: flex; align-items: center; line-height: 0; }
	.icon-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
</style>
