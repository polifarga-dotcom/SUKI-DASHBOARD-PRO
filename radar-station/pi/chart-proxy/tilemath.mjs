// Kachelmathematik Web-Mercator (EPSG:3857) für WMS-Umrechnung und Revier-Download.
const R = 6378137;
const HALF = Math.PI * R; // 20037508.34

/** BBox (minx,miny,maxx,maxy in m, EPSG:3857) einer XYZ-Kachel */
export function tileBBox3857(z, x, y) {
	const size = (2 * HALF) / 2 ** z;
	const minx = -HALF + x * size;
	const maxy = HALF - y * size;
	return [minx, maxy - size, minx + size, maxy];
}

export function lon2tile(lon, z) {
	return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function lat2tile(lat, z) {
	const r = (lat * Math.PI) / 180;
	return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** Kachelbereich je Zoomstufe für eine BBox [west, south, east, north] (Grad) */
export function tileRange(bbox, z) {
	const [w, s, e, n] = bbox;
	const max = 2 ** z - 1;
	const clamp = (v) => Math.max(0, Math.min(max, v));
	return { z, x0: clamp(lon2tile(w, z)), x1: clamp(lon2tile(e, z)), y0: clamp(lat2tile(n, z)), y1: clamp(lat2tile(s, z)) };
}

export function countTiles(bbox, zmin, zmax) {
	let n = 0;
	for (let z = zmin; z <= zmax; z++) {
		const r = tileRange(bbox, z);
		n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
	}
	return n;
}

export function* iterTiles(bbox, zmin, zmax) {
	for (let z = zmin; z <= zmax; z++) {
		const r = tileRange(bbox, z);
		for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield [z, x, y];
	}
}
