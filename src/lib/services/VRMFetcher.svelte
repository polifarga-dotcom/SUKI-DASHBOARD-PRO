<script lang="ts">
	// Headless service component — no UI, only VRM data fetching.
	// Mount once in +layout.svelte so data is available app-wide.
	import { onDestroy } from 'svelte';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { currentBoat } from '$lib/stores/boat.js';
	import { vrmData, vrmError, vrmPolling, vrmLastFetchAt } from '$lib/stores/vrm.js';
	import { parseVRMDiagnostics } from '$lib/utils/vrm.js';

	let nextTimer: ReturnType<typeof setTimeout> | null = null;
	let fetching    = false;
	let lastKnownTs: number | null = null;

	const cfg = $derived($anchorConfig);
	const vrmToken  = $derived(cfg?.vrm_api_token          ?? null);
	const vrmInstId = $derived(cfg?.vrm_installation_id    ?? null);
	function apiReady() { return !!(vrmToken && vrmInstId); }

	function schedule(delayMs: number) {
		if (nextTimer) clearTimeout(nextTimer);
		nextTimer = setTimeout(fetchVRM, delayMs);
	}

	async function fetchVRM() {
		if (fetching) return;
		fetching = true;
		try {
			const boatId = $currentBoat?.id;
			let { data: json, error: fnErr } = await supabase.functions.invoke('vrm-proxy', {
				body: { boat_id: boatId },
			});
			// Retry once on auth error (handles iOS PWA background token expiry)
			if (fnErr) {
				const { error: refreshErr } = await supabase.auth.refreshSession();
				if (!refreshErr) {
					({ data: json, error: fnErr } = await supabase.functions.invoke('vrm-proxy', {
						body: { boat_id: boatId },
					}));
				}
			}
			if (fnErr) { vrmError.set(fnErr.message); schedule(30_000); return; }

			const parsed = parseVRMDiagnostics(json?.records ?? []);
			vrmData.set(parsed);
			vrmLastFetchAt.set(Math.floor(Date.now() / 1000));
			vrmError.set('');

			const newTs = parsed.last_ts;
			if (newTs && newTs !== lastKnownTs) {
				lastKnownTs = newTs;
				vrmPolling.set(false);
				const msUntilHotWindow = Math.max(5_000, (newTs + 55) * 1000 - Date.now());
				schedule(msUntilHotWindow);
			} else {
				vrmPolling.set(true);
				schedule(5_000);
			}
		} catch (e) {
			vrmError.set(String(e));
			schedule(30_000);
		} finally {
			fetching = false;
		}
	}

	// Start / restart only when actual VRM credentials change (not on every config poll)
	$effect(() => {
		if (!vrmToken || !vrmInstId) return;
		lastKnownTs = null;
		vrmPolling.set(false);
		fetchVRM();
		return () => { if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; } };
	});

	// Re-fetch when user returns to tab
	$effect(() => {
		const onVisible = () => {
			if (!document.hidden && apiReady()) {
				if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
				fetchVRM();
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	onDestroy(() => { if (nextTimer) clearTimeout(nextTimer); });
</script>
