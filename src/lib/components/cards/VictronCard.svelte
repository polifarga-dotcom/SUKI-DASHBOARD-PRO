<script lang="ts">
	import { vrmData } from '$lib/stores/vrm.js';

	const data = $derived($vrmData);

	// ── Derived values ────────────────────────────────────────────────────────
	const batSoc    = $derived(data?.battery_soc   ?? null);   // 0–100
	const batV      = $derived(data?.battery_v     ?? null);
	const batA      = $derived(data?.battery_a     ?? null);
	const batW      = $derived(data?.battery_w     ?? null);
	const batTTG    = $derived(data?.batteries[0]?.time_to_go_s ?? null);
	const solW      = $derived(data?.solar_w       ?? null);
	const acInW     = $derived(data?.ac_input_w    ?? null);
	const acInV     = $derived(data?.ac_input_v    ?? null);
	const loadW     = $derived(data?.load_w        ?? null);
	const vebDcA    = $derived(data?.vebus_dc_a    ?? null);
	const batName   = $derived(data?.batteries[0]?.name ?? 'Battery');

	// DC Loads = |battery discharge| − solar − VE.Bus DC draw (Victron Venus OS formula)
	const dcLoadsW  = $derived((() => {
		if (!data || batW == null) return null;
		const discharge = -Math.min(batW, 0);           // positive when discharging
		const solar     = Math.max(0, solW ?? 0);
		const vebDC     = vebDcA != null && batV != null
			? Math.max(0, vebDcA) * Math.abs(batV)   // positive = inverter consuming DC
			: 0;
		const dc = Math.round(discharge - solar - vebDC);
		return dc > 5 ? dc : null;
	})());

	// Charging / discharging / idle
	const isCharging    = $derived((batA ?? 0) > 0.5);
	const isDischarging = $derived((batA ?? 0) < -0.5);
	const isShoreOn     = $derived((acInW ?? 0) > 5 || (acInV ?? 0) > 50);
	const isSolarOn     = $derived((solW ?? 0) > 5);
	const hasLoad       = $derived((loadW ?? 0) > 5);
	const hasDcLoad     = $derived(dcLoadsW != null && dcLoadsW > 5);

	// Inverter/Charger state text (matching Victron labels)
	const inverterState = $derived(
		isShoreOn && isCharging    ? 'Charging' :
		isShoreOn && !isCharging   ? 'Pass-through' :
		isDischarging              ? 'Inverting' :
		                             'Idle'
	);

	// Battery status
	const battStatus = $derived(
		data?.mpptsArr.some(m => m.state === 5) && !isDischarging ? 'Float' :
		isCharging    ? 'Charging' :
		isDischarging ? 'Discharging' :
		                'Idle'
	);

	// Time-to-go formatter: "1d 7h" style
	function fmtTTG(s: number | null): string {
		if (!s || s <= 0) return '—';
		const d = Math.floor(s / 86400);
		const h = Math.floor((s % 86400) / 3600);
		return d > 0 ? `${d}d ${h}h` : `${h}h`;
	}

	function fmtW(w: number | null): string {
		return w != null ? `${Math.abs(Math.round(w))} W` : '— W';
	}
	function fmtA(a: number | null): string {
		return a != null ? `${a.toFixed(1)} A` : '— A';
	}
	function fmtV(v: number | null): string {
		return v != null ? `${v.toFixed(2)} V` : '— V';
	}

	// Solar bar chart: up to 5 MPPTs, normalised to max yield today
	const solarBars = $derived((() => {
		if (!data?.mpptsArr.length) {
			// Fallback: single bar from total yield today
			const wh = data?.solar_yield_today_wh ?? 0;
			return [{ pct: wh > 0 ? 100 : 0, name: 'Solar' }];
		}
		const maxWh = Math.max(...data.mpptsArr.map(m => m.yield_today_wh), 1);
		return data.mpptsArr.slice(0, 5).map(m => ({
			pct: Math.round((m.yield_today_wh / maxWh) * 100),
			name: m.name,
		}));
	})());
</script>

