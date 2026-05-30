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

	// Reactive start — fires as soon as credentials are loaded from Supabase
	$effect(() => {
		if (!apiReady()) return;
		fetchVRM();
		const timer = setInterval(fetchVRM, 60_000);
		return () => clearInterval(timer);
	});

	// Live tick for timestamps/GPS age counter
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
	// mm:ss after the first minute, plain seconds before
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
		if (soc > 50) return '#4ec7ff';   // Venus OS blue for good SOC
		if (soc > 20) return 'var(--amber)';
		return 'var(--red)';
	}
	function socBorderColor(soc: number | null) {
		if (soc == null) return 'rgba(0,120,230,0.2)';
		if (soc > 50) return 'rgba(0,160,255,0.45)';
		if (soc > 20) return 'rgba(230,160,0,0.45)';
		return 'rgba(220,60,60,0.45)';
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

	// Max W across MPPTs — for power bar scaling
	const mpptMaxW = $derived(data ? Math.max(100, ...data.mpptsArr.map(m => m.power_w)) : 100);

	// Section guards
	const hasSolar   = $derived(!!data && (data.solar_w != null || data.mpptsArr.length > 0));
	const hasBatt    = $derived(!!data && (data.battery_soc != null || data.battery_v != null));
	const hasSecBatt = $derived(!!data && data.batteries.length > 1);
	const hasAcIn    = $derived(!!data && (data.ac_input_v != null || data.ac_input_w != null));
	const hasLoad    = $derived(!!data && data.load_w != null && data.load_w > 5);
	const hasTemps   = $derived(!!data && data.temperatures.length > 0);
	const hasTanks   = $derived(!!data && data.tanks.length > 0);
	const hasGps     = $derived(!!data && data.gps_lat != null && data.gps_lon != null);
	const isCharging    = $derived(!!data && (data.battery_a ?? 0) > 0.5);
	const isDischarging = $derived(!!data && (data.battery_a ?? 0) < -0.5);

	// Venus OS battery status label
	const battStatus = $derived(
		!data ? '' :
		(data.battery_a ?? 0) > 0.5  ? 'Laden' :
		(data.battery_a ?? 0) < -0.5 ? 'Entladen' :
		data.mpptsArr.some(m => m.state === 5) ? 'Float' :
		data.mpptsArr.some(m => m.state === 3 || m.state === 4) ? 'Laden' :
		'Bereit'
	);
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
	     ENERGY FLOW  —  Venus OS 3-box horizontal layout
	═══════════════════════════════════════════════════════════════ -->
	<div class="vf">
		<div class="vf-row">

			<!-- LEFT: Sources (Solar and/or Shore stacked) -->
			{#if hasSolar || hasAcIn}
			<div class="vf-sources">

				{#if hasSolar}
				<div class="vf-box vf-solar">
					<div class="vf-box-head">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
							stroke={SOLAR_C} stroke-width="2" stroke-linecap="round">
							<circle cx="12" cy="12" r="4" fill={SOLAR_C} stroke="none"/>
							<line x1="12" y1="2"  x2="12" y2="5"/>
							<line x1="12" y1="19" x2="12" y2="22"/>
							<line x1="4.22" y1="4.22"  x2="6.34" y2="6.34"/>
							<line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
							<line x1="2" y1="12" x2="5" y2="12"/>
							<line x1="19" y1="12" x2="22" y2="12"/>
							<line x1="4.22"  y1="19.78" x2="6.34" y2="17.66"/>
							<line x1="17.66" y1="6.34"  x2="19.78" y2="4.22"/>
						</svg>
						<span class="vf-lbl">Solar</span>
					</div>
					<div class="vf-big" style="color:{SOLAR_C}">{fmtW(data.solar_w)}</div>
					{#if data.solar_yield_today_wh}
					<div class="vf-sub">{fmtWh(data.solar_yield_today_wh)} heute</div>
					{/if}
				</div>
				{/if}

				{#if hasAcIn}
				<div class="vf-box vf-shore">
					<div class="vf-box-head">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
							stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M9 3v4M15 3v4M7 7h10v7a5 5 0 01-10 0V7z"/>
							<path d="M12 19v2"/>
						</svg>
						<span class="vf-lbl">Landstrom</span>
					</div>
					<div class="vf-big" style="color:var(--accent)">{fmtW(data.ac_input_w)}</div>
					{#if data.ac_input_v != null}
					<div class="vf-sub">{fmtV(data.ac_input_v)}</div>
					{/if}
				</div>
				{/if}

			</div><!-- /vf-sources -->

			<!-- Arrow → Battery -->
			<div class="vf-arrow">
				<div class="vf-line"></div>
				<div class="vf-head"></div>
			</div>
			{/if}

			<!-- CENTER: Battery (dominant box) -->
			{#if hasBatt}
			{@const soc = Math.round(data.battery_soc ?? 0)}
			{@const col = socColor(data.battery_soc)}
			{@const brd = socBorderColor(data.battery_soc)}
			<div class="vf-box vf-batt" style="border-color:{brd}" class:vf-charging={isCharging}>
				<div class="vf-box-head">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
						stroke={col} stroke-width="2" stroke-linecap="round">
						<rect x="2" y="7" width="16" height="11" rx="2"/>
						<path d="M20 11v3"/>
					</svg>
					<span class="vf-lbl">Batterie</span>
				</div>
				{#if data.battery_soc != null}
				<div class="vf-soc" style="color:{col}">{soc}%</div>
				{/if}
				{#if battStatus}
				<div class="vf-status" style="color:{col}aa">{battStatus}</div>
				{/if}
				<div class="vf-batt-vals">
					{#if data.battery_v != null}<span class="vf-stat">{fmtV(data.battery_v)}</span>{/if}
					{#if data.battery_a != null}
					<span class="vf-stat" class:c-green={isCharging} class:c-amber={isDischarging}>{fmtA(data.battery_a)}</span>
					{/if}
				</div>
				{#if data.battery_w != null}
				<div class="vf-sub">{fmtW(data.battery_w)}</div>
				{/if}
				{#if ttgStr(data.batteries[0]?.time_to_go_s)}
				<div class="vf-ttg">⏱ {ttgStr(data.batteries[0].time_to_go_s)}</div>
				{/if}
			</div>
			{/if}

			<!-- Arrow → Load -->
			{#if hasLoad && hasBatt}
			<div class="vf-arrow">
				<div class="vf-line"></div>
				<div class="vf-head"></div>
			</div>

			<!-- RIGHT: Load -->
			<div class="vf-box vf-load">
				<div class="vf-box-head">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
						<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
					</svg>
					<span class="vf-lbl">Verbrauch</span>
				</div>
				<div class="vf-big" style="color:var(--accent)">{fmtW(data.load_w)}</div>
				{#if data.ac_output_v != null}
				<div class="vf-sub">{fmtV(data.ac_output_v)}</div>
				{/if}
			</div>
			{/if}

		</div><!-- /vf-row -->
	</div><!-- /vf -->

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
				<div class="mppt-head">
					<span class="mppt-name">{mpptShortName(mppt.name)}</span>
					<div class="mppt-nums">
						<span class="mppt-w" style={mppt.power_w > 0 ? `color:${SOLAR_C}` : ''}>{fmtW(mppt.power_w)}</span>
						<span class="mppt-wh c-muted">{fmtWh(mppt.yield_today_wh)}</span>
					</div>
				</div>
				<div class="mppt-bar-track">
					<div class="mppt-bar-fill" style="width:{barPct}%; background:{SOLAR_C}80"></div>
				</div>
				<div class="mppt-meta">
					{#if mppt.state != null}
					<span class="mppt-state" style="color:{mpptStateColor(mppt.state)}">{mpptStateLabel(mppt.state)}</span>
					{/if}
					{#if mppt.pv_v != null}<span class="c-muted mppt-pv">{mppt.pv_v.toFixed(0)} V PV</span>{/if}
					{#if mppt.yield_total_kwh != null}<span class="c-muted mppt-pv">{mppt.yield_total_kwh.toFixed(0)} kWh ges.</span>{/if}
				</div>
			</div>
			{/each}
		</div>
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     TANKS  (directly below energy flow)
	═══════════════════════════════════════════════════════════════ -->
	{#if hasTanks}
	<div class="section">
		<div class="section-title">Tanks</div>
		{#each data.tanks as tank}
		{@const lvl = Math.round(tank.level)}
		{@const tc  = lvl > 60 ? 'var(--green)' : lvl > 30 ? 'var(--amber)' : 'var(--red)'}
		<div class="tank-row">
			<span class="tank-name">{tank.name}</span>
			<div class="tank-track"><div class="tank-fill" style="width:{lvl}%; background:{tc}"></div></div>
			<span class="tank-pct" style="color:{tc}">{lvl} %</span>
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
				<div class="soc-track"><div class="soc-fill" style="width:{Math.round(batt.soc)}%; background:{socColor(batt.soc)}"></div></div>
				<span class="soc-val" style="color:{socColor(batt.soc)}">{Math.round(batt.soc)} %</span>
			</div>
			{:else if batt.v != null}
			<span class="sec-v">{fmtV(batt.v)}</span>
			{/if}
		</div>
		{/each}
	</div>
	{/if}

	<!-- ══════════════════════════════════════════════════════════
	     GPS  —  live age counter (mm:ss after 60 s)
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
			<svg width="11" height="11" viewBox="0 0 24 24" fill="none"
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
			{#if data.gps_speed_ms != null}<span class="c-muted">SOG</span><span class="gps-val">{fmtKnots(data.gps_speed_ms)}</span>{/if}
			{#if data.gps_course_deg != null}<span class="c-muted">COG</span><span class="gps-val">{Math.round(data.gps_course_deg)}°</span>{/if}
		</div>
		{/if}
	</div>
	{/if}

	{/if}<!-- /data -->
</div>
{/if}

<style>
/* ── Card ─────────────────────────────────────────────────── */
.vrm-card { display: flex; flex-direction: column; }

/* ── Header ──────────────────────────────────────────────── */
.hdr { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
.card-title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.age { font-size: 11px; color: var(--muted); }
.age.stale { color: var(--amber); }
.loading { font-size: 13px; color: var(--muted); }
.err { font-size: 13px; color: var(--red); }

/* ══ ENERGY FLOW — Venus OS 3-box horizontal ══════════════ */
.vf { margin-bottom: 6px; }

.vf-row {
	display: flex;
	align-items: flex-start;   /* boxes size to their content */
	gap: 0;
}

/* Sources column: Solar and/or Shore stacked vertically */
.vf-sources {
	display: flex;
	flex-direction: column;
	gap: 5px;
	flex: 1;
	min-width: 0;
}

/* ── Venus OS-style boxes ─────────────────────────────────── */
.vf-box {
	border-radius: 10px;
	padding: 10px 11px;
	display: flex;
	flex-direction: column;
	gap: 3px;
}

/* Solar box: yellow tint */
.vf-solar {
	background: rgba(245, 200, 66, 0.08);
	border: 1px solid rgba(245, 200, 66, 0.25);
	flex: 1;
}

/* Shore/AC box: blue tint */
.vf-shore {
	background: rgba(0, 140, 230, 0.08);
	border: 1px solid rgba(0, 140, 230, 0.25);
}

/* Battery box: centre, dominant — border set inline from socBorderColor() */
.vf-batt {
	background: rgba(0, 80, 160, 0.12);
	border: 1px solid rgba(0, 120, 230, 0.22); /* fallback, overridden inline */
	flex: 1.4;
	min-width: 0;
}
.vf-batt.vf-charging {
	background: rgba(0, 100, 200, 0.18);
}

/* Load box: right */
.vf-load {
	background: rgba(0, 140, 200, 0.08);
	border: 1px solid rgba(0, 140, 200, 0.22);
	flex: 0.85;
	min-width: 0;
}

/* Box header: icon + label on one row */
.vf-box-head {
	display: flex;
	align-items: center;
	gap: 4px;
	margin-bottom: 2px;
}
.vf-lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }

/* Main values */
.vf-big  { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.vf-soc  { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.vf-status { font-size: 10px; margin-top: -1px; }
.vf-sub  { font-size: 10px; color: var(--muted); }
.vf-ttg  { font-size: 10px; color: var(--accent); }

.vf-batt-vals {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 8px;
	margin-top: 1px;
}
.vf-stat { font-size: 12px; font-variant-numeric: tabular-nums; }

/* ── CSS Arrow  line + filled triangle ───────────────────── */
.vf-arrow {
	display: flex;
	align-items: center;
	align-self: center;    /* vertically centered relative to boxes */
	padding: 0 3px;
	flex-shrink: 0;
}
.vf-line {
	width: 12px;
	height: 1.5px;
	background: rgba(0, 140, 255, 0.3);
}
.vf-head {
	width: 0; height: 0;
	border-top:    4px solid transparent;
	border-bottom: 4px solid transparent;
	border-left:   6px solid rgba(0, 140, 255, 0.3);
}

/* ── Sections ────────────────────────────────────────────── */
.section { border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; margin-top: 10px; }
.section-title {
	font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;
	margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;
}

/* ── MPPTs ───────────────────────────────────────────────── */
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

/* ── Tanks ───────────────────────────────────────────────── */
.tank-row  { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.tank-name { font-size: 12px; color: var(--muted); min-width: 70px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tank-track { flex: 1; height: 6px; background: var(--card2); border-radius: 3px; overflow: hidden; }
.tank-fill  { height: 100%; border-radius: 3px; transition: width 0.4s; }
.tank-pct   { font-size: 12px; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }

/* ── Temperatures ────────────────────────────────────────── */
.temp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 6px; }
.temp-cell { background: var(--card2); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.temp-name { font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.temp-val  { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.temp-hum  { font-size: 10px; color: var(--muted); }

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

/* ── GPS ─────────────────────────────────────────────────── */
.gps-age  { font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--green); }
.gps-age.gps-stale { color: var(--amber); }
.gps-row  { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.gps-sog  { margin-top: 4px; }
.gps-val  { font-size: 12px; font-variant-numeric: tabular-nums; }

/* ── Utilities ───────────────────────────────────────────── */
.c-green { color: var(--green); font-weight: 600; }
.c-amber { color: var(--amber); font-weight: 600; }
.c-muted { color: var(--muted); }
</style>
