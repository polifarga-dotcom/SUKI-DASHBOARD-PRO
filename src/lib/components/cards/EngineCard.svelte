<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import { onMount } from 'svelte';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';
	import { k2c, k2cNum, fmtRuntime, fmtTemp } from '$lib/utils/units.js';
	import { unitSystem } from '$lib/stores/userSettings.js';

	interface Props {
		t: Telemetry | null;
		boatId?: string;       // For multi-boat localStorage isolation
		engineCount?: 1 | 2;   // Configured engine count (from boat settings)
	}
	let { t, boatId = 'default', engineCount = 1 }: Props = $props();

	// Boat-specific localStorage keys for multi-boat support
	const portKey = `engine.${boatId}.port.runtime_sec`;
	const sbKey = `engine.${boatId}.starboard.runtime_sec`;

	// Runtime persistence (localStorage)
	let portRuntimeStored = $state<number | null>(null);
	let sbRuntimeStored = $state<number | null>(null);

	onMount(() => {
		// Load stored runtimes from localStorage
		const portStored = localStorage.getItem(portKey);
		const sbStored = localStorage.getItem(sbKey);
		if (portStored) portRuntimeStored = parseFloat(portStored);
		if (sbStored) sbRuntimeStored = parseFloat(sbStored);
	});

	// Update stored runtime whenever live data changes
	$effect(() => {
		if (t?.eng_run_sec != null) {
			portRuntimeStored = t.eng_run_sec;
			localStorage.setItem(portKey, t.eng_run_sec.toString());
		}
		if (t?.eng_sb_run_sec != null) {
			sbRuntimeStored = t.eng_sb_run_sec;
			localStorage.setItem(sbKey, t.eng_sb_run_sec.toString());
		}
	});

	// Check if motors have current data (besides runtime)
	const portHasLiveData = $derived(
		t?.eng_rpm != null || t?.eng_temp_k != null || t?.eng_alt_v != null
	);
	const sbHasLiveData = $derived(
		t?.eng_sb_rpm != null || t?.eng_sb_temp_k != null || t?.eng_sb_alt_v != null
	);

	// Runtime display (prefer live, fallback to stored)
	const portRuntime = $derived(t?.eng_run_sec ?? portRuntimeStored);
	const sbRuntime = $derived(t?.eng_sb_run_sec ?? sbRuntimeStored);

	// Motor count: configured engine_count is authoritative;
	// fall back to auto-detection from live data / stored runtime.
	const motorCount = $derived(
		engineCount === 2 ? 2 :
		(portHasLiveData || portRuntime != null ? 1 : 0) +
		(sbHasLiveData || sbRuntime != null ? 1 : 0)
	);

	// Hide card if no motors at all
	const hasAnyMotor = $derived(motorCount > 0);
</script>

{#if hasAnyMotor}
	<div class="card">
		<div class="title">Engine</div>

		{#if motorCount === 1}
			<!-- Single Motor -->
			<div class="grid">
				{#if portHasLiveData}
					<ValueCell label="Speed" value={t?.eng_rpm != null ? t.eng_rpm.toFixed(0) : null} unit="RPM" />
					<ValueCell label="Coolant" value={fmtTemp(k2cNum(t?.eng_temp_k ?? null), $unitSystem)} />
					<ValueCell label="Alternator" value={t?.eng_alt_v != null ? t.eng_alt_v.toFixed(1) : null} unit="V" />
				{/if}
				<ValueCell label="Runtime" value={fmtRuntime(portRuntime ?? null)} />
			</div>
		{:else if motorCount === 2}
			<!-- Dual Motors (Catamaran) -->
			<div class="motors-grid">
				<!-- Port Engine -->
				<div class="motor-section">
					<div class="motor-header">
						<span>Port</span>
						{#if portHasLiveData}
							<span class="live-dot">●</span>
						{/if}
					</div>
					<div class="grid-compact">
						{#if portHasLiveData}
							<ValueCell label="Speed" value={t?.eng_rpm != null ? t.eng_rpm.toFixed(0) : null} unit="RPM" />
							<ValueCell label="Coolant" value={fmtTemp(k2cNum(t?.eng_temp_k ?? null), $unitSystem)} />
							<ValueCell label="Alt" value={t?.eng_alt_v != null ? t.eng_alt_v.toFixed(1) : null} unit="V" />
						{/if}
						<ValueCell label="Runtime" value={fmtRuntime(portRuntime ?? null)} />
					</div>
				</div>

				<!-- Starboard Engine -->
				<div class="motor-section">
					<div class="motor-header">
						<span>Starboard</span>
						{#if sbHasLiveData}
							<span class="live-dot">●</span>
						{/if}
					</div>
					<div class="grid-compact">
						{#if sbHasLiveData}
							<ValueCell label="Speed" value={t?.eng_sb_rpm != null ? t.eng_sb_rpm.toFixed(0) : null} unit="RPM" />
							<ValueCell label="Coolant" value={fmtTemp(k2cNum(t?.eng_sb_temp_k ?? null), $unitSystem)} />
							<ValueCell label="Alt" value={t?.eng_sb_alt_v != null ? t.eng_sb_alt_v.toFixed(1) : null} unit="V" />
						{/if}
						<ValueCell label="Runtime" value={fmtRuntime(sbRuntime ?? null)} />
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.title {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 14px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 10px;
	}

	.motors-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 12px;
	}

	.motor-section {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px;
		background: var(--surface);
	}

	.motor-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}

	.live-dot {
		font-size: 8px;
		color: var(--green);
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.grid-compact {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
</style>
