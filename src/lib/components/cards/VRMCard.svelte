<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { parseVRMDiagnostics, MPPT_STATE } from '$lib/utils/vrm.js';
	import type { VRMData } from '$lib/types.js';

	let data         = $state<VRMData | null>(null);
	let error        = $state('');
	let now          = $state(Math.floor(Date.now() / 1000));
	let lastFetchAt  = $state<number | null>(null);  // epoch-s of our last successful API call
	let lastKnownTs  = $state<number | null>(null);  // last_ts we've confirmed from the API
	let polling      = $state(false);                // true = hot-window (waiting for new upload)

	let nextTimer: ReturnType<typeof setTimeout> | null = null;
	let tickTimer:  ReturnType<typeof setInterval>;
	let fetching    = false;

	const cfg = $derived($anchorConfig);
	function apiReady() { return !!(cfg?.vrm_api_token && cfg?.vrm_installation_id); }

	// Schedule the next fetch after delayMs — self-scheduling, no setInterval needed
	function schedule(delayMs: number) {
		if (nextTimer) clearTimeout(nextTimer);
		nextTimer = setTimeout(fetchVRM, delayMs);
	}

	async function fetchVRM() {
		if (fetching) return;
		fetching = true;
		try {
			const { data: json, error: fnErr } = await supabase.functions.invoke('vrm-proxy');
			if (fnErr) { error = fnErr.message; schedule(30_000); return; }

			const parsed = parseVRMDiagnostics(json?.records ?? []);
			data        = parsed;
			lastFetchAt = Math.floor(Date.now() / 1000);
			error       = '';

			const newTs = parsed.last_ts;

			if (newTs && newTs !== lastKnownTs) {
				// ✓ Fresh upload from Cerbo detected
				// Schedule next fetch for 5 s before the expected next upload (upload every ~60 s)
				lastKnownTs = newTs;
				polling     = false;
				const msUntilHotWindow = Math.max(5_000, (newTs + 55) * 1000 - Date.now());
				schedule(msUntilHotWindow);
			} else {
				// Same timestamp — Cerbo hasn't pushed new data yet
				// Enter / stay in hot-window mode: retry every 5 s
				polling = true;
				schedule(5_000);
			}
		} catch (e) {
			error = String(e);
			schedule(30_000);
		} finally {
			fetching = false;
		}
	}

	// Start self-scheduling loop when credentials are ready
	$effect(() => {
		if (!apiReady()) return;
		lastKnownTs = null;
		polling     = false;
		fetchVRM();
		return () => { if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; } };
	});

	// Re-fetch immediately when user returns to the tab
	$effect(() => {
		const onVisible = () => {
			if (!document.hidden && apiReady()) {
				if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
				fetchVRM();
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	// Tick: live seconds counter for GPS age + fetch age display
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

	// Age of VRM cloud data (how old is the Cerbo's last upload)
	function dataAgeStr(ts: number | null) {
		if (!ts) return null;
		const s = now - ts;
		if (s < 90)   return 'Gerade eben';
		if (s < 3600) return `${Math.floor(s / 60)} Min. alt`;
		return `${Math.floor(s / 3600)} Std. alt`;
	}
	// Age of our last fetch from the API
	function fetchAgeStr(ts: number | null) {
		if (!ts) return null;
		const s = now - ts;
		if (s < 10)   return 'Jetzt';
		if (s < 90)   return `${s} s`;
		return `${Math.floor(s / 60)} Min.`;
	}
	// GPS age as mm:ss after the first minute
	function gpsAgeStr(ts: number | null) {
		if (!ts) return null;
		const s = Math.max(0, now - ts);
		const m = Math.floor(s / 60), sec = s % 60;
		return m > 0 ? `${m}:${String(sec).padStart(2, '0')} min` : `${sec} s`;
	}
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

	// Max W for MPPT bar scaling
	const mpptMaxW = $derived(data ? Math.max(100, ...data.mpptsArr.map(m => m.power_w)) : 100);

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

	// Battery status label (Venus OS style)
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
		<div class="hdr-right">
			{#if polling}
			<span class="poll-spin" title="Warte auf neues VRM-Update…">⟳</span>
			{/if}
			{#if data?.last_ts}
			<!-- Data age: how old is the Cerbo's last upload to VRM cloud -->
			<span class="data-age" class:age-warn={data.last_ts != null && (now - data.last_ts) > 300}>
				{dataAgeStr(data.last_ts)}
			</span>
			{/if}
			{#if lastFetchAt}
			<span class="fetch-dot" title="Abgeholt vor {fetchAgeStr(lastFetchAt)}">●</span>
			{/if}
		</div>
	</div>

	{#if error}
		<p class="err">{error}</p>
	{:else if !data}
		<p class="loading">Verbinde mit VRM…</p>
	{:else}

	<!-- ══════════════════════════════════════════════════════════
	     ENERGY FLOW — Venus OS style (local app reference)
	     Top: Solar/Shore source box (full width)
	     │
	     Hub: [Battery] [──] [AC Load]
	═══════════════════════════════════════════════════════════════ -->
	<div class="vflow">

		<!-- SOURCE BOX: Solar (full width), or Shore when no solar -->
		{#if hasSolar}
		<div class="vf-source vf-solar-src">
			<div class="vf-src-top">
				<div class="vf-src-lbl">
					<!-- Sun icon -->
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
						stroke={SOLAR_C} stroke-width="2" stroke-linecap="round">
						<circle cx="12" cy="12" r="4" fill={SOLAR_C} stroke="none"/>
						<line x1="12" y1="2"  x2="12" y2="5"/>
						<line x1="12" y1="19" x2="12" y2="22"/>
						<line x1="4.22" y1="4.22"  x2="6.34" y2="6.34"/>
						<line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
						<line x1="2" y1="12" x2="5" y2="12"/>
						<line x1="19" y1="12" x2="22" y2="12"/>
						<line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/>
						<line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
					</svg>
					Solar Total
				</div>
				<div class="vf-src-vals">
					<span class="vf-src-big" style="color:{SOLAR_C}">{fmtW(data.solar_w)}</span>
					{#if data.solar_yield_today_wh}
					<span class="vf-src-sub">{fmtWh(data.solar_yield_today_wh)} heute</span>
					{/if}
				</div>
			</div>
			<!-- MPPT pills — compact summary per charger -->
			{#if data.mpptsArr.length > 0}
			<div class="vf-mppt-strip">
				{#each data.mpptsArr as mppt}
				<span class="vf-mppt-pill">
					{mpptShortName(mppt.name)} <b style="color:{SOLAR_C}">{fmtW(mppt.power_w)}</b>
				</span>
				{/each}
			</div>
			{/if}
			<!-- Shore power badge inside solar box if also connected -->
			{#if hasAcIn}
			<div class="vf-shore-inline">
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none"
					stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M9 3v4M15 3v4M7 7h10v7a5 5 0 01-10 0V7z"/>
					<path d="M12 19v2"/>
				</svg>
				Landstrom ·
				{#if data.ac_input_v != null}<span>{fmtV(data.ac_input_v)}</span>{/if}
				{#if data.ac_input_w != null}<span>{fmtW(data.ac_input_w)}</span>{/if}
			</div>
			{/if}
		</div>

		{:else if hasAcIn}
		<!-- Shore only (no solar): show shore as source box -->
		<div class="vf-source vf-shore-src">
			<div class="vf-src-top">
				<div class="vf-src-lbl">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
						stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M9 3v4M15 3v4M7 7h10v7a5 5 0 01-10 0V7z"/>
						<path d="M12 19v2"/>
					</svg>
					Landstrom
				</div>
				<div class="vf-src-vals">
					<span class="vf-src-big" style="color:var(--accent)">{fmtW(data.ac_input_w)}</span>
					{#if data.ac_input_v != null}
					<span class="vf-src-sub">{fmtV(data.ac_input_v)}</span>
					{/if}
				</div>
			</div>
		</div>
		{/if}

		<!-- Vertical connector: source → hub -->
		{#if hasSolar || hasAcIn}
		<div class="vf-vc-wrap"><div class="vf-vc"></div></div>
		{/if}

		<!-- Hub row: [Battery] [──] [Load] -->
		{#if hasBatt || hasLoad}
		<div class="vf-hub">

			<!-- Battery node -->
			{#if hasBatt}
			{@const soc = Math.round(data.battery_soc ?? 0)}
			{@const col = socColor(data.battery_soc)}
			<div class="vfn vfn-batt" style="border-color:{col}44">
				<div class="vfn-icon">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
						stroke={col} stroke-width="2" stroke-linecap="round">
						<rect x="2" y="7" width="16" height="11" rx="2"/>
						<path d="M20 11v3"/>
					</svg>
				</div>
				<div class="vfn-lbl">Batterie</div>
				{#if data.battery_soc != null}
				<div class="vfn-val" style="color:{col}">{soc}%</div>
				{/if}
				{#if battStatus}
				<div class="vfn-status" style="color:{col}bb">{battStatus}</div>
				{/if}
				<div class="vfn-detail">
					{#if data.battery_v != null}<span>{fmtV(data.battery_v)}</span>{/if}
					{#if data.battery_a != null}
					<span class:c-green={isCharging} class:c-amber={isDischarging}>{fmtA(data.battery_a)}</span>
					{/if}
				</div>
				{#if data.battery_w != null}
				<div class="vfn-sub">{fmtW(data.battery_w)}</div>
				{/if}
				{#if ttgStr(data.batteries[0]?.time_to_go_s)}
				<div class="vfn-ttg">⏱ {ttgStr(data.batteries[0].time_to_go_s)}</div>
				{/if}
			</div>
			{/if}

			<!-- Horizontal connector line -->
			{#if hasBatt && hasLoad}
			<div class="vf-hline"></div>
			{/if}

			<!-- Load node -->
			{#if hasLoad}
			<div class="vfn vfn-load">
				<div class="vfn-icon">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
						<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
					</svg>
				</div>
				<div class="vfn-lbl">Verbrauch</div>
				<div class="vfn-val" style="color:var(--accent)">{fmtW(data.load_w)}</div>
				{#if data.ac_output_v != null}
				<div class="vfn-sub">{fmtV(data.ac_output_v)}</div>
				{/if}
			</div>
			{/if}

		</div><!-- /vf-hub -->
		{/if}

	</div><!-- /vflow -->

	<!-- ══════════════════════════════════════════════════════════
	     MPPT LADEREGLER — individual chargers with power bars
	     (MPPT pills already shown in the solar source box above;
	      this section shows the detailed per-charger breakdown)
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
					<div class="mppt-bar-fill" style="width:{barPct}%; background:{SOLAR_C}70"></div>
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
.hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.card-title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.hdr-right { display: flex; align-items: center; gap: 6px; }
/* Data age = how old is the Cerbo's upload to VRM */
.data-age { font-size: 11px; color: var(--muted); }
.data-age.age-warn { color: var(--amber); }
/* Green dot = we have a recent fetch */
.fetch-dot { font-size: 8px; color: var(--green); opacity: 0.7; }
/* Spinning ⟳ = hot-window active (polling for new Cerbo upload) */
.poll-spin { font-size: 11px; color: var(--accent); opacity: 0.8; display: inline-block;
	animation: vrm-spin 1.2s linear infinite; }
@keyframes vrm-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.loading { font-size: 13px; color: var(--muted); }
.err     { font-size: 13px; color: var(--red); }

/* ══ ENERGY FLOW — matches local SUKI app's Power Flow ════ */
.vflow { display: flex; flex-direction: column; align-items: center; width: 100%; gap: 0; margin-bottom: 4px; }

/* ── Source box (solar or shore, full width) ─────────────── */
.vf-source {
	width: 100%; border-radius: 8px; padding: 8px 12px;
}
.vf-solar-src {
	background: rgba(245, 200, 66, 0.08);
	border: 1px solid rgba(245, 200, 66, 0.25);
}
.vf-shore-src {
	background: rgba(0, 160, 230, 0.07);
	border: 1px solid rgba(0, 160, 230, 0.25);
}

.vf-src-top { display: flex; justify-content: space-between; align-items: center; }
.vf-src-lbl {
	font-size: 10px; color: var(--muted); text-transform: uppercase;
	letter-spacing: 0.5px; display: flex; align-items: center; gap: 5px;
}
.vf-src-vals { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.vf-src-big  { font-size: 24px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
.vf-src-sub  { font-size: 10px; color: var(--muted); }

/* MPPT pills strip inside solar box */
.vf-mppt-strip {
	display: flex; gap: 5px; flex-wrap: wrap; margin-top: 7px;
}
.vf-mppt-pill {
	font-size: 10px; color: var(--muted);
	background: rgba(245, 200, 66, 0.07);
	border: 1px solid rgba(245, 200, 66, 0.16);
	border-radius: 4px; padding: 2px 7px;
}
.vf-mppt-pill b { font-weight: 600; }

/* Shore badge inside solar box */
.vf-shore-inline {
	display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
	margin-top: 6px; font-size: 10px; color: var(--accent);
	border-top: 1px solid rgba(245,200,66,0.12); padding-top: 5px;
}

/* ── Vertical connector: source → hub ───────────────────── */
.vf-vc-wrap { display: flex; width: 100%; justify-content: center; }
.vf-vc {
	width: 2px; height: 16px;
	background: linear-gradient(180deg, rgba(245,200,66,0.6), rgba(0,160,230,0.4));
}

/* ── Hub row ─────────────────────────────────────────────── */
.vf-hub {
	display: flex; align-items: stretch; width: 100%;
}

/* Horizontal connector between hub nodes */
.vf-hline {
	width: 12px; flex-shrink: 0;
	display: flex; align-items: center;
}
.vf-hline::after {
	content: ''; display: block; width: 100%; height: 2px;
	background: rgba(255, 255, 255, 0.15);
}

/* Node boxes */
.vfn {
	flex: 1; border-radius: 8px; padding: 9px 8px; text-align: center;
	border: 1px solid rgba(255, 255, 255, 0.08);
	background: rgba(255, 255, 255, 0.03);
	min-width: 0;
	display: flex; flex-direction: column; align-items: center; gap: 2px;
}
.vfn-batt {
	background: rgba(0, 100, 180, 0.10);
	/* border-color set inline from socColor */
}
.vfn-load {
	background: rgba(0, 160, 220, 0.07);
	border-color: rgba(0, 160, 220, 0.22);
}

.vfn-icon { display: flex; justify-content: center; margin-bottom: 1px; }
.vfn-lbl  { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
.vfn-val  { font-size: 18px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.vfn-status { font-size: 10px; line-height: 1.2; }
.vfn-detail { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; font-size: 11px; font-variant-numeric: tabular-nums; }
.vfn-sub  { font-size: 10px; color: var(--muted); }
.vfn-ttg  { font-size: 10px; color: var(--accent); }

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
