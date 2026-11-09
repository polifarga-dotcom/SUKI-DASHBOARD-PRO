// Instrumentenwerte für den Tab „Instrumente“: Rohdaten aus SignalK (inst/own), wahrer Wind berechnet,
// wenn SignalK ihn nicht liefert, mit kurzer Glättung (Winkel als Vektoren gemittelt).
import { own, inst } from '../data/signalk.svelte';
import { D2R, KN, NM, dec, norm2pi, normPi, fmtLat, fmtLon } from './geo';
import { t } from './i18n.svelte';

const FRESH = 10000;

const raw = (path: string): number | null => {
	const x = inst[path];
	return x && Date.now() - x.t < FRESH ? x.v : null;
};

/** wahrer Wind (wasserbezogen) aus AWS/AWA und STW (oder SOG) */
export function trueWind(aws: number, awa: number, boat: number) {
	const x = aws * Math.sin(awa);
	const y = aws * Math.cos(awa) - boat;
	return { tws: Math.hypot(x, y), twa: Math.atan2(x, y) };
}

// ── Glättung ─────────────────────────────────────────────────────────────────
const TAU = 2500; // ms
const sm: Record<string, { v: number; s: number; c: number; t: number }> = {};
function smooth(key: string, v: number | null, angle = false): number | null {
	if (v == null) {
		delete sm[key];
		return null;
	}
	const now = Date.now();
	const o = sm[key];
	if (!o || now - o.t > 5000) {
		sm[key] = { v, s: Math.sin(v), c: Math.cos(v), t: now };
		return v;
	}
	const k = 1 - Math.exp(-(now - o.t) / TAU);
	o.t = now;
	if (angle) {
		o.s += (Math.sin(v) - o.s) * k;
		o.c += (Math.cos(v) - o.c) * k;
		o.v = Math.atan2(o.s, o.c);
	} else o.v += (v - o.v) * k;
	return o.v;
}

export interface Wind {
	aws: number | null;
	awa: number | null;
	tws: number | null;
	twa: number | null;
	twd: number | null;
	calc: boolean;
}

/** einmal je Anzeigetakt aufrufen (glättet) */
export function readWind(): Wind {
	const aws = smooth('aws', raw('environment.wind.speedApparent'));
	const awa = smooth('awa', raw('environment.wind.angleApparent'), true);
	let tws = raw('environment.wind.speedTrue');
	let twa = raw('environment.wind.angleTrueWater');
	let twd = raw('environment.wind.directionTrue');
	let calc = false;
	const boat = own.stw ?? own.sog;
	if ((tws == null || twa == null) && aws != null && awa != null && boat != null) {
		const tw = trueWind(aws, awa, boat);
		tws = tw.tws;
		twa = tw.twa;
		calc = true;
	}
	tws = smooth('tws', tws);
	twa = smooth('twa', twa, true);
	if (twd == null && twa != null && own.hdg != null) {
		twd = norm2pi(own.hdg + twa);
		calc = true;
	}
	twd = twd == null ? smooth('twd', null) : norm2pi(smooth('twd', twd, true)!);
	return { aws, awa, tws, twa, twd, calc };
}

// ── Boxen ────────────────────────────────────────────────────────────────────
export interface Box {
	id: string;
	label: string; // Kurzbezeichnung (bleibt in beiden Sprachen gleich, z. B. AWS)
	name: string; // ausgeschrieben, übersetzbar
	value: (w: Wind) => string;
	unit: string;
	calc?: (w: Wind) => boolean;
}

const kn = (ms: number | null) => (ms == null ? '—' : dec(ms / KN, 1));
const deg = (r: number | null) => (r == null ? '—' : `${Math.round(norm2pi(r) / D2R)}`.padStart(3, '0'));
/** Winkel −180…180 mit Seite: 38 P / 38 S */
const side = (r: number | null) => (r == null ? '—' : `${Math.round(Math.abs(normPi(r)) / D2R)}° ${normPi(r) < 0 ? t('P') : t('S')}`);

export const BOXES: Box[] = [
	{ id: 'aws', label: 'AWS', name: 'Apparent wind speed', value: (w) => kn(w.aws), unit: 'kn' },
	{ id: 'awa', label: 'AWA', name: 'Apparent wind angle', value: (w) => side(w.awa), unit: '' },
	{ id: 'tws', label: 'TWS', name: 'True wind speed', value: (w) => kn(w.tws), unit: 'kn', calc: (w) => w.calc },
	{ id: 'twa', label: 'TWA', name: 'True wind angle', value: (w) => side(w.twa), unit: '', calc: (w) => w.calc },
	{ id: 'twd', label: 'TWD', name: 'True wind direction', value: (w) => deg(w.twd), unit: '°T', calc: (w) => w.calc },
	{ id: 'sog', label: 'SOG', name: 'Speed over ground', value: () => kn(own.sog), unit: 'kn' },
	{ id: 'stw', label: 'STW', name: 'Speed through water', value: () => kn(own.stw), unit: 'kn' },
	{ id: 'cog', label: 'COG', name: 'Course over ground', value: () => deg(own.cog), unit: '°T' },
	{ id: 'hdg', label: 'HDG', name: 'Heading', value: () => deg(own.hdg), unit: '°T' },
	{
		id: 'vmg',
		label: 'VMG',
		name: 'Velocity made good (wind)',
		value: (w) => {
			const v = raw('performance.velocityMadeGood');
			if (v != null) return kn(Math.abs(v));
			const b = own.stw ?? own.sog;
			return b != null && w.twa != null ? kn(Math.abs(b * Math.cos(w.twa))) : '—';
		},
		unit: 'kn'
	},
	{ id: 'dpt', label: 'DPT', name: 'Depth', value: () => (own.depth != null && Date.now() - own.depthT < FRESH ? dec(own.depth, 1) : '—'), unit: 'm' },
	{ id: 'wtemp', label: 'WTEMP', name: 'Water temperature', value: () => tempC(raw('environment.water.temperature')), unit: '°C' },
	{ id: 'atemp', label: 'AIR', name: 'Air temperature', value: () => tempC(raw('environment.outside.temperature')), unit: '°C' },
	{ id: 'baro', label: 'BARO', name: 'Air pressure', value: () => { const p = raw('environment.outside.pressure'); return p == null ? '—' : dec(p / 100, 1); }, unit: 'hPa' },
	{ id: 'heel', label: 'HEEL', name: 'Heel', value: () => side(raw('navigation.attitude.roll')), unit: '' },
	{ id: 'rudder', label: 'RUDDER', name: 'Rudder angle', value: () => side(raw('steering.rudderAngle')), unit: '' },
	{ id: 'pos', label: 'POS', name: 'Position', value: () => (own.pos ? `${fmtLat(own.pos.lat)}\n${fmtLon(own.pos.lon)}` : '—'), unit: '' },
	{ id: 'trip', label: 'TRIP', name: 'Trip log', value: () => nmVal(raw('navigation.trip.log')), unit: 'nm' },
	{ id: 'log', label: 'LOG', name: 'Total log', value: () => nmVal(raw('navigation.log'), 0), unit: 'nm' }
];

function tempC(k: number | null) {
	return k == null ? '—' : dec(k - 273.15, 1);
}
function nmVal(m: number | null, d = 1) {
	return m == null ? '—' : dec(m / NM, d);
}

export const DEFAULT_BOXES = ['aws', 'awa', 'tws', 'twd', 'sog', 'stw', 'dpt', 'cog'];
