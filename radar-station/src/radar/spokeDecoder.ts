// Protobuf-Decoder für mayara RadarMessage { repeated Spoke spokes = 2 }.
// Spoke: angle=1 (varint, relativ zum Bug, 0..spokesPerRev-1), bearing=2 (varint, true, optional),
// range=3 (varint, m), time=4 (varint, ms epoch), data=5 (bytes), lat=6 (double), lon=7 (double).
// Gleiche Feldbelegung wie der Node-RED-Decoder des ESP-Mini-Dashboards (build_flow.py, RADAR_FN).

export interface SpokeBatch {
	n: number;
	stride: number; // Bytes je Spoke in `data`
	angle: Uint16Array;
	bearing: Int32Array; // -1 = nicht vorhanden
	range: Uint32Array;
	len: Uint16Array;
	time: Float64Array;
	lat: Float64Array; // NaN = nicht vorhanden
	lon: Float64Array;
	data: Uint8Array;
}

const MAX_SPOKES = 256;

export function decodeRadarMessage(buf: Uint8Array, stride = 1024): SpokeBatch {
	// Erst zählen, dann füllen → genau passende Transfer-Puffer
	let count = 0;
	scan(buf, () => count++);
	count = Math.min(count, MAX_SPOKES);
	const out: SpokeBatch = {
		n: 0,
		stride,
		angle: new Uint16Array(count),
		bearing: new Int32Array(count).fill(-1),
		range: new Uint32Array(count),
		len: new Uint16Array(count),
		time: new Float64Array(count),
		lat: new Float64Array(count).fill(NaN),
		lon: new Float64Array(count).fill(NaN),
		data: new Uint8Array(count * stride)
	};
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	scan(buf, (start, end) => {
		const i = out.n;
		if (i >= count) return;
		const pos = { i: start };
		while (pos.i < end) {
			const key = varint(buf, pos);
			const f = key >>> 3;
			const wt = key & 7;
			if (wt === 0) {
				const v = varint(buf, pos);
				if (f === 1) out.angle[i] = v;
				else if (f === 2) out.bearing[i] = v;
				else if (f === 3) out.range[i] = v;
				else if (f === 4) out.time[i] = v;
			} else if (wt === 1) {
				const d = dv.getFloat64(pos.i, true);
				if (f === 6) out.lat[i] = d;
				else if (f === 7) out.lon[i] = d;
				pos.i += 8;
			} else if (wt === 2) {
				const l = varint(buf, pos);
				if (f === 5) {
					const L = Math.min(l, stride);
					out.data.set(buf.subarray(pos.i, pos.i + L), i * stride);
					out.len[i] = L;
				}
				pos.i += l;
			} else if (wt === 5) pos.i += 4;
			else break;
		}
		out.n++;
	});
	return out;
}

function scan(buf: Uint8Array, onSpoke: (start: number, end: number) => void) {
	const pos = { i: 0 };
	while (pos.i < buf.length) {
		const key = varint(buf, pos);
		const f = key >>> 3;
		const wt = key & 7;
		if (wt === 2) {
			const len = varint(buf, pos);
			const end = pos.i + len;
			if (f === 2) onSpoke(pos.i, end);
			pos.i = end;
		} else if (wt === 0) varint(buf, pos);
		else if (wt === 1) pos.i += 8;
		else if (wt === 5) pos.i += 4;
		else break;
	}
}

function varint(buf: Uint8Array, pos: { i: number }): number {
	let v = 0;
	let m = 1;
	let c: number;
	do {
		c = buf[pos.i++];
		v += (c & 127) * m;
		m *= 128;
	} while (c & 128 && pos.i < buf.length);
	return v;
}

/** Test-Hilfe: Spoke als Protobuf kodieren */
export function encodeSpoke(s: { angle: number; bearing?: number; range: number; time?: number; data: Uint8Array; lat?: number; lon?: number }): Uint8Array {
	const bytes: number[] = [];
	const vi = (v: number) => {
		do {
			let b = v % 128;
			v = Math.floor(v / 128);
			if (v > 0) b |= 128;
			bytes.push(b);
		} while (v > 0);
	};
	const dbl = (d: number) => {
		const b = new Uint8Array(8);
		new DataView(b.buffer).setFloat64(0, d, true);
		bytes.push(...b);
	};
	vi((1 << 3) | 0);
	vi(s.angle);
	if (s.bearing != null) {
		vi((2 << 3) | 0);
		vi(s.bearing);
	}
	vi((3 << 3) | 0);
	vi(s.range);
	if (s.time != null) {
		vi((4 << 3) | 0);
		vi(s.time);
	}
	vi((5 << 3) | 2);
	vi(s.data.length);
	bytes.push(...s.data);
	if (s.lat != null) {
		vi((6 << 3) | 1);
		dbl(s.lat);
	}
	if (s.lon != null) {
		vi((7 << 3) | 1);
		dbl(s.lon);
	}
	const inner = bytes.splice(0);
	vi((2 << 3) | 2);
	vi(inner.length);
	return new Uint8Array([...bytes, ...inner]);
}
