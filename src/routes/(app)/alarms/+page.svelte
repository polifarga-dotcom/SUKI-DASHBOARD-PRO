<script lang="ts">
	import { onMount } from 'svelte';
	import { supabase } from '$lib/supabase.js';
	import { currentBoat } from '$lib/stores/boat.js';
	import { telemetry } from '$lib/stores/telemetry.js';
	import type { SensorAlarm } from '$lib/types.js';
	import SensorChart from '$lib/components/charts/SensorChart.svelte';
	import type { SensorPoint } from '$lib/components/charts/SensorChart.svelte';

	// ── Sensor definitions (mirror of edge function) ─────────────────────────

	type SensorKey = 'wind_speed' | 'wind_dir' | 'pressure' | 'depth' | 'water_temp'
	               | 'batt_soc' | 'batt_volt' | 'tank_fw' | 'tank_dsl';

	type SensorDef = {
		label: string;
		unit: string;
		group: string;
		direction: 'above' | 'below' | 'deviation';
		defaultThreshold: number;
		defaultHysteresis: number;
		gracePeriodS: number;
		icon: string;
		getValue: (t: typeof $telemetry) => number | null;
	};

	const SENSORS: { key: SensorKey; def: SensorDef }[] = [
		{
			key: 'wind_speed',
			def: {
				label: 'Wind Speed', unit: 'kn', group: 'Wind',
				direction: 'above', defaultThreshold: 25, defaultHysteresis: 3, gracePeriodS: 60,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 8 Q6 8 8 6 Q10 4 13 4 Q16 4 16 7 Q16 10 12 10 H3"/>
					<path d="M3 13 Q5 13 6 12 Q8 10 10 10 Q13 10 13 12.5 Q13 15 10 15 H3"/>
				</svg>`,
				getValue: (t) => t?.env_aws_ms != null ? +(t.env_aws_ms * 1.94384).toFixed(1) : null,
			}
		},
		{
			key: 'wind_dir',
			def: {
				label: 'Wind Direction', unit: '°', group: 'Wind',
				direction: 'deviation', defaultThreshold: 0, defaultHysteresis: 20, gracePeriodS: 120,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="10" cy="10" r="7"/>
					<polygon points="10,4 12,10 10,9 8,10" fill="currentColor" stroke="none"/>
					<text x="10" y="17" text-anchor="middle" font-size="5" fill="currentColor" stroke="none">N</text>
				</svg>`,
				getValue: (t) => {
					if (!t || t.nav_hdg_rad == null) return null;
					// Prefer TWA directly from SignalK
					if (t.env_twa_rad != null) {
						return +((((t.nav_hdg_rad + t.env_twa_rad) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1);
					}
					// Fallback: derive TWA from AWS/AWA/SOG vector math (same as public-boat-tracker)
					if (t.env_aws_ms != null && t.env_awa_rad != null && t.nav_sog_ms != null) {
						const hdg = t.nav_hdg_rad;
						const cog = t.nav_cog_rad ?? hdg;
						const bx = t.nav_sog_ms * Math.cos(cog - hdg);
						const by = t.nav_sog_ms * Math.sin(cog - hdg);
						const twX = t.env_aws_ms * Math.cos(t.env_awa_rad) - bx;
						const twY = t.env_aws_ms * Math.sin(t.env_awa_rad) - by;
						const twaRad = Math.atan2(twY, twX);
						return +((((t.nav_hdg_rad + twaRad) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1);
					}
					// Last resort: heading + AWA (accurate when stationary, e.g. at anchor)
					if (t.env_awa_rad != null) {
						return +((((t.nav_hdg_rad + t.env_awa_rad) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1);
					}
					return null;
				},
			}
		},
		{
			key: 'pressure',
			def: {
				label: 'Barometric Pressure', unit: 'hPa', group: 'Environment',
				direction: 'below', defaultThreshold: 980, defaultHysteresis: 2, gracePeriodS: 60,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="10" cy="10" r="7"/>
					<path d="M10 6 L10 10 L13 12" stroke-width="1.8"/>
				</svg>`,
				getValue: (t) => t?.env_pressure_pa != null ? +(t.env_pressure_pa / 100).toFixed(1) : null,
			}
		},
		{
			key: 'depth',
			def: {
				label: 'Depth', unit: 'm', group: 'Environment',
				direction: 'below', defaultThreshold: 3, defaultHysteresis: 1, gracePeriodS: 30,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 5 Q5 3 7 5 Q9 7 11 5 Q13 3 15 5 Q17 7 17 5"/>
					<line x1="10" y1="7" x2="10" y2="16"/>
					<path d="M7 13 L10 16 L13 13"/>
				</svg>`,
				getValue: (t) => t?.env_depth_m ?? null,
			}
		},
		{
			key: 'water_temp',
			def: {
				label: 'Water Temperature', unit: '°C', group: 'Environment',
				direction: 'above', defaultThreshold: 30, defaultHysteresis: 1, gracePeriodS: 120,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<rect x="8.5" y="3" width="3" height="10" rx="1.5"/>
					<circle cx="10" cy="14.5" r="2.5"/>
					<line x1="12" y1="5.5" x2="14" y2="5.5"/>
					<line x1="12" y1="8" x2="14" y2="8"/>
				</svg>`,
				getValue: (t) => t?.temp_water != null ? +(t.temp_water - 273.15).toFixed(1) : null,
			}
		},
		{
			key: 'batt_soc',
			def: {
				label: 'Battery SOC', unit: '%', group: 'Power',
				direction: 'below', defaultThreshold: 20, defaultHysteresis: 5, gracePeriodS: 120,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<rect x="2" y="6" width="14" height="8" rx="1.5"/>
					<line x1="17" y1="8.5" x2="17" y2="11.5" stroke-width="2"/>
					<rect x="4" y="8" width="6" height="4" rx="0.5" fill="currentColor" stroke="none" opacity="0.4"/>
				</svg>`,
				getValue: (t) => t?.batt_main_soc != null ? +(t.batt_main_soc * 100).toFixed(1) : null,
			}
		},
		{
			key: 'batt_volt',
			def: {
				label: 'Battery Voltage', unit: 'V', group: 'Power',
				direction: 'below', defaultThreshold: 12.2, defaultHysteresis: 0.3, gracePeriodS: 120,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<rect x="2" y="6" width="14" height="8" rx="1.5"/>
					<line x1="17" y1="8.5" x2="17" y2="11.5" stroke-width="2"/>
					<path d="M8 13 L10 10 L9 10 L11 7" stroke-width="1.3"/>
				</svg>`,
				getValue: (t) => t?.batt_main_v ?? null,
			}
		},
		{
			key: 'tank_fw',
			def: {
				label: 'Fresh Water', unit: '%', group: 'Tanks',
				direction: 'below', defaultThreshold: 20, defaultHysteresis: 5, gracePeriodS: 300,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M10 3 Q14 8 14 12 A4 4 0 0 1 6 12 Q6 8 10 3Z"/>
				</svg>`,
				getValue: (t) => t?.tank_fw != null ? +(t.tank_fw * 100).toFixed(1) : null,
			}
		},
		{
			key: 'tank_dsl',
			def: {
				label: 'Diesel', unit: '%', group: 'Tanks',
				direction: 'below', defaultThreshold: 15, defaultHysteresis: 5, gracePeriodS: 300,
				icon: `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<rect x="4" y="5" width="9" height="12" rx="1"/>
					<path d="M13 8 L16 8 L16 12 Q16 14 14.5 14"/>
					<line x1="4" y1="9" x2="13" y2="9"/>
					<line x1="7" y1="5" x2="7" y2="3"/>
					<line x1="10" y1="5" x2="10" y2="3"/>
				</svg>`,
				getValue: (t) => t?.tank_dsl != null ? +(t.tank_dsl * 100).toFixed(1) : null,
			}
		},
	];

	// ── Bell SVG ─────────────────────────────────────────────────────────────
	const BELL_ON = `<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
		<path d="M10 2.5 Q13.5 3 14.5 7 L15 13 H5 L5.5 7 Q6.5 3 10 2.5Z" fill="rgba(0,200,255,0.15)" stroke="var(--accent)"/>
		<line x1="8.2" y1="15" x2="11.8" y2="15"/>
		<line x1="10" y1="2.5" x2="10" y2="1.5"/>
	</svg>`;
	const BELL_OFF = `<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
		<path d="M10 2.5 Q13.5 3 14.5 7 L15 13 H5 L5.5 7 Q6.5 3 10 2.5Z"/>
		<line x1="8.2" y1="15" x2="11.8" y2="15"/>
		<line x1="10" y1="2.5" x2="10" y2="1.5"/>
	</svg>`;

	// ── State ─────────────────────────────────────────────────────────────────
	let alarms = $state<Record<string, SensorAlarm>>({});
	let openKey = $state<SensorKey | null>(null);
	let saving  = $state<SensorKey | null>(null);

	// Per-sensor edit buffers (only populated when accordion open)
	let editEnabled:   Record<string, boolean>  = $state({});
	let editThreshold: Record<string, string>   = $state({});
	let editHysteresis:Record<string, string>   = $state({});
	let editGrace:     Record<string, number>   = $state({});

	// ── History charts ────────────────────────────────────────────────────────

	type HistoryCfg = {
		table: 'telemetry_history' | 'log_entries';
		timeCol: string;
		valueCol: string;
		transform?: (v: number) => number;
	} | null;

	const SENSOR_HISTORY: Record<SensorKey, HistoryCfg> = {
		// wind_speed + wind_dir use telemetry_history (written every 60s by DB trigger).
		// log_entries is trip-only — no data at anchor.
		wind_speed:  { table: 'telemetry_history', timeCol: 'recorded_at', valueCol: 'env_aws_ms',  transform: v => +(v * 1.94384).toFixed(1) },
		wind_dir:    null, // handled specially in fetchHistory (needs two columns for TWD)
		pressure:    { table: 'telemetry_history', timeCol: 'recorded_at', valueCol: 'env_pressure_pa', transform: v => v / 100 },
		depth:       { table: 'log_entries',       timeCol: 'logged_at',   valueCol: 'depth_m' },
		water_temp:  { table: 'log_entries',       timeCol: 'logged_at',   valueCol: 'water_temp_c' },
		batt_soc:    { table: 'telemetry_history', timeCol: 'recorded_at', valueCol: 'batt_main_soc', transform: v => v * 100 },
		batt_volt:   { table: 'telemetry_history', timeCol: 'recorded_at', valueCol: 'batt_main_v' },
		tank_fw:     { table: 'telemetry_history', timeCol: 'recorded_at', valueCol: 'tank_fw',       transform: v => v * 100 },
		tank_dsl:    { table: 'telemetry_history', timeCol: 'recorded_at', valueCol: 'tank_dsl',      transform: v => v * 100 },
	};

	let history        = $state<Record<string, SensorPoint[]>>({});
	let historyLoading = $state<Record<string, boolean>>({});

	async function fetchHistory(key: SensorKey) {
		if (!boat?.id) return;
		historyLoading = { ...historyLoading, [key]: true };
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		// wind_dir: compute TWD from heading + apparent wind angle (two columns)
		if (key === 'wind_dir') {
			const { data } = await supabase
				.from('telemetry_history')
				.select('recorded_at, nav_hdg_rad, env_awa_rad')
				.eq('boat_id', boat.id)
				.gte('recorded_at', since)
				.order('recorded_at', { ascending: true })
				.limit(1440);
			// deno-lint-ignore no-explicit-any
			const pts: SensorPoint[] = (data ?? []).map((row: any) => {
				const hdg = row.nav_hdg_rad, awa = row.env_awa_rad;
				const v = (hdg != null && awa != null)
					? +((((hdg + awa) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1)
					: null;
				return { t: new Date(row.recorded_at).getTime(), v };
			});
			history = { ...history, [key]: pts };
			historyLoading = { ...historyLoading, [key]: false };
			return;
		}

		const cfg = SENSOR_HISTORY[key];
		if (!cfg) { historyLoading = { ...historyLoading, [key]: false }; return; }

		const { data } = await supabase
			.from(cfg.table)
			.select(`${cfg.timeCol}, ${cfg.valueCol}`)
			.eq('boat_id', boat.id)
			.gte(cfg.timeCol, since)
			.order(cfg.timeCol, { ascending: true })
			.limit(1440);
		// deno-lint-ignore no-explicit-any
		const pts: SensorPoint[] = (data ?? []).map((row: any) => ({
			t: new Date(row[cfg.timeCol]).getTime(),
			v: row[cfg.valueCol] != null
				? (cfg.transform ? cfg.transform(row[cfg.valueCol]) : row[cfg.valueCol])
				: null,
		}));
		history = { ...history, [key]: pts };
		historyLoading = { ...historyLoading, [key]: false };
	}

	const t = $derived($telemetry);
	const boat = $derived($currentBoat);

	// ── Load alarms from DB ───────────────────────────────────────────────────
	async function loadAlarms() {
		if (!boat?.id) return;
		const { data } = await supabase
			.from('sensor_alarms')
			.select('*')
			.eq('boat_id', boat.id);
		const map: Record<string, SensorAlarm> = {};
		for (const row of data ?? []) map[row.sensor] = row;
		alarms = map;
	}

	$effect(() => {
		if (boat?.id) loadAlarms();
	});

	// ── Open accordion ────────────────────────────────────────────────────────
	function toggleRow(key: SensorKey, liveValue: number | null) {
		if (openKey === key) { openKey = null; return; }
		const existing = alarms[key];
		const def = SENSORS.find(s => s.key === key)!.def;

		editEnabled[key]    = existing?.enabled ?? false;
		editThreshold[key]  = String(existing?.threshold_value ?? def.defaultThreshold);
		editHysteresis[key] = String(existing?.hysteresis ?? def.defaultHysteresis);
		editGrace[key]      = existing?.grace_period_s ?? def.gracePeriodS;

		// Wind direction: pre-fill with current TWD as suggestion
		if (key === 'wind_dir' && liveValue != null && !(existing?.threshold_value)) {
			editThreshold[key] = String(Math.round(liveValue));
		}

		openKey = key;
		// Fetch history lazily (only once per boat session; wind_dir handled specially inside)
		if (!history[key]) fetchHistory(key);
	}

	// ── Save ──────────────────────────────────────────────────────────────────
	async function saveAlarm(key: SensorKey) {
		if (!boat?.id) return;
		saving = key;
		const def = SENSORS.find(s => s.key === key)!.def;

		const payload = {
			boat_id:             boat.id,
			sensor:              key,
			enabled:             editEnabled[key] ?? false,
			threshold_value:     parseFloat(editThreshold[key]) || def.defaultThreshold,
			threshold_direction: def.direction,
			hysteresis:          parseFloat(editHysteresis[key]) || def.defaultHysteresis,
			grace_period_s:      editGrace[key] ?? def.gracePeriodS,
			// reset state on save so new threshold takes effect immediately
			state:               'ok',
			grace_started_at:    null,
			last_alarmed_at:     null,
			alarm_count:         0,
			updated_at:          new Date().toISOString(),
		};

		const { data: row } = await supabase
			.from('sensor_alarms')
			.upsert(payload, { onConflict: 'boat_id,sensor' })
			.select()
			.single();

		if (row) alarms = { ...alarms, [key]: row };
		saving = null;
		openKey = null;
	}

	// ── Grace period slider label ─────────────────────────────────────────────
	function graceLabel(s: number): string {
		if (s < 60) return `${s}s`;
		const m = Math.round(s / 60);
		return `${m} min`;
	}

	// ── Group sensors ─────────────────────────────────────────────────────────
	const groups = $derived(
		SENSORS.reduce<Record<string, typeof SENSORS>>((acc, s) => {
			const g = s.def.group;
			if (!acc[g]) acc[g] = [];
			acc[g].push(s);
			return acc;
		}, {})
	);
</script>

<div class="alarm-page">
	<div class="page-header">
		<h2 class="page-title">Telegram Alarms</h2>
		<p class="page-sub">Notifications are sent to all subscribed Telegram contacts for this boat.</p>
	</div>

	{#each Object.entries(groups) as [groupName, sensors]}
	<div class="sensor-group">
		<div class="group-label">{groupName}</div>

		{#each sensors as { key, def }}
		{@const liveVal = def.getValue(t)}
		{@const hasData = liveVal != null}
		{@const alarm   = alarms[key]}
		{@const isActive = alarm?.enabled && alarm?.state === 'alarming'}
		{@const isOpen  = openKey === key}

		<div class="sensor-row-wrap" class:alarming={isActive}>
			<!-- Main row -->
			<button
				class="sensor-row"
				class:disabled={!hasData}
				class:open={isOpen}
				disabled={!hasData}
				onclick={() => toggleRow(key, liveVal)}
			>
				<span class="row-icon">{@html def.icon}</span>
				<span class="row-label">{def.label}</span>
				<span class="row-value" class:no-data={!hasData}>
					{#if hasData}{liveVal} {def.unit}{:else}—{/if}
				</span>
				<span class="row-bell" class:bell-on={alarm?.enabled}>
					{@html alarm?.enabled ? BELL_ON : BELL_OFF}
				</span>
			</button>

			<!-- Accordion config panel -->
			{#if isOpen}
			<div class="sensor-config">
				<!-- 24h history chart -->
				<SensorChart
					points={history[key] ?? []}
					unit={def.unit}
					threshold={parseFloat(editThreshold[key]) || null}
					thresholdDir={def.direction}
					loading={historyLoading[key] ?? false}
				/>

				<!-- Enable toggle -->
				<div class="cfg-row cfg-toggle-row">
					<span class="cfg-label">Enable alarm</span>
					<label class="toggle">
						<input type="checkbox" bind:checked={editEnabled[key]} />
						<span class="toggle-track">
							<span class="toggle-thumb"></span>
						</span>
					</label>
				</div>

				<!-- Threshold -->
				<div class="cfg-row">
					<label class="cfg-label" for="thresh-{key}">
						{def.direction === 'deviation' ? 'Reference bearing' : def.direction === 'above' ? 'Alert above' : 'Alert below'}
						<span class="cfg-unit">{def.unit}</span>
					</label>
					{#if key === 'wind_dir' && liveVal != null}
					<button class="twd-suggest" onclick={() => { editThreshold[key] = String(Math.round(liveVal)); }}>
						Use current TWD ({Math.round(liveVal)}°)
					</button>
					{/if}
					<input
						id="thresh-{key}"
						class="cfg-input"
						type="number"
						step={def.unit === 'V' ? '0.1' : def.unit === '°C' ? '0.5' : '1'}
						bind:value={editThreshold[key]}
					/>
				</div>

				<!-- Hysteresis -->
				<div class="cfg-row">
					<label class="cfg-label" for="hyst-{key}">
						{def.direction === 'deviation' ? 'Max deviation' : 'Hysteresis'}
						<span class="cfg-unit">{def.unit}</span>
					</label>
					<input
						id="hyst-{key}"
						class="cfg-input"
						type="number"
						step={def.unit === 'V' ? '0.1' : '1'}
						min="0"
						bind:value={editHysteresis[key]}
					/>
				</div>

				<!-- Grace period -->
				<div class="cfg-row">
					<label class="cfg-label" for="grace-{key}">
						Grace period <span class="cfg-grace-val">{graceLabel(editGrace[key] ?? def.gracePeriodS)}</span>
					</label>
					<input
						id="grace-{key}"
						class="cfg-slider"
						type="range"
						min="15" max="300" step="15"
						bind:value={editGrace[key]}
					/>
				</div>

				<!-- State badge (read-only) -->
				{#if alarm?.state && alarm.state !== 'ok'}
				<div class="cfg-state-badge state-{alarm.state}">
					{alarm.state === 'grace' ? 'In grace period' : `Alarming (×${alarm.alarm_count})`}
				</div>
				{/if}

				<!-- Actions -->
				<div class="cfg-actions">
					<button class="btn-ghost" onclick={() => { openKey = null; }}>Cancel</button>
					<button
						class="btn-save"
						disabled={saving === key}
						onclick={() => saveAlarm(key)}
					>
						{saving === key ? 'Saving…' : 'Save'}
					</button>
				</div>
			</div>
			{/if}
		</div>
		{/each}
	</div>
	{/each}
</div>

<style>
	.alarm-page { display: flex; flex-direction: column; gap: 20px; padding-bottom: 24px; }

	.page-header { margin-bottom: 4px; }
	.page-title { font-size: 17px; font-weight: 700; margin: 0 0 4px; }
	.page-sub { font-size: 12px; color: var(--muted); margin: 0; line-height: 1.4; }

	/* ── Groups ── */
	.sensor-group { display: flex; flex-direction: column; gap: 1px; }
	.group-label {
		font-size: 10px; font-weight: 600; text-transform: uppercase;
		letter-spacing: 0.8px; color: var(--muted);
		padding: 0 4px 6px;
	}

	/* ── Sensor row ── */
	.sensor-row-wrap {
		background: var(--card); border-radius: 10px; overflow: hidden;
		border: 1px solid var(--border);
		margin-bottom: 4px;
		transition: border-color 0.2s;
	}
	.sensor-row-wrap.alarming { border-color: rgba(255, 80, 80, 0.5); }

	.sensor-row {
		display: flex; align-items: center; gap: 10px;
		width: 100%; padding: 12px 14px;
		background: none; border: none; color: var(--text);
		cursor: pointer; text-align: left;
		transition: background 0.15s;
	}
	.sensor-row:hover:not(.disabled) { background: var(--card2); }
	.sensor-row.disabled { opacity: 0.38; cursor: default; }
	.sensor-row.open { background: var(--card2); }

	.row-icon { flex-shrink: 0; color: var(--muted); display: flex; align-items: center; }
	.row-label { flex: 1; font-size: 14px; font-weight: 500; }
	.row-value {
		font-size: 13px; color: var(--muted);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}
	.row-value.no-data { color: rgba(255,255,255,0.15); }
	.row-bell { flex-shrink: 0; display: flex; align-items: center; color: var(--muted); }
	.row-bell.bell-on { color: var(--accent); }

	/* ── Accordion config ── */
	.sensor-config {
		padding: 0 14px 14px;
		border-top: 1px solid var(--border);
		display: flex; flex-direction: column; gap: 12px;
	}

	.cfg-row {
		display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
	}
	.cfg-toggle-row { justify-content: space-between; padding-top: 4px; }
	.cfg-label {
		font-size: 12px; color: var(--muted); flex: 1; min-width: 120px;
		display: flex; align-items: baseline; gap: 4px;
	}
	.cfg-unit { font-size: 10px; color: rgba(255,255,255,0.2); }
	.cfg-grace-val { color: var(--text); font-size: 12px; font-variant-numeric: tabular-nums; }

	.cfg-input {
		width: 90px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
		color: var(--text); font-size: 14px; padding: 7px 10px; text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.cfg-input:focus { outline: none; border-color: var(--accent); }

	.cfg-slider {
		width: 100%; accent-color: var(--accent);
		background: none; border: none; cursor: pointer;
	}

	.twd-suggest {
		font-size: 11px; color: var(--accent); background: rgba(0,200,255,0.1);
		border: 1px solid rgba(0,200,255,0.25); border-radius: 6px;
		padding: 3px 8px; cursor: pointer; white-space: nowrap;
	}
	.twd-suggest:hover { background: rgba(0,200,255,0.18); }

	/* ── Toggle ── */
	.toggle { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
	.toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
	.toggle-track {
		width: 40px; height: 22px; background: var(--border);
		border-radius: 11px; transition: background 0.2s; position: relative;
	}
	.toggle input:checked ~ .toggle-track { background: var(--accent); }
	.toggle-thumb {
		position: absolute; top: 3px; left: 3px;
		width: 16px; height: 16px; border-radius: 50%; background: #fff;
		transition: transform 0.2s;
	}
	.toggle input:checked ~ .toggle-track .toggle-thumb { transform: translateX(18px); }

	/* ── State badge ── */
	.cfg-state-badge {
		font-size: 11px; padding: 4px 10px; border-radius: 6px;
		text-align: center; font-weight: 500;
	}
	.state-grace    { background: rgba(255,180,0,0.12); color: #ffb400; border: 1px solid rgba(255,180,0,0.3); }
	.state-alarming { background: rgba(255,60,60,0.12);  color: #ff4040; border: 1px solid rgba(255,60,60,0.3); }

	/* ── Actions ── */
	.cfg-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
	.btn-ghost {
		padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border);
		background: none; color: var(--muted); font-size: 13px; cursor: pointer;
	}
	.btn-ghost:hover { color: var(--text); }
	.btn-save {
		padding: 8px 20px; border-radius: 8px; border: none;
		background: var(--accent); color: #000; font-size: 13px; font-weight: 600;
		cursor: pointer; transition: opacity 0.15s;
	}
	.btn-save:disabled { opacity: 0.5; cursor: default; }
	.btn-save:hover:not(:disabled) { opacity: 0.85; }
</style>
