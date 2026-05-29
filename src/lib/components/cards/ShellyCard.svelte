<script lang="ts">
	import { supabase } from '$lib/supabase.js';
	import { shellyDevices } from '$lib/stores/shelly.js';
	import type { ShellyDevice } from '$lib/types.js';

	const devices = $derived($shellyDevices);

	async function toggle(dev: ShellyDevice) {
		if (!dev.online || dev.state === null) return;
		const newState = dev.state === 1 ? 0 : 1;
		shellyDevices.update(list =>
			list.map(d => d.id === dev.id ? { ...d, state: newState as 0 | 1 } : d)
		);
		await supabase.from('relay_commands').insert({
			device: 'shelly_cloud',
			channel: dev.id,
			desired_state: newState,
		});
	}
</script>

<div class="card">
	<div class="title">Shelly</div>
	{#if devices.length === 0}
		<div class="empty">Keine Shelly-Geräte — Cloud-Zugangsdaten unter Settings konfigurieren.</div>
	{:else}
		<div class="list">
			{#each devices as dev (dev.id)}
				<div class="row">
					<div class="device-info">
						<span class="dot" class:online={dev.online}></span>
						<span class="label">{dev.name || dev.id}</span>
					</div>
					<button
						class="toggle"
						class:on={dev.state === 1}
						class:disabled={!dev.online || dev.state === null}
						aria-label="{dev.name} {dev.state === 1 ? 'aus' : 'ein'}schalten"
						disabled={!dev.online || dev.state === null}
						onclick={() => toggle(dev)}
					>
						<span class="knob"></span>
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }

	.empty { font-size: 13px; color: var(--muted); line-height: 1.5; }

	.list { display: flex; flex-direction: column; gap: 2px; }

	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.row:last-child { border-bottom: none; }

	.device-info { display: flex; align-items: center; gap: 8px; overflow: hidden; }

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--muted);
		flex-shrink: 0;
		opacity: 0.4;
	}
	.dot.online { background: var(--green); opacity: 1; }

	.label { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

	/* iOS-style toggle — gleich wie RelayCard */
	.toggle {
		width: 44px;
		height: 26px;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 13px;
		position: relative;
		transition: background 0.2s, border-color 0.2s, opacity 0.2s;
		padding: 0;
		cursor: pointer;
		flex-shrink: 0;
	}
	.toggle.on { background: var(--green); border-color: var(--green); }
	.toggle.disabled { opacity: 0.35; cursor: default; }

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
