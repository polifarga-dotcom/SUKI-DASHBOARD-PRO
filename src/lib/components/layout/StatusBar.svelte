<script lang="ts">
	import { telemetry, dataStale } from '$lib/stores/telemetry.js';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { socColor, pressureColor, rigColor } from '$lib/utils/units.js';

	const t = $derived($telemetry);
	const stale = $derived($dataStale);
	const anc = $derived($anchorConfig);

	const anchColor = $derived(() => {
		if (!anc?.active) return 'var(--muted)';
		if (anc.alarming) return 'var(--red)';
		return 'var(--green)';
	});

	const battColor = $derived(() => socColor(t?.batt_main_soc ?? null));

	const solarColor = $derived(() => {
		const w = t?.solar_total_w;
		if (w == null) return 'var(--muted)';
		if (w > 50) return 'var(--green)';
		if (w > 0) return 'var(--amber)';
		return 'var(--muted)';
	});

	const windColor = $derived(() => {
		const kn = (t?.env_aws_ms ?? null);
		if (kn == null) return 'var(--muted)';
		const k = kn * 1.94384;
		if (k < 20) return 'var(--green)';
		if (k < 30) return 'var(--amber)';
		return 'var(--red)';
	});

	const pressColor = $derived(() => pressureColor(t?.env_pressure_pa ?? null));

	const engColor = $derived(() => {
		const rpm = t?.eng_rpm;
		if (rpm == null) return 'var(--muted)';
		return rpm > 100 ? 'var(--green)' : 'var(--muted)';
	});

	const items = $derived([
		{ label: '⚓', color: anchColor(), title: 'Anker' },
		{ label: '🔋', color: battColor(), title: 'Batterie' },
		{ label: '☀️', color: solarColor(), title: 'Solar' },
		{ label: '💨', color: windColor(), title: 'Wind' },
		{ label: '📊', color: pressColor(), title: 'Druck' },
		{ label: '⚙️', color: engColor(), title: 'Motor' },
	]);
</script>

<header class="status-bar" class:stale>
	{#each items as item}
		<div class="indicator" title={item.title}>
			<span class="icon">{item.label}</span>
			<span class="dot" style="background:{item.color}"></span>
		</div>
	{/each}
	{#if stale}
		<div class="stale-dot" title="Keine Daten">●</div>
	{/if}
</header>

<style>
	.status-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		height: var(--status-h);
		background: var(--card);
		border-bottom: 1px solid var(--border);
		padding: 0 16px;
		padding-top: env(safe-area-inset-top);
		flex-shrink: 0;
	}

	.status-bar.stale { opacity: 0.6; }

	.indicator {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.icon { font-size: 14px; line-height: 1; }
	.dot { width: 6px; height: 6px; border-radius: 50%; }

	.stale-dot {
		color: var(--amber);
		font-size: 10px;
		margin-left: 8px;
	}
</style>
