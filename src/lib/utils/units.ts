export const k2c = (k: number | null): string =>
	k == null ? '—' : (k - 273.15).toFixed(1) + '°C';

export const ms2kn = (ms: number | null): string =>
	ms == null ? '—' : (ms * 1.94384).toFixed(1);

export const ms2knNum = (ms: number | null): number | null =>
	ms == null ? null : ms * 1.94384;

export const rad2deg = (r: number | null): number | null =>
	r == null ? null : (r * 180) / Math.PI;

export const rad2degStr = (r: number | null): string =>
	r == null ? '—' : ((r * 180) / Math.PI).toFixed(0) + '°';

export const nToTons = (n: number | null): number | null =>
	n == null ? null : n / 9806.65;

export const pct = (ratio: number | null): string =>
	ratio == null ? '—' : (ratio * 100).toFixed(0) + '%';

export const fmtV = (v: number | null): string =>
	v == null ? '—' : v.toFixed(1) + 'V';

export const fmtA = (a: number | null): string =>
	a == null ? '—' : (a >= 0 ? '+' : '') + a.toFixed(1) + 'A';

export const fmtW = (w: number | null): string =>
	w == null ? '—' : w.toFixed(0) + 'W';

export const fmtSOC = (soc: number | null): string =>
	soc == null ? '—' : (soc * 100).toFixed(0) + '%';

export const fmtDepth = (m: number | null): string =>
	m == null ? '—' : m.toFixed(1) + 'm';

export const fmtPressure = (pa: number | null): string =>
	pa == null ? '—' : (pa / 100).toFixed(1) + ' hPa';

export const fmtLatLon = (lat: number | null, lon: number | null): string => {
	if (lat == null || lon == null) return '—';
	const latD = Math.abs(lat).toFixed(4) + '° ' + (lat >= 0 ? 'N' : 'S');
	const lonD = Math.abs(lon).toFixed(4) + '° ' + (lon >= 0 ? 'E' : 'W');
	return `${latD}  ${lonD}`;
};

export const joule2kwh = (j: number | null): string =>
	j == null ? '—' : (j / 3_600_000).toFixed(2) + ' kWh';

export const fmtRuntime = (sec: number | null): string => {
	if (sec == null) return '—';
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${h}h ${m}m`;
};

export const socColor = (soc: number | null): string => {
	if (soc == null) return 'var(--muted)';
	if (soc >= 0.7) return 'var(--green)';
	if (soc >= 0.3) return 'var(--amber)';
	return 'var(--red)';
};

export const pressureColor = (pa: number | null): string => {
	if (pa == null) return 'var(--muted)';
	const hpa = pa / 100;
	if (hpa >= 1010 && hpa <= 1025) return 'var(--green)';
	if ((hpa >= 995 && hpa < 1010) || (hpa > 1025 && hpa <= 1035)) return 'var(--amber)';
	return 'var(--red)';
};

export const rigColor = (n: number | null): string => {
	if (n == null) return 'var(--muted)';
	const t = n / 9806.65;
	if (t < 3) return 'var(--green)';
	if (t < 3.5) return 'var(--amber)';
	return 'var(--red)';
};

export const dataAge = (updatedAt: string | null): boolean => {
	if (!updatedAt) return true;
	return Date.now() - new Date(updatedAt).getTime() > 15_000;
};

const CARDINALS = ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'];
export const bearingCardinal = (deg: number | null): string => {
	if (deg == null) return '—';
	return CARDINALS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
};
