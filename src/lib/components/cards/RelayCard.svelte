<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import { supabase } from '$lib/supabase.js';
	import { telemetry } from '$lib/stores/telemetry.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const relays = $derived([
		{ device: 'victron_relay', channel: '0', label: 'Water Heater', state: t?.relay_0 },
		{ device: 'victron_relay', channel: '1', label: 'Anchor Light', state: t?.relay_1 },
	]);

	async function toggle(device: string, channel: string, currentState: 0 | 1 | null | undefined) {
		const newState = currentState === 1 ? 0 : 1;
		// Optimistic update
		telemetry.update(cur => cur ? { ...cur, [`relay_${channel}`]: newState } : cur);
		await supabase.from('relay_commands').insert({ device, channel, desired_state: newState });
	}
</script>

<div class="card">
	<div class="title">Switches</div>
	<div class="relays">
		{#each relays as r}
			<div class="relay-row">
				<span class="relay-label">{r.label}</span>
				<button
					class="toggle"
					class:on={r.state === 1}
					aria-label="{r.label} {r.state === 1 ? 'turn off' : 'turn on'}"
					onclick={() => toggle(r.device, r.channel, r.state)}
				>
					<span class="knob"></span>
				</button>
			</div>
		{/each}
	</div>
</div>

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }

	.relays { display: flex; flex-direction: column; gap: 2px; }
	.relay-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.relay-row:last-child { border-bottom: none; }
	.relay-label { font-size: 14px; }

	/* iOS-style toggle */
	.toggle {
		width: 44px;
		height: 26px;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 13px;
		position: relative;
		transition: background 0.2s, border-color 0.2s;
		padding: 0;
		cursor: pointer;
	}
	.toggle.on { background: var(--green); border-color: var(--green); }

	.knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 18px;
		height: 18px;
		background: var(--text);
		border-radius: 50%;
		transition: transform 0.2s;
		display: block;
	}
	.toggle.on .knob { transform: translateX(18px); }
</style>
