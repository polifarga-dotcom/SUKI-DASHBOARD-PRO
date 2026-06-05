<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';
	import { k2cNum, fmtTemp } from '$lib/utils/units.js';
	import { unitSystem } from '$lib/stores/userSettings.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	// Engine running = RPM > 0. If engine is off, the alternator isn't charging —
	// zero out displayed values so stale data doesn't linger.
	// Falls back to alt_v > 13.5 V when RPM is unavailable (no RPM sensor).
	const portEngineOn = $derived(
		t?.eng_rpm    != null ? t.eng_rpm    > 0 :
		t?.eng_alt_v  != null ? t.eng_alt_v  > 13.5 : false
	);
	const sbEngineOn = $derived(
		t?.eng_sb_rpm   != null ? t.eng_sb_rpm   > 0 :
		t?.eng_sb_alt_v != null ? t.eng_sb_alt_v > 13.5 : false
	);

	const hasPort = $derived((t?.ws_0_alt_v != null || t?.ws_0_mode != null));
	const hasSb   = $derived((t?.ws_1_alt_v != null || t?.ws_1_mode != null));

	function modeColor(mode: string | null): string {
		if (!mode) return 'var(--muted)';
		const m = mode.toLowerCase();
		if (m === 'float')                        return 'var(--green)';
		if (m === 'bulk' || m === 'absorption')   return 'var(--amber)';
		if (m === 'off' || m === 'not charging')  return 'var(--muted)';
		return '#60a5fa'; // blue for "external control" / other
	}
</script>

{#if hasPort || hasSb}
<div class="card">
	<div class="title">Wakespeed</div>

	{#snippet altUnit(
		label: string,
		v: number | null,
		tempK: number | null,
		fieldPct: number | null,
		mode: string | null,
	)}
	<div class="alt-section">
		<div class="alt-header">
			<span>{label}</span>
			{#if mode}
				<span class="alt-mode" style="color:{modeColor(mode)}">{mode}</span>
			{/if}
		</div>
		<div class="grid-compact">
			{#if v != null}
				<ValueCell label="Voltage" value={v.toFixed(2)} unit="V" />
			{/if}
			{#if tempK != null}
				<ValueCell label="Temp" value={fmtTemp(k2cNum(tempK), $unitSystem)} />
			{/if}
			{#if fieldPct != null}
				<ValueCell label="Field" value={(fieldPct * 100).toFixed(0)} unit="%" />
			{/if}
		</div>
	</div>
	{/snippet}

	{#if hasPort}
		{@render altUnit(
			'Port',
			portEngineOn ? (t?.ws_0_alt_v ?? null)      : null,
			portEngineOn ? (t?.ws_0_alt_temp_k ?? null) : null,
			portEngineOn ? (t?.ws_0_field_pct ?? null)  : null,
			portEngineOn ? (t?.ws_0_mode ?? null)       : 'Off',
		)}
	{/if}
	{#if hasSb}
		{@render altUnit(
			'Starboard',
			sbEngineOn ? (t?.ws_1_alt_v ?? null)      : null,
			sbEngineOn ? (t?.ws_1_alt_temp_k ?? null) : null,
			sbEngineOn ? (t?.ws_1_field_pct ?? null)  : null,
			sbEngineOn ? (t?.ws_1_mode ?? null)       : 'Off',
		)}
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

	.alt-section {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px;
		background: var(--surface);
		margin-bottom: 10px;
	}
	.alt-section:last-child { margin-bottom: 0; }

	.alt-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}

	.alt-mode {
		font-size: 11px;
		font-weight: 500;
		text-transform: capitalize;
		letter-spacing: 0.3px;
	}

	.grid-compact {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
</style>
