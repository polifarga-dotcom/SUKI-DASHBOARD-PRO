<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { parseVRMDiagnostics, MPPT_STATE } from '$lib/utils/vrm.js';
	import type { VRMData } from '$lib/types.js';

	let data  = $state<VRMData | null>(null);
	let error = $state('');
	let now   = $state(Math.floor(Date.now() / 1000));

	let tickTimer: ReturnType<typeof setInterval>;

	const cfg = $derived($anchorConfig);
	function apiReady() { return !!(cfg?.vrm_api_token && cfg?.vrm_installation_id); }

	async function fetchVRM() {
		try {
			const { data: json, error: fnErr } = await supabase.functions.invoke('vrm-proxy');
			if (fnErr) { error = fnErr.message; return; }
			data  = parseVRMDiagnostics(json?.records ?? []);
			error = '';
		} catch (e) { error = String(e); }
	}

	// ── Reactive start: fetch as soon as credentials are ready ────────────────
	// $effect re-runs when cfg changes (null → loaded). Returns cleanup so the
	// interval is always cleared on unmount or when credentials are removed.
	$effect(() => {
		if (!apiReady()) return;
		fetchVRM(); // immediate first fetch
		const timer = setInterval(fetchVRM, 60_000);
		return () => clearInterval(timer);
	});

	// Tick timer for live GPS age counter (independent of credentials)
	onMount(() => {
		tickTimer = setInterval(() => { now = Math.floor(Date.now() / 1000); }, 1000);
	});
	onDestroy(() => clearInterval(tickTimer));

	// ── Formatters ─────────────────────────────────────────────────────────
	function pct(v: number | null) { return v != null ? Math.round(v) : null; }

	function fmtW(v: number | null | undefined) {
		if (v == null) return '—';
		const a = Math.abs(v);
		return a >= 1000 ? `${(v / 1000).toFixed(2)} kW` : `${Math.round(v)} W`;
	}
	function fmtWh(v: number | null | undefined) {
		if (v == null) return '—';
		return v >= 1000 ? `${(v / 1000).toFixed(2)} kWh` : `${Math.round(v)} Wh`;
	}
	function fmtV(v: number | null) { return v != null ? `${v.toFixed(1)} V` : '—'; }
	function fmtA(v: number | null) {
		if (v == null) return '—';
		return `${v > 0 ? '+' : ''}${v.toFixed(1)} A`;
	}
	function fmtC(v: number) { return `${v.toFixed(1)} °C`; }
	function fmtKnots(ms: number) { return `${(ms * 1.944).toFixed(1)} kn`; }

	function ttgStr(s: number | null) {
		if (!s || s <= 0 || s > 86400 * 10) return null;
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}

	function ageStr(ts: number | null) {
		if (!ts) return '';
		const s = now - ts;
		if (s < 90)   return 'Gerade eben';
		if (s < 3600) return `Vor ${Math.floor(s / 60)} Min.`;
		return `Vor ${Math.floor(s / 3600)} Std.`;
	}
	function gpsAgeS(ts: number | null) { return ts ? Math.max(0, now - ts) : null; }
	function stale(ts: number | null)   { return ts ? (now - ts) > 180 : false; }

	function socColor(soc: number | null) {
		if (soc == null) return 'var(--muted)';
		if (soc > 50)   return 'var(--green)';
		if (soc > 20)   return 'var(--amber)';
		return 'var(--red)';
	}
	function socBg(soc: number | null) {
		if (soc == null) return 'transparent';
		if (soc > 50)   return 'rgba(80,200,100,0.09)';
		if (soc > 20)   return 'rgba(240,180,50,0.09)';
		return 'rgba(220,60,60,0.09)';
	}

	function mpptStateLabel(st: number | null) {
		if (st == null) return '';
		return MPPT_STATE[st] ?? `St.${st}`;
	}
	function mpptStateColor(st: number | null) {
		if (st == null) return 'var(--muted)';
		if (st === 5)  return 'var(--green)';   // float
		if (st === 4)  return 'var(--accent)';  // absorption
		if (st === 3)  return '#f5c842';         // bulk (solar yellow)
		if (st === 0)  return 'var(--muted)';
		return 'var(--amber)';
	}

	function mpptShortName(name: string) {
		return name
			.replace(/^BlueSolar Charger /i, 'BlueSolar ')
			.replace(/^SmartSolar Charger /i, 'SmartSolar ')
			.replace(/^Victron Energy /i, '')
			.replace(/^Victron /i, '');
	}

	const SOLAR_COLOR = '#f5c842';
	const LOAD_COLOR  = 'var(--accent)';

	// Derive: is there anything meaningful to show per section?
	const hasSolar   = $derived(data && (data.solar_w != null || data.mpptsArr.length > 0));
	const hasBatt    = $derived(data && (data.battery_soc != null || data.battery_v != null));
	const hasSecBatt = $derived(data && data.batteries.length > 1);
	const hasAcIn    = $derived(data && (data.ac_input_v != null || data.ac_input_w != null));
	const hasLoad    = $derived(data && data.load_w != null && data.load_w > 5);
	const hasTemps   = $derived(data && data.temperatures.length > 0);
	const hasTanks   = $derived(data && data.tanks.length > 0);
	const hasGps     = $derived(data && data.gps_lat != null && data.gps_lon != null);
