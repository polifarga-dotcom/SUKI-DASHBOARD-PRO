<script lang="ts">
	import { currentBoat } from '$lib/stores/boat.js';
	import { unitSystem, timeFormat, updateBoatSettings } from '$lib/stores/userSettings.js';
	import { supabase } from '$lib/supabase.js';

	let saving = $state(false);
	let message = $state('');

	async function saveSettings(updates: {
		unit_system?: 'metric' | 'imperial';
		time_format?: '12h' | '24h';
	}) {
		if (!$currentBoat?.id) return;

		saving = true;
		message = '';
		try {
			await updateBoatSettings(supabase, $currentBoat.id, updates);
			message = 'Settings saved ✓';
			setTimeout(() => { message = ''; }, 2000);
		} catch (err) {
			console.error('Failed to save settings:', err);
			message = 'Error saving settings';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>Settings · SUKI PRO</title></svelte:head>

{#if !$currentBoat}
	<div class="empty">No boat selected</div>
{:else}
	<div class="container">
		<h1>Settings</h1>

		<!-- Units & Time Format -->
		<section class="settings-group">
			<h2>Units & Time Format</h2>

			<div class="setting-row">
				<div class="setting-label">
					<h3>Measurements</h3>
					<p>Choose units for wave height and temperature</p>
				</div>
				<div class="radio-group">
					<label class:checked={$unitSystem === 'metric'}>
						<input
							type="radio"
							name="units"
							value="metric"
							checked={$unitSystem === 'metric'}
							onchange={() => saveSettings({ unit_system: 'metric' })}
							{saving}
						/>
						<span class="radio-label">Metric (m, °C)</span>
					</label>
					<label class:checked={$unitSystem === 'imperial'}>
						<input
							type="radio"
							name="units"
							value="imperial"
							checked={$unitSystem === 'imperial'}
							onchange={() => saveSettings({ unit_system: 'imperial' })}
							{saving}
						/>
						<span class="radio-label">Imperial (feet, °F)</span>
					</label>
				</div>
			</div>

			<div class="setting-row">
				<div class="setting-label">
					<h3>Time Format</h3>
					<p>Choose how times are displayed</p>
				</div>
				<div class="radio-group">
					<label class:checked={$timeFormat === '24h'}>
						<input
							type="radio"
							name="time"
							value="24h"
							checked={$timeFormat === '24h'}
							onchange={() => saveSettings({ time_format: '24h' })}
							{saving}
						/>
						<span class="radio-label">24-hour (14:30)</span>
					</label>
					<label class:checked={$timeFormat === '12h'}>
						<input
							type="radio"
							name="time"
							value="12h"
							checked={$timeFormat === '12h'}
							onchange={() => saveSettings({ time_format: '12h' })}
							{saving}
						/>
						<span class="radio-label">12-hour (2:30 PM)</span>
					</label>
				</div>
			</div>

			{#if message}
				<div class="message" class:error={message.includes('Error')}>{message}</div>
			{/if}
		</section>

		<!-- Boat Info -->
		<section class="settings-group">
			<h2>Boat</h2>
			<div class="info-row">
				<span class="label">Boat Name:</span>
				<span class="value">{$currentBoat.name}</span>
			</div>
			<div class="info-row">
				<span class="label">Boat ID:</span>
				<span class="value monospace">{$currentBoat.id}</span>
			</div>
		</section>
	</div>
{/if}

<style>
	:global(body) {
		background: var(--bg);
		color: var(--text);
	}

	.container {
		max-width: 600px;
		padding: 20px;
		margin: 0 auto;
	}

	h1 {
		font-size: 28px;
		font-weight: 700;
		margin: 0 0 30px;
		color: var(--text);
	}

	.settings-group {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 20px;
		margin-bottom: 20px;
	}

	.settings-group h2 {
		font-size: 14px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--muted);
		margin: 0 0 16px;
	}

	.setting-row {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 20px;
		padding: 16px 0;
		border-bottom: 1px solid var(--border);
	}

	.setting-row:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}

	.setting-label {
		flex: 1;
	}

	.setting-label h3 {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
		margin: 0 0 4px;
	}

	.setting-label p {
		font-size: 12px;
		color: var(--muted);
		margin: 0;
	}

	.radio-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 200px;
	}

	.radio-group label {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		padding: 6px 8px;
		border-radius: 4px;
		transition: background 0.2s;
	}

	.radio-group label:hover {
		background: var(--card2);
	}

	.radio-group label.checked {
		background: var(--card2);
	}

	.radio-group input[type='radio'] {
		cursor: pointer;
		width: 16px;
		height: 16px;
		margin: 0;
	}

	.radio-label {
		font-size: 13px;
		color: var(--text);
		font-weight: 500;
	}

	.message {
		margin-top: 12px;
		padding: 8px 12px;
		border-radius: 4px;
		font-size: 12px;
		color: var(--green);
		background: rgba(34, 197, 94, 0.1);
	}

	.message.error {
		color: var(--red);
		background: rgba(239, 68, 68, 0.1);
	}

	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 0;
		border-bottom: 1px solid var(--border);
		font-size: 13px;
	}

	.info-row:last-child {
		border-bottom: none;
	}

	.label {
		color: var(--muted);
		font-weight: 500;
	}

	.value {
		color: var(--text);
		font-weight: 600;
	}

	.monospace {
		font-family: 'Monaco', 'Menlo', monospace;
		font-size: 11px;
	}

	.empty {
		padding: 40px 20px;
		text-align: center;
		color: var(--muted);
		font-size: 14px;
	}

	@media (max-width: 480px) {
		.container {
			padding: 16px;
		}

		.setting-row {
			flex-direction: column;
			gap: 12px;
		}

		.radio-group {
			min-width: auto;
		}
	}
</style>
