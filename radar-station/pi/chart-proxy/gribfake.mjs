// Nur für Tests: synthetische GRIB1-Meldungen
/** minimale GRIB1-Meldung: Gitter Nord→Süd (scan 0), Werte = R + X·2^E, 16 Bit, optional Bitmap */
export function msg({ param, ltype = 105, level = 10, hour = 0, ni = 3, nj = 2, values, bitmap = null, D = 0 }) {
	const s24 = (v) => { const a = Math.abs(Math.round(v * 1000)); return [((a >> 16) & 0x7f) | (v < 0 ? 0x80 : 0), (a >> 8) & 255, a & 255]; };
	const pds = [0, 0, 28, 2, 98, 0, 255, bitmap ? 0xc0 : 0x80, param, ltype, level >> 8, level & 255, 26, 11, 21, 0, 0, 1, hour, 0, 0, 0, 0, 0, 21, 0, D < 0 ? 0x80 : 0, Math.abs(D)];
	const gds = [0, 0, 32, 0, 255, 0, ni >> 8, ni & 255, nj >> 8, nj & 255, ...s24(38), ...s24(14), 0x80, ...s24(37), ...s24(14 + (ni - 1)), 0, 0, 0, 0, 0, 0, 0, 0, 0];
	gds[23] = 0x03; gds[24] = 0xe8; gds[25] = 0x03; gds[26] = 0xe8; // 1,000° Schrittweite
	const packed = bitmap ? values.filter((_, i) => bitmap[i]) : values;

	const data = packed.flatMap((v) => { const x = Math.round(v * 10 ** D); return [x >> 8, x & 255]; });
	const bds = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, ...data, 0];
	bds[2] = bds.length;
	let bms = [];
	if (bitmap) {
		const bytes = [];
		for (let i = 0; i < bitmap.length; i += 8) bytes.push(bitmap.slice(i, i + 8).reduce((a, b, k) => a | (b ? 0x80 >> k : 0), 0));
		bms = [0, 0, 6 + bytes.length, 0, 0, 0, ...bytes];
	}

	const body = [...pds, ...gds, ...bms, ...bds, 0x37, 0x37, 0x37, 0x37];
	const len = 8 + body.length;
	return [0x47, 0x52, 0x49, 0x42, (len >> 16) & 255, (len >> 8) & 255, len & 255, 1, ...body];
}