</script>

{#if apiReady()}
<div class="card vrm-card">

	<!-- ── Header ──────────────────────────────────────────────── -->
	<div class="header-row">
		<span class="card-title">Victron VRM</span>
		{#if data?.last_ts}
			<span class="age" class:stale={stale(data.last_ts)}>{ageStr(data.last_ts)}</span>
		{/if}
	</div>

	{#if error}
		<p class="err-msg">{error}</p>
	{:else if !data}
		<p class="loading">Verbinde mit VRM…</p>
	{:else}

	<!-- ══════════════════════════════════════════════════════════
	     SOLAR + BATTERIE — side by side
	═══════════════════════════════════════════════════════════════ -->
	{#if hasSolar || hasBatt}
	<div class="top-grid">

		<!-- Solar box -->
		{#if hasSolar}
		<div class="mini-box solar-box">
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
				stroke={SOLAR_COLOR} stroke-width="2" stroke-linecap="round">
				<circle cx="12" cy="12" r="4" fill={SOLAR_COLOR} stroke="none"/>
				<line x1="12" y1="2"  x2="12" y2="5"/>
				<line x1="12" y1="19" x2="12" y2="22"/>
				<line x1="4.22" y1="4.22"  x2="6.34" y2="6.34"/>
				<line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
				<line x1="2"  y1="12" x2="5"  y2="12"/>
				<line x1="19" y1="12" x2="22" y2="12"/>
				<line x1="4.22"  y1="19.78" x2="6.34" y2="17.66"/>
				<line x1="17.66" y1="6.34"  x2="19.78" y2="4.22"/>
			</svg>
			<div class="mini-power" style="color:{SOLAR_COLOR}">
				{fmtW(data.solar_w)}
			</div>
			<div class="mini-label">Solar</div>
			{#if data.solar_yield_today_wh}
				<div class="mini-sub">{fmtWh(data.solar_yield_today_wh)} heute</div>
			{/if}
		</div>
		{/if}

		<!-- Battery box -->
		{#if hasBatt}
		{@const soc = pct(data.battery_soc) ?? 0}
		{@const r = 28}
		{@const circ = 2 * Math.PI * r}
		<div class="mini-box batt-box" style="background:{socBg(data.battery_soc)}">
			<!-- SOC ring -->
			{#if data.battery_soc != null}
			<svg width="64" height="64" viewBox="0 0 64 64" style="flex-shrink:0">
				<circle cx="32" cy="32" r={r} fill="none" stroke="var(--card2)" stroke-width="6"/>
				<circle cx="32" cy="32" r={r} fill="none"
					stroke={socColor(data.battery_soc)} stroke-width="6"
					stroke-dasharray="{circ * soc / 100} {circ}"
					stroke-linecap="round"
					transform="rotate(-90 32 32)"/>
				<text x="32" y="36" text-anchor="middle" font-size="13" font-weight="700"
					fill={socColor(data.battery_soc)}>{soc}%</text>
			</svg>
			{:else}
			<svg width="36" height="36" viewBox="0 0 24 24" fill="none"
				stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round">
				<rect x="2" y="7" width="18" height="11" rx="2"/>
				<path d="M22 11v3"/>
			</svg>
			{/if}
			<div class="mini-label">Batterie</div>
			<div class="batt-row">
				{#if data.battery_v != null}<span class="batt-stat">{fmtV(data.battery_v)}</span>{/if}
				{#if data.battery_a != null}
					<span class="batt-stat" class:c-green={data.battery_a > 0.5} class:c-amber={data.battery_a < -0.5}>
						{fmtA(data.battery_a)}
					</span>
				{/if}
			</div>
			{#if data.battery_w != null}
				<div class="mini-sub">{fmtW(data.battery_w)}</div>
			{/if}
			{#if data.batteries[0]?.time_to_go_s != null && ttgStr(data.batteries[0].time_to_go_s)}
				<div class="mini-sub ttg">⏱ {ttgStr(data.batteries[0].time_to_go_s)} verbleibend</div>
			{/if}
		</div>
		{/if}

	</div><!-- /top-grid -->
	{/if}

	<!-- Shore power badge (if AC input detected) -->
	{#if hasAcIn}
	<div class="badge-row">
		<span class="badge shore-badge">
			🔌 {hasAcIn && data.ac_input_w != null ? fmtW(data.ac_input_w) : ''}
			{hasAcIn && data.ac_input_v != null ? ` · ${fmtV(data.ac_input_v)}` : ''}
			Landstrom
		</span>
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     INDIVIDUAL MPPTs
	═══════════════════════════════════════════════════════════════ -->
	{#if data.mpptsArr.length > 0}
	<div class="section">
		<div class="section-title">MPPT Laderegler</div>
		<div class="mppt-list">
			{#each data.mpptsArr as mppt}
			<div class="mppt-row">
				<div class="mppt-info">
					<span class="mppt-name">{mpptShortName(mppt.name)}</span>
					<div class="mppt-subs">
						{#if mppt.state != null}
							<span class="mppt-state" style="color:{mpptStateColor(mppt.state)}">
								{mpptStateLabel(mppt.state)}
							</span>
						{/if}
						{#if mppt.pv_v != null}
							<span class="mppt-pv">{mppt.pv_v.toFixed(0)} V PV</span>
						{/if}
						{#if mppt.yield_total_kwh != null}
							<span class="mppt-pv">{mppt.yield_total_kwh.toFixed(0)} kWh gesamt</span>
						{/if}
					</div>
				</div>
				<div class="mppt-vals">
					<span class="mppt-power" class:mppt-active={mppt.power_w > 0}
						style={mppt.power_w > 0 ? `color:${SOLAR_COLOR}` : ''}>
						{fmtW(mppt.power_w)}
					</span>
					<span class="mppt-yield">{fmtWh(mppt.yield_today_wh)}</span>
				</div>
			</div>
			{/each}
		</div>
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     SECONDARY BATTERIES (engine, starter, etc.)
	═══════════════════════════════════════════════════════════════ -->
	{#if hasSecBatt}
	<div class="section">
		<div class="section-title">Weitere Batterien</div>
		{#each data.batteries.slice(1) as batt}
		<div class="sec-batt-row">
			<div class="sec-batt-left">
				<span class="sec-batt-name">{batt.name}</span>
				<div class="sec-batt-subs">
					{#if batt.v != null}<span>{fmtV(batt.v)}</span>{/if}
					{#if batt.a != null}
						<span class:c-green={batt.a > 0.5} class:c-amber={batt.a < -0.5}>{fmtA(batt.a)}</span>
					{/if}
					{#if batt.temp_c != null}<span class="c-muted">{fmtC(batt.temp_c)}</span>{/if}
				</div>
			</div>
			{#if batt.soc != null}
			<div class="sec-batt-right">
				<div class="sec-soc-track">
					<div class="sec-soc-fill" style="width:{Math.round(batt.soc)}%; background:{socColor(batt.soc)}"></div>
				</div>
				<span class="sec-soc-val" style="color:{socColor(batt.soc)}">{Math.round(batt.soc)} %</span>
			</div>
			{:else if batt.v != null}
			<span class="sec-v-only" style="color:{socColor(null)}">{fmtV(batt.v)}</span>
			{/if}
		</div>
		{/each}
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     AC LOAD / VERBRAUCH
	═══════════════════════════════════════════════════════════════ -->
	{#if hasLoad}
	<div class="section">
		<div class="section-title">AC Verbrauch</div>
		<div class="load-row">
			<svg width="16" height="16" viewBox="0 0 24 24" fill={LOAD_COLOR} stroke="none">
				<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
			</svg>
			<span class="load-val" style="color:{LOAD_COLOR}">{fmtW(data.load_w)}</span>
			{#if data.ac_output_v != null}
				<span class="c-muted">{fmtV(data.ac_output_v)}</span>
			{/if}
		</div>
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     TEMPERATUREN & HUMIDITY
	═══════════════════════════════════════════════════════════════ -->
	{#if hasTemps}
	<div class="section">
		<div class="section-title">Temperaturen</div>
		<div class="temp-grid">
			{#each data.temperatures as t}
			<div class="temp-cell">
				<div class="temp-name">{t.name}</div>
				<div class="temp-val">{fmtC(t.celsius)}</div>
				{#if t.humidity != null}
					<div class="temp-hum">{Math.round(t.humidity)} % rF</div>
				{/if}
			</div>
			{/each}
		</div>
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     TANKS
	═══════════════════════════════════════════════════════════════ -->
	{#if hasTanks}
	<div class="section">
		<div class="section-title">Tanks</div>
		{#each data.tanks as tank}
		{@const lvl = Math.round(tank.level)}
		{@const tc  = lvl > 60 ? 'var(--green)' : lvl > 30 ? 'var(--amber)' : 'var(--red)'}
		<div class="tank-row">
			<span class="tank-name">{tank.name}</span>
			<div class="tank-track">
				<div class="tank-fill" style="width:{lvl}%; background:{tc}"></div>
			</div>
			<span class="tank-pct" style="color:{tc}">{lvl} %</span>
		</div>
		{/each}
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     GPS
	═══════════════════════════════════════════════════════════════ -->
	{#if hasGps}
	<div class="section">
		<div class="section-title">
			<span>GPS Position</span>
			{#if gpsAgeS(data.gps_ts) != null}
			<span class="gps-age" class:gps-stale={gpsAgeS(data.gps_ts)! > 120}>
				{gpsAgeS(data.gps_ts)} s
			</span>
			{/if}
		</div>
		<div class="gps-row">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
				stroke="var(--muted)" stroke-width="2" stroke-linecap="round">
				<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/>
				<circle cx="12" cy="10" r="3"/>
			</svg>
			<span class="gps-coord">{Math.abs(data.gps_lat!).toFixed(5)}° {data.gps_lat! >= 0 ? 'N' : 'S'}</span>
			<span class="c-muted">·</span>
			<span class="gps-coord">{Math.abs(data.gps_lon!).toFixed(5)}° {data.gps_lon! >= 0 ? 'E' : 'W'}</span>
		</div>
		{#if data.gps_speed_ms != null || data.gps_course_deg != null}
		<div class="gps-row gps-row2">
			{#if data.gps_speed_ms != null}
				<span class="c-muted">SOG</span>
				<span class="gps-coord">{fmtKnots(data.gps_speed_ms)}</span>
			{/if}
			{#if data.gps_course_deg != null}
				<span class="c-muted">COG</span>
				<span class="gps-coord">{Math.round(data.gps_course_deg)}°</span>
			{/if}
		</div>
		{/if}
	</div>
	{/if}

	{/if}<!-- /data -->
</div>
{/if}

<style>
/* ── Base ────────────────────────────────────────────────── */
.vrm-card { display: flex; flex-direction: column; }

.header-row {
	display: flex; justify-content: space-between; align-items: baseline;
	margin-bottom: 14px;
}
.card-title {
	font-size: 13px; font-weight: 600; color: var(--muted);
	text-transform: uppercase; letter-spacing: 0.5px;
}
.age { font-size: 11px; color: var(--muted); }
.age.stale { color: var(--amber); }
.loading, .err-msg { font-size: 13px; color: var(--muted); }
.err-msg { color: var(--red); }

/* ── Top grid: Solar | Battery ───────────────────────────── */
.top-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
	margin-bottom: 4px;
}

.mini-box {
	border-radius: 10px;
	padding: 12px 10px;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 3px;
	text-align: center;
}
.solar-box {
	background: rgba(245,200,66,0.07);
	border: 1px solid rgba(245,200,66,0.18);
}
.batt-box {
	border: 1px solid rgba(255,255,255,0.07);
}

.mini-power {
	font-size: 20px; font-weight: 700;
	font-variant-numeric: tabular-nums; line-height: 1.1;
}
.mini-label {
	font-size: 10px; color: var(--muted);
	text-transform: uppercase; letter-spacing: 0.5px; margin-top: 1px;
}
.mini-sub { font-size: 10px; color: var(--muted); }
.ttg { color: var(--accent) !important; }

.batt-row {
	display: flex; gap: 6px; flex-wrap: wrap;
	justify-content: center; margin-top: 2px;
}
.batt-stat { font-size: 12px; font-variant-numeric: tabular-nums; }

/* ── Shore badge ─────────────────────────────────────────── */
.badge-row { margin: 6px 0 2px; }
.badge {
	display: inline-flex; align-items: center; gap: 4px;
	font-size: 11px; border-radius: 20px;
	padding: 3px 10px; font-weight: 500;
}
.shore-badge {
	background: rgba(0,180,220,0.1);
	border: 1px solid rgba(0,180,220,0.25);
	color: var(--accent);
}

/* ── Sections ────────────────────────────────────────────── */
.section { border-top: 1px solid rgba(255,255,255,0.06); padding-top: 11px; margin-top: 10px; }
.section-title {
	font-size: 10px; color: var(--muted); text-transform: uppercase;
	letter-spacing: 0.5px; margin-bottom: 8px;
	display: flex; justify-content: space-between; align-items: center;
}

/* ── MPPT ────────────────────────────────────────────────── */
.mppt-list { display: flex; flex-direction: column; gap: 7px; }
.mppt-row  { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.mppt-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.mppt-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mppt-subs { display: flex; gap: 8px; flex-wrap: wrap; }
.mppt-state { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
.mppt-pv   { font-size: 10px; color: var(--muted); }
.mppt-vals { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.mppt-power {
	font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
	color: var(--muted); min-width: 54px; text-align: right;
}
.mppt-active { font-weight: 700; }
.mppt-yield  { font-size: 11px; color: var(--muted); min-width: 60px; text-align: right; font-variant-numeric: tabular-nums; }

/* ── Secondary batteries ─────────────────────────────────── */
.sec-batt-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sec-batt-left { flex: 1; min-width: 0; }
.sec-batt-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
.sec-batt-subs { display: flex; gap: 8px; font-size: 11px; font-variant-numeric: tabular-nums; margin-top: 2px; flex-wrap: wrap; }
.sec-batt-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.sec-soc-track { width: 60px; height: 5px; background: var(--card2); border-radius: 3px; overflow: hidden; }
.sec-soc-fill  { height: 100%; border-radius: 3px; }
.sec-soc-val   { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 32px; }
.sec-v-only    { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* ── AC load ─────────────────────────────────────────────── */
.load-row { display: flex; align-items: center; gap: 8px; }
.load-val { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }

/* ── Temperatures ────────────────────────────────────────── */
.temp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 6px; }
.temp-cell {
	background: var(--card2); border-radius: 8px; padding: 8px 10px;
	display: flex; flex-direction: column; gap: 1px;
}
.temp-name { font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.temp-val  { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.temp-hum  { font-size: 10px; color: var(--muted); }

/* ── Tanks ───────────────────────────────────────────────── */
.tank-row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.tank-name {
	font-size: 12px; color: var(--muted); min-width: 70px;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tank-track { flex: 1; height: 6px; background: var(--card2); border-radius: 3px; overflow: hidden; }
.tank-fill  { height: 100%; border-radius: 3px; transition: width 0.4s; }
.tank-pct   { font-size: 12px; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }

/* ── GPS ─────────────────────────────────────────────────── */
.gps-age { font-size: 10px; color: var(--green); font-weight: 600; font-variant-numeric: tabular-nums; }
.gps-age.gps-stale { color: var(--amber); }
.gps-row  { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.gps-row2 { margin-top: 4px; }
.gps-coord { font-size: 12px; font-variant-numeric: tabular-nums; }

/* ── Utility colors ──────────────────────────────────────── */
.c-green  { color: var(--green); font-weight: 600; }
.c-amber  { color: var(--amber); font-weight: 600; }
.c-muted  { color: var(--muted); }
</style>
