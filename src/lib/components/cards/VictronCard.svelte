<script lang="ts">
	import { vrmData } from '$lib/stores/vrm.js';

	const data = $derived($vrmData);

	const batSoc    = $derived(data?.battery_soc   ?? null);
	const batV      = $derived(data?.battery_v     ?? null);
	const batA      = $derived(data?.battery_a     ?? null);
	const batW      = $derived(data?.battery_w     ?? null);
	const batTTG    = $derived(data?.batteries[0]?.time_to_go_s ?? null);
	const secBatts  = $derived(data?.batteries.slice(1) ?? []);
	const solW      = $derived(data?.solar_w       ?? null);
	const acInW     = $derived(data?.ac_input_w    ?? null);
	const acInV     = $derived(data?.ac_input_v    ?? null);
	const loadW     = $derived(data?.load_w        ?? null);
	const vebDcA    = $derived(data?.vebus_dc_a    ?? null);

	// DC Loads = |battery discharge| − solar − VE.Bus DC draw
	const dcLoadsW = $derived((() => {
		if (!data || batW == null) return null;
		const discharge = -Math.min(batW, 0);
		const solar     = Math.max(0, solW ?? 0);
		const vebDC     = vebDcA != null && batV != null
			? Math.max(0, vebDcA) * Math.abs(batV) : 0;
		const dc = Math.round(discharge - solar - vebDC);
		return dc > 5 ? dc : null;
	})());

	const isCharging    = $derived((batA ?? 0) >  0.5);
	const isDischarging = $derived((batA ?? 0) < -0.5);
	const isShoreOn     = $derived((acInW ?? 0) > 5 || (acInV ?? 0) > 50);
	const isSolarOn     = $derived((solW ?? 0) > 5);
	const hasLoad       = $derived((loadW ?? 0) > 5);
	const hasDcLoad     = $derived(dcLoadsW != null && dcLoadsW > 5);

	const inverterState = $derived(
		isShoreOn && isCharging  ? 'Charging' :
		isShoreOn                ? 'Pass-through' :
		isDischarging            ? 'Inverting' : 'Idle'
	);
	const battStatus = $derived(
		data?.mpptsArr.some(m => m.state === 5) && !isDischarging ? 'Float' :
		isCharging    ? 'Charging' :
		isDischarging ? 'Discharging' : 'Idle'
	);

	function fmtTTG(s: number | null): string {
		if (!s || s <= 0) return '';
		const d = Math.floor(s / 86400);
		const h = Math.floor((s % 86400) / 3600);
		return d > 0 ? `${d}d ${h}h` : `${h}h`;
	}
	function r(n: number | null, d = 0): string {
		return n != null ? n.toFixed(d) : '—';
	}

	// Solar bar chart per MPPT
	const solarBars = $derived((() => {
		if (!data?.mpptsArr.length) {
			const wh = data?.solar_yield_today_wh ?? 0;
			return [{ pct: wh > 0 ? 100 : 2, name: 'Solar' }];
		}
		const maxWh = Math.max(...data.mpptsArr.map(m => m.yield_today_wh), 1);
		return data.mpptsArr.slice(0, 6).map(m => ({
			pct: Math.max(2, Math.round(m.yield_today_wh / maxWh * 100)),
			name: m.name,
		}));
	})());
</script>

