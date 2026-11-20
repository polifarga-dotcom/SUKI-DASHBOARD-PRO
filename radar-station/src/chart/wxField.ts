// Wetterfeld vom Pi (Open-Meteo-Gitter): Abtasten an Position/Zeit, Farbskalen. Reine Funktionen (testbar).

export type WxKind = 'wind' | 'wave' | 'current';

export interface WxModel {
	id: string;
	kind: WxKind;
	name: string;
	res: number;
	info: string;
	/** Kurzbeschreibung: Wetterdienst, Hinweise, Güte */
	about?: string;
	about_de?: string;
	/** ungefähres Nutzungsgebiet, z. B. „Weltweit“, „Zentrales Mittelmeer“ */
	region?: string;
	region_de?: string;
}

export interface WxField {
	model: string;
	kind: WxKind;
	lat0: number;
	lon0: number;
	dlat: number;
	dlon: number;
	nx: number;
	ny: number;
	t0: number;
	dt: number;
	nt: number;
	/** Stärke (kn bzw. m), Richtung (Grad; wind/wave „woher“, current „wohin“), p = Böen (wind, kn) bzw. Periode (wave, s); flach [t][y][x] */
	s: (number | null)[];
	d: (number | null)[];
	p: (number | null)[] | null;
	/** Luftdruck hPa (nur wind) */
	q?: (number | null)[] | null;
	fetched: number;
	/** Modelllauf des Wetterdienstes (Initialisierung), verfügbar seit, Takt – ms; null = unbekannt */
	run?: number | null;
	avail?: number;
	every?: number;
	stale?: boolean;
	error?: string;
	/** quota | outside | api | network | queued */
	code?: string;
	/** Kontingent wieder frei ab (ms) */
	resetAt?: number | null;
	/** nächster Lauf erwartet (ms) */
	next?: number | null;
	/** vorberechnet: Bewegungsrichtung als Vektor (für saubere Interpolation der Richtung) */
	u?: Float32Array;
	v?: Float32Array;
}

const D2R = Math.PI / 180;

/** u/v („wohin“, Einheitsvektor × Stärke) vorberechnen; null → NaN */
export function prepare(f: WxField): WxField {
	const n = f.s.length;
	const u = new Float32Array(n);
	const v = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const s = f.s[i];
		const d = f.d[i];
		if (s == null || d == null) {
			u[i] = v[i] = NaN;
			continue;
		}
		const to = (f.kind === 'current' ? d : d + 180) * D2R;
		u[i] = Math.sin(to) * s;
		v[i] = Math.cos(to) * s;
	}
	f.u = u;
	f.v = v;
	return f;
}

export const tEnd = (f: WxField) => f.t0 + (f.nt - 1) * f.dt;

/** Zeitschritt zur Uhrzeit (nächster), -1 außerhalb des Modellzeitraums */
export function timeIndex(f: WxField, t: number) {
	const i = Math.round((t - f.t0) / f.dt);
	return i >= 0 && i < f.nt ? i : -1;
}

export interface WxSample {
	/** Stärke (kn bzw. m) */
	s: number;
	/** Richtung „woher“ (wind/wave) bzw. „wohin“ (current), Grad */
	dir: number;
	/** Böen kn (wind) bzw. Wellenperiode s (wave) */
	p: number | null;
	/** Luftdruck hPa (wind) */
	q: number | null;
}

/** bilinear an lat/lon zum Zeitschritt ti; Ecken ohne Daten (Land) zählen nicht */
export function sample(f: WxField, ti: number, lat: number, lon: number): WxSample | null {
	if (ti < 0 || !f.u || !f.v) return null;
	const fx = (lon - f.lon0) / f.dlon;
	const fy = (lat - f.lat0) / f.dlat;
	if (fx < 0 || fy < 0 || fx > f.nx - 1 || fy > f.ny - 1) return null;
	const x0 = Math.min(f.nx - 2, Math.floor(fx));
	const y0 = Math.min(f.ny - 2, Math.floor(fy));
	const ax = fx - x0;
	const ay = fy - y0;
	const base = ti * f.nx * f.ny;
	// Land/keine Daten am nächsten Gitterpunkt → nichts zeigen (sonst ragen Meeresfelder weit ins Land)
	if (f.s[base + (y0 + Math.round(ay)) * f.nx + x0 + Math.round(ax)] == null) return null;
	let w = 0, s = 0, u = 0, v = 0, p = 0, pw = 0, q = 0, qw = 0;
	for (let k = 0; k < 4; k++) {
		const x = x0 + (k & 1);
		const y = y0 + (k >> 1);
		const i = base + y * f.nx + x;
		const sv = f.s[i];
		if (sv == null || Number.isNaN(f.u[i])) continue;
		const wk = (k & 1 ? ax : 1 - ax) * (k >> 1 ? ay : 1 - ay);
		if (wk <= 0) continue;
		w += wk;
		s += wk * sv;
		u += wk * f.u[i];
		v += wk * f.v[i];
		const pv = f.p?.[i];
		if (pv != null) {
			p += wk * pv;
			pw += wk;
		}
		const qv = f.q?.[i];
		if (qv != null) {
			q += wk * qv;
			qw += wk;
		}
	}
	if (w < 0.25) return null; // überwiegend Land/keine Daten
	const to = (Math.atan2(u, v) / D2R + 360) % 360;
	return { s: s / w, dir: f.kind === 'current' ? to : (to + 180) % 360, p: pw ? p / pw : null, q: qw ? q / qw : null };
}

