// Geometrie & Einheiten. Intern: Meter, m/s, Radiant (true), Zeit in ms.
export const NM = 1852;
export const KN = 1852 / 3600; // m/s je Knoten
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const TAU = Math.PI * 2;
const EARTH_R = 6371008.8;

export interface LatLon {
	lat: number;
	lon: number;
}

export const norm2pi = (a: number) => ((a % TAU) + TAU) % TAU;
/** Winkel in (-π, π] */
export const normPi = (a: number) => {
	const x = norm2pi(a);
	return x > Math.PI ? x - TAU : x;
};

/** Lokale Ebene (Ost, Nord) in m von `o` aus — für die Radar-/CPA-Distanzen (< 50 NM) ausreichend genau. */
export function toLocal(o: LatLon, p: LatLon): [number, number] {
	const lat0 = o.lat * D2R;
	const x = normPi((p.lon - o.lon) * D2R) * Math.cos(lat0) * EARTH_R;
	const y = (p.lat - o.lat) * D2R * EARTH_R;
	return [x, y];
}

export function fromLocal(o: LatLon, x: number, y: number): LatLon {
	const lat0 = o.lat * D2R;
	return { lat: o.lat + (y / EARTH_R) * R2D, lon: o.lon + (x / (EARTH_R * Math.cos(lat0))) * R2D };
}

/** Peilung (rad true) und Distanz (m) aus lokalen Koordinaten */
export const bearingOf = (x: number, y: number) => norm2pi(Math.atan2(x, y));

/** Geschwindigkeitsvektor (Ost, Nord) in m/s aus Kurs (rad) und Fahrt (m/s) */
export const velocity = (course: number, speed: number): [number, number] => [Math.sin(course) * speed, Math.cos(course) * speed];

// ── Formatierung ───────────────────────────────────────────────
// Sprache für Zahlen/Einheiten (gesetzt von i18n): DE = Dezimalkomma und „sm“ statt „nm“.
let locale: () => 'en' | 'de' = () => 'en';
/** i18n übergibt einen Getter auf settings.lang → Formatierung ist in Svelte reaktiv */
export const setNumberLocale = (get: () => 'en' | 'de') => (locale = get);
/** Zahl mit festen Nachkommastellen im Sprachformat */
export const dec = (x: number, d: number) => (locale() === 'de' ? x.toFixed(d).replace('.', ',') : x.toFixed(d));
/** beliebige Zahl als Text im Sprachformat */
export const numStr = (x: number) => (locale() === 'de' ? String(x).replace('.', ',') : String(x));
export const nmUnit = () => (locale() === 'de' ? 'sm' : 'nm');
export const fmtDeg = (rad: number | null | undefined, digits = 0) =>
	rad == null || !isFinite(rad) ? '—' : `${(norm2pi(rad) * R2D).toFixed(digits).padStart(3, '0')}°`;

export function fmtDist(m: number | null | undefined): string {
	if (m == null || !isFinite(m)) return '—';
	const nm = m / NM;
	if (nm < 0.1) return `${Math.round(m)} m`;
	if (nm < 10) return `${dec(nm, 2)} ${nmUnit()}`;
	return `${dec(nm, 1)} ${nmUnit()}`;
}

export const fmtSpeed = (ms: number | null | undefined) => (ms == null || !isFinite(ms) ? '—' : `${dec(ms / KN, 1)} kn`);

export function fmtTime(sec: number | null | undefined): string {
	if (sec == null || !isFinite(sec)) return '—';
	const neg = sec < 0;
	const s = Math.abs(Math.round(sec));
	const m = Math.floor(s / 60);
	const out = m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
	return neg ? `-${out}` : out;
}

export function fmtLat(lat: number | null | undefined) {
	if (lat == null) return '—';
	const a = Math.abs(lat);
	return `${String(Math.floor(a)).padStart(2, '0')}°${dec((a % 1) * 60, 3).padStart(6, '0')}′${lat >= 0 ? 'N' : 'S'}`;
}
export function fmtLon(lon: number | null | undefined) {
	if (lon == null) return '—';
	const a = Math.abs(lon);
	return `${String(Math.floor(a)).padStart(3, '0')}°${dec((a % 1) * 60, 3).padStart(6, '0')}′${lon >= 0 ? (locale() === 'de' ? 'O' : 'E') : 'W'}`;
}

/** Range-Beschriftung wie am Plotter: 1/8, 1/4, 1/2, 3/4 nm oder Meter bei metrischen Stufen */
export function fmtRange(m: number): string {
	const nm = m / NM;
	const fr: [number, string][] = [
		[1 / 32, '1/32'],
		[1 / 16, '1/16'],
		[1 / 8, '1/8'],
		[1 / 4, '1/4'],
		[1 / 2, '1/2'],
		[3 / 4, '3/4'],
		[1.5, '1.5']
	];
	for (const [v, s] of fr) if (Math.abs(nm - v) < 0.002) return `${locale() === 'de' ? s.replace('.', ',') : s} ${nmUnit()}`;
	if (Math.abs(nm - Math.round(nm)) < 0.002 && nm >= 1) return `${Math.round(nm)} ${nmUnit()}`;
	return m < 1000 ? `${Math.round(m)} m` : `${dec(m / 1000, m % 1000 ? 1 : 0)} km`;
}

/** Ist die Range-Stufe eine nautische (Vielfaches von 1/32 nm)? */
export const isNauticalRange = (m: number) => Math.abs(m / NM * 32 - Math.round((m / NM) * 32)) < 0.01;

/** Ringabstand für eine Range: 4 Ringe bei „runden“ Werten, sonst 3 */
export function ringStep(rangeM: number): { step: number; count: number } {
	const nm = rangeM / NM;
	const count = [0.75, 1.5, 3, 6, 12, 24, 36, 48].some((v) => Math.abs(nm - v) < 0.01) ? 3 : 4;
	return { step: rangeM / count, count };
}

// Großkreis (lange Passagen: die lokale Ebene von toLocal ist dort zu ungenau)
const R_EARTH = 6371008.8;
export function gcDist(a: LatLon, b: LatLon): number {
	const p1 = a.lat * D2R, p2 = b.lat * D2R;
	const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b.lon - a.lon) * D2R) / 2) ** 2;
	return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Anfangskurs a → b (rad, wahr) */
export function gcBearing(a: LatLon, b: LatLon): number {
	const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
	return norm2pi(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)));
}