<div class="vic">
	<div class="vic-header">Victron</div>

	<!--
		Layout: 5-column grid (box · connector · box · connector · box)
		        3-row grid   (row1 · vertical-connector · row2)
		All connectors are grid cells with CSS-drawn lines + arrows.
	-->
	<div class="vic-grid">

		<!-- ══ Row 1 ══════════════════════════════════════════════════════════ -->

		<!-- Shore -->
		<div class="box" class:box-on={isShoreOn}>
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/><line x1="8" y1="4" x2="8" y2="12"/>
					<line x1="5" y1="6.5" x2="11" y2="6.5"/>
				</svg>
				Shore
			</div>
			{#if isShoreOn}
				<div class="box-val">{r(acInV,1)} <span class="unit">V</span></div>
				<div class="box-sub">{r(acInW,0)} W</div>
			{:else}
				<div class="box-state">Disconnected</div>
			{/if}
		</div>

		<!-- Connector: Shore → Inverter -->
		<div class="conn-h" class:conn-on={isShoreOn} class:arr-r={isShoreOn}></div>

		<!-- Inverter / Charger -->
		<div class="box box-center">
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<rect x="2" y="3" width="12" height="10" rx="1.5"/>
					<path d="M8 6 L5.5 8 L8 10 M8 6 L10.5 8 L8 10"/>
				</svg>
				Inverter / Charger
			</div>
			<div class="box-state">{inverterState}</div>
		</div>

		<!-- Connector: Inverter → AC Loads -->
		<div class="conn-h" class:conn-on={hasLoad} class:arr-r={hasLoad}></div>

		<!-- AC Loads -->
		<div class="box" class:box-on={hasLoad}>
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/>
					<line x1="5" y1="8" x2="11" y2="8"/>
					<line x1="5" y1="5.5" x2="5" y2="10.5"/>
					<line x1="11" y1="5.5" x2="11" y2="10.5"/>
				</svg>
				AC Loads
			</div>
			<div class="box-val">{r(loadW,0)} <span class="unit">W</span></div>
		</div>

		<!-- ══ Vertical connector row ══════════════════════════════════════════ -->
		<div></div><!-- placeholder col 1 -->
		<div></div><!-- placeholder col 2 -->
		<!-- Vertical connector: Inverter ↕ Battery (col 3, center) -->
		<div class="conn-v"
			class:conn-on={isCharging || isDischarging}
			class:arr-up={isDischarging}
			class:arr-dn={isCharging}></div>
		<div></div><!-- placeholder col 4 -->
		<div></div><!-- placeholder col 5 -->

		<!-- ══ Row 2 ══════════════════════════════════════════════════════════ -->

		<!-- Solar yield -->
		<div class="box" class:box-on={isSolarOn}>
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="3"/>
					<line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/>
					<line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/>
					<line x1="3" y1="3" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="13" y2="13"/>
					<line x1="13" y1="3" x2="11.5" y2="4.5"/><line x1="4.5" y1="11.5" x2="3" y2="13"/>
				</svg>
				Solar yield
			</div>
			<div class="box-val">{r(solW,0)} <span class="unit">W</span></div>
			<div class="vic-bars">
				{#each solarBars as bar}
					<div class="vic-bar-wrap">
						<div class="vic-bar" style="height:{bar.pct}%" title={bar.name}></div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Connector: Solar → Battery -->
		<div class="conn-h" class:conn-on={isSolarOn} class:arr-r={isSolarOn}></div>

		<!-- Battery (main + secondary) -->
		<div class="box box-center box-batt">
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<rect x="1" y="4" width="12" height="8" rx="1.5"/>
					<line x1="13" y1="7" x2="15" y2="7"/><line x1="13" y1="9" x2="15" y2="9"/>
				</svg>
				Battery
			</div>
			<!-- Main battery -->
			<div class="batt-main">
				<span class="batt-soc">{r(batSoc,0)}<span class="unit-lg">%</span></span>
				<div class="batt-info">
					<span class="batt-status">{battStatus}</span>
					{#if fmtTTG(batTTG)}<span class="batt-ttg">{fmtTTG(batTTG)}</span>{/if}
				</div>
			</div>
			<div class="batt-metrics">
				{#if batV != null}<span>{r(batV,2)} V</span>{/if}
				{#if batA != null}<span>{r(batA,1)} A</span>{/if}
				{#if batW != null}<span>{r(batW,0)} W</span>{/if}
			</div>
			<!-- Secondary batteries -->
			{#if secBatts.length > 0}
			<div class="batt-secondary">
				{#each secBatts as b}
				<div class="batt-sec-row">
					<span class="batt-sec-name">{b.name}</span>
					<span class="batt-sec-vals">
						{#if b.soc != null}{Math.round(b.soc)}%{/if}
						{#if b.v != null} · {b.v.toFixed(2)} V{/if}
					</span>
				</div>
				{/each}
			</div>
			{/if}
		</div>

		<!-- Connector: Battery → DC Loads -->
		<div class="conn-h" class:conn-on={hasDcLoad} class:arr-r={hasDcLoad}></div>

		<!-- DC Loads -->
		<div class="box" class:box-on={hasDcLoad}>
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/>
					<line x1="5" y1="8" x2="11" y2="8"/>
					<line x1="5" y1="6" x2="5" y2="10"/>
					<line x1="8" y1="6" x2="8" y2="10"/>
				</svg>
				DC Loads
			</div>
			<div class="box-val">{dcLoadsW != null ? dcLoadsW : '—'} <span class="unit">W</span></div>
		</div>

	</div><!-- /vic-grid -->
</div>

<style>
	/* ── Card ── */
	.vic {
		background: #081c2e;
		border-radius: var(--r, 10px);
		border: 1px solid rgba(255,255,255,0.07);
		padding: 12px 14px;
	}
	.vic-header {
		font-size: 11px; font-weight: 700;
		color: rgba(255,255,255,0.3);
		text-transform: uppercase; letter-spacing: 1px;
		margin-bottom: 12px;
	}

	/* ── Grid: 5 cols (box · conn · box · conn · box), 3 rows (row1 · vert · row2) ── */
	.vic-grid {
		display: grid;
		grid-template-columns: 1fr 28px 1fr 28px 1fr;
		grid-template-rows: auto 18px auto;
		align-items: stretch;
	}

	/* ── Boxes ── */
	.box {
		background: #0d2d4a;
		border: 1px solid rgba(100,160,220,0.18);
		border-radius: 6px;
		padding: 10px 12px;
		min-height: 90px;
		display: flex; flex-direction: column; gap: 3px;
	}
	.box-on     { background: #1565c0; border-color: rgba(120,180,255,0.5); }
	.box-center { border-color: rgba(120,180,255,0.4); }
	.box-batt   { min-height: 110px; }

	.box-hdr {
		display: flex; align-items: center; gap: 5px;
		font-size: 10px; color: rgba(255,255,255,0.65);
		font-weight: 600; letter-spacing: 0.3px; margin-bottom: 3px;
	}
	.box-val {
		font-size: 20px; font-weight: 300; color: #fff;
		font-variant-numeric: tabular-nums; line-height: 1.2;
	}
	.box-state {
		font-size: 18px; font-weight: 300; color: #fff; line-height: 1.2;
	}
	.box-sub { font-size: 11px; color: rgba(255,255,255,0.55); }
	.unit    { font-size: 14px; color: rgba(255,255,255,0.5); }

	/* ── Battery specific ── */
	.batt-main  { display: flex; align-items: center; gap: 8px; }
	.batt-soc   { font-size: 28px; font-weight: 300; color: #fff; font-variant-numeric: tabular-nums; line-height: 1; }
	.unit-lg    { font-size: 18px; color: rgba(255,255,255,0.5); }
	.batt-info  { display: flex; flex-direction: column; gap: 1px; }
	.batt-status{ font-size: 11px; color: rgba(255,255,255,0.7); }
	.batt-ttg   { font-size: 12px; color: rgba(255,255,255,0.6); }
	.batt-metrics {
		display: flex; gap: 8px; flex-wrap: wrap;
		font-size: 11px; color: rgba(255,255,255,0.7);
		font-variant-numeric: tabular-nums;
	}
	/* Secondary batteries */
	.batt-secondary {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid rgba(255,255,255,0.1);
		display: flex; flex-direction: column; gap: 3px;
	}
	.batt-sec-row {
		display: flex; justify-content: space-between; align-items: center;
		gap: 6px;
	}
	.batt-sec-name { font-size: 10px; color: rgba(255,255,255,0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.batt-sec-vals { font-size: 10px; color: rgba(255,255,255,0.75); font-variant-numeric: tabular-nums; flex-shrink: 0; }

	/* ── Solar bar chart ── */
	.vic-bars {
		display: flex; align-items: flex-end; gap: 2px;
		height: 28px; margin-top: 6px;
	}
	.vic-bar-wrap { flex: 1; height: 100%; display: flex; align-items: flex-end; }
	.vic-bar {
		width: 100%;
		background: rgba(100,180,255,0.55);
		border-radius: 2px 2px 0 0;
		min-height: 2px;
	}
	.box-on .vic-bar { background: rgba(200,230,255,0.7); }

	/* ── Horizontal connectors ── */
	.conn-h {
		display: flex; align-items: center; position: relative;
	}
	/* The line */
	.conn-h::before {
		content: '';
		position: absolute; left: 0; right: 0; top: 50%;
		height: 1.5px;
		background: rgba(255,255,255,0.1);
		transform: translateY(-50%);
	}
	.conn-h.conn-on::before { background: rgba(100,170,255,0.8); }
	/* Right-pointing arrow */
	.conn-h.arr-r::after {
		content: '';
		position: absolute; right: 1px;
		width: 0; height: 0;
		border-top: 5px solid transparent;
		border-bottom: 5px solid transparent;
		border-left: 7px solid rgba(140,200,255,0.9);
	}

	/* ── Vertical connector ── */
	.conn-v {
		grid-column: 3;
		display: flex; justify-content: center; position: relative;
	}
	/* The line */
	.conn-v::before {
		content: '';
		position: absolute; top: 0; bottom: 0; left: 50%;
		width: 1.5px;
		background: rgba(255,255,255,0.1);
		transform: translateX(-50%);
	}
	.conn-v.conn-on::before { background: rgba(100,170,255,0.8); }
	/* Arrow up (discharging: battery → inverter) */
	.conn-v.arr-up::after {
		content: '';
		position: absolute; top: 1px;
		width: 0; height: 0;
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-bottom: 7px solid rgba(140,200,255,0.9);
	}
	/* Arrow down (charging: inverter → battery) */
	.conn-v.arr-dn::after {
		content: '';
		position: absolute; bottom: 1px;
		width: 0; height: 0;
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-top: 7px solid rgba(140,200,255,0.9);
	}
</style>
