<script lang="ts">
	import { anchorConfig } from '$lib/stores/anchor.js';

	type Device = { id: string; name: string; online: boolean; state: 0 | 1 | null };

	let devices = $state<Device[]>([]);
	let loaded  = $state(false);

	const cfg = $derived($anchorConfig);

	function apiBase() {
		const srv = cfg?.shelly_cloud_server;
		const key = cfg?.shelly_cloud_auth_key;
		if (!srv || !key) return null;
		return { srv, key };
	}

	/** Extract On/Off state from any Shelly status object (Gen1 + Gen2). */
	function extractState(s: Record<string, unknown>): 0 | 1 | null {
		// Gen2 / Plus / Pro
		const sw2 = s['switch:0'] as Record<string, unknown> | undefined;
		if (sw2 && 'output' in sw2) return sw2.output ? 1 : 0;
		// Gen1
		const rels = s['relays'] as Array<{ ison: boolean }> | undefined;
		if (rels?.length && 'ison' in rels[0]) return rels[0].ison ? 1 : 0;
		return null;
	}

	/** Fetch current state for one device via /device/status (authoritative). */
	async function fetchOneState(srv: string, key: string, id: string): Promise<0 | 1 | null> {
		try {
			const r = await fetch(`https://${srv}/device/status`, {
				method:  'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body:    `auth_key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`,
			});
			const j = await r.json();
			const ds = (j?.data?.device_status ?? j?.data) as Record<string, unknown> | null;
			return ds ? extractState(ds) : null;
		} catch { return null; }
	}

	async function fetchDevices() {
		const api = apiBase();
		if (!api) return;
		try {
			// ── Step 1: device list (names + online status) ──────────────────────
			const listRes  = await fetch(`https://${api.srv}/interface/device/list?auth_key=${api.key}`);
			const listJson = await listRes.json();

			const devsInfo:   Record<string, Record<string, unknown>> = listJson?.data?.devices        ?? {};
			const devsStatus: Record<string, Record<string, unknown>> = listJson?.data?.devices_status ?? {};

			const ids = [...new Set([...Object.keys(devsInfo), ...Object.keys(devsStatus)])];
			if (!ids.length) { devices = []; loaded = true; return; }

			// Show names immediately (state still resolving)
			devices = ids.map(id => {
				const info   = devsInfo[id]   ?? {};
				const status = devsStatus[id] ?? {};
				return {
					id,
					name:   ((info.name ?? status.name ?? id) as string),
					online: Boolean(status.online),
					state:  extractState(status),   // best-effort from list; may be null
				};
			}).sort((a, b) => a.name.localeCompare(b.name));

			loaded = true;

			// ── Step 2: authoritative per-device status in parallel ───────────────
			const states = await Promise.all(
				ids.map(id => fetchOneState(api.srv, api.key, id).then(state => ({ id, state })))
			);

			// Merge: only overwrite if we got a real value
			devices = devices.map(dev => {
				const found = states.find(s => s.id === dev.id);
				return found?.state !== null ? { ...dev, state: found!.state } : dev;
			});

		} catch {
			loaded = true;
		}
	}

	async function toggle(dev: Device) {
		const api = apiBase();
		if (!api) return;
		const newState = dev.state === 1 ? 0 : 1;
		devices = devices.map(d => d.id === dev.id ? { ...d, state: newState as 0 | 1 } : d);
		try {
			const res = await fetch(
				`https://${api.srv}/v2/devices/api/set/switch?auth_key=${api.key}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: dev.id, channel: 0, on: Boolean(newState) }),
				}
			);
			if (!res.ok) {
				devices = devices.map(d => d.id === dev.id ? { ...d, state: dev.state } : d);
			}
		} catch {
			devices = devices.map(d => d.id === dev.id ? { ...d, state: dev.state } : d);
		}
	}

	// ── Reactive start: fetch as soon as credentials are ready ───────────────
	$effect(() => {
		if (!apiBase()) return;
		fetchDevices(); // immediate first fetch
		const timer = setInterval(fetchDevices, 30_000);
		return () => clearInterval(timer);
	});
</script>

{#if cfg?.shelly_cloud_server && (!loaded || devices.length > 0)}
<div class="card">
	<div class="title">Shelly</div>
	{#if !loaded}
		<div class="empty">Connecting…</div>
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
						aria-label="{dev.name} {dev.state === 1 ? 'turn off' : 'turn on'}"
						onclick={() => toggle(dev)}
					>
						<span class="knob"></span>
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>
{/if}

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
