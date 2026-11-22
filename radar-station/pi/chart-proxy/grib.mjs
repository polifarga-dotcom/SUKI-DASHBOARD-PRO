// GRIB1-Leser (WMO FM 92 Edition 1) für PredictWind-Downloads: reguläres Lat/Lon-Gitter, einfache Packung.
// Ohne Bibliothek: Kopfdaten einmal lesen (index), Werte nur für den gebrauchten Ausschnitt entpacken (crop).

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
/** Vorzeichen im höchsten Bit (GRIB1-Konvention), nicht Zweierkomplement */
const s16 = (b, o) => (b[o] & 0x80 ? -(u16(b, o) & 0x7fff) : u16(b, o));
const s24 = (b, o) => (b[o] & 0x80 ? -(u24(b, o) & 0x7fffff) : u24(b, o));
/** IBM-Gleitkomma (Basis 16) */
function ibm(b, o) {
	const sign = b[o] & 0x80 ? -1 : 1;
	const exp = (b[o] & 0x7f) - 64;
	const mant = u24(b, o + 1) / 0x1000000;
	return sign * mant * 16 ** exp;
}
/** Zeiteinheit (PDS Oktett 18) → ms */
const UNIT = { 0: 60e3, 1: 3600e3, 2: 86400e3, 10: 3 * 3600e3, 11: 6 * 3600e3, 12: 12 * 3600e3, 254: 1e3 };

/** Kopfdaten aller Meldungen; GRIB2/fremde Formate → [] (z. B. verschlüsselte „PW01“-Dateien) */
export function gribIndex(buf) {
	const out = [];
	let o = 0;
	while (o + 8 < buf.length) {
		if (buf[o] !== 0x47 || buf[o + 1] !== 0x52 || buf[o + 2] !== 0x49 || buf[o + 3] !== 0x42) {
			const n = buf.indexOf('GRIB', o + 1);
			if (n < 0) break;
			o = n;
			continue;
		}
		const len = u24(buf, o + 4);
		if (buf[o + 7] !== 1 || len < 40) break; // nur Edition 1
		const pds = o + 8;
		const pl = u24(buf, pds);
		const flag = buf[pds + 7];
		const cent = buf[pds + 24] || 21;
		const run = Date.UTC((cent - 1) * 100 + buf[pds + 12], buf[pds + 13] - 1, buf[pds + 14], buf[pds + 15], buf[pds + 16]);
		const unit = UNIT[buf[pds + 17]] ?? 3600e3;
		const p1 = buf[pds + 18], p2 = buf[pds + 19], tr = buf[pds + 20];
		// Zeitbereich: 0/1 = P1, 10 = P1 als 16 Bit, 2–5 = Ende des Intervalls (P2, z. B. Regen)
		const step = (tr === 10 ? (p1 << 8) | p2 : tr >= 2 && tr <= 5 ? p2 : p1) * unit;
		const rec = { off: o, param: buf[pds + 8], ltype: buf[pds + 9], level: u16(buf, pds + 10), run, valid: run + step, D: s16(buf, pds + 26), grid: null, bms: -1, bds: -1 };
		let p = pds + pl;
		if (flag & 0x80) {
			const g = p;
			if (buf[g + 5] !== 0) {
				o += len;
				continue; // kein Lat/Lon-Gitter
			}
			rec.grid = {
				ni: u16(buf, g + 6),
				nj: u16(buf, g + 8),
				la1: s24(buf, g + 10) / 1000,
				lo1: s24(buf, g + 13) / 1000,
				la2: s24(buf, g + 17) / 1000,
				lo2: s24(buf, g + 20) / 1000,
				scan: buf[g + 27]
			};
			p += u24(buf, g);
		}
		if (flag & 0x40) {
			rec.bms = p;
			p += u24(buf, p);
		}
		rec.bds = p;
		if (rec.grid && !(buf[p + 3] & 0xf0)) out.push(rec); // nur Gitterpunkte, einfache Packung, Gleitkomma
		o += len;
	}
	return out;
}

