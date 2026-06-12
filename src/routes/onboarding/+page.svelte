<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase.js';
	import { boatIconSettingsSvg, BOAT_ICON_LABELS } from '$lib/utils/boatIcons.js';
	import { pwaInstallPrompt } from '$lib/stores/pwa.js';

	// ── Step: 1 = name boat, 2 = configure APIs, 3 = install PWA ─────────────
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
	let s2Loading     = $state(false);
	let s2Error       = $state('');
	let skApiKey      = $state('');  // fetched after boat creation

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
		// Fetch the auto-generated SignalK API key so the user can copy it immediately
		const { data: cfgRow } = await supabase
			.from('anchor_config')
			.select('plugin_api_key')
			.eq('boat_id', result.boatId)
			.maybeSingle();
		skApiKey = cfgRow?.plugin_api_key ?? '';
		s1Loading = false;
		step = 2;
	}

	async function saveAndFinish() {
		if (!createdBoatId) { goto('/vessel'); return; }
		s2Error = '';

		// Only save if VRM credentials were entered
		if (vrmToken) {
			s2Loading = true;
			const patch: Record<string, unknown> = {};
			if (vrmToken)   patch.vrm_api_token       = vrmToken;
			if (vrmSiteId)  patch.vrm_installation_id = Number(vrmSiteId) || null;

			const { error } = await supabase
				.from('anchor_config')
				.update(patch)
				.eq('boat_id', createdBoatId);

			s2Loading = false;
			if (error) { s2Error = error.message; return; }
		}

		// Skip PWA install step if already running as standalone app
		const isStandalone =
			window.matchMedia('(display-mode: standalone)').matches ||
			(navigator as any).standalone === true;
		if (isStandalone) {
			goto('/vessel');
		} else {
			step = 3;
		}
	}

	async function installPwa() {
		const prompt = $pwaInstallPrompt;
		if (!prompt) return;
		prompt.prompt();
		const { outcome } = await prompt.userChoice;
		if (outcome === 'accepted') pwaInstallPrompt.set(null);
		goto('/vessel');
	}

	const isIOS = typeof navigator !== 'undefined' &&
		/iphone|ipad|ipod/i.test(navigator.userAgent) &&
		!(window as any).MSStream;

	let skKeyCopied = $state(false);
	async function copySkKey() {
		if (!skApiKey) return;
		await navigator.clipboard.writeText(skApiKey);
		skKeyCopied = true;
		setTimeout(() => { skKeyCopied = false; }, 2000);
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
		<!-- ── Step 2: Connect data sources ───────────────────── -->
		<h1 class="ob-title">Connect your boat</h1>
		<p class="ob-sub">You can configure all of this later in Settings.</p>

		{#if s2Error}
			<div class="ob-error">{s2Error}</div>
		{/if}

		<!-- SignalK — primary data source -->
		<div class="api-section">
			<div class="api-label-row">
				<div class="api-label">SignalK Bridge</div>
				<div class="api-badge primary">Primary</div>
			</div>
			<p class="api-desc">
				SignalK streams live data from your boat — GPS, speed, wind, depth, battery and engine.
				Install <code>signalk-plugin-suki-bridge</code> from your SignalK Appstore and paste this API Key into the plugin settings.
			</p>
			{#if skApiKey}
			<div class="field">
				<label>API Key</label>
				<div class="sk-copy-row">
					<input type="password" readonly value={skApiKey} class="sk-copy-input" />
					<button class="btn btn-ghost sk-copy-btn" onclick={copySkKey} type="button">
						{skKeyCopied ? '✓' : 'Copy'}
					</button>
				</div>
				<span class="field-hint-sm">Paste this into the signalk-plugin-suki-bridge settings</span>
			</div>
			{/if}
		</div>

		<!-- VRM — optional complement -->
		<div class="api-section">
			<div class="api-label-row">
				<div class="api-label">Victron VRM</div>
				<div class="api-badge optional">Optional</div>
			</div>
			<p class="api-desc">
				Cloud fallback for GPS when SignalK is offline. Only needed if you have a Cerbo GX linked to vrm.victronenergy.com.
			</p>
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

		<!-- Telegram — optional alerts -->
		<div class="api-section">
			<div class="api-label-row">
				<div class="api-label">Telegram Alerts</div>
				<div class="api-badge optional">Optional</div>
			</div>
			<p class="api-desc">
				Receive anchor alarm notifications on your phone via <strong>@SukiProBot</strong> — no token setup required.
				Open the link below in Telegram and tap <strong>Start</strong>.
			</p>
			{#if skApiKey}
			<a class="btn btn-ghost tg-ob-btn"
				href="https://t.me/SukiProBot?start={skApiKey}"
				target="_blank" rel="noopener">
				Open @SukiProBot in Telegram
			</a>
			<span class="field-hint-sm">Your activation code: <code>{skApiKey.slice(0,8)}…</code></span>
			{/if}
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

		{#if step === 3}
		<!-- ── Step 3: Install PWA ────────────────────────────── -->
		<div class="ob-logo">
			<img src="/logo.png" alt="SUKI PRO" class="logo-img" />
		</div>
		<h1 class="ob-title">Add to Home Screen</h1>
		<p class="ob-sub">Install SUKI PRO for the best experience — full screen, works offline, no browser chrome.</p>

		{#if $pwaInstallPrompt}
		<!-- Android / Chrome with native install API -->
		<div class="pwa-block">
			<div class="pwa-icon">📲</div>
			<p class="pwa-desc">Tap the button below to add SUKI PRO to your home screen with one tap.</p>
			<button class="btn btn-primary pwa-install-btn" onclick={installPwa}>
				Install App
			</button>
		</div>
		{:else if isIOS}
		<!-- iOS / Safari — manual instructions -->
		<div class="pwa-block">
			<ol class="pwa-steps">
				<li>
					<span class="pwa-step-num">1</span>
					<span>Tap the <strong>Share</strong> icon <span class="share-icon">⬆</span> in the Safari toolbar</span>
				</li>
				<li>
					<span class="pwa-step-num">2</span>
					<span>Scroll down and tap <strong>"Add to Home Screen"</strong></span>
				</li>
				<li>
					<span class="pwa-step-num">3</span>
					<span>Tap <strong>"Add"</strong> — done!</span>
				</li>
			</ol>
		</div>
		{/if}

		<div class="ob-actions" style="margin-top: 24px;">
			<button class="btn btn-ghost" onclick={() => goto('/vessel')}>
				{$pwaInstallPrompt || isIOS ? 'Skip' : 'Open App →'}
			</button>
			{#if isIOS}
			<button class="btn btn-primary" onclick={() => goto('/vessel')}>
				Done →
			</button>
			{/if}
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
	.api-label-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.api-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.8px;
	}
	.api-badge {
		font-size: 9px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		padding: 2px 6px;
		border-radius: 4px;
	}
	.api-badge.primary {
		background: rgba(0,200,255,.12);
		color: var(--accent);
		border: 1px solid rgba(0,200,255,.25);
	}
	.api-badge.optional {
		background: var(--card2);
		color: var(--muted);
		border: 1px solid var(--border);
	}
	.api-desc {
		font-size: 12px;
		color: var(--muted);
		margin: 0;
		line-height: 1.5;
	}
	.api-desc code {
		font-size: 11px;
		background: var(--card2);
		padding: 1px 4px;
		border-radius: 3px;
		color: var(--text);
	}
	.sk-copy-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.sk-copy-input {
		flex: 1;
		height: 38px;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0 10px;
		font-size: 13px;
		color: var(--text);
		font-family: monospace;
	}
	.sk-copy-btn {
		height: 38px;
		padding: 0 14px;
		font-size: 13px;
		white-space: nowrap;
	}
	.field-hint-sm {
		font-size: 11px;
		color: var(--muted);
		margin-top: 2px;
	}

	.tg-ob-btn {
		display: block;
		text-align: center;
		text-decoration: none;
		margin: 8px 0 4px;
		font-size: 13px;
	}

	/* ── PWA install step ── */
	.pwa-block {
		background: var(--card2, rgba(255,255,255,0.04));
		border: 1px solid var(--border, rgba(255,255,255,0.1));
		border-radius: 14px;
		padding: 20px 18px;
		margin: 8px 0;
	}
	.pwa-icon { font-size: 40px; text-align: center; margin-bottom: 12px; }
	.pwa-desc { font-size: 13px; color: var(--muted); text-align: center; margin: 0 0 16px; line-height: 1.5; }
	.pwa-install-btn { width: 100%; font-size: 15px; padding: 12px; }
	.pwa-steps {
		list-style: none; padding: 0; margin: 0;
		display: flex; flex-direction: column; gap: 14px;
	}
	.pwa-steps li {
		display: flex; align-items: flex-start; gap: 12px;
		font-size: 13px; line-height: 1.5; color: var(--text);
	}
	.pwa-step-num {
		width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
		background: var(--accent, #00c8ff); color: #000;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px; font-weight: 700; margin-top: 1px;
	}
	.share-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 22px; height: 22px; border-radius: 5px;
		background: var(--accent, #00c8ff); color: #000;
		font-size: 12px; font-weight: 700; vertical-align: middle;
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
