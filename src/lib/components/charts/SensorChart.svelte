<script lang="ts">
	export type SensorPoint = { t: number; v: number | null };

	interface Props {
		points:       SensorPoint[];
		unit?:        string;
		threshold?:   number | null;
		thresholdDir?: 'above' | 'below' | 'deviation' | null;
		loading?:     boolean;
		color?:       string;   // RGB components e.g. "0,200,255"
		minRange?:    number;   // minimum Y-axis span in data units
	}
	let { points = [], unit = '', threshold = null, thresholdDir = null, loading = false,
	      color = '0,200,255', minRange = 0 }: Props = $props();

	// ── SVG coordinate space ─────────────────────────────────────────────────
	const W = 600, H = 62;
	const PL = 2, PR = 2, PT = 4, PB = 14;  // PB includes space for time axis
	const IW = W - PL - PR;
	const IH = H - PT - PB;

	// ── Time domain (last 24 h window) ───────────────────────────────────────
	const tMax   = $derived(points.at(-1)?.t ?? Date.now());
	const tMin   = $derived(points[0]?.t ?? (tMax - 86_400_000));
	const tRange = $derived(Math.max(tMax - tMin, 1));

	// ── Value domain ─────────────────────────────────────────────────────────
	const validVals = $derived(points.map(p => p.v).filter(v => v != null) as number[]);
	const hasData   = $derived(validVals.length >= 2);

	const rawMin = $derived(hasData ? Math.min(...validVals) : 0);
	const rawMax = $derived(hasData ? Math.max(...validVals) : 1);

	// Apply minRange: expand symmetrically around midpoint if data range is too small
	const mid       = $derived((rawMin + rawMax) / 2);
	const halfSpan  = $derived(Math.max((rawMax - rawMin) / 2, minRange / 2));
	const expandMin = $derived(mid - halfSpan);
	const expandMax = $derived(mid + halfSpan);

	// Include threshold in domain so it's always visible
	const domMin = $derived(threshold != null ? Math.min(expandMin, threshold) : expandMin);
	const domMax = $derived(threshold != null ? Math.max(expandMax, threshold) : expandMax);

	// 8% padding top + bottom so the line never clips the edges
	const domPad   = $derived(Math.max((domMax - domMin) * 0.08, 0.001));
	const padMin   = $derived(domMin - domPad);
	const domRange = $derived(domMax - domMin + 2 * domPad);

	// ── Coordinate helpers ───────────────────────────────────────────────────
	function tx(t: number): number { return PL + ((t - tMin) / tRange) * IW; }
	function vy(v: number): number { return PT + (1 - (v - padMin) / domRange) * IH; }

	// Unique gradient ID derived from color so multiple charts can coexist
	const gradId = $derived(`sg${color.replaceAll(',', '')}`);
	const zoneId = $derived(`sz${color.replaceAll(',', '')}`);

	// ── Catmull-Rom smoothing (from TripCharts) ──────────────────────────────
	const TENSION = 1.0;

	const linePts = $derived(
		points
			.filter(p => p.v != null)
			.map(p => [tx(p.t), vy(p.v!)] as [number, number])
	);

	const smoothD = $derived((() => {
		// Build segments (broken at nulls)
		const segments: [number, number][][] = [];
		let seg: [number, number][] = [];
		for (const p of points) {
			if (p.v == null) { if (seg.length) { segments.push(seg); seg = []; } continue; }
			seg.push([tx(p.t), vy(p.v)]);
		}
		if (seg.length) segments.push(seg);

		return segments.map(pts => {
			if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]}`;
			if (pts.length === 2) return `M${pts[0][0]} ${pts[0][1]} L${pts[1][0]} ${pts[1][1]}`;
			let d = `M${pts[0][0]} ${pts[0][1]}`;
			for (let i = 0; i < pts.length - 1; i++) {
				const p0 = pts[Math.max(i - 1, 0)];
				const p1 = pts[i];
				const p2 = pts[i + 1];
				const p3 = pts[Math.min(i + 2, pts.length - 1)];
				const cp1x = p1[0] + (p2[0] - p0[0]) / 6 * TENSION;
				const cp1y = p1[1] + (p2[1] - p0[1]) / 6 * TENSION;
				const cp2x = p2[0] - (p3[0] - p1[0]) / 6 * TENSION;
				const cp2y = p2[1] - (p3[1] - p1[1]) / 6 * TENSION;
				d += ` C${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
			}
			return d;
		}).join(' ');
	})());

	const areaD = $derived((() => {
		const base = PT + IH;
		const result: string[] = [];
		let seg = '', inSeg = false, lastX = 0;
		for (const p of points) {
			if (p.v != null) {
				const x = tx(p.t), y = vy(p.v);
				seg = inSeg ? seg + ` L${x.toFixed(2)} ${y.toFixed(2)}` : `M${x.toFixed(2)} ${base} L${x.toFixed(2)} ${y.toFixed(2)}`;
				inSeg = true; lastX = x;
			} else if (inSeg) {
				result.push(`${seg} L${lastX.toFixed(2)} ${base} Z`);
				seg = ''; inSeg = false;
			}
		}
		if (inSeg) result.push(`${seg} L${lastX.toFixed(2)} ${base} Z`);
		return result.join(' ');
	})());

	// ── Threshold line & zone ────────────────────────────────────────────────
	const threshY = $derived(threshold != null ? vy(threshold) : null);

	// Zone path: fill above/below threshold
	const zoneD = $derived((() => {
		if (threshY == null || !hasData || thresholdDir === 'deviation') return '';
		const base = thresholdDir === 'above' ? PT : PT + IH;
		const y0 = threshY;
		return `M${PL} ${y0} L${PL + IW} ${y0} L${PL + IW} ${base} L${PL} ${base} Z`;
	})());

	// ── Slider ────────────────────────────────────────────────────────────────
	let sliderVal = $state(1000);
	const cursorPct  = $derived(sliderVal / 1000);
	const cursorTime = $derived(tMin + cursorPct * tRange);
	const cursorX    = $derived(PL + cursorPct * IW);

	const cursorIdx = $derived((() => {
		if (!hasData) return -1;
		let best = 0, bestDist = Infinity;
		for (let i = 0; i < points.length; i++) {
			const d = Math.abs(points[i].t - cursorTime);
			if (d < bestDist) { bestDist = d; best = i; }
		}
		return best;
	})());

	const cursorVal = $derived(cursorIdx >= 0 ? points[cursorIdx]?.v : null);

	function fmtVal(v: number | null): string {
		if (v == null) return '—';
		const digits = (unit === 'V' || unit === '°C') ? 1 : (unit === 'hPa' ? 1 : 0);
		return v.toFixed(digits);
	}

	// ── Time axis labels (5 ticks) ───────────────────────────────────────────
	const timeTicks = $derived((() => {
		const n = 5;
		return Array.from({ length: n }, (_, i) => {
			const t = tMin + (i / (n - 1)) * tRange;
			const d = new Date(t);
			const h = d.getUTCHours().toString().padStart(2, '0');
			const m = d.getUTCMinutes().toString().padStart(2, '0');
			return { x: PL + (i / (n - 1)) * IW, label: `${h}:${m}` };
		});
	})());