/** Gitter einer Meldung: Breite/Länge von Zeile/Spalte (j, i) */
export function gridGeo(gr) {
	const { ni, nj, la1, lo1, la2, scan } = gr;
	let lo2 = gr.lo2;
	if (scan & 0x80 ? lo2 > lo1 : lo2 < lo1) lo2 += scan & 0x80 ? -360 : 360; // über 180°
	return { ni, nj, la1, lo1, la2, lo2, di: (lo2 - lo1) / (ni - 1), dj: (la2 - la1) / (nj - 1), jcons: !!(scan & 0x20) };
}

/** Werte einer Meldung an den Gitterindizes (i, j) → Float32Array (NaN = fehlt) */
export function gribValues(buf, rec, picks) {
	const b = rec.bds;
	const E = s16(buf, b + 4);
	const R = ibm(buf, b + 6);
	const nb = buf[b + 10];
	const D = 10 ** rec.D;
	const { ni, nj, jcons } = gridGeo(rec.grid);
	const out = new Float32Array(picks.length);
	// Bitmap: k-tes gesetztes Bit = k-ter gepackter Wert
	let rank = null;
	if (rec.bms >= 0) {
		const bm = rec.bms + 6;
		rank = new Int32Array(ni * nj);
		let k = 0;
		for (let n = 0; n < ni * nj; n++) rank[n] = buf[bm + (n >> 3)] & (0x80 >> (n & 7)) ? k++ : -1;
	}
	const scale = 2 ** E;
	const data = b + 11;
	for (let q = 0; q < picks.length; q++) {
		const [i, j] = picks[q];
		const n = jcons ? i * nj + j : j * ni + i;
		const k = rank ? rank[n] : n;
		if (k < 0) {
			out[q] = NaN;
			continue;
		}
		let x = 0;
		if (nb) {
			// nb Bits ab Bitposition k*nb lesen (≤ 32 Bit)
			let bit = k * nb;
			for (let r = nb; r > 0; ) {
				const byte = buf[data + (bit >> 3)];
				const avail = 8 - (bit & 7);
				const take = Math.min(avail, r);
				x = x * 2 ** take + ((byte >> (avail - take)) & ((1 << take) - 1));
				bit += take;
				r -= take;
			}
		}
		out[q] = (R + x * scale) / D;
	}
	return out;
}

// ── PredictWind-Dateien → Wetterfeld (gleiches Format wie Open-Meteo, siehe wx.mjs) ──
const MS2KN = 1.943844;
/** Parameter (WMO-Tabelle 2) */
const P = { PRES: 1, PRMSL: 2, UGRD: 33, VGRD: 34, UOGRD: 49, VOGRD: 50, GUST: 180, HTSGW: 100, WVDIR: 101, WVPER: 103 };
/** Zusatzwerte als Farbfläche (nur Wind-Dateien): Parameter und Umrechnung in die Anzeigeeinheit */
const EXTRA = {
	rain: { param: 59, conv: (v) => Math.round(v * 3600 * 10) / 10 }, // PRATE kg/m²/s → mm/h
	cloud: { param: 71, conv: (v) => Math.round(v) }, // TCDC %
	cape: { param: 157, conv: (v) => Math.round(v) }, // CAPE J/kg
	temp: { param: 11, level2m: true, conv: (v) => Math.round((v > 150 ? v - 273.15 : v) * 10) / 10 } // TMP 2 m, K → °C
};

/** Dateiname „20261121_0545_PWG_All_8km_3h_37.250_14.291__…grb“ → { model, variant } */
export function pwFileInfo(name) {
	const m = String(name).match(/^(\d{8})_(\d{4})_([A-Za-z0-9]+)_([A-Za-z]+)_(\d+k(?:m)?)_/);
	if (!m) return null;
	return { stamp: `${m[1]}_${m[2]}`, model: m[3].toUpperCase(), variant: m[4], res: m[5] };
}

