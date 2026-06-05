<script lang="ts">
	import { vrmData } from '$lib/stores/vrm.js';

	const data = $derived($vrmData);

	const batSoc   = $derived(data?.battery_soc   ?? null);
	const batV     = $derived(data?.battery_v     ?? null);
	const batA     = $derived(data?.battery_a     ?? null);
	const batW     = $derived(data?.battery_w     ?? null);
	const batTTG   = $derived(data?.batteries[0]?.time_to_go_s ?? null);
	const secBatts = $derived(data?.batteries.slice(1) ?? []);
	const solW     = $derived(data?.solar_w       ?? null);
	const solA     = $derived(data?.solar_a       ?? null);
	const solToday = $derived(data?.solar_yield_today_wh     != null ? data.solar_yield_today_wh / 1000     : null);
	const solYest  = $derived(data?.solar_yield_yesterday_wh != null ? data.solar_yield_yesterday_wh / 1000 : null);
	const mpptsArr = $derived(data?.mpptsArr ?? []);
	const acInW    = $derived(data?.ac_input_w    ?? null);
	const acInV    = $derived(data?.ac_input_v    ?? null);
	const loadW    = $derived(data?.load_w        ?? null);
	const vebDcA   = $derived(data?.vebus_dc_a    ?? null);

	const dcLoadsW = $derived((() => {
		if (!data || batW == null) return null;
		const discharge = -Math.min(batW, 0);
		const solar     = Math.max(0, solW ?? 0);
		const vebDC     = vebDcA != null && batV != null ? Math.max(0, vebDcA) * Math.abs(batV) : 0;
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

	let solarExpanded = $state(false);

	function fmtTTG(s: number | null): string {
		if (!s || s <= 0) return '';
		const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
		return d > 0 ? `${d}d ${h}h` : `${h}h`;
	}
	function r0(n: number | null) { return n != null ? Math.round(n).toString() : '—'; }
	function r2(n: number | null) { return n != null ? n.toFixed(2) : '—'; }
	function r1(n: number | null) { return n != null ? n.toFixed(1) : '—'; }
	function kw(wh: number | null) { return wh != null ? (wh).toFixed(2) + ' kWh' : '—'; }
</script>

<div class="vic">
	<div class="vic-hdr">Victron</div>

	<!--
	  LAYOUT STRATEGY
	  Desktop (≥ 540 px): horizontal flow  3 cols × 3 rows (incl. connector rows)
	    Shore ──► Inverter ──► AC Loads
	                ↕
	    Solar ──► Battery ──► DC Loads

	  Mobile (< 540 px): vertical flow  3 cols × 5 rows  (rotated 90° right)
	    Shore   │ vert │ Solar
	    vert    │      │ vert
	    Inverter│horiz │ Battery
	    vert    │      │ vert
	    AC Loads│      │ DC Loads

	  Implementation: every connector exists twice in the DOM (desktop + mobile),
	  CSS shows/hides the correct set per breakpoint.
	-->
	<div class="vic-grid">

		<!-- ░░ ROW 1 ░░ -->
		<div class="box" class:box-on={isShoreOn} style="grid-area:shore">
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/><line x1="8" y1="4" x2="8" y2="12"/>
					<line x1="5" y1="6.5" x2="11" y2="6.5"/>
				</svg>
				Shore
			</div>
			{#if isShoreOn}
				<div class="box-val">{r1(acInV)} <span class="u">V</span></div>
				<div class="box-sub">{r0(acInW)} W</div>
			{:else}
				<div class="box-state">Disconnected</div>
			{/if}
		</div>

		<!-- desktop: h connector Shore→Inverter -->
		<div class="conn conn-h d-only" class:on={isShoreOn} class:arr-r={isShoreOn} style="grid-area:ch1"></div>
		<!-- mobile: v connector Shore↓Inverter -->
		<div class="conn conn-v m-only" class:on={isShoreOn} class:arr-d={isShoreOn} style="grid-area:mv1"></div>

		<div class="box box-c" style="grid-area:inv">
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<rect x="2" y="3" width="12" height="10" rx="1.5"/>
					<path d="M8 6 L5.5 8 L8 10 M8 6 L10.5 8 L8 10"/>
				</svg>
				Inverter / Charger
			</div>
			<div class="box-state">{inverterState}</div>
		</div>

		<!-- desktop: h connector Inverter→AC Loads -->
		<div class="conn conn-h d-only" class:on={hasLoad} class:arr-r={hasLoad} style="grid-area:ch2"></div>
		<!-- mobile: v connector Inverter↓AC -->
		<div class="conn conn-v m-only" class:on={hasLoad} class:arr-d={hasLoad} style="grid-area:mv3"></div>

		<div class="box box-load" class:box-on={hasLoad} style="grid-area:acload">
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/>
					<line x1="5" y1="8" x2="11" y2="8"/>
					<line x1="5" y1="5.5" x2="5" y2="10.5"/>
					<line x1="11" y1="5.5" x2="11" y2="10.5"/>
				</svg>
				AC Loads
			</div>
			<div class="box-val">{r0(loadW)} <span class="u">W</span></div>
		</div>

		<!-- ░░ MIDDLE ROW (desktop vertical + mobile horizontal) ░░ -->
		<!-- desktop: v connector Inverter↕Battery (center col) -->
		<div class="conn conn-v d-only"
			class:on={isCharging || isDischarging}
			class:arr-u={isDischarging}
			class:arr-d={isCharging && !isDischarging}
			style="grid-area:cv"></div>
		<!-- mobile: h connector Inverter↔Battery (center row) -->
		<div class="conn conn-mh m-only"
			class:on={isCharging || isDischarging}
			class:arr-r={isDischarging}
			class:arr-l={isCharging && !isDischarging}
			style="grid-area:mh"></div>

		<!-- ░░ ROW 2 ░░ -->

		<!-- Solar box — collapsible -->
		<div class="box" class:box-on={isSolarOn} style="grid-area:solar">
			<button class="solar-hdr box-hdr" onclick={() => solarExpanded = !solarExpanded}>
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="3"/>
					<line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/>
					<line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/>
					<line x1="3" y1="3" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="13" y2="13"/>
					<line x1="13" y1="3" x2="11.5" y2="4.5"/><line x1="4.5" y1="11.5" x2="3" y2="13"/>
				</svg>
				Solar yield
				<span class="expand-icon">{solarExpanded ? '▲' : '▼'}</span>
			</button>
			<!-- Compact view -->
			<div class="sol-compact">
				<div class="box-val">{r0(solW)} <span class="u">W</span>
					{#if solA != null && solA > 0.05}<span class="sol-a"> · {r1(solA)} A</span>{/if}
				</div>
				<div class="sol-yields">
					<span>Today {kw(solToday)}</span>
					{#if solYest != null}<span>Yesterday {kw(solYest)}</span>{/if}
				</div>
			</div>
			<!-- Expanded MPPT list -->
			{#if solarExpanded && mpptsArr.length > 0}
			<div class="sol-mpptslist">
				{#each mpptsArr as m}
				<div class="mppt-row">
					<span class="mppt-name">{m.name}</span>
					<span class="mppt-pw">{r0(m.power_w)} W</span>
					<span class="mppt-yld">{m.yield_today_wh > 0 ? (m.yield_today_wh / 1000).toFixed(2) + ' kWh' : '—'}</span>
				</div>
				{/each}
			</div>
			{/if}
		</div>

		<!-- desktop: h connector Solar→Battery -->
		<div class="conn conn-h d-only" class:on={isSolarOn} class:arr-r={isSolarOn} style="grid-area:ch3"></div>
		<!-- mobile: v connector Solar↓Battery -->
		<div class="conn conn-v m-only" class:on={isSolarOn} class:arr-d={isSolarOn} style="grid-area:mv2"></div>

		<!-- Battery -->
		<div class="box box-c box-batt" style="grid-area:batt">
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<rect x="1" y="4" width="12" height="8" rx="1.5"/>
					<line x1="13" y1="7" x2="15" y2="7"/><line x1="13" y1="9" x2="15" y2="9"/>
				</svg>
				Battery
			</div>
			<div class="batt-main">
				<span class="batt-soc">{r0(batSoc)}<span class="u-lg">%</span></span>
				<div class="batt-info">
					<span class="batt-status">{battStatus}</span>
					{#if fmtTTG(batTTG)}<span class="batt-ttg">{fmtTTG(batTTG)}</span>{/if}
				</div>
			</div>
			<div class="batt-met">
				{#if batV != null}<span>{r2(batV)} V</span>{/if}
				{#if batA != null}<span>{r1(batA)} A</span>{/if}
				{#if batW != null}<span>{r0(batW)} W</span>{/if}
			</div>
			{#if secBatts.length > 0}
			<div class="sec-batts">
				{#each secBatts as b}
				<div class="sec-row">
					<span class="sec-name">{b.name}</span>
					<span class="sec-vals">
						{#if b.soc != null}{Math.round(b.soc)}%{/if}
						{#if b.v != null} · {b.v.toFixed(2)} V{/if}
					</span>
				</div>
				{/each}
			</div>
			{/if}
		</div>

		<!-- desktop: h connector Battery→DC Loads -->
		<div class="conn conn-h d-only" class:on={hasDcLoad} class:arr-r={hasDcLoad} style="grid-area:ch4"></div>
		<!-- mobile: v connector Battery↓DC Loads -->
		<div class="conn conn-v m-only" class:on={hasDcLoad} class:arr-d={hasDcLoad} style="grid-area:mv4"></div>

		<div class="box box-load" class:box-on={hasDcLoad} style="grid-area:dcload">
			<div class="box-hdr">
				<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<circle cx="8" cy="8" r="6"/>
					<line x1="5" y1="8" x2="11" y2="8"/>
					<line x1="5" y1="6" x2="5" y2="10"/>
					<line x1="8" y1="6" x2="8" y2="10"/>
				</svg>
				DC Loads
			</div>
			<div class="box-val">{dcLoadsW != null ? dcLoadsW : '—'} <span class="u">W</span></div>
		</div>

	</div>
</div>

<style>
	/* ── Card ── */
	.vic { background:#081c2e; border-radius:var(--r,10px); border:1px solid rgba(255,255,255,.07); padding:12px 14px; }
	.vic-hdr { font-size:11px; font-weight:700; color:rgba(255,255,255,.3); text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; }

	/* ── Desktop grid ─────────────────────────────────────────────────────── */
	.vic-grid {
		display: grid;
		grid-template-columns: 1fr 28px 1fr 28px 1fr;
		grid-template-rows: auto 20px auto;
		grid-template-areas:
			"shore  ch1  inv  ch2  acload"
			".      .    cv   .    ."
			"solar  ch3  batt ch4  dcload";
		gap: 6px 0;
	}

	/* Mobile connector areas are removed from desktop layout (display:none via class) */

	/* ── Mobile grid ─────────────────────────────────────────────────────── */
	@media (max-width: 540px) {
		.vic-grid {
			grid-template-columns: 1fr 28px 1fr;
			grid-template-rows: auto 20px auto 20px auto;
			grid-template-areas:
				"shore  mv1  solar"
				"mv1b   mh   mv2"
				"inv    mh   batt"
				"mv3    .    mv4"
				"acload .    dcload";
		}
		/* Fix: mv1 is both the arrow area and needs to be in row 2, col 1 */
		/* Correct grid-template-areas for mobile: */
	}

	/* Override the mobile grid with correct named areas */
	@media (max-width: 540px) {
		.vic-grid {
			grid-template-areas:
				"shore  .   solar"
				"mv1    mh  mv2"
				"inv    mh  batt"
				"mv3    .   mv4"
				"acload .   dcload";
		}
		/* Reassign connector grid-areas for mobile */
		[style*="grid-area:ch1"] { display: none; }
		[style*="grid-area:ch2"] { display: none; }
		[style*="grid-area:cv"]  { display: none; }
		[style*="grid-area:ch3"] { display: none; }
		[style*="grid-area:ch4"] { display: none; }
	}

	/* ── Show/hide desktop vs mobile connectors ── */
	.d-only { /* shown on desktop */ }
	.m-only { display: none; }  /* hidden on desktop */

	@media (max-width: 540px) {
		.d-only { display: none; }
		.m-only { display: flex; align-items: center; justify-content: center; }
	}

	/* ── Boxes ── */
	.box {
		background:#0d2d4a; border:1px solid rgba(100,160,220,.18);
		border-radius:6px; padding:10px 12px;
		min-height:80px; display:flex; flex-direction:column; gap:3px;
		justify-content:center;
	}
	.box-on { background:#1565c0; border-color:rgba(120,180,255,.5); }
	.box-c  { border-color:rgba(120,180,255,.4); }
	.box-batt { min-height:100px; }

	.box-hdr {
		display:flex; align-items:center; gap:5px;
		font-size:10px; color:rgba(255,255,255,.65);
		font-weight:600; letter-spacing:.3px; margin-bottom:3px;
	}
	.box-val  { font-size:20px; font-weight:300; color:#fff; font-variant-numeric:tabular-nums; line-height:1.2; }
	.box-state{ font-size:17px; font-weight:300; color:#fff; line-height:1.2; }
	.box-sub  { font-size:11px; color:rgba(255,255,255,.55); }
	.u        { font-size:14px; color:rgba(255,255,255,.5); }

	/* ── Battery ── */
	.batt-main { display:flex; align-items:center; gap:8px; }
	.batt-soc  { font-size:26px; font-weight:300; color:#fff; font-variant-numeric:tabular-nums; line-height:1; }
	.u-lg      { font-size:17px; color:rgba(255,255,255,.5); }
	.batt-info { display:flex; flex-direction:column; gap:1px; }
	.batt-status{ font-size:11px; color:rgba(255,255,255,.7); }
	.batt-ttg  { font-size:11px; color:rgba(255,255,255,.6); }
	.batt-met  { display:flex; gap:8px; flex-wrap:wrap; font-size:11px; color:rgba(255,255,255,.7); font-variant-numeric:tabular-nums; }
	.sec-batts { margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,.1); display:flex; flex-direction:column; gap:3px; }
	.sec-row   { display:flex; justify-content:space-between; gap:6px; }
	.sec-name  { font-size:10px; color:rgba(255,255,255,.55); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.sec-vals  { font-size:10px; color:rgba(255,255,255,.75); font-variant-numeric:tabular-nums; flex-shrink:0; }

	/* ── Solar collapsible ── */
	.solar-hdr {
		background:none; border:none; padding:0; cursor:pointer; width:100%;
		text-align:left; color:inherit; font:inherit;
		display:flex; align-items:center; gap:5px;
		-webkit-tap-highlight-color: transparent;
	}
	.solar-hdr:hover .expand-icon { color:rgba(255,255,255,.7); }
	.expand-icon {
		margin-left:auto;
		font-size:11px;
		color:rgba(255,255,255,.5);
		background:rgba(255,255,255,.08);
		border-radius:4px;
		padding:1px 5px;
		transition:color .15s, background .15s;
	}
	.sol-compact { display:flex; flex-direction:column; gap:2px; }
	.sol-a       { font-size:13px; color:rgba(255,255,255,.6); }
	.sol-yields  { display:flex; gap:10px; flex-wrap:wrap; font-size:10px; color:rgba(255,255,255,.55); margin-top:2px; }
	.sol-mpptslist {
		margin-top:6px; padding-top:6px;
		border-top:1px solid rgba(255,255,255,.1);
		display:flex; flex-direction:column; gap:3px;
	}
	.mppt-row { display:flex; gap:6px; align-items:center; }
	.mppt-name{ font-size:10px; color:rgba(255,255,255,.5); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.mppt-pw  { font-size:10px; color:rgba(255,255,255,.8); font-variant-numeric:tabular-nums; flex-shrink:0; }
	.mppt-yld { font-size:10px; color:rgba(255,255,255,.5); flex-shrink:0; }

	/* ── Connectors ── */
	/* Base: all connectors have position:relative and a centred dim line */
	.conn { position:relative; overflow:visible; }

	/* Arrow pulse animation (only arrows blink, no moving dashes) */
	@keyframes arr-pulse {
		0%,100% { opacity:1; }
		50%      { opacity:0.15; }
	}

	/* Horizontal line */
	.conn-h::before {
		content:''; position:absolute; left:0; right:0; top:50%;
		height:2px; background:rgba(255,255,255,.08); transform:translateY(-50%);
	}
	.conn-h.on::before { background:rgba(100,170,255,.75); }

	/* Right-pointing arrow */
	.conn-h.arr-r::after {
		content:''; position:absolute;
		right:0; top:50%; transform:translateY(-50%);
		border:5px solid transparent; border-left:7px solid rgba(140,200,255,.25);
	}
	.conn-h.arr-r.on::after {
		border-left-color:rgba(140,200,255,1);
		animation: arr-pulse 1.2s ease-in-out infinite;
	}
	/* Left-pointing arrow */
	.conn-h.arr-l::after {
		content:''; position:absolute;
		left:0; top:50%; transform:translateY(-50%);
		border:5px solid transparent; border-right:7px solid rgba(140,200,255,.25);
	}
	.conn-h.arr-l.on::after {
		border-right-color:rgba(140,200,255,1);
		animation: arr-pulse 1.2s ease-in-out infinite;
	}

	/* Vertical connector */
	.conn-v { display:flex; align-items:center; justify-content:center; }
	.conn-v::before {
		content:''; position:absolute; top:0; bottom:0; left:50%;
		width:2px; background:rgba(255,255,255,.08); transform:translateX(-50%);
	}
	.conn-v.on::before { background:rgba(100,170,255,.75); }

	/* Up arrow */
	.conn-v.arr-u::after {
		content:''; position:absolute;
		top:0; left:50%; transform:translateX(-50%);
		border:5px solid transparent; border-bottom:7px solid rgba(140,200,255,.25);
	}
	.conn-v.arr-u.on::after {
		border-bottom-color:rgba(140,200,255,1);
		animation: arr-pulse 1.2s ease-in-out infinite;
	}
	/* Down arrow */
	.conn-v.arr-d::after {
		content:''; position:absolute;
		bottom:0; left:50%; transform:translateX(-50%);
		border:5px solid transparent; border-top:7px solid rgba(140,200,255,.25);
	}
	.conn-v.arr-d.on::after {
		border-top-color:rgba(140,200,255,1);
		animation: arr-pulse 1.2s ease-in-out infinite;
	}

	/* Load boxes: stretch to full row height like other boxes */
	.box-load { }  /* no override — grid stretches all equally */

	/* Mobile connectors hidden on desktop */
	.m-only { display:none !important; }

	/* Mobile horizontal connector between inv and batt */
	.conn-mh { display:none; }
	.conn-mh::before {
		left:0; right:0; top:50%; bottom:auto; height:1.5px; width:auto; transform:translateY(-50%);
	}

	@media (max-width: 540px) {
		.m-only  { display:flex !important; align-items:center; justify-content:center; }
		.conn-mh { display:flex; align-items:center; }
		.conn-mh::before { content:''; position:absolute; }
	}
</style>
