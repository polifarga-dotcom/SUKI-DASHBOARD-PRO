<script lang="ts">
	import { anchorConfig } from '$lib/stores/anchor.js';

	type Device = { id: string; name: string; online: boolean; state: 0 | 1 | null };

	let devices = $state<Device[]>([]);
	let loaded  = $state(false);

	const cfg = $derived($anchorConfig);

	// Derived credential strings — $effect only re-runs when these actually change,
	// not on every anchorConfig poll tick (which would restart fetchDevices repeatedly)
	const shellySrv = $derived(cfg?.shelly_cloud_server  ?? null);
	const shellyKey = $derived(cfg?.shelly_cloud_auth_key ?? null);

	function apiBase() {
		if (!shellySrv || !shellyKey) return null;
		return { srv: shellySrv, key: shellyKey };
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

	/** Fetch current state for one device via /device/status. */
	async function fetchOneState(srv: string, key: string, id: string): Promise<0 | 1 | null> {
		try {
			const r = await fetch(`https://${srv}/device/status`, {
				method:  'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body:    `auth_key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`,
			});
			if (!r.ok) return null;
			const j = await r.json();
			const ds = j?.data?.device_status as Record<string, unknown> | undefined;
			return ds ? extractState(ds) : null;
		} catch { return null; }
	}

	async function fetchDevices() {
		const api = apiBase();
		if (!api) return;
		try {
			// ── Step 1: device list (names + online status) ──────────────────────
			// Note: list returns `devices` (metadata) only — no devices_status.
			// Online flag lives in devsInfo[id].cloud_online.
			const listRes  = await fetch(`https://${api.srv}/interface/device/list?auth_key=${api.key}`);
			const listJson = await listRes.json();

			const devsInfo: Record<string, Record<string, unknown>> = listJson?.data?.devices ?? {};
			const ids = Object.keys(devsInfo);
			if (!ids.length) { devices = []; loaded = true; return; }

			// Preserve last-known state across refreshes to avoid flicker
			const prev = new Map(devices.map(d => [d.id, d.state]));

			// Show names + online status immediately (switch state carries over or null on first load)
			devices = ids.map(id => {
				const info = devsInfo[id] ?? {};
				return {
					id,
					name:   (info.name ?? id) as string,
					online: Boolean(info.cloud_online ?? info.online),
					state:  prev.get(id) ?? null,
				};
			}).sort((a, b) => a.name.localeCompare(b.name));

			loaded = true;

			// ── Step 2: per-device status — sequential to respect rate limit (≈1 req/s) ──
			for (const id of ids) {
				await new Promise(r => setTimeout(r, 1000));
				const state = await fetchOneState(api.srv, api.key, id);
				if (state !== null) {
					devices = devices.map(d => d.id === id ? { ...d, state } : d);
				}
			}

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

	// ── Reactive start: only re-run when the credential strings change ───────
	// Reading shellySrv + shellyKey (not the whole cfg object) means this effect
	// won't restart on every anchorConfig poll tick — only on actual cred changes.
	$effect(() => {
		if (!shellySrv || !shellyKey) return;
		fetchDevices();
		const timer = setInterval(fetchDevices, 30_000);
		return () => clearInterval(timer);
	});
</script>

{#if shellySrv && shellyKey}
<div class="card">
	<div class="title">Shelly</div>
	{#if !loaded}
		<div class="empty">Connecting…</div>
	{:else}
		<div class="grid">
			{#each devices as dev (dev.id)}
				<button
					class="tile"
					class:on={dev.state === 1}
					class:offline={!dev.online}
					aria-label="{dev.name} {dev.state === 1 ? 'turn off' : 'turn on'}"
					onclick={() => toggle(dev)}
				>
					<span class="dot" class:online={dev.online}></span>
					<span class="name">{dev.name}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>
{/if}

<style>
	.title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
	.empty { font-size: 13px; color: var(--muted); }
	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}
	.tile {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 6px; padding: 10px 6px;
		background: var(--card2); border: 1px solid var(--border);
		border-radius: 10px; cursor: pointer;
		transition: background 0.18s, border-color 0.18s;
		min-height: 62px;
	}
	.tile:active { transform: scale(0.96); }
	.tile.on {
		background: rgba(0, 200, 100, 0.15);
		border-color: rgba(0, 200, 100, 0.5);
	}
	.tile.offline { opacity: 0.45; cursor: default; }
	.dot {
		width: 7px; height: 7px; border-radius: 50%;
		background: #444; flex-shrink: 0;
	}
	.dot.online { background: var(--green); }
	.tile.on .dot.online { background: var(--green); box-shadow: 0 0 5px var(--green); }
	.name {
		font-size: 11px; font-weight: 600; text-align: center;
		color: var(--text); line-height: 1.2;
		word-break: break-word;
	}
	.tile.on .name { color: var(--green); }
</style>
