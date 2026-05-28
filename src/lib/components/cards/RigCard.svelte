<script lang="ts">
	import type { Telemetry } from '$lib/types.js';

	interface Props { t: Telemetry | null; }
	let { t }: Props = $props();

	const MAX_T  = 6.0;
	const WARN_T = 3.5;
	const CRIT_T = 4.2;

	// Tick positions as % of bar width
	const WARN_PCT = (WARN_T / MAX_T) * 100;   // 58.33 %
	const CRIT_PCT = (CRIT_T / MAX_T) * 100;   // 70.00 %

	function nToT(n: number | null): number | null {
		return n == null ? null : n / 9806.65;
	}
	function fillPct(tons: number | null): number {
		if (tons == null) return 0;
		return Math.min(tons / MAX_T, 1) * 100;
	}
	function valColor(tons: number | null): string {
		if (tons == null) return 'var(--muted)';
		if (tons >= CRIT_T) return 'var(--red)';
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

	<div class="bars">
		{#each sides as side}
			<div class="bar-row">
				<span class="bar-label">{side.label}</span>

				<div class="track">
					<!-- Dark overlay covers the unfilled right portion; slides left as load increases -->
					<div class="unfill" style="left: {fillPct(side.tons)}%"></div>
					<!-- Threshold tick lines -->
					<div class="tick-line" style="left: {WARN_PCT}%"></div>
					<div class="tick-line" style="left: {CRIT_PCT}%"></div>
				</div>

				<span class="val" style="color: {valColor(side.tons)}">
					{side.tons != null ? side.tons.toFixed(2) : '—'}{#if side.tons != null}<span class="unit"> t</span>{/if}
				</span>
			</div>
		{/each}

		<!-- Scale row: aligns with bar column via same grid -->
		<div class="bar-row scale-row" aria-hidden="true">
			<span></span>
			<div class="scale">
				<span class="s0">0</span>
				<span class="sw" style="left: {WARN_PCT}%">3.5 t</span>
				<span class="sc" style="left: {CRIT_PCT}%">4.2 t</span>
				<span class="s6">6 t</span>
			</div>
			<span></span>
		</div>
	</div>
</div>

<style>
	.title {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 16px;
	}

	/* ── layout ── */
	.bars { display: flex; flex-direction: column; gap: 10px; }

	.bar-row {
		display: grid;
		grid-template-columns: 2rem 1fr 4.5rem;
		align-items: center;
		gap: 10px;
	}

	.bar-label {
		font-size: 11px;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.8px;
		text-align: right;
	}

	/* ── bar track ── */
	.track {
		position: relative;
		height: 16px;
		border-radius: 8px;
		overflow: hidden;
		/*
		 * Three colour zones baked into the track:
		 *   green  0 – 58.33 % (0 – 3.5 t)
		 *   amber  58.33 – 70 % (3.5 – 4.2 t)
		 *   red    70 – 100 % (4.2 – 6 t)
		 */
		background: linear-gradient(to right,
			#22c55e 0%,     #22c55e 58.33%,
			#f59e0b 58.33%, #f59e0b 70%,
			#ef4444 70%,    #ef4444 100%
		);
	}

	/*
	 * Dark overlay that covers from the current load value to the right edge.
	 * As load grows, `left` increases → overlay shrinks → more colour is revealed.
	 */
	.unfill {
		position: absolute;
		top: 0; right: 0; bottom: 0;
		background: rgba(13, 13, 13, 0.84);
		transition: left 0.9s cubic-bezier(0.4, 0, 0.2, 1);
	}

	/* white tick marks at warning and critical thresholds */
	.tick-line {
		position: absolute;
		top: 0; bottom: 0;
		width: 2px;
		background: rgba(255, 255, 255, 0.45);
		z-index: 2;
		pointer-events: none;
	}

	/* ── numeric value ── */
	.val {
		font-size: 15px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}
	.unit { font-size: 11px; font-weight: 400; color: var(--muted); }

	/* ── scale labels ── */
	.scale-row { gap: 10px; }

	.scale {
		position: relative;
		height: 16px;
	}

	.scale span {
		position: absolute;
		font-size: 10px;
		color: var(--muted);
		white-space: nowrap;
	}
	/* "0" — left edge */
	.s0 { left: 0; }
	/* "3.5 t" — at warn tick, centred */
	.sw { transform: translateX(-50%); color: var(--amber); }
	/* "4.2 t" — at crit tick, centred */
	.sc { transform: translateX(-50%); color: var(--red); }
	/* "6 t" — right edge */
	.s6 { right: 0; }
</style>
