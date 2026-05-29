<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { anchorConfig } from '$lib/stores/anchor.js';

	type Device = { id: string; name: string; online: boolean; state: 0 | 1 | null };

	let devices = $state<Device[]>([]);
	let pollTimer: ReturnType<typeof setInterval>;

	const cfg = $derived($anchorConfig);

	function apiBase() {
		const srv = cfg?.shelly_cloud_server;
		const key = cfg?.shelly_cloud_auth_key;
		if (!srv || !key) return null;
		return { srv, key };
	}

	async function fetchDevices() {
		const api = apiBase();
		if (!api) return;
		try {
			const listRes = await fetch(
				`https://${api.srv}/interface/device/list?auth_key=${api.key}`
			);
			const listJson = await listRes.json();
			const devsMap: Record<string, { name: string; online: boolean }> =
				listJson?.data?.devices ?? listJson?.data?.devices_status ?? {};

			const ids = Object.keys(devsMap);
			if (!ids.length) { devices = []; return; }

			// Fetch switch states for all devices
			const stateRes = await fetch(
				`https://${api.srv}/v2/devices/api/get?auth_key=${api.key}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ids, select: ['status'] }),
				}
			);
			const stateJson = await stateRes.json();
			const statesData: Record<string, unknown> = stateJson?.data ?? {};

			devices = ids.map(id => {
				const info = devsMap[id] ?? {};
				const sw = (statesData[id] as Record<string, unknown> | undefined)?.['switch:0'] as Record<string, unknown> | undefined;
				const state: 0 | 1 | null = sw && 'output' in sw ? (sw.output ? 1 : 0) : null;
				return {
					id,
					name: info.name || id,
					online: Boolean(info.online),
					state,
				};
			}).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			// keep existing device list on transient error
		}
	}

	async function toggle(dev: Device) {
		const api = apiBase();
		if (!api) return;
		const newState = dev.state === 1 ? 0 : 1;
		// Optimistic update
		devices = devices.map(d => d.id === dev.id ? { ...d, state: newState as 0 | 1 } : d);
		try {
			await fetch(
				`https://${api.srv}/v2/devices/api/set/switch?auth_key=${api.key}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: dev.id, channel: 0, on: Boolean(newState) }),
				}
			);
		} catch {
			// revert optimistic update on error
			devices = devices.map(d => d.id === dev.id ? { ...d, state: dev.state } : d);
		}
	}

	onMount(() => {
		fetchDevices();
		pollTimer = setInterval(fetchDevices, 30_000);
	});

	onDestroy(() => clearInterval(pollTimer));
</script>

<div class="card">
	<div class="title">Shelly</div>
	{#if !cfg?.shelly_cloud_server}
		<div class="empty">Cloud-Zugangsdaten unter Settings konfigurieren.</div>
	{:else if devices.length === 0}
		<div class="empty">Verbinde…</div>
	{:else}
		<div class="list">
			{#each devices as dev (dev.id)}
				<div class="row">
					<div class="device-info">
						<span class="dot" class:online={dev.online}></span>
						<span class="label">{dev.name}</span>
					</div>
					<button
						class="toggle"
						class:on={dev.state === 1}
						aria-label="{dev.name} {dev.state === 1 ? 'aus' : 'ein'}schalten"
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
		display: flex; justify-content: space-between; align-items: center;
		padding: 8px 0; border-bottom: 1px solid var(--border);
	}
	.row:last-child { border-bottom: none; }
	.device-info { display: flex; align-items: center; gap: 8px; overflow: hidden; }
	.dot {
		width: 7px; height: 7px; border-radius: 50%;
		background: var(--muted); flex-shrink: 0; opacity: 0.4;
	}
	.dot.online { background: var(--green); opacity: 1; }
	.label { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.toggle {
		width: 44px; height: 26px; background: var(--card2); border: 1px solid var(--border);
		border-radius: 13px; position: relative; transition: background 0.2s, border-color 0.2s, opacity 0.2s;
		padding: 0; cursor: pointer; flex-shrink: 0;
	}
	.toggle.on { background: var(--green); border-color: var(--green); }
	.knob {
		position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
		background: var(--text); border-radius: 50%; transition: transform 0.2s; display: block;
	}
	.toggle.on .knob { transform: translateX(18px); }
</style>