</script>

<div class="sensor-chart-wrap">
	{#if loading}
	<div class="chart-loading">
		<div class="loading-bar"></div>
	</div>
	{:else if !hasData}
	<div class="chart-empty">No data for this period</div>
	{:else}
	<div class="chart-val-row">
		<span class="chart-val-label" style="color: rgba({color},1)">{fmtVal(cursorVal)} {unit}</span>
		<span class="chart-time-label">{new Date(cursorTime).toUTCString().slice(17, 22)} UTC</span>
	</div>
	<svg
		viewBox="0 0 {W} {H}"
		preserveAspectRatio="none"
		class="chart-svg"
		style="touch-action:none"
	>
		<defs>
			<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%"   stop-color="rgba({color},0.35)" />
				<stop offset="100%" stop-color="rgba({color},0)" />
			</linearGradient>
			<linearGradient id={zoneId} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%"   stop-color="rgba(255,60,60,0.18)" />
				<stop offset="100%" stop-color="rgba(255,60,60,0)" />
			</linearGradient>
		</defs>

		<!-- Threshold zone (gradient) -->
		{#if zoneD}
		<path d={zoneD} fill="url(#{zoneId})" />
		{/if}

		<!-- Area under curve (gradient infill) -->
		<path d={areaD} fill="url(#{gradId})" />

		<!-- Smooth line -->
		<path d={smoothD} fill="none" stroke="rgba({color},0.9)" stroke-width="1.4" />

		<!-- Threshold line -->
		{#if threshY != null}
		<line
			x1={PL} y1={threshY} x2={PL + IW} y2={threshY}
			stroke="rgba(255,60,60,0.6)" stroke-width="0.8" stroke-dasharray="4 3"
		/>
		{/if}

		<!-- Crosshair -->
		<line
			x1={cursorX} y1={PT} x2={cursorX} y2={PT + IH}
			stroke="rgba(255,255,255,0.2)" stroke-width="0.8"
		/>
		{#if cursorVal != null}
		{@const cy = vy(cursorVal)}
		<circle cx={cursorX} cy={cy} r="2.5" fill="rgba({color},1)" />
		{/if}

		<!-- Time axis labels -->
		{#each timeTicks as tick, i}
		<text
			x={tick.x}
			y={H - 1}
			font-size="6"
			fill="rgba(255,255,255,0.25)"
			text-anchor={i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'}
		>{tick.label}</text>
		{/each}
	</svg>
	<input
		type="range" min="0" max="1000" step="1"
		bind:value={sliderVal}
		class="chart-slider"
	/>
	{/if}
</div>

<style>
	.sensor-chart-wrap {
		margin: 4px 0 8px;
		background: var(--bg);
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid rgba(255,255,255,0.06);
	}

	.chart-val-row {
		display: flex; justify-content: space-between; align-items: baseline;
		padding: 6px 8px 2px;
	}
	.chart-val-label {
		font-size: 12px; font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.chart-time-label {
		font-size: 10px; color: rgba(255,255,255,0.25);
		font-variant-numeric: tabular-nums;
	}

	.chart-svg {
		width: 100%; height: auto;
		display: block;
	}

	.chart-slider {
		display: block; width: 100%;
		accent-color: var(--accent);
		background: none; border: none; cursor: pointer;
		padding: 0; margin: 0; height: 20px;
	}

	.chart-loading {
		height: 80px; display: flex; align-items: center; padding: 0 12px;
	}
	.loading-bar {
		width: 100%; height: 2px; border-radius: 1px;
		background: linear-gradient(90deg, transparent, rgba(0,200,255,0.4), transparent);
		background-size: 200% 100%;
		animation: shimmer 1.5s ease-in-out infinite;
	}
	@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }

	.chart-empty {
		height: 80px; display: flex; align-items: center; justify-content: center;
		font-size: 11px; color: rgba(255,255,255,0.2);
	}
</style>
