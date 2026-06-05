import type { VRMData, VRMMppt, VRMBattery, VRMTempSensor } from '$lib/types.js';

type DiagAttr = {
	Device: string;
	instance: number;
	dbusPath: string;
	rawValue: string | number | null;
	description?: string;  // e.g., "Salon", "Tech Room" from VRM diagnostics metadata
	timestamp?: number;
};

function num(v: string | number | null | undefined): number | null {
	if (v == null || v === '') return null;
	const n = Number(v);
	return isFinite(n) ? n : null;
}

// MPPT charger state labels
export const MPPT_STATE: Record<number, string> = {
	0: 'Off', 2: 'Error', 3: 'Bulk', 4: 'Absorb.', 5: 'Float',
	7: 'Equalize', 252: 'Hub-1', 255: 'N/A',
};

// Tank fluid type → display name
const FLUID_TYPE: Record<number, string> = {
	0: 'Fuel', 1: 'Fresh water', 2: 'Wastewater',
	3: 'Live Well', 4: 'Oil', 5: 'Blackwater', 6: 'Diesel',
};

export function parseVRMDiagnostics(attrs: unknown[]): VRMData {
	const rows = attrs as DiagAttr[];


	const find    = (path: string) => rows.find(r => r.dbusPath === path);
	const findAll = (path: string) => rows.filter(r => r.dbusPath === path);

	// ── Custom names — collected first, used everywhere ───────────────────────
	// Venus OS lets users rename each device; these appear as /CustomName records.
	const customNames = new Map<string, string>();
	rows.forEach(r => {
		if (r.dbusPath !== '/CustomName') return;
		const raw = r.rawValue;
		if (raw == null || String(raw).trim() === '') return;
		customNames.set(`${r.Device}__${r.instance}`, String(raw).trim());
	});

	// Tank fluid types (numeric → label), used for default tank names
	const fluidTypes = new Map<string, number>();
	rows.forEach(r => {
		if (r.dbusPath !== '/FluidType') return;
		const v = num(r.rawValue);
		if (v == null) return;
		fluidTypes.set(`${r.Device}__${r.instance}`, Math.round(v));
	});

	// Helper: best display name for a Device+instance key
	function deviceName(device: string, instance: number, fallback: string, description?: string): string {
		const key = `${device}__${instance}`;
		// Priority: CustomName > description > Device > fallback
		return customNames.get(key) ?? description ?? (device ? device : fallback);
	}

	// ── Battery Monitors ──────────────────────────────────────────────────────
	const battMap = new Map<string, VRMBattery>();

	const battPaths = [
		'/Dc/0/Soc', '/Dc/0/Voltage', '/Dc/0/Current', '/Dc/0/Power',
		'/Dc/0/Temperature', '/TimeToGo', '/ConsumedAmphours', '/Soc',
	];

	rows.forEach(r => {
		if (!battPaths.includes(r.dbusPath)) return;
		const v = num(r.rawValue);
		if (v == null) return;

		const key = `${r.Device}__${r.instance}`;
		const entry: VRMBattery = battMap.get(key) ?? {
			name: deviceName(r.Device, r.instance, `Battery ${r.instance}`),
			instance: r.instance,
			soc: null, v: null, a: null, w: null,
			temp_c: null, time_to_go_s: null, consumed_ah: null,
		};

		if (r.dbusPath === '/Dc/0/Soc' || r.dbusPath === '/Soc') entry.soc = v;
		else if (r.dbusPath === '/Dc/0/Voltage')       entry.v   = v;
		else if (r.dbusPath === '/Dc/0/Current')       entry.a   = v;
		else if (r.dbusPath === '/Dc/0/Power')         entry.w   = v;
		else if (r.dbusPath === '/Dc/0/Temperature')   entry.temp_c = v;
		else if (r.dbusPath === '/TimeToGo')           entry.time_to_go_s = v != null ? v * 3600 : null;
		else if (r.dbusPath === '/ConsumedAmphours')   entry.consumed_ah  = v;

		battMap.set(key, entry);
	});

	// Calculate power = V × I for battery monitors that don't expose /Dc/0/Power
	for (const entry of battMap.values()) {
		if (entry.w == null && entry.v != null && entry.a != null) {
			entry.w = Math.round(entry.v * entry.a);
		}
	}

	// ── Individual MPPTs ──────────────────────────────────────────────────────
	// Built BEFORE filtering batteries so we can cross-reference and exclude
	// MPPT charger devices from the battery list (they share /Dc/0/* paths).
	const mpptMap = new Map<string, VRMMppt>();
	const mpptPaths = [
		// Output (battery)
		'/Yield/Power', '/Dc/0/Voltage', '/Dc/0/Current', '/Dc/0/Power',
		// Input (solar)
		'/Pv/V', '/Pv/I', '/Pv/P',
		// Energy
		'/Yield/User', '/Yield/System', '/History/Daily/1/Yield',
		// State & diagnostics
		'/State', '/MppOperatingMode', '/ErrorCode', '/Dc/0/Temperature',
		// Metadata
		'/FirmwareVersion', '/SerialNumber',
	];

	rows.forEach(r => {
		if (!mpptPaths.includes(r.dbusPath)) return;
		const v = num(r.rawValue);

		const key = `${r.Device}__${r.instance}`;
		const entry: VRMMppt = mpptMap.get(key) ?? {
			name: deviceName(r.Device, r.instance, `MPPT ${r.instance}`),
			instance: r.instance,
			// Output
			power_w: 0, batt_v: null, batt_i: null, batt_p: null,
			// Input
			pv_v: null, pv_i: null, pv_p: null,
			// Energy
			yield_today_wh: 0, yield_yesterday_wh: 0, yield_total_kwh: null,
			// State & diagnostics
			state: null, mppt_mode: null, error_code: null, temp_c: null,
			// Metadata
			firmware: null, serial: null,
		};

		// Output (battery)
		if (r.dbusPath === '/Yield/Power')       entry.power_w         = v ?? 0;
		else if (r.dbusPath === '/Dc/0/Voltage') entry.batt_v          = v;
		else if (r.dbusPath === '/Dc/0/Current') entry.batt_i          = v;
		else if (r.dbusPath === '/Dc/0/Power')   entry.batt_p          = v;
		// Input (solar)
		else if (r.dbusPath === '/Pv/V')         entry.pv_v            = v;
		else if (r.dbusPath === '/Pv/I')         entry.pv_i            = v;
		else if (r.dbusPath === '/Pv/P')         entry.pv_p            = v;
		// Energy (both in Wh from VRM API)
		else if (r.dbusPath === '/Yield/User')              entry.yield_today_wh     = v ?? 0;  // Wh
		else if (r.dbusPath === '/History/Daily/1/Yield')   entry.yield_yesterday_wh = v ?? 0;  // Wh
		else if (r.dbusPath === '/Yield/System')            entry.yield_total_kwh    = (v ?? 0) / 1000;
		// State & diagnostics
		else if (r.dbusPath === '/State')        entry.state           = v != null ? Math.round(v) : null;
		else if (r.dbusPath === '/MppOperatingMode') entry.mppt_mode   = v != null ? Math.round(v) : null;
		else if (r.dbusPath === '/ErrorCode')    entry.error_code      = v != null ? Math.round(v) : null;
		else if (r.dbusPath === '/Dc/0/Temperature') entry.temp_c      = v;
		// Metadata
		else if (r.dbusPath === '/FirmwareVersion') entry.firmware = String(r.rawValue);
		else if (r.dbusPath === '/SerialNumber')    entry.serial    = String(r.rawValue);

		mpptMap.set(key, entry);
	});

	const mpptsArr = Array.from(mpptMap.values())
		.filter(m => m.yield_today_wh > 0 || m.power_w > 0 || m.pv_v != null)
		.sort((a, b) => b.power_w - a.power_w);

	// ── Battery monitors — exclude MPPT chargers ──────────────────────────────
	// MPPTs share /Dc/0/Voltage & /Dc/0/Current with battery monitors,
	// but MPPTs NEVER expose /Soc. So SOC presence = real battery monitor.
	const batteries = Array.from(battMap.values())
		.filter(b => b.soc != null)
		.sort((a, b) => a.instance - b.instance);

	// Primary battery (first / instance 0)
	const primary = batteries[0] ?? null;
	const battery_soc = primary?.soc ?? null;
	const battery_v   = primary?.v   ?? null;
	const battery_a   = primary?.a   ?? null;
	const battery_w   = primary?.w   ?? null;

	// ── Solar totals ──────────────────────────────────────────────────────────
	const solar_w = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + m.power_w, 0)
		: null;
	const solar_yield_today_wh = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + m.yield_today_wh, 0)
		: null;
	const solar_yield_yesterday_wh = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + m.yield_yesterday_wh, 0)
		: null;
	const solar_a = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + (m.batt_i ?? 0), 0)
		: null;

	// ── VE.Bus DC current (for DC loads calculation) ─────────────────────────
	// The VE.Bus inverter/charger exposes /Dc/0/Current on its own device record.
	// We find it by matching Device='VE.Bus System' to avoid confusion with battery monitors.
	const vebusRow = rows.find(r => r.dbusPath === '/Dc/0/Current' &&
		typeof r.Device === 'string' && r.Device.includes('VE.Bus'));
	const vebus_dc_a = num(vebusRow?.rawValue) ?? null;

	// ── AC Input (shore power / generator) ───────────────────────────────────
	const acInV  = num(find('/Ac/In/L1/V')?.rawValue)
		?? num(find('/Ac/ActiveIn/L1/V')?.rawValue);
	const acInP  = ['/Ac/In/L1/P', '/Ac/ActiveIn/L1/P']
		.map(p => num(find(p)?.rawValue)).find(v => v != null) ?? null;

	// ── AC Output / Load ──────────────────────────────────────────────────────
	const acOutV = num(find('/Ac/Out/L1/V')?.rawValue);
	const acOutP = num(find('/Ac/Out/L1/P')?.rawValue);

	// AC consumption (aggregate across phases)
	const acL = [1, 2, 3].map(n => num(find(`/Ac/Consumption/L${n}/Power`)?.rawValue) ?? 0);
	const load_w = acL.some(v => v > 0) ? acL.reduce((s, v) => s + v, 0) : (acOutP ?? null);

	// ── Temperature & Humidity Sensors ───────────────────────────────────────
	// Names come directly from VRM CustomName — no hardcoded mapping needed.
	const tempMap = new Map<string, VRMTempSensor>();

	rows.forEach(r => {
		if (r.dbusPath !== '/Temperature' && r.dbusPath !== '/Humidity') return;
		const v = num(r.rawValue);
		if (v == null) return;

		const key = `${r.Device}__${r.instance}`;
		const entry: VRMTempSensor = tempMap.get(key) ?? {
			// Priority: CustomName > description > fallback
			name: customNames.get(key) ??
				  (r.description && r.description !== 'Temperature' && r.description !== 'Humidity' ? r.description : null) ??
				  `Sensor ${r.instance}`,
			instance: r.instance,
			celsius: 0,
			humidity: null,
		};

		if (r.dbusPath === '/Temperature') entry.celsius  = v;
		else if (r.dbusPath === '/Humidity') entry.humidity = v;

		tempMap.set(key, entry);
	});

	// Battery temperature from primary battery — add if not already in tempMap
	if (primary?.temp_c != null) {
		const key = `__batt_temp_${primary.instance}`;
		if (!tempMap.has(key)) {
			tempMap.set(key, {
				name: `${primary.name} Temp.`,
				instance: primary.instance,
				celsius: primary.temp_c,
				humidity: null,
			});
		}
	}

	const temperatures = Array.from(tempMap.values())
		.sort((a, b) => a.instance - b.instance);

	// ── Tanks ─────────────────────────────────────────────────────────────────
	const tanksSeen = new Set<string>();
	const tanks = findAll('/Level')
		.filter(r => {
			// De-duplicate per device+instance
			const k = `${r.Device}__${r.instance}`;
			if (tanksSeen.has(k)) return false;
			tanksSeen.add(k);
			if (num(r.rawValue) == null) return false;
			// Skip ghost tanks: must have a CustomName OR a /Capacity record.
			// VRM instance 0 is a phantom entry with no sensor — no CustomName, no Capacity.
			const key = `${r.Device}__${r.instance}`;
			const hasName     = customNames.has(key);
			const hasCapacity = rows.some(x => x.Device === r.Device && x.instance === r.instance && x.dbusPath === '/Capacity');
			return hasName || hasCapacity;
		})
		.map(r => {
			const key = `${r.Device}__${r.instance}`;
			// Prefer custom name, then device name, then fluid type label
			const fluidType = fluidTypes.get(key);
			const fallback  = fluidType != null ? (FLUID_TYPE[fluidType] ?? `Tank ${r.instance}`) : `Tank ${r.instance}`;
			const name      = customNames.get(key) ?? (r.Device ? r.Device : fallback);
			return { name, level: num(r.rawValue) ?? 0 };
		});

	// ── GPS ───────────────────────────────────────────────────────────────────
	const gpsLatRow = find('/Position/Latitude');
	const gpsLonRow = find('/Position/Longitude');
	const gps_lat        = num(gpsLatRow?.rawValue);
	const gps_lon        = num(gpsLonRow?.rawValue);
	const gps_speed_ms   = num(find('/Position/Speed')?.rawValue);
	const gps_course_deg = num(find('/Position/Course')?.rawValue);
	const gps_ts         = gpsLatRow?.timestamp ?? gpsLonRow?.timestamp ?? null;

	// ── Freshness ─────────────────────────────────────────────────────────────
	const timestamps = rows.map(r => r.timestamp).filter(Boolean) as number[];
	const last_ts = timestamps.length ? Math.max(...timestamps) : null;

	return {
		battery_soc, battery_v, battery_a, battery_w,
		batteries,
		solar_w, solar_a, solar_yield_today_wh, solar_yield_yesterday_wh, mpptsArr,
		ac_input_v: acInV ?? null, ac_input_w: acInP,
		ac_output_v: acOutV, ac_output_w: acOutP,
		load_w,
		vebus_dc_a,
		temperatures,
		tanks,
		gps_lat, gps_lon, gps_speed_ms, gps_course_deg, gps_ts,
		last_ts,
	};
}
