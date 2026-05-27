<script lang="ts">
	import { telemetry, dataStale } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { socColor, pressureColor, rigColor, fmtSOC, ms2kn, fmtPressure } from '$lib/utils/units.js';

	const t = $derived($telemetry);
	const stale = $derived($dataStale);
	const anc = $derived($anchorConfig);

	const anchColor = $derived(
		!anc?.active ? 'var(--muted)' :
		anc.alarming ? 'var(--red)' : 'var(--green)'
	);
	const anchLabel = $derived(
		!anc?.active ? 'ANKER' :
		anc.alarming ? 'ALARM' : 'OK'
	);

	const battColor = $derived(socColor(t?.batt_main_soc ?? null));
	const battLabel = $derived(
		t?.batt_main_soc != null ? fmtSOC(t.batt_main_soc) : '—'
	);

	const rigColorVal = $derived(() => {
		const maxRig = Math.max(t?.rig_port ?? 0, t?.rig_sb ?? 0);
		return rigColor(maxRig > 0 ? maxRig : null);
	});
	const rigLabel = $derived(() => {
		const maxRig = Math.max(t?.rig_port ?? 0, t?.rig_sb ?? 0);
		if (maxRig <= 0) return '—';
		return (maxRig / 9806.65).toFixed(1) + 't';
	});

	const windColor = $derived(() => {
		const ms = t?.env_aws_ms ?? null;
		if (ms == null) return 'var(--muted)';
		const kn = ms * 1.94384;
		if (kn < 20) return 'var(--green)';
		if (kn < 30) return 'var(--amber)';
		return 'var(--red)';
	});
	const windLabel = $derived(
		t?.env_aws_ms != null ? ms2kn(t.env_aws_ms) + ' kn' : '—'
	);

	const pressColor = $derived(pressureColor(t?.env_pressure_pa ?? null));
	const pressLabel = $derived(
		t?.env_pressure_pa != null
			? ((t.env_pressure_pa) / 100).toFixed(0) + ' hPa'
			: '—'
	);

	const engColor = $derived(() => {
		const rpm = t?.eng_rpm;
		if (rpm == null) return 'var(--muted)';
		return rpm > 100 ? 'var(--green)' : 'var(--muted)';
	});
	const engLabel = $derived(
		t?.eng_rpm != null && t.eng_rpm > 100
			? t.eng_rpm.toFixed(0) + ' rpm'
			: 'AUS'
	);

	const items = $derived([
		{ label: 'ANKER', val: anchLabel,  color: anchColor,     title: 'Anker' },
		{ label: 'BATT',  val: battLabel,  color: battColor,     title: 'Batterie' },
		{ label: 'RIG',   val: rigLabel(), color: rigColorVal(), title: 'Rigg' },
		{ label: 'WIND',  val: windLabel,  color: windColor(),   title: 'Wind' },
		{ label: 'DRUCK', val: pressLabel, color: pressColor,    title: 'Luftdruck' },
		{ label: 'MOTOR', val: engLabel,   color: engColor(),    title: 'Motor' },
	]);
</script>

<div class="status-bar" class:stale>
	{#each items as item}
		<div class="tile" title={item.title}>
			<div class="accent-bar" style="background:{item.color}"></div>
			<div class="tile-label">{item.label}</div>
			<div class="tile-val" style="color:{item.color}">{item.val}</div>
		</div>
	{/each}
</div>

<style>
	.status-bar {
		display: flex;
		height: var(--status-h);
		background: var(--card);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		transition: opacity 0.3s;
	}
	.status-bar.stale { opacity: 0.5; }

	.tile {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		position: relative;
		padding-top: 3px;
		border-right: 1px solid var(--border);
		overflow: hidden;
	}
	.tile:last-child { border-right: none; }

	.accent-bar {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
	}

	.tile-label {
		font-size: 8px;
		color: var(--muted);
		letter-spacing: 0.5px;
		line-height: 1;
	}

	.tile-val {
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
</style>
