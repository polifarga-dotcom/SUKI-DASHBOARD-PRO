<script lang="ts">
	import type { Telemetry } from '$lib/types.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const MAX_T  = 4.2;
	const WARN_T = 3.5;
	/** warning line position as % from bottom */
	const WARN_PCT = (WARN_T / MAX_T) * 100; // ≈ 83.3 %

	function nToT(n: number | null): number | null {
		return n == null ? null : n / 9806.65;
	}
	function fillPct(tons: number | null): number {
		if (tons == null) return 0;
		return Math.min(tons / MAX_T, 1) * 100;
	}
	function barColor(tons: number | null): string {
		if (tons == null) return 'var(--border)';
		if (tons > MAX_T)   return 'var(--red)';
		if (tons >= WARN_T) return 'var(--amber)';
		return 'var(--green)';
	}

	const portT = $derived(nToT(t?.rig_port ?? null));
	const sbT   = $derived(nToT(t?.rig_sb   ?? null));

	const sides = $derived([
		{ label: 'BB', tons: portT },
		{ label: 'SB', tons: sbT  },
	]);
</script>

<div class="card">
	<div class="title">Rigg</div>

	<div class="gauges">
		{#each sides as side}
			<div class="side">
				<!-- vertical gauge bar -->
				<div class="track-wrap">
					<!-- max reference tick (top) -->
					<span class="ref-tick ref-max">4.2 t</span>
					<!-- warn reference tick (at 3.5 t) -->
					<span class="ref-tick ref-warn" style="bottom: {WARN_PCT}%">3.5 t</span>

					<div class="track">
						<!-- dashed warning threshold line -->
						<div class="warn-line" style="bottom: {WARN_PCT}%"></div>
						<!-- animated fill -->
						<div
							class="fill"
							class:pulsing={side.tons != null && side.tons >= WARN_T}
							style="height: {fillPct(side.tons)}%; background: {barColor(side.tons)};"
						></div>
					</div>
				</div>

				<!-- numeric value -->
				<div class="val" style="color: {barColor(side.tons)}">
					{side.tons != null ? side.tons.toFixed(2) : '—'}<span class="unit">{side.tons != null ? ' t' : ''}</span>
				</div>

				<!-- side label -->
				<div class="lbl">{side.label}</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.title {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 20px;
	}

	.gauges {
		display: flex;
		justify-content: space-around;
		align-items: flex-start;
		gap: 8px;
		padding: 0 4px 4px;
	}

	.side {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}

	/* ── track wrap (bar + floating tick labels) ── */
	.track-wrap {
		position: relative;
		width: 44px;
		height: 92px;
		/* allow tick labels to overflow left */
		overflow: visible;
	}

	.ref-tick {
		position: absolute;
		right: calc(100% + 5px);
		font-size: 9px;
		color: var(--muted);
		white-space: nowrap;
		line-height: 1;
	}
	.ref-max  { top: 0;    transform: translateY(-50%); }
	.ref-warn { /* bottom set inline */ transform: translateY(50%); }

	.track {
		width: 100%;
		height: 100%;
		background: var(--card2);
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		position: relative;
	}

	/* dashed warning threshold */
	.warn-line {
		position: absolute;
		left: 0;
		right: 0;
		height: 1px;
		background: repeating-linear-gradient(
			to right,
			var(--amber) 0px,
			var(--amber) 3px,
			transparent 3px,
			transparent 6px
		);
		opacity: 0.65;
		z-index: 2;
		pointer-events: none;
	}

	/* animated fill bar */
	.fill {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		transition: height 0.9s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.3s;
		border-radius: 0 0 5px 5px;
		z-index: 1;
	}
	.fill.pulsing {
		animation: rig-pulse 1.8s ease-in-out infinite;
	}
	@keyframes rig-pulse {
		0%, 100% { opacity: 1; }
		50%       { opacity: 0.5; }
	}

	/* ── numeric value ── */
	.val {
		font-size: 18px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.unit {
		font-size: 11px;
		font-weight: 400;
		color: var(--muted);
	}

	/* ── side label ── */
	.lbl {
		font-size: 11px;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.8px;
	}
</style>
