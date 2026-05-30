<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { anchorConfig } from '$lib/stores/anchor.js';
	import { supabase } from '$lib/supabase.js';
	import { parseVRMDiagnostics } from '$lib/utils/vrm.js';
	import type { VRMData } from '$lib/types.js';

	let data  = $state<VRMData | null>(null);
	let error = $state('');
	let now   = $state(Math.floor(Date.now() / 1000));

	let pollTimer: ReturnType<typeof setInterval>;
	let tickTimer: ReturnType<typeof setInterval>;

	const cfg = $derived($anchorConfig);

	function apiReady() {
		return cfg?.vrm_api_token && cfg?.vrm_installation_id;
	}

	async function fetchVRM() {
		if (!apiReady()) return;
		try {
			const { data: json, error: fnErr } = await supabase.functions.invoke('vrm-proxy');
			if (fnErr) { error = fnErr.message; return; }
			const attrs: unknown[] = json?.records ?? [];
			data  = parseVRMDiagnostics(attrs);
			error = '';
		} catch (e) {
			error = String(e);
		}
	}

	onMount(() => {
		fetchVRM();
		pollTimer = setInterval(fetchVRM, 60_000);
		tickTimer = setInterval(() => { now = Math.floor(Date.now() / 1000); }, 1000);
	});
	onDestroy(() => { clearInterval(pollTimer); clearInterval(tickTimer); });

	// ── Formatters ─────────────────────────────────────────────────────────
	function pct(v: number | null) { return v != null ? Math.round(v) : null; }

	function fmtW(v: number | null | undefined) {
		if (v == null) return '—';
		const abs = Math.abs(v);
		return abs >= 1000 ? `${(v / 1000).toFixed(2)} kW` : `${Math.round(v)} W`;
	}

	function fmtWh(v: number | null | undefined) {
		if (v == null) return '—';
		return v >= 1000 ? `${(v / 1000).toFixed(2)} kWh` : `${Math.round(v)} Wh`;
	}

	function ageStr(ts: number | null) {
		if (!ts) return '';
		const s = now - ts;
		if (s < 90)   return 'Gerade eben';
		if (s < 3600) return `Vor ${Math.floor(s / 60)} Min.`;
		return `Vor ${Math.floor(s / 3600)} Std.`;
	}

	function gpsAgeS(ts: number | null): number | null {
		if (!ts) return null;
		return Math.max(0, now - ts);
	}

	function socColor(soc: number | null) {
		if (soc == null) return 'var(--muted)';
		if (soc > 50)   return 'var(--green)';
		if (soc > 20)   return 'var(--amber)';
		return 'var(--red)';
	}

	function socBg(soc: number | null) {
		if (soc == null) return 'transparent';
		if (soc > 50)   return 'rgba(80,200,100,0.08)';
		if (soc > 20)   return 'rgba(240,180,50,0.08)';
		return 'rgba(220,60,60,0.08)';
	}

	function stale(ts: number | null) {
		return ts ? (now - ts) > 180 : false;
	}

	function mpptShortName(name: string) {
		return name
			.replace(/^BlueSolar Charger /i, 'BlueSolar ')
			.replace(/^SmartSolar Charger /i, 'SmartSolar ')
			.replace(/^Victron /i, '');
	}

	const SOLAR_COLOR = '#f5c842';
	const LOAD_COLOR  = 'var(--accent)';
</script>