type Stops = [number, [number, number, number]][];
/** Farbskalen (Werte in kn bzw. m) */
export const SCALES: Record<WxKind, Stops> = {
	wind: [
		[0, [40, 60, 150]],
		[5, [40, 120, 200]],
		[10, [50, 170, 180]],
		[15, [80, 190, 110]],
		[20, [200, 210, 60]],
		[25, [245, 170, 40]],
		[30, [235, 100, 40]],
		[40, [210, 30, 50]],
		[50, [160, 30, 140]],
		[65, [100, 20, 120]]
	],
	wave: [
		[0, [40, 70, 160]],
		[0.5, [40, 130, 200]],
		[1, [50, 180, 170]],
		[2, [100, 200, 90]],
		[3, [230, 210, 60]],
		[4, [245, 140, 40]],
		[6, [220, 40, 50]],
		[9, [150, 30, 140]]
	],
	current: [
		[0, [40, 70, 160]],
		[0.25, [40, 130, 200]],
		[0.5, [50, 180, 170]],
		[1, [100, 200, 90]],
		[1.5, [230, 210, 60]],
		[2, [245, 140, 40]],
		[3, [220, 40, 50]],
		[4, [150, 30, 140]]
	]
};

export function colorAt(kind: WxKind, val: number): [number, number, number] {
	const st = SCALES[kind];
	if (val <= st[0][0]) return st[0][1];
	for (let i = 1; i < st.length; i++)
		if (val <= st[i][0]) {
			const [a, ca] = st[i - 1];
			const [b, cb] = st[i];
			const k = (val - a) / (b - a);
			return [0, 1, 2].map((j) => Math.round(ca[j] + (cb[j] - ca[j]) * k)) as [number, number, number];
		}
	return st[st.length - 1][1];
}

export const UNIT: Record<WxKind, string> = { wind: 'kn', wave: 'm', current: 'kn' };

/** Tile-Pixel (Web-Mercator) → lat/lon */
export function tileLatLon(z: number, x: number, y: number): [number, number] {
	const n = 2 ** z;
	const lon = (x / n) * 360 - 180;
	const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / D2R;
	return [lat, lon];
}

const ISO_STEP = 2; // hPa

/** Isobaren per Marching Squares über ein (n+1)²-Druckgitter der Kachel; alle 4 hPa kräftiger */
export function drawIsobars(ctx: CanvasRenderingContext2D, size: number, q: (number | null)[], n: number) {
	const segs = new Map<number, number[]>();
	const at = (i: number, j: number) => q[j * (n + 1) + i];
	const cs = size / n;
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const V = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
			if (V.some((x) => x == null)) continue;
			const v = V as number[];
			const lo = Math.ceil(Math.min(...v) / ISO_STEP) * ISO_STEP;
			const hi = Math.max(...v);
			// Ecken oben-links, oben-rechts, unten-rechts, unten-links
			const P = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
			for (let lv = lo; lv <= hi; lv += ISO_STEP) {
				const pts: number[] = [];
				for (let e = 0; e < 4; e++) {
					const v0 = v[e], v1 = v[(e + 1) % 4];
					if (v0 < lv === v1 < lv) continue;
					const k = (lv - v0) / (v1 - v0);
					const [x0, y0] = P[e], [x1, y1] = P[(e + 1) % 4];
					pts.push((x0 + (x1 - x0) * k) * cs, (y0 + (y1 - y0) * k) * cs);
				}
				if (pts.length < 4) continue;
				const s = segs.get(lv) ?? [];
				s.push(...pts.slice(0, 8)); // 2 Punkte = 1 Strich, 4 Punkte (Sattel) = 2 Striche
				segs.set(lv, s);
			}
		}
	ctx.lineCap = 'round';
	for (const [lv, s] of segs) {
		const major = lv % 4 === 0;
		// weiße Linie mit dunklem Rand: auf jeder Farbfläche lesbar
		for (const [col, w] of [['rgba(0,0,0,0.6)', major ? 4 : 3], ['rgba(255,255,255,0.95)', major ? 2 : 1.2]] as const) {
			ctx.strokeStyle = col;
			ctx.lineWidth = w;
			ctx.beginPath();
			for (let k = 0; k < s.length; k += 4) {
				ctx.moveTo(s[k], s[k + 1]);
				ctx.lineTo(s[k + 2], s[k + 3]);
			}
			ctx.stroke();
		}
		// Beschriftung am Strich nächst der Kachelmitte
		let best = 0, bd = Infinity;
		for (let k = 0; k < s.length; k += 4) {
			const dd = Math.hypot(s[k] - size / 2, s[k + 1] - size / 2);
			if (dd < bd) {
				bd = dd;
				best = k;
			}
		}
		const x = (s[best] + s[best + 2]) / 2, y = (s[best + 1] + s[best + 3]) / 2;
		ctx.font = 'bold 11px system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.lineWidth = 3;
		ctx.strokeStyle = 'rgba(0,0,0,0.8)';
		ctx.strokeText(String(lv), x, y);
		ctx.fillStyle = '#fff';
		ctx.fillText(String(lv), x, y);
	}
}