/** Datei → { kind, times, geo, rec-Gruppen } oder null (nicht lesbar) */
export function gribSummary(buf) {
	const recs = gribIndex(buf);
	if (!recs.length) return null;
	const sfc = (r, p) => r.param === p && (r.ltype === 105 ? r.level === 10 : r.ltype === 1 || r.ltype === 102);
	const has = (p) => recs.some((r) => sfc(r, p));
	const kind = has(P.UGRD) && has(P.VGRD) ? 'wind' : has(P.HTSGW) ? 'wave' : has(P.UOGRD) ? 'current' : null;
	if (!kind) return null;
	const by = (p, alt) => {
		const m = new Map();
		for (const r of recs) if (sfc(r, p) || (alt != null && sfc(r, alt))) if (!m.has(r.valid)) m.set(r.valid, r);
		return m;
	};
	const groups =
		kind === 'wind'
			? { a: by(P.UGRD), b: by(P.VGRD), p: by(P.GUST), q: by(P.PRMSL, P.PRES) }
			: kind === 'wave'
				? { a: by(P.HTSGW), b: by(P.WVDIR), p: by(P.WVPER), q: new Map() }
				: { a: by(P.UOGRD), b: by(P.VOGRD), p: new Map(), q: new Map() };
	// Zusatzwerte: je Zeitpunkt der erste passende Datensatz, Höhenart egal (Wolken: Boden oder ganze Atmosphäre); Temperatur nur 2 m
	const extra = {};
	if (kind === 'wind')
		for (const [k, e] of Object.entries(EXTRA)) {
			const m = new Map();
			for (const r of recs) if (r.param === e.param && (!e.level2m || (r.ltype === 105 && r.level === 2)) && !m.has(r.valid)) m.set(r.valid, r);
			if (m.size) extra[k] = m;
		}
	groups.x = extra;
	const times = [...groups.a.keys()].filter((t) => groups.b.has(t)).sort((x, y) => x - y);
	// gleichmäßige Zeitachse: häufigster Abstand, ab dem ersten Zeitpunkt lückenlos
	const diffs = new Map();
	for (let i = 1; i < times.length; i++) diffs.set(times[i] - times[i - 1], (diffs.get(times[i] - times[i - 1]) ?? 0) + 1);
	const dt = [...diffs].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 3600e3;
	const regular = [times[0]];
	for (const t of times.slice(1)) if (t === regular[regular.length - 1] + dt) regular.push(t);
	const first = groups.a.get(times[0]);
	return { kind, times: regular, dt, geo: gridGeo(first.grid), run: Math.min(...recs.map((r) => r.run)), groups };
}

/**
 * Ausschnitt um lat/lon (Halbseite rNm) als Wetterfeld; höchstens maxN × maxN Punkte (gröber abgetastet).
 * Werte wie Open-Meteo: wind kn „woher“, Böen kn, Druck hPa; wave m, Richtung „woher“, Periode s.
 */