<div class="vic-card">
	<div class="vic-title">Victron</div>

	<!-- Flow diagram grid -->
	<div class="vic-grid">

		<!-- ── Row 1 ── -->

		<!-- Shore Power -->
		<div class="vic-box" class:vic-box--active={isShoreOn}>
			<div class="vic-box-header">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/>
					<line x1="8" y1="4" x2="8" y2="12"/>
					<line x1="5" y1="6.5" x2="11" y2="6.5"/>
				</svg>
				<span>Shore</span>
			</div>
			<div class="vic-box-val">{isShoreOn ? fmtV(acInV) : 'Disconnected'}</div>
			{#if isShoreOn && acInW != null}
				<div class="vic-box-sub">{fmtW(acInW)}</div>
			{/if}
		</div>

		<!-- Inverter / Charger -->
		<div class="vic-box vic-box--center" class:vic-box--active={true}>
			<div class="vic-box-header">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
					<rect x="2" y="3" width="12" height="10" rx="1.5"/>
					<line x1="6" y1="6" x2="10" y2="6"/>
					<line x1="6" y1="10" x2="10" y2="10"/>
					<path d="M8 6 L5.5 8 L8 10"/>
					<path d="M8 10 L10.5 8 L8 6"/>
				</svg>
				<span>Inverter / Charger</span>
			</div>
			<div class="vic-box-state">{inverterState}</div>
		</div>

		<!-- AC Loads -->
		<div class="vic-box" class:vic-box--active={hasLoad}>
			<div class="vic-box-header">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/>
					<line x1="5" y1="8" x2="11" y2="8"/>
					<line x1="5" y1="5.5" x2="5" y2="10.5"/>
					<line x1="11" y1="5.5" x2="11" y2="10.5"/>
				</svg>
				<span>AC Loads</span>
			</div>
			<div class="vic-box-val">
				<span class="vic-num">{loadW != null ? Math.round(loadW) : '—'}</span><span class="vic-unit">W</span>
			</div>
		</div>

		<!-- ── Row 2 ── -->

		<!-- Solar yield -->
		<div class="vic-box" class:vic-box--active={isSolarOn}>
			<div class="vic-box-header">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
					<circle cx="8" cy="8" r="3"/>
					<line x1="8" y1="1" x2="8" y2="3"/>
					<line x1="8" y1="13" x2="8" y2="15"/>
					<line x1="1" y1="8" x2="3" y2="8"/>
					<line x1="13" y1="8" x2="15" y2="8"/>
					<line x1="3" y1="3" x2="4.5" y2="4.5"/>
					<line x1="11.5" y1="11.5" x2="13" y2="13"/>
					<line x1="13" y1="3" x2="11.5" y2="4.5"/>
					<line x1="4.5" y1="11.5" x2="3" y2="13"/>
				</svg>
				<span>Solar yield</span>
			</div>
			<div class="vic-box-val">
				<span class="vic-num">{solW != null ? Math.round(solW) : '—'}</span><span class="vic-unit">W</span>
			</div>
			<!-- Bar chart -->
			<div class="vic-bars">
				{#each solarBars as bar}
					<div class="vic-bar-wrap" title={bar.name}>
						<div class="vic-bar" style="height:{Math.max(2, bar.pct)}%"></div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Battery -->
		<div class="vic-box vic-box--center vic-box--battery" class:vic-box--active={true}>
			<div class="vic-box-header">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
					<rect x="1" y="4" width="12" height="8" rx="1.5"/>
					<line x1="13" y1="7" x2="15" y2="7"/>
					<line x1="13" y1="9" x2="15" y2="9"/>
				</svg>
				<span>Battery</span>
			</div>
			<div class="vic-batt-soc">
				<span class="vic-num-lg">{batSoc != null ? Math.round(batSoc) : '—'}</span><span class="vic-unit-lg">%</span>
			</div>
			<div class="vic-batt-status">{battStatus}</div>
			{#if batTTG && batTTG > 0}
				<div class="vic-batt-ttg">{fmtTTG(batTTG)}</div>
			{/if}
			<div class="vic-batt-metrics">
				{#if batV != null}<span>{fmtV(batV)}</span>{/if}
				{#if batA != null}<span>{fmtA(batA)}</span>{/if}
				{#if batW != null}<span>{fmtW(batW)}</span>{/if}
			</div>
		</div>

		<!-- DC Loads -->
		<div class="vic-box" class:vic-box--active={hasDcLoad}>
			<div class="vic-box-header">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/>
					<line x1="5" y1="8" x2="11" y2="8"/>
					<line x1="5" y1="6" x2="5" y2="10"/>
					<line x1="8" y1="6" x2="8" y2="10"/>
				</svg>
				<span>DC Loads</span>
			</div>
			<div class="vic-box-val">
				<span class="vic-num">{dcLoadsW != null ? dcLoadsW : '—'}</span><span class="vic-unit">W</span>
			</div>
		</div>

	</div><!-- /vic-grid -->

	<!-- ── SVG Flow Lines ──────────────────────────────────────────────────── -->
	<!-- Coordinates based on the 3×2 grid cell centres (responsive via viewBox) -->
	<svg class="vic-flow" viewBox="0 0 300 200" preserveAspectRatio="none">

		<!-- Shore → Inverter (top row, horizontal) -->
		<line class="vic-line" class:vic-line--on={isShoreOn}
			x1="75" y1="50" x2="125" y2="50"/>
		{#if isShoreOn}
			<polygon class="vic-arrow vic-arrow--on" points="125,47 131,50 125,53"/>
		{/if}

		<!-- Inverter → AC Loads (top row) -->
		<line class="vic-line" class:vic-line--on={hasLoad}
			x1="175" y1="50" x2="225" y2="50"/>
		{#if hasLoad}
			<polygon class="vic-arrow vic-arrow--on" points="225,47 231,50 225,53"/>
		{/if}

		<!-- Inverter ↕ Battery (vertical centre) -->
		<line class="vic-line" class:vic-line--on={isCharging || isDischarging}
			x1="150" y1="75" x2="150" y2="125"/>
		{#if isDischarging}
			<!-- Arrow pointing UP (battery → inverter) -->
			<polygon class="vic-arrow vic-arrow--on" points="147,82 150,75 153,82"/>
		{:else if isCharging}
			<!-- Arrow pointing DOWN (inverter → battery) -->
			<polygon class="vic-arrow vic-arrow--on" points="147,118 150,125 153,118"/>
		{/if}

		<!-- Solar → Battery (bottom row) -->
		<line class="vic-line" class:vic-line--on={isSolarOn}
			x1="75" y1="150" x2="125" y2="150"/>
		{#if isSolarOn}
			<polygon class="vic-arrow vic-arrow--on" points="125,147 131,150 125,153"/>
		{/if}

		<!-- Battery → DC Loads (bottom row) -->
		<line class="vic-line" class:vic-line--on={hasDcLoad}
			x1="175" y1="150" x2="225" y2="150"/>
		{#if hasDcLoad}
			<polygon class="vic-arrow vic-arrow--on" points="225,147 231,150 225,153"/>
		{/if}
	</svg>

</div>

<style>
	/* ── Card ── */
	.vic-card {
		position: relative;
		background: #081c2e;
		border-radius: var(--r, 10px);
		border: 1px solid rgba(255,255,255,0.06);
		padding: 12px;
		overflow: hidden;
	}
	.vic-title {
		font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.35);
		text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;
	}

	/* ── Grid ── */
	.vic-grid {
		display: grid;
		grid-template-columns: 1fr 1.2fr 1fr;
		grid-template-rows: auto auto;
		gap: 6px;
		position: relative;
		z-index: 1;
	}

	/* ── Boxes ── */
	.vic-box {
		background: #0d2d4a;
		border: 1px solid rgba(100,160,220,0.2);
		border-radius: 6px;
		padding: 8px 9px;
		min-height: 72px;
		display: flex; flex-direction: column; gap: 2px;
	}
	.vic-box--active  { background: #1565c0; border-color: rgba(100,160,255,0.45); }
	.vic-box--battery { min-height: 100px; }
	.vic-box--center  { border-color: rgba(100,180,255,0.5); }

	.vic-box-header {
		display: flex; align-items: center; gap: 5px;
		font-size: 10px; color: rgba(255,255,255,0.7);
		font-weight: 600; letter-spacing: 0.2px;
		margin-bottom: 4px;
	}
	.vic-box-val {
		font-size: 18px; font-weight: 300; color: #fff;
		font-variant-numeric: tabular-nums; line-height: 1.1;
	}
	.vic-box-sub { font-size: 10px; color: rgba(255,255,255,0.55); }
	.vic-box-state {
		font-size: 18px; font-weight: 300; color: #fff;
		line-height: 1.2;
	}

	/* Number + unit formatting (matches Victron: large number, smaller grey unit) */
	.vic-num  { font-size: 20px; font-weight: 300; }
	.vic-unit { font-size: 14px; color: rgba(255,255,255,0.55); margin-left: 1px; }
	.vic-num-lg  { font-size: 26px; font-weight: 300; }
	.vic-unit-lg { font-size: 18px; color: rgba(255,255,255,0.55); margin-left: 1px; }

	/* Battery specific */
	.vic-batt-soc    { display: flex; align-items: baseline; line-height: 1; }
	.vic-batt-status { font-size: 11px; color: rgba(255,255,255,0.7); margin-top: 1px; }
	.vic-batt-ttg    { font-size: 12px; color: rgba(255,255,255,0.65); }
	.vic-batt-metrics {
		display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap;
		font-size: 11px; color: rgba(255,255,255,0.75);
		font-variant-numeric: tabular-nums;
	}

	/* Solar bar chart */
	.vic-bars {
		display: flex; align-items: flex-end; gap: 2px;
		height: 26px; margin-top: 6px;
	}
	.vic-bar-wrap { flex: 1; height: 100%; display: flex; align-items: flex-end; }
	.vic-bar {
		width: 100%; min-height: 2px;
		background: rgba(100,180,255,0.6);
		border-radius: 2px 2px 0 0;
		transition: height 0.3s ease;
	}
	.vic-box--active .vic-bar { background: rgba(200,230,255,0.7); }

	/* ── SVG Flow Lines ── */
	.vic-flow {
		position: absolute;
		inset: 0;
		width: 100%; height: 100%;
		pointer-events: none;
		z-index: 0;
	}
	.vic-line {
		stroke: rgba(255,255,255,0.1);
		stroke-width: 1.5;
		stroke-dasharray: none;
	}
	.vic-line--on { stroke: rgba(100,170,255,0.75); }
	.vic-arrow { fill: rgba(255,255,255,0.08); }
	.vic-arrow--on { fill: rgba(140,200,255,0.9); }
</style>
