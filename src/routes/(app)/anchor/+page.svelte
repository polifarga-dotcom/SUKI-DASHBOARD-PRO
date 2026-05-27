<script lang="ts">
	import { onMount } from 'svelte';
	import { telemetry } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { haversine, destinationPoint } from '$lib/utils/geo.js';
	import { fmtLatLon } from '$lib/utils/units.js';

	let mapEl: HTMLDivElement;
	let map: unknown = null;

	const boatLat = $derived($telemetry?.nav_lat ?? null);
	const boatLon = $derived($telemetry?.nav_lon ?? null);
	const hdgRad  = $derived($telemetry?.nav_hdg_rad ?? null);
	const cfg     = $derived($anchorConfig);
	const alarming = $derived(cfg?.alarming ?? false);

	const anchorDist = $derived(() => {
		if (!cfg?.lat || !cfg?.lon || !boatLat || !boatLon) return null;
		return haversine(boatLat, boatLon, cfg.lat, cfg.lon);
	});

	async function setAnchor() {
		if (!boatLat || !boatLon || !cfg) return;
		const [ancLat, ancLon] = destinationPoint(
			boatLat, boatLon, cfg.bearing_deg, cfg.chain_length_m
		);
		const { data } = await supabase
			.from('anchor_config')
			.update({ lat: ancLat, lon: ancLon, active: true })
			.eq('id', 1)
			.select()
			.single();
		if (data) anchorConfig.set(data);
	}

	async function clearAnchor() {
		const { data } = await supabase
			.from('anchor_config')
			.update({ active: false, alarming: false })
			.eq('id', 1)
			.select()
			.single();
		if (data) anchorConfig.set(data);
	}

	onMount(async () => {
		const L = await import('leaflet');
		await import('leaflet/dist/leaflet.css');

		map = L.map(mapEl, { zoomControl: true, attributionControl: false });
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19
		}).addTo(map as ReturnType<typeof L.map>);

		const m = map as ReturnType<typeof L.map>;
		if (boatLat && boatLon) m.setView([boatLat, boatLon], 15);
		else m.setView([0, 0], 2);
	});
</script>

<svelte:head><title>Anker · SUKI PRO</title></svelte:head>

{#if alarming}
	<div class="alarm-banner">⚓ ANKER-ALARM — Boot hat den sicheren Bereich verlassen!</div>
{/if}

<div class="map-wrap" class:alarming>
	<div bind:this={mapEl} class="map"></div>
</div>

<div class="controls card">
	<div class="row">
		<div>
			<div class="label">Boot</div>
			<div class="val">{fmtLatLon(boatLat, boatLon)}</div>
		</div>
		<div>
			<div class="label">Abstand</div>
			<div class="val">
				{anchorDist() != null ? anchorDist()!.toFixed(0) + ' m' : '—'}
				{#if cfg?.radius_m}
					<span class="muted"> / {cfg.radius_m}m</span>
				{/if}
			</div>
		</div>
	</div>

	{#if cfg}
		<div class="row params">
			<label>Kettenlänge
				<input type="number" min="5" max="100" value={cfg.chain_length_m}
					onchange={async (e) => {
						const v = parseInt((e.target as HTMLInputElement).value);
						const { data } = await supabase.from('anchor_config').update({ chain_length_m: v }).eq('id', 1).select().single();
						if (data) anchorConfig.set(data);
					}} /> m
			</label>
			<label>Radius
				<input type="number" min="10" max="500" value={cfg.radius_m}
					onchange={async (e) => {
						const v = parseInt((e.target as HTMLInputElement).value);
						const { data } = await supabase.from('anchor_config').update({ radius_m: v }).eq('id', 1).select().single();
						if (data) anchorConfig.set(data);
					}} /> m
			</label>
		</div>
	{/if}

	<div class="btn-row">
		{#if !cfg?.active}
			<button class="btn btn-primary" onclick={setAnchor} disabled={!boatLat}>
				⚓ Anker setzen
			</button>
		{:else}
			<button class="btn btn-danger" onclick={clearAnchor}>
				Anker lichten
			</button>
		{/if}
	</div>
</div>

<style>
	.alarm-banner {
		background: #450a0a;
		border: 2px solid var(--red);
		color: var(--red);
		border-radius: 8px;
		padding: 10px 14px;
		font-weight: 700;
		text-align: center;
		margin-bottom: 12px;
		animation: pulse 1s ease-in-out infinite alternate;
	}
	@keyframes pulse { from { opacity: 1; } to { opacity: 0.6; } }

	.map-wrap {
		border-radius: var(--r);
		overflow: hidden;
		height: 280px;
		border: 1px solid var(--border);
		margin-bottom: 12px;
	}
	.map-wrap.alarming { border-color: var(--red); }
	.map { width: 100%; height: 100%; }

	.controls { display: flex; flex-direction: column; gap: 12px; }
	.row { display: flex; gap: 16px; flex-wrap: wrap; }
	.label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.val { font-size: 14px; font-weight: 600; margin-top: 2px; }
	.muted { color: var(--muted); font-weight: 400; }

	.params { align-items: center; }
	.params label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
	.params input {
		width: 64px;
		padding: 4px 8px;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text);
		font-size: 13px;
		text-align: center;
	}

	.btn-row { display: flex; gap: 8px; }
</style>