{#if apiReady()}
<div class="card vrm-card">

	<!-- Header -->
	<div class="header-row">
		<span class="card-title">Victron VRM</span>
		{#if data?.last_ts}
			<span class="age" class:stale={stale(data.last_ts)}>{ageStr(data.last_ts)}</span>
		{/if}
	</div>

	{#if error}
		<div class="err-msg">{error}</div>
	{:else if !data}
		<div class="loading">Verbinde mit VRM…</div>
	{:else}

	<!-- ══════════════════════════════════════════
	     ENERGY FLOW DIAGRAM
	══════════════════════════════════════════════ -->
	<div class="flow-wrap">

		<!-- Solar node -->
		{#if data.solar_w != null}
		<div class="flow-node solar-node">
			<!-- Sun icon -->
			<svg class="node-svg" width="28" height="28" viewBox="0 0 24 24" fill="none"
				stroke={SOLAR_COLOR} stroke-width="2" stroke-linecap="round">
				<circle cx="12" cy="12" r="4" fill={SOLAR_COLOR} stroke="none"/>
				<line x1="12" y1="2"  x2="12" y2="5"/>
				<line x1="12" y1="19" x2="12" y2="22"/>
				<line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/>
				<line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
				<line x1="2" y1="12" x2="5" y2="12"/>
				<line x1="19" y1="12" x2="22" y2="12"/>
				<line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/>
				<line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
			</svg>
			<div class="node-power" style="color:{SOLAR_COLOR}">{fmtW(data.solar_w)}</div>
			<div class="node-label">Solar</div>
			{#if data.solar_yield_today_wh}
				<div class="node-sub">{fmtWh(data.solar_yield_today_wh)} heute</div>
			{/if}
		</div>

		<!-- Arrow down: Solar → Battery -->
		<div class="flow-arrow-v" style="--clr:{SOLAR_COLOR}"></div>
		{/if}

		<!-- Battery node -->
		<div class="flow-node batt-node" style="background:{socBg(data.battery_soc)}">
			<!-- SOC ring gauge -->
			{#if data.battery_soc != null}
			{@const s = pct(data.battery_soc) ?? 0}
			{@const r = 30}
			{@const circ = 2 * Math.PI * r}
			<svg width="72" height="72" viewBox="0 0 72 72">
				<circle cx="36" cy="36" r={r} fill="none" stroke="var(--card2)" stroke-width="7"/>
				<circle cx="36" cy="36" r={r} fill="none"
					stroke={socColor(data.battery_soc)} stroke-width="7"
					stroke-dasharray="{circ * s / 100} {circ}"
					stroke-linecap="round"
					transform="rotate(-90 36 36)"/>
				<text x="36" y="40" text-anchor="middle"
					font-size="15" font-weight="700"
					fill={socColor(data.battery_soc)}>{s}%</text>
			</svg>
			{:else}
			<!-- Battery icon if no SOC -->
			<svg width="36" height="36" viewBox="0 0 24 24" fill="none"
				stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round">
				<rect x="2" y="7" width="18" height="11" rx="2"/>
				<path d="M22 11v3"/>
			</svg>
			{/if}

			<div class="batt-label">Batterie</div>

			<div class="batt-stats">
				{#if data.battery_v != null}
					<span class="batt-stat">{data.battery_v.toFixed(1)} V</span>
				{/if}
				{#if data.battery_a != null}
					<span class="batt-stat"
						class:charging={data.battery_a > 0.5}
						class:discharging={data.battery_a < -0.5}>
						{data.battery_a > 0 ? '+' : ''}{data.battery_a.toFixed(1)} A
					</span>
				{/if}
				{#if data.battery_w != null}
					<span class="batt-stat batt-w">{fmtW(data.battery_w)}</span>
				{/if}
			</div>
		</div>

		<!-- Arrow + Load node (if AC load available) -->
		{#if data.load_w != null && data.load_w > 5}
		<div class="flow-arrow-v" style="--clr:{LOAD_COLOR}"></div>
		<div class="flow-node load-node">
			<svg class="node-svg" width="22" height="22" viewBox="0 0 24 24"
				fill={LOAD_COLOR} stroke="none">
				<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
			</svg>
			<div class="node-power" style="color:{LOAD_COLOR}">{fmtW(data.load_w)}</div>
			<div class="node-label">Verbrauch</div>
		</div>
		{/if}

	</div><!-- /flow-wrap -->

	<!-- ══════════════════════════════════════════
	     INDIVIDUAL MPPTs
	══════════════════════════════════════════════ -->
	{#if data.mpptsArr.length > 0}
	<div class="section">
		<div class="section-title">MPPT Laderegler</div>
		<div class="mppt-list">
			{#each data.mpptsArr as mppt}
			<div class="mppt-row">
				<div class="mppt-info">
					<span class="mppt-name">{mpptShortName(mppt.name)}</span>
					{#if mppt.pv_v != null}
						<span class="mppt-pv">{mppt.pv_v.toFixed(0)} V PV</span>
					{/if}
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

	<!-- ══════════════════════════════════════════
	     TANKS
	══════════════════════════════════════════════ -->
	{#if data.tanks.length > 0}
	<div class="section">
		<div class="section-title">Tanks</div>
		{#each data.tanks as tank}
		{@const lvl = Math.round(tank.level)}
		{@const tColor = lvl > 60 ? 'var(--green)' : lvl > 30 ? 'var(--amber)' : 'var(--red)'}
		<div class="tank-row">
			<span class="tank-name">{tank.name}</span>
			<div class="tank-track">
				<div class="tank-fill" style="width:{lvl}%; background:{tColor}"></div>
			</div>
			<span class="tank-pct" style="color:{tColor}">{lvl} %</span>
		</div>
		{/each}
	</div>
	{/if}

	<!-- ══════════════════════════════════════════
	     GPS
	══════════════════════════════════════════════ -->
	{#if data.gps_lat != null && data.gps_lon != null}
	<div class="section gps-section">
		<div class="section-title">
			<span>GPS Position</span>
			{#if gpsAgeS(data.gps_ts) != null}
			<span class="gps-age" class:gps-stale={gpsAgeS(data.gps_ts)! > 120}>
				{gpsAgeS(data.gps_ts)} s
			</span>
			{/if}
		</div>
		<div class="gps-row">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
				stroke="var(--muted)" stroke-width="2" stroke-linecap="round">
				<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/>
				<circle cx="12" cy="10" r="3"/>
			</svg>
			<span class="gps-coord">{Math.abs(data.gps_lat).toFixed(5)}° {data.gps_lat >= 0 ? 'N' : 'S'}</span>
			<span class="gps-sep">·</span>
			<span class="gps-coord">{Math.abs(data.gps_lon).toFixed(5)}° {data.gps_lon >= 0 ? 'E' : 'W'}</span>
		</div>
	</div>
	{/if}

	{/if}<!-- /data -->
</div>
{/if}

<style>
/* ── Card base ─────────────────────────────────────────────── */
.vrm-card { display: flex; flex-direction: column; }

.header-row {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	margin-bottom: 16px;
}
.card-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--muted);
	text-transform: uppercase;
	letter-spacing: 0.5px;
}
.age { font-size: 11px; color: var(--muted); }
.age.stale { color: var(--amber); }
.loading, .err-msg { font-size: 13px; color: var(--muted); }
.err-msg { color: var(--red); }

/* ── Energy flow ───────────────────────────────────────────── */
.flow-wrap {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0;
	margin-bottom: 4px;
}

.flow-node {
	width: 100%;
	border-radius: 12px;
	padding: 14px 16px;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 3px;
}

.solar-node {
	background: rgba(245, 200, 66, 0.07);
	border: 1px solid rgba(245, 200, 66, 0.18);
}
.batt-node {
	border: 1px solid rgba(255,255,255,0.07);
}
.load-node {
	background: rgba(0,180,220,0.07);
	border: 1px solid rgba(0,180,220,0.18);
}

.node-svg { flex-shrink: 0; }
.node-power {
	font-size: 22px;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
	line-height: 1.1;
}
.node-label {
	font-size: 11px;
	color: var(--muted);
	text-transform: uppercase;
	letter-spacing: 0.5px;
}
.node-sub { font-size: 11px; color: var(--muted); }

/* Battery specific */
.batt-label {
	font-size: 11px;
	color: var(--muted);
	text-transform: uppercase;
	letter-spacing: 0.5px;
	margin-top: 2px;
}
.batt-stats {
	display: flex;
	gap: 10px;
	flex-wrap: wrap;
	justify-content: center;
	margin-top: 4px;
}
.batt-stat {
	font-size: 13px;
	font-variant-numeric: tabular-nums;
}
.charging    { color: var(--green); font-weight: 600; }
.discharging { color: var(--amber); font-weight: 600; }
.batt-w      { color: var(--muted); }

/* Arrow */
.flow-arrow-v {
	width: 2px;
	height: 24px;
	background: var(--clr, var(--muted));
	opacity: 0.5;
	position: relative;
	margin: 0;
}
.flow-arrow-v::after {
	content: '';
	position: absolute;
	bottom: -6px;
	left: 50%;
	transform: translateX(-50%);
	width: 0; height: 0;
	border-left: 5px solid transparent;
	border-right: 5px solid transparent;
	border-top: 7px solid var(--clr, var(--muted));
	opacity: 1;
}

/* ── Sections ──────────────────────────────────────────────── */
.section {
	border-top: 1px solid rgba(255,255,255,0.06);
	padding-top: 12px;
	margin-top: 12px;
}
.section-title {
	font-size: 11px;
	color: var(--muted);
	text-transform: uppercase;
	letter-spacing: 0.5px;
	margin-bottom: 8px;
	display: flex;
	justify-content: space-between;
	align-items: center;
}

/* ── MPPT ──────────────────────────────────────────────────── */
.mppt-list { display: flex; flex-direction: column; gap: 7px; }

.mppt-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 8px;
}
.mppt-info {
	display: flex;
	flex-direction: column;
	gap: 1px;
	flex: 1;
	min-width: 0;
}
.mppt-name {
	font-size: 12px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.mppt-pv { font-size: 10px; color: var(--muted); }

.mppt-vals {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-shrink: 0;
}
.mppt-power {
	font-size: 13px;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
	color: var(--muted);
	min-width: 56px;
	text-align: right;
}
.mppt-active { font-weight: 700; }
.mppt-yield {
	font-size: 11px;
	color: var(--muted);
	min-width: 62px;
	text-align: right;
	font-variant-numeric: tabular-nums;
}

/* ── Tanks ─────────────────────────────────────────────────── */
.tank-row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.tank-name {
	font-size: 12px;
	color: var(--muted);
	min-width: 70px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.tank-track {
	flex: 1;
	height: 6px;
	background: var(--card2);
	border-radius: 3px;
	overflow: hidden;
}
.tank-fill { height: 100%; border-radius: 3px; transition: width 0.4s; }
.tank-pct {
	font-size: 12px;
	min-width: 34px;
	text-align: right;
	font-variant-numeric: tabular-nums;
}

/* ── GPS ───────────────────────────────────────────────────── */
.gps-age {
	font-size: 11px;
	color: var(--green);
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}
.gps-age.gps-stale { color: var(--amber); }

.gps-row {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}
.gps-coord {
	font-size: 13px;
	font-variant-numeric: tabular-nums;
}
.gps-sep { color: var(--muted); }
</style>