export function gribField(buf, sum, lat, lon, rNm, maxN = 41) {
	const g = sum.geo;
	const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
	const sLa = Math.min(g.la1, g.la2), nLa = Math.max(g.la1, g.la2);
	const wLo = Math.min(g.lo1, g.lo2), eLo = Math.max(g.lo1, g.lo2);
	let la0 = Math.max(sLa, lat - rNm / 60), la1 = Math.min(nLa, lat + rNm / 60);
	let lo0 = Math.max(wLo, lon - rNm / 60 / cos), lo1 = Math.min(eLo, lon + rNm / 60 / cos);
	if (la0 >= la1 || lo0 >= lo1) return null; // außerhalb der Datei
	const dj = Math.abs(g.dj), di = Math.abs(g.di);
	const sy = Math.max(1, Math.ceil((la1 - la0) / dj / (maxN - 1)));
	const sx = Math.max(1, Math.ceil((lo1 - lo0) / di / (maxN - 1)));
	// Gitterzeilen/-spalten (Index im Datei-Gitter), Süd → Nord, West → Ost
	const jOf = (la) => Math.round((la - g.la1) / g.dj);
	const iOf = (lo) => Math.round((lo - g.lo1) / g.di);
	const js = [], is = [];
	const jA = jOf(la0), jB = jOf(la1);
	for (let j = Math.min(jA, jB); j <= Math.max(jA, jB); j += sy) js.push(j);
	if (g.dj < 0) js.reverse(); // Datei Nord → Süd: Süd zuerst
	const iA = iOf(lo0), iB = iOf(lo1);
	for (let i = Math.min(iA, iB); i <= Math.max(iA, iB); i += sx) is.push(i);
	if (g.di < 0) is.reverse();
	const picks = [];
	for (const j of js) for (const i of is) picks.push([i, j]);
	const nx = is.length, ny = js.length, nt = sum.times.length, n = nx * ny;
	const s = new Array(nt * n), d = new Array(nt * n);
	const p = sum.groups.p.size ? new Array(nt * n).fill(null) : null;
	const q = sum.groups.q.size ? new Array(nt * n).fill(null) : null;
	const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
	const x = {};
	for (const [k, m] of Object.entries(sum.groups.x ?? {})) {
		const arr = (x[k] = new Array(nt * n).fill(null));
		sum.times.forEach((t, ti) => {
			const rec = m.get(t);
			if (!rec) return;
			const V = gribValues(buf, rec, picks);
			for (let kk = 0; kk < n; kk++) if (Number.isFinite(V[kk])) arr[ti * n + kk] = EXTRA[k].conv(V[kk]);
		});
	}
	sum.times.forEach((t, ti) => {
		const A = gribValues(buf, sum.groups.a.get(t), picks);
		const B = gribValues(buf, sum.groups.b.get(t), picks);
		const Pv = sum.groups.p.get(t) && gribValues(buf, sum.groups.p.get(t), picks);
		const Qv = sum.groups.q.get(t) && gribValues(buf, sum.groups.q.get(t), picks);
		for (let k = 0; k < n; k++) {
			const o = ti * n + k;
			if (sum.kind === 'wave') {
				s[o] = Number.isFinite(A[k]) ? Math.round(A[k] * 100) / 100 : null;
				d[o] = s[o] == null ? null : r1(B[k]);
				if (p && Pv) p[o] = r1(Pv[k]);
			} else {
				const u = A[k], v = B[k];
				if (!Number.isFinite(u) || !Number.isFinite(v)) {
					s[o] = d[o] = null;
					continue;
				}
				const k2 = sum.kind === 'wind' ? MS2KN : MS2KN;
				s[o] = Math.round(Math.hypot(u, v) * k2 * 100) / 100;
				// wind: „woher“; current: „wohin“
				const to = (Math.atan2(u, v) * 180) / Math.PI;
				d[o] = r1(((sum.kind === 'wind' ? to + 180 : to) + 360) % 360);
				if (p && Pv) p[o] = Number.isFinite(Pv[k]) ? Math.round(Pv[k] * MS2KN * 10) / 10 : null;
			}
			if (q && Qv) q[o] = Number.isFinite(Qv[k]) ? Math.round(Qv[k] / 10) / 10 : null; // Pa → hPa
		}
	});
	const latOf = (j) => g.la1 + j * g.dj, lonOf = (i) => g.lo1 + i * g.di;
	return {
		kind: sum.kind,
		lat0: latOf(js[0]),
		lon0: lonOf(is[0]),
		dlat: ny > 1 ? latOf(js[1]) - latOf(js[0]) : dj,
		dlon: nx > 1 ? lonOf(is[1]) - lonOf(is[0]) : di,
		nx,
		ny,
		t0: sum.times[0],
		dt: sum.dt,
		nt,
		s,
		d,
		p,
		q,
		...(Object.keys(x).length ? { x } : {}),
		run: sum.run
	};
}
