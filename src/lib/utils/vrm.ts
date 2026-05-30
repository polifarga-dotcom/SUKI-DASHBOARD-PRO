import type { VRMData, VRMMppt, VRMBattery, VRMTempSensor } from '$lib/types.js';

type DiagAttr = {
	Device: string;
	instance: number;
	dbusPath: string;
	rawValue: string | number | null;
	timestamp?: number;
};

function num(v: string | number | null | undefined): number | null {
	if (v == null || v === '') return null;
	const n = Number(v);
	return isFinite(n) ? n : null;
}

// MPPT charger state labels
export const MPPT_STATE: Record<number, string> = {
	0: 'Aus', 2: 'Fehler', 3: 'Bulk', 4: 'Absorb.', 5: 'Float',
	7: 'Equalize', 252: 'Hub-1', 255: 'N/A',
};

export function parseVRMDiagnostics(attrs: unknown[]): VRMData {
	const rows = attrs as DiagAttr[];

	const find    = (path: string) => rows.find(r => r.dbusPath === path);
	const findAll = (path: string) => rows.filter(r => r.dbusPath === path);

	// ── Battery Monitors ──────────────────────────────────────────────────────
	// Collect all unique (Device, instance) pairs that have battery data
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
			name: r.Device || `Batterie ${r.instance}`,
			instance: r.instance,
			soc: null, v: null, a: null, w: null,
			temp_c: null, time_to_go_s: null, consumed_ah: null,
		};

		if (r.dbusPath === '/Dc/0/Soc' || r.dbusPath === '/Soc') entry.soc = v;
		else if (r.dbusPath === '/Dc/0/Voltage')       entry.v   = v;
		else if (r.dbusPath === '/Dc/0/Current')       entry.a   = v;
		else if (r.dbusPath === '/Dc/0/Power')         entry.w   = v;
		else if (r.dbusPath === '/Dc/0/Temperature')   entry.temp_c = v;
		else if (r.dbusPath === '/TimeToGo')           entry.time_to_go_s = v;
		else if (r.dbusPath === '/ConsumedAmphours')   entry.consumed_ah  = v;

		battMap.set(key, entry);
	});

	// Sort: primary battery first (instance 0), then by instance
	const batteries = Array.from(battMap.values())
		.filter(b => b.v != null || b.soc != null)
		.sort((a, b) => a.instance - b.instance);

	// Primary battery (first / instance 0)
	const primary = batteries[0] ?? null;
	const battery_soc = primary?.soc ?? null;
	const battery_v   = primary?.v   ?? null;
	const battery_a   = primary?.a   ?? null;
	const battery_w   = primary?.w   ?? null;

	// ── Individual MPPTs ──────────────────────────────────────────────────────
	const mpptMap = new Map<string, VRMMppt>();

	const mpptPaths = ['/Yield/Power', '/Yield/User', '/Yield/System', '/Pv/V', '/State'];

	rows.forEach(r => {
		if (!mpptPaths.includes(r.dbusPath)) return;
		const v = num(r.rawValue);

		const key = `${r.Device}__${r.instance}`;
		const entry: VRMMppt = mpptMap.get(key) ?? {
			name: r.Device || `MPPT ${r.instance}`,
			instance: r.instance,
			power_w: 0, yield_today_wh: 0, yield_total_kwh: null,
			pv_v: null, state: null,
		};

		if (r.dbusPath === '/Yield/Power')  entry.power_w        = v ?? 0;
		else if (r.dbusPath === '/Yield/User')   entry.yield_today_wh  = (v ?? 0) * 1000;
		else if (r.dbusPath === '/Yield/System') entry.yield_total_kwh = v;
		else if (r.dbusPath === '/Pv/V')         entry.pv_v            = v;
		else if (r.dbusPath === '/State')        entry.state           = v != null ? Math.round(v) : null;

		mpptMap.set(key, entry);
	});

	const mpptsArr = Array.from(mpptMap.values())
		.filter(m => m.yield_today_wh > 0 || m.power_w > 0 || m.pv_v != null)
		.sort((a, b) => b.power_w - a.power_w);

	// ── Solar totals ──────────────────────────────────────────────────────────
	const solar_w = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + m.power_w, 0)
		: null;
	const solar_yield_today_wh = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + m.yield_today_wh, 0)
		: null;

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
	// Scan for /Temperature and /Humidity on any device
	const tempMap = new Map<string, VRMTempSensor>();

	rows.forEach(r => {
		if (r.dbusPath !== '/Temperature' && r.dbusPath !== '/Humidity') return;
		const v = num(r.rawValue);
		if (v == null) return;

		const key = `${r.Device}__${r.instance}`;
		const entry: VRMTempSensor = tempMap.get(key) ?? {
			name: r.Device || `Sensor ${r.instance}`,
			instance: r.instance,
			celsius: 0,
			humidity: null,
		};

		if (r.dbusPath === '/Temperature') entry.celsius  = v;
		else if (r.dbusPath === '/Humidity') entry.humidity = v;

		tempMap.set(key, entry);
	});

	// Also pick up battery temperature from the primary battery and add it
	// only if not already in tempMap (avoid duplicates)
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
	const tanks = rows
		.filter(r => r.dbusPath === '/Level')
		.map(r => ({ name: r.Device || `Tank ${r.instance}`, level: num(r.rawValue) ?? 0 }));

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
		solar_w, solar_yield_today_wh, mpptsArr,
		ac_input_v: acInV ?? null, ac_input_w: acInP,
		ac_output_v: acOutV, ac_output_w: acOutP,
		load_w,
		temperatures,
		tanks,
		gps_lat, gps_lon, gps_speed_ms, gps_course_deg, gps_ts,
		last_ts,
	};
}
