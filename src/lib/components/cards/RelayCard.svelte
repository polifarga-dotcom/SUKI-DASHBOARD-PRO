<script lang="ts">
	import type { Telemetry } from '$lib/types.js';
	import { supabase } from '$lib/supabase.js';
	import { telemetry } from '$lib/stores/telemetry.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const relays = $derived([
		{ device: 'victron_relay', channel: '0', label: 'Relais 1', state: t?.relay_0 },
		{ device: 'victron_relay', channel: '1', label: 'Relais 2', state: t?.relay_1 },
		{ device: 'shelly', channel: '108', label: 'Hecklicht', state: t?.shelly_108, localOnly: true },
		{ device: 'shelly', channel: '102', label: 'Ambientelicht', state: t?.shelly_102, localOnly: true },
		{ device: 'shelly', channel: '118', label: 'Wasserpumpe', state: t?.shelly_118, localOnly: true },
	]);

	async function toggle(device: string, channel: string, currentState: 0 | 1 | null | undefined) {
		const newState = currentState === 1 ? 0 : 1;
		// Optimistic update
		telemetry.update(cur => {
			if (!cur) return cur;
			const key = device === 'shelly' ? `shelly_${channel}` : `relay_${channel}`;
			return { ...cur, [key]: newState };
		});
		await supabase.from('relay_commands').insert({ device, channel, desired_state: newState });
	}
</script>

<div class="card">
	<div class="card-head">
		<span class="title">Schalter</span>
		<span class="hint">Shelly: nur im Boot-LAN</span>
	</div>
	<div class="relays">
		{#each relays as r}
			<div class="relay-row">
				<div class="relay-info">
					<span class="relay-label">{r.label}</span>
					{#if r.localOnly}<span class="local-badge">LAN</span>{/if}
				</div>
				<button
					class="toggle"
					class:on={r.state === 1}
					aria-label="{r.label} {r.state === 1 ? 'aus' : 'ein'}schalten"
					onclick={() => toggle(r.device, r.channel, r.state)}
				>
					<span class="knob"></span>
				</button>
			</div>
		{/each}
	</div>
</div>

<style>
	.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.hint { font-size: 10px; color: var(--muted); }

	.relays { display: flex; flex-direction: column; gap: 2px; }
	.relay-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.relay-row:last-child { border-bottom: none; }

	.relay-info { display: flex; align-items: center; gap: 8px; }
	.relay-label { font-size: 14px; }
	.local-badge {
		font-size: 9px;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 1px 5px;
	}

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
