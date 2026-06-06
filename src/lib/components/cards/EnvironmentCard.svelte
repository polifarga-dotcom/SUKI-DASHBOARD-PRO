<script lang="ts">
	import type { Telemetry, VRMData } from '$lib/types.js';
	import ValueCell from '$lib/components/ui/ValueCell.svelte';
	import { ms2kn, rad2degStr, fmtDepthWithUnit, fmtPressure, pressureColor, fmtTemp, k2cNum } from '$lib/utils/units.js';
	import { unitSystem } from '$lib/stores/userSettings.js';
	import { supabase } from '$lib/supabase.js';
	import { currentBoat } from '$lib/stores/boat.js';

	interface Props { t: Telemetry | null; vrm: VRMData | null; }
	let { t, vrm }: Props = $props();

	const pressColor = $derived(pressureColor(t?.env_pressure_pa ?? null));
	const hasTanks   = $derived(!!vrm && vrm.tanks.length > 0);
	const hasTemps   = $derived(!!vrm && vrm.temperatures.length > 0);

	let sensorNames = $state<Record<number, string>>({});
	$effect(() => {
		const boatId = $currentBoat?.id;
		if (!boatId) return;
		supabase
			.from('temperature_sensors')
			.select('instance, custom_name')
			.eq('boat_id', boatId)
			.then(({ data }) => {
				sensorNames = {};
				data?.forEach(row => { sensorNames[row.instance] = row.custom_name; });
			});
	});

	function tempColor(celsius: number | null): string {
		if (celsius == null) return 'var(--muted)';
		if (celsius < 5)  return '#4f46e5';
		if (celsius < 20) return 'var(--green)';
		if (celsius < 28) return '#84cc16';
		if (celsius < 35) return 'var(--amber)';
		return 'var(--red)';
	}
	function tankColor(lvl: number): string {
		return lvl > 60 ? 'var(--green)' : lvl > 30 ? 'var(--amber)' : 'var(--red)';
	}
</script>

<div class="card">
	<div class="title">Environment &amp; Tanks</div>

	<!-- Env values — compact tile grid -->
	<div class="env-grid">
		<ValueCell label="Depth"    value={fmtDepthWithUnit(t?.env_depth_m ?? null, $unitSystem)} />
		<ValueCell label="AWS"      value={ms2kn(t?.env_aws_ms ?? null)} unit="kn" />
		<ValueCell label="AWA"      value={rad2degStr(t?.env_awa_rad ?? null)} />
		<ValueCell label="Pressure" value={fmtPressure(t?.env_pressure_pa ?? null)} color={pressColor} />
		<ValueCell label="Water"    value={fmtTemp(k2cNum(t?.temp_water ?? null), $unitSystem)} />
	</div>

	<!-- Tanks -->
	{#if hasTanks}
	<div class="sub-title">Tanks</div>
	<div class="tanks">
		{#each vrm!.tanks as tank}
		{@const lvl = Math.round(tank.level)}
		{@const tc  = tankColor(lvl)}
		<div class="tank-row">
			<span class="tank-name">{tank.name}</span>
			<div class="tank-track"><div class="tank-fill" style="width:{lvl}%; background:{tc}"></div></div>
			<span class="tank-pct" style="color:{tc}">{lvl}%</span>
		</div>
		{/each}
	</div>
	{/if}

	<!-- Temperatures — compact 3-column tiles, no gauge bar -->
	{#if hasTemps}
	<div class="sub-title">Temperatures</div>
	<div class="temp-grid">
		{#each vrm!.temperatures as sensor}
		{@const col = tempColor(sensor.celsius)}
		<div class="temp-tile">
			<div class="temp-val" style="color:{col}">{fmtTemp(sensor.celsius, $unitSystem)}</div>
			<div class="temp-name">{sensorNames[sensor.instance] ?? sensor.name}</div>
			{#if sensor.humidity != null}
			<div class="temp-hum">💧{Math.round(sensor.humidity)}%</div>
			{/if}
		</div>
		{/each}
	</div>
	{/if}
</div>

<style>
	.title {
		font-size: 13px; font-weight: 600; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;
	}
	.sub-title {
		font-size: 10px; font-weight: 600; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.5px;
		margin: 10px 0 6px;
		border-top: 1px solid rgba(255,255,255,0.06);
		padding-top: 10px;
	}

	/* Env tiles */
	.env-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
	@media (max-width: 380px) { .env-grid { grid-template-columns: repeat(2, 1fr); } }

	/* Tanks */
	.tanks { display: flex; flex-direction: column; gap: 5px; }
	.tank-row  { display: flex; align-items: center; gap: 6px; }
	.tank-name { font-size: 11px; color: var(--muted); min-width: 64px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tank-track { flex: 1; height: 5px; background: var(--card2); border-radius: 3px; overflow: hidden; }
	.tank-fill  { height: 100%; border-radius: 3px; transition: width 0.4s; }
	.tank-pct   { font-size: 11px; min-width: 30px; text-align: right; font-variant-numeric: tabular-nums; }

	/* Temperature tiles */
	.temp-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}
	@media (max-width: 380px) { .temp-grid { grid-template-columns: repeat(2, 1fr); } }

	.temp-tile {
		background: var(--card2);
		border-radius: 8px;
		padding: 7px 8px;
		display: flex; flex-direction: column; gap: 2px;
	}
	.temp-val  {
		font-size: 15px; font-weight: 700;
		font-variant-numeric: tabular-nums; line-height: 1;
	}
	.temp-name {
		font-size: 9px; color: var(--muted);
		text-transform: uppercase; letter-spacing: 0.4px;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.temp-hum  { font-size: 9px; color: var(--muted); }
</style>
