import type { VRMData } from '$lib/types.js';

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

export function parseVRMDiagnostics(attrs: unknown[]): VRMData {
	const rows = attrs as DiagAttr[];

	const find = (path: string) => rows.find(r => r.dbusPath === path);
	const findAll = (path: string) => rows.filter(r => r.dbusPath === path);

	// Battery (Battery Monitor or Multi/Quattro DC side)
	const battery_soc = num(find('/Dc/0/Soc')?.rawValue);
	const battery_v   = num(find('/Dc/0/Voltage')?.rawValue);
	const battery_a   = num(find('/Dc/0/Current')?.rawValue);
	const battery_w   = num(find('/Dc/0/Power')?.rawValue);

	// Solar — sum across all MPPT chargers
	const solarPowerAttrs = findAll('/Yield/Power');
	const solar_w = solarPowerAttrs.length
		? solarPowerAttrs.reduce((s, r) => s + (num(r.rawValue) ?? 0), 0)
		: null;

	// Solar yield today — VRM stores in kWh, multiply to Wh for consistency
	const solarYieldAttrs = findAll('/Yield/User');
	const solar_yield_today_wh = solarYieldAttrs.length
		? solarYieldAttrs.reduce((s, r) => s + (num(r.rawValue) ?? 0), 0) * 1000
		: null;

	// Tanks — group by device+instance
	const tankAttrs = rows.filter(r => r.dbusPath === '/Level');
	const tanks = tankAttrs.map(r => ({
		name: r.Device || `Tank ${r.instance}`,
		level: num(r.rawValue) ?? 0,
	}));

	// GPS
	const gps_lat = num(find('/Position/Latitude')?.rawValue);
	const gps_lon = num(find('/Position/Longitude')?.rawValue);

	// Timestamp from latest attribute
	const timestamps = rows.map(r => r.timestamp).filter(Boolean) as number[];
	const last_ts = timestamps.length ? Math.max(...timestamps) : null;

	return { battery_soc, battery_v, battery_a, battery_w, solar_w, solar_yield_today_wh, tanks, gps_lat, gps_lon, last_ts };
}
