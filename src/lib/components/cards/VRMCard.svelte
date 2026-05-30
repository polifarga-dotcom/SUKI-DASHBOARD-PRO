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

	// Reactive start — fires immediately when credentials are loaded
	$effect(() => {
		if (!apiReady()) return;
		fetchVRM();
		const timer = setInterval(fetchVRM, 60_000);
		return () => clearInterval(timer);
	});

	// Live tick for timestamps (independent of credentials)
	onMount(() => { tickTimer = setInterval(() => { now = Math.floor(Date.now() / 1000); }, 1000); });
	onDestroy(() => clearInterval(tickTimer));

	// ── Formatters ───────────────────────────────────────────────────────────
	function fmtW(v: number | null | undefined) {
		if (v == null) return '—';
		if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} kW`;
		return `${Math.round(v)} W`;
	}
	function fmtWh(v: number | null | undefined) {
		if (v == null) return '—';
		return v >= 1000 ? `${(v / 1000).toFixed(2)} kWh` : `${Math.round(v)} Wh`;
	}
	function fmtV(v: number | null) { return v != null ? `${v.toFixed(1)} V` : '—'; }
	function fmtA(v: number | null) {
		if (v == null) return '—';
		return `${v >= 0 ? '+' : ''}${v.toFixed(1)} A`;
	}
	function fmtC(v: number) { return `${v.toFixed(1)} °C`; }
	function fmtKnots(ms: number) { return `${(ms * 1.944).toFixed(1)} kn`; }

	function ttgStr(s: number | null) {
		if (!s || s <= 0 || s > 86400 * 10) return null;
		const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}
	function ageStr(ts: number | null) {
		if (!ts) return '';
		const s = now - ts;
		if (s < 90)   return 'Gerade eben';
		if (s < 3600) return `Vor ${Math.floor(s / 60)} Min.`;
		return `Vor ${Math.floor(s / 3600)} Std.`;
	}
	// GPS age as mm:ss after first minute, plain seconds before
	function gpsAgeStr(ts: number | null) {
		if (!ts) return null;
		const s = Math.max(0, now - ts);
		const m = Math.floor(s / 60), sec = s % 60;
		return m > 0 ? `${m}:${String(sec).padStart(2, '0')} min` : `${sec} s`;
	}
	function stale(ts: number | null)    { return ts ? (now - ts) > 180 : false; }
	function gpsStale(ts: number | null) { return ts ? (now - ts) > 120 : false; }

	function socColor(soc: number | null) {
		if (soc == null) return 'var(--muted)';
		if (soc > 50) return 'var(--green)';
		if (soc > 20) return 'var(--amber)';
		return 'var(--red)';
	}
	function mpptStateLabel(st: number | null) { return st != null ? (MPPT_STATE[st] ?? `St.${st}`) : ''; }
	function mpptStateColor(st: number | null) {
		if (st == null) return 'var(--muted)';
		if (st === 5) return 'var(--green)';
		if (st === 4) return 'var(--accent)';
		if (st === 3) return '#f5c842';
		if (st === 0) return 'var(--muted)';
		return 'var(--amber)';
	}
	function mpptShortName(name: string) {
		return name
			.replace(/^BlueSolar Charger MPPT /i, 'BlueSolar ')
			.replace(/^SmartSolar Charger MPPT /i, 'SmartSolar ')
			.replace(/^BlueSolar Charger /i, 'BlueSolar ')
			.replace(/^SmartSolar Charger /i, 'SmartSolar ')
			.replace(/^Victron Energy /i, '')
			.replace(/^Victron /i, '');
	}

	const SOLAR_C = '#f5c842';

	// Max W across all MPPTs — used for relative power bars
	const mpptMaxW   = $derived(data ? Math.max(100, ...data.mpptsArr.map(m => m.power_w)) : 100);

	// Section visibility guards
	const hasSolar   = $derived(!!data && (data.solar_w != null || data.mpptsArr.length > 0));
	const hasBatt    = $derived(!!data && (data.battery_soc != null || data.battery_v != null));
	const hasSecBatt = $derived(!!data && data.batteries.length > 1);
	const hasAcIn    = $derived(!!data && (data.ac_input_v != null || data.ac_input_w != null));
	const hasLoad    = $derived(!!data && data.load_w != null && data.load_w > 5);
	const hasTemps   = $derived(!!data && data.temperatures.length > 0);
	const hasTanks   = $derived(!!data && data.tanks.length > 0);
	const hasGps     = $derived(!!data && data.gps_lat != null && data.gps_lon != null);
	const isCharging = $derived(!!data && (data.battery_a ?? 0) > 0.5);
	const isDischarging = $derived(!!data && (data.battery_a ?? 0) < -0.5);
	const hasSources = $derived(hasSolar || hasAcIn);
</script>

{#if apiReady()}
<div class="card vrm-card">

	<!-- ── Header ──────────────────────────────────────────────── -->
	<div class="hdr">
		<span class="card-title">Victron VRM</span>
		{#if data?.last_ts}
			<span class="age" class:stale={stale(data.last_ts)}>{ageStr(data.last_ts)}</span>
		{/if}
	</div>

	{#if error}
		<p class="err">{error}</p>
	{:else if !data}
		<p class="loading">Verbinde mit VRM…</p>
	{:else}

	<!-- ══════════════════════════════════════════════════════════
	     ENERGY FLOW  (Venus OS-style vertical diagram)
	═══════════════════════════════════════════════════════════════ -->
	<div class="ef">

		<!-- Sources row: Solar · Landstrom -->
		{#if hasSources}
		<div class="ef-sources">
			{#if hasSolar}
			<div class="ef-node ef-solar">
				<!-- Sun icon -->
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
					stroke={SOLAR_C} stroke-width="2" stroke-linecap="round">
					<circle cx="12" cy="12" r="4" fill={SOLAR_C} stroke="none"/>
					<line x1="12" y1="2"  x2="12" y2="5"/>
					<line x1="12" y1="19" x2="12" y2="22"/>
					<line x1="4.22" y1="4.22"  x2="6.34" y2="6.34"/>
					<line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
					<line x1="2"  y1="12" x2="5"  y2="12"/>
					<line x1="19" y1="12" x2="22" y2="12"/>
					<line x1="4.22"  y1="19.78" x2="6.34" y2="17.66"/>
					<line x1="17.66" y1="6.34"  x2="19.78" y2="4.22"/>
				</svg>
				<div class="ef-val" style="color:{SOLAR_C}">{fmtW(data.solar_w)}</div>
				<div class="ef-lbl">Solar</div>
			</div>
			{/if}

			{#if hasAcIn}
			<div class="ef-node ef-shore">
				<!-- Plug icon -->
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
					stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M9 3v4M15 3v4M7 7h10v7a5 5 0 01-10 0V7z"/>
					<path d="M12 19v2"/>
				</svg>
				<div class="ef-val" style="color:var(--accent)">{fmtW(data.ac_input_w)}</div>
				<div class="ef-lbl">Landstrom</div>
				{#if data.ac_input_v != null}
				<div class="ef-sub">{fmtV(data.ac_input_v)}</div>
				{/if}
			</div>
			{/if}
		</div>

		<!-- Connector: sources → battery -->
		<div class="ef-connector">
			<div class="ef-stem"></div>
			<div class="ef-tip">▼</div>
		</div>
		{/if}

		<!-- Battery block (central element) -->
		{#if hasBatt}
		{@const soc = Math.round(data.battery_soc ?? 0)}
		{@const r = 30}
		{@const circ = +(2 * Math.PI * r).toFixed(2)}
		{@const col = socColor(data.battery_soc)}
		<div class="ef-batt" style="border-color:{col}30">
			<!-- SOC ring gauge -->
			{#if data.battery_soc != null}
			<svg width="72" height="72" viewBox="0 0 72 72" style="flex-shrink:0">
				<circle cx="36" cy="36" r={r} fill="none" stroke="var(--card2)" stroke-width="7"/>
				<circle cx="36" cy="36" r={r} fill="none"
					stroke={col} stroke-width="7"
					stroke-dasharray="{+(circ * soc / 100).toFixed(2)} {circ}"
					stroke-linecap="round"
					transform="rotate(-90 36 36)"/>
				<text x="36" y="40" text-anchor="middle" font-size="14" font-weight="700" fill={col}>{soc}%</text>
			</svg>
			{:else}
			<!-- Battery outline icon if no SOC -->
			<svg width="40" height="40" viewBox="0 0 24 24" fill="none"
				stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" style="flex-shrink:0;opacity:0.5">
				<rect x="2" y="7" width="18" height="11" rx="2"/>
				<path d="M22 11v3"/>
			</svg>
			{/if}
			<div class="ef-batt-right">
				<div class="ef-batt-lbl">Batterie</div>
				<div class="ef-batt-stats">
					{#if data.battery_v != null}
					<span class="ef-stat">{fmtV(data.battery_v)}</span>
					{/if}
					{#if data.battery_a != null}
					<span class="ef-stat" class:c-green={isCharging} class:c-amber={isDischarging}>
						{fmtA(data.battery_a)}
					</span>
					{/if}
					{#if data.battery_w != null}
					<span class="ef-stat c-muted">{fmtW(data.battery_w)}</span>
					{/if}
				</div>
				{#if ttgStr(data.batteries[0]?.time_to_go_s)}
				<div class="ef-ttg">⏱ {ttgStr(data.batteries[0].time_to_go_s)} verbleibend</div>
				{/if}
			</div>
		</div>
		{/if}

		<!-- Connector: battery → load -->
		{#if hasLoad}
		<div class="ef-connector">
			<div class="ef-stem"></div>
			<div class="ef-tip">▼</div>
		</div>
		<div class="ef-node ef-load">
			<!-- Bolt / consumption icon -->
			<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
				<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
			</svg>
			<div class="ef-val" style="color:var(--accent)">{fmtW(data.load_w)}</div>
			<div class="ef-lbl">Verbrauch</div>
			{#if data.ac_output_v != null}
			<div class="ef-sub">{fmtV(data.ac_output_v)}</div>
			{/if}
		</div>
		{/if}

	</div><!-- /ef -->

	<!-- ══════════════════════════════════════════════════════════
	     MPPT LADEREGLER — individual chargers with power bars
	═══════════════════════════════════════════════════════════════ -->
	{#if data.mpptsArr.length > 0}
	<div class="section">
		<div class="section-title">MPPT Laderegler</div>
		<div class="mppt-list">
			{#each data.mpptsArr as mppt}
			{@const barPct = mpptMaxW > 0 ? Math.min(100, (mppt.power_w / mpptMaxW) * 100) : 0}
			<div class="mppt-row">
				<!-- Name + values -->
				<div class="mppt-head">
					<span class="mppt-name">{mpptShortName(mppt.name)}</span>
					<div class="mppt-nums">
						<span class="mppt-w" style={mppt.power_w > 0 ? `color:${SOLAR_C}` : ''}>
							{fmtW(mppt.power_w)}
						</span>
						<span class="mppt-wh c-muted">{fmtWh(mppt.yield_today_wh)}</span>
					</div>
				</div>
				<!-- Thin power bar -->
				<div class="mppt-bar-track">
					<div class="mppt-bar-fill" style="width:{barPct}%; background:{SOLAR_C}80"></div>
				</div>
				<!-- Meta: state · PV voltage · lifetime -->
				<div class="mppt-meta">
					{#if mppt.state != null}
					<span class="mppt-state" style="color:{mpptStateColor(mppt.state)}">{mpptStateLabel(mppt.state)}</span>
					{/if}
					{#if mppt.pv_v != null}
					<span class="c-muted mppt-pv">{mppt.pv_v.toFixed(0)} V</span>
					{/if}
					{#if mppt.yield_total_kwh != null}
					<span class="c-muted mppt-pv">{mppt.yield_total_kwh.toFixed(0)} kWh ges.</span>
					{/if}
				</div>
			</div>
			{/each}
		</div>
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     WEITERE BATTERIEN  (engine, starter …)
	═══════════════════════════════════════════════════════════════ -->
	{#if hasSecBatt}
	<div class="section">
		<div class="section-title">Weitere Batterien</div>
		{#each data.batteries.slice(1) as batt}
		<div class="sec-row">
			<div class="sec-left">
				<span class="sec-name">{batt.name}</span>
				<div class="sec-subs">
					{#if batt.v != null}<span>{fmtV(batt.v)}</span>{/if}
					{#if batt.a != null}
					<span class:c-green={batt.a > 0.5} class:c-amber={batt.a < -0.5}>{fmtA(batt.a)}</span>
					{/if}
					{#if batt.temp_c != null}<span class="c-muted">{fmtC(batt.temp_c)}</span>{/if}
				</div>
			</div>
			{#if batt.soc != null}
			<div class="sec-right">
				<div class="soc-track">
					<div class="soc-fill" style="width:{Math.round(batt.soc)}%; background:{socColor(batt.soc)}"></div>
				</div>
				<span class="soc-val" style="color:{socColor(batt.soc)}">{Math.round(batt.soc)} %</span>
			</div>
			{:else if batt.v != null}
			<span class="sec-v" style="color:{socColor(null)}">{fmtV(batt.v)}</span>
			{/if}
		</div>
		{/each}
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     TEMPERATUREN & LUFTFEUCHTIGKEIT
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
	     GPS — live age counter (mm:ss after 60 s)
	═══════════════════════════════════════════════════════════════ -->
	{#if hasGps}
	{@const gpsAge = gpsAgeStr(data.gps_ts)}
	<div class="section">
		<div class="section-title">
			<span>GPS Position</span>
			{#if gpsAge}
			<span class="gps-age" class:gps-stale={gpsStale(data.gps_ts)}>⟳ {gpsAge}</span>
			{/if}
		</div>
		<div class="gps-row">
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
				stroke="var(--muted)" stroke-width="2" stroke-linecap="round">
				<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/>
				<circle cx="12" cy="10" r="3"/>
			</svg>
			<span class="gps-val">{Math.abs(data.gps_lat!).toFixed(5)}° {data.gps_lat! >= 0 ? 'N' : 'S'}</span>
			<span class="c-muted">·</span>
			<span class="gps-val">{Math.abs(data.gps_lon!).toFixed(5)}° {data.gps_lon! >= 0 ? 'E' : 'W'}</span>
		</div>
		{#if data.gps_speed_ms != null || data.gps_course_deg != null}
		<div class="gps-row gps-sog">
			{#if data.gps_speed_ms != null}
			<span class="c-muted">SOG</span>
			<span class="gps-val">{fmtKnots(data.gps_speed_ms)}</span>
			{/if}
			{#if data.gps_course_deg != null}
			<span class="c-muted">COG</span>
			<span class="gps-val">{Math.round(data.gps_course_deg)}°</span>
			{/if}
		</div>
		{/if}
	</div>
	{/if}

	{/if}<!-- /data -->
</div>
{/if}

<style>
/* ── Card wrapper ─────────────────────────────────────────── */
.vrm-card { display: flex; flex-direction: column; }

/* ── Header ──────────────────────────────────────────────── */
.hdr {
	display: flex; justify-content: space-between; align-items: baseline;
	margin-bottom: 14px;
}
.card-title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.age { font-size: 11px; color: var(--muted); }
.age.stale { color: var(--amber); }
.loading { font-size: 13px; color: var(--muted); }
.err { font-size: 13px; color: var(--red); }

/* ── Energy Flow ─────────────────────────────────────────── */
.ef {
	display: flex; flex-direction: column; align-items: center;
	gap: 0; margin-bottom: 4px;
}

/* Sources row */
.ef-sources {
	display: flex; justify-content: center; gap: 10px;
	width: 100%;
}

/* Generic source/sink node */
.ef-node {
	display: flex; flex-direction: column; align-items: center; gap: 3px;
	padding: 8px 16px; border-radius: 10px; text-align: center;
	flex: 1; min-width: 0;
}
.ef-solar { background: rgba(245,200,66,0.08); border: 1px solid rgba(245,200,66,0.22); }
.ef-shore { background: rgba(0,160,230,0.07);  border: 1px solid rgba(0,160,230,0.22); }
.ef-load  { background: rgba(0,160,230,0.06);  border: 1px solid rgba(0,160,230,0.18); }
.ef-val   { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.ef-lbl   { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; margin-top: 1px; }
.ef-sub   { font-size: 10px; color: var(--muted); }

/* Connector line + arrowhead */
.ef-connector {
	display: flex; flex-direction: column; align-items: center;
	height: 18px; color: var(--muted); opacity: 0.35; flex-shrink: 0;
}
.ef-stem { width: 1px; flex: 1; background: currentColor; }
.ef-tip  { font-size: 7px; line-height: 1; }

/* Battery central block */
.ef-batt {
	display: flex; align-items: center; gap: 12px;
	width: 100%; padding: 10px 14px;
	border-radius: 12px;
	border: 1px solid rgba(255,255,255,0.07);
	background: rgba(255,255,255,0.025);
}
.ef-batt-right { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.ef-batt-lbl  { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
.ef-batt-stats { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.ef-stat  { font-size: 13px; font-variant-numeric: tabular-nums; }
.ef-ttg   { font-size: 11px; color: var(--accent); }

/* ── Sections ────────────────────────────────────────────── */
.section { border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; margin-top: 10px; }
.section-title {
	font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;
	margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;
}

/* ── MPPT list ───────────────────────────────────────────── */
.mppt-list { display: flex; flex-direction: column; gap: 10px; }
.mppt-row  { display: flex; flex-direction: column; gap: 3px; }

.mppt-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.mppt-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.mppt-nums { display: flex; align-items: baseline; gap: 8px; flex-shrink: 0; }
.mppt-w    { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.mppt-wh   { font-size: 11px; font-variant-numeric: tabular-nums; }

.mppt-bar-track { height: 3px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; }
.mppt-bar-fill  { height: 100%; border-radius: 2px; transition: width 0.6s ease; }

.mppt-meta  { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.mppt-state { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
.mppt-pv    { font-size: 10px; }

/* ── Secondary batteries ─────────────────────────────────── */
.sec-row  { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sec-left { flex: 1; min-width: 0; }
.sec-name { font-size: 12px; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sec-subs { display: flex; gap: 8px; font-size: 11px; font-variant-numeric: tabular-nums; margin-top: 2px; flex-wrap: wrap; }
.sec-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.soc-track { width: 60px; height: 5px; background: var(--card2); border-radius: 3px; overflow: hidden; }
.soc-fill  { height: 100%; border-radius: 3px; }
.soc-val   { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 32px; }
.sec-v     { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--muted); }

/* ── Temperatures ────────────────────────────────────────── */
.temp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 6px; }
.temp-cell { background: var(--card2); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.temp-name { font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.temp-val  { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.temp-hum  { font-size: 10px; color: var(--muted); }

/* ── Tanks ───────────────────────────────────────────────── */
.tank-row  { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.tank-name { font-size: 12px; color: var(--muted); min-width: 70px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tank-track { flex: 1; height: 6px; background: var(--card2); border-radius: 3px; overflow: hidden; }
.tank-fill  { height: 100%; border-radius: 3px; transition: width 0.4s; }
.tank-pct   { font-size: 12px; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }

/* ── GPS ─────────────────────────────────────────────────── */
.gps-age  { font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--green); }
.gps-age.gps-stale { color: var(--amber); }
.gps-row  { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.gps-sog  { margin-top: 4px; }
.gps-val  { font-size: 12px; font-variant-numeric: tabular-nums; }

/* ── Utility colours ─────────────────────────────────────── */
.c-green { color: var(--green); font-weight: 600; }
.c-amber { color: var(--amber); font-weight: 600; }
.c-muted { color: var(--muted); }
</style>
