import type { VRMData, VRMMppt } from '$lib/types.js';

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

	const find    = (path: string) => rows.find(r => r.dbusPath === path);
	const findAll = (path: string) => rows.filter(r => r.dbusPath === path);

	// ── Battery ───────────────────────────────────────────────────────────────
	// SOC may live on the battery monitor (/Dc/0/Soc) or vebus (/Soc)
	const battery_soc =
		num(find('/Dc/0/Soc')?.rawValue) ??
		num(rows.find(r => r.dbusPath === '/Soc')?.rawValue);

	const battery_v = num(find('/Dc/0/Voltage')?.rawValue);
	const battery_a = num(find('/Dc/0/Current')?.rawValue);
	const battery_w = num(find('/Dc/0/Power')?.rawValue);

	// ── Individual MPPTs ──────────────────────────────────────────────────────
	const mpptMap = new Map<string, VRMMppt>();

	findAll('/Yield/Power').forEach(r => {
		const key = `${r.Device}__${r.instance}`;
		const entry = mpptMap.get(key) ?? {
			name: r.Device || `MPPT ${r.instance}`,
			instance: r.instance,
			power_w: 0,
			yield_today_wh: 0,
			pv_v: null,
		};
		entry.power_w = num(r.rawValue) ?? 0;
		mpptMap.set(key, entry);
	});

	findAll('/Yield/User').forEach(r => {
		const key = `${r.Device}__${r.instance}`;
		const entry = mpptMap.get(key) ?? {
			name: r.Device || `MPPT ${r.instance}`,
			instance: r.instance,
			power_w: 0,
			yield_today_wh: 0,
			pv_v: null,
		};
		entry.yield_today_wh = (num(r.rawValue) ?? 0) * 1000; // kWh → Wh
		mpptMap.set(key, entry);
	});

	findAll('/Pv/V').forEach(r => {
		const key = `${r.Device}__${r.instance}`;
		const entry = mpptMap.get(key);
		if (entry) { entry.pv_v = num(r.rawValue); mpptMap.set(key, entry); }
	});

	// Sort by power descending (active first)
	const mpptsArr = Array.from(mpptMap.values()).sort((a, b) => b.power_w - a.power_w);

	// ── Solar totals ──────────────────────────────────────────────────────────
	const solar_w = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + m.power_w, 0)
		: null;

	const solar_yield_today_wh = mpptsArr.length > 0
		? mpptsArr.reduce((s, m) => s + m.yield_today_wh, 0)
		: null;

	// ── AC Load (Vebus / Multi / Quattro) ─────────────────────────────────────
	const acL1 = num(find('/Ac/Consumption/L1/Power')?.rawValue);
	const acL2 = num(find('/Ac/Consumption/L2/Power')?.rawValue);
	const acL3 = num(find('/Ac/Consumption/L3/Power')?.rawValue);
	const load_w = (acL1 != null || acL2 != null || acL3 != null)
		? (acL1 ?? 0) + (acL2 ?? 0) + (acL3 ?? 0)
		: null;

	// ── Tanks ─────────────────────────────────────────────────────────────────
	const tanks = rows
		.filter(r => r.dbusPath === '/Level')
		.map(r => ({
			name: r.Device || `Tank ${r.instance}`,
			level: num(r.rawValue) ?? 0,
		}));

	// ── GPS ───────────────────────────────────────────────────────────────────
	const gpsLatRow = find('/Position/Latitude');
	const gpsLonRow = find('/Position/Longitude');
	const gps_lat = num(gpsLatRow?.rawValue);
	const gps_lon = num(gpsLonRow?.rawValue);
	const gps_ts  = gpsLatRow?.timestamp ?? gpsLonRow?.timestamp ?? null;

	// ── Overall data freshness ────────────────────────────────────────────────
	const timestamps = rows.map(r => r.timestamp).filter(Boolean) as number[];
	const last_ts = timestamps.length ? Math.max(...timestamps) : null;

	return {
		battery_soc, battery_v, battery_a, battery_w,
		solar_w, solar_yield_today_wh, mpptsArr,
		load_w,
		tanks,
		gps_lat, gps_lon, gps_ts,
		last_ts,
	};
}
