// Web Worker: Spoke-WebSocket je Radar, Protobuf-Decode, Guard-Zone-Echozählung.
// Der Haupt-Thread bekommt fertige Spoke-Batches (Transfer, keine Kopie).
import { decodeRadarMessage } from './spokeDecoder';

interface Zone {
	enabled: boolean;
	start: number; // rad relativ Bug
	end: number;
	inner: number;
	outer: number;
}

let ws: WebSocket | null = null;
let url = '';
let radarId = '';
let closed = false;
let retry = 0;
let spr = 2048;
let strong = 10;
let maxNormal = 15;
let zones: Zone[] = [];
let counts = [0, 0];
let lastAngle = -1;
let revStart = 0;
let msgs = 0;

const inSector = (a: number, s: number, e: number) => {
	const T = Math.PI * 2;
	if (Math.abs(((e - s) % T + T) % T) < 1e-6) return true; // Vollkreis
	const x = ((a - s) % T + T) % T;
	const w = ((e - s) % T + T) % T;
	return x <= w;
};

function connect() {
	if (!url || closed) return;
	ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	ws.onopen = () => {
		retry = 0;
		postMessage({ type: 'status', radarId, connected: true });
	};
	ws.onmessage = (e) => {
		if (!(e.data instanceof ArrayBuffer)) return;
		msgs++;
		const b = decodeRadarMessage(new Uint8Array(e.data));
		if (!b.n) return;
		// Guard Zones: starke Echos zählen, pro Umdrehung melden
		for (let i = 0; i < b.n; i++) {
			const ang = b.angle[i];
			if (lastAngle >= 0 && ang < lastAngle - spr / 4) {
				const now = Date.now();
				postMessage({ type: 'rev', radarId, counts, period: revStart ? now - revStart : 0 });
				counts = [0, 0];
				revStart = now;
			}
			lastAngle = ang;
			if (!zones.length) continue;
			const rel = (ang / spr) * Math.PI * 2;
			const L = b.len[i];
			if (!L) continue;
			const mpc = b.range[i] / L;
			for (let z = 0; z < zones.length; z++) {
				const Z = zones[z];
				if (!Z.enabled || !inSector(rel, Z.start, Z.end)) continue;
				const j0 = Math.max(0, Math.floor(Z.inner / mpc));
				const j1 = Math.min(L, Math.ceil(Z.outer / mpc));
				const off = i * b.stride;
				let c = 0;
				for (let j = j0; j < j1; j++) {
					const v = b.data[off + j];
					if (v >= strong && v <= maxNormal + 2) c++;
				}
				counts[z] += c;
			}
		}
		postMessage({ type: 'spokes', radarId, batch: b }, [
			b.angle.buffer,
			b.bearing.buffer,
			b.range.buffer,
			b.len.buffer,
			b.time.buffer,
			b.lat.buffer,
			b.lon.buffer,
			b.data.buffer
		]);
	};
	ws.onclose = () => {
		ws = null;
		postMessage({ type: 'status', radarId, connected: false });
		if (!closed) setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
	};
	ws.onerror = () => ws?.close();
}

setInterval(() => {
	postMessage({ type: 'rate', radarId, msgs });
	msgs = 0;
}, 1000);

self.onmessage = (e: MessageEvent) => {
	const m = e.data;
	if (m.cmd === 'connect') {
		closed = false;
		url = m.url;
		radarId = m.radarId;
		// alte (evtl. tote) Verbindung hart verwerfen und sofort neu verbinden
		if (ws) {
			const old = ws;
			ws = null;
			old.onopen = old.onmessage = old.onerror = old.onclose = null;
			try {
				old.close();
			} catch {
				/* ignore */
			}
		}
		connect();
	} else if (m.cmd === 'close') {
		closed = true;
		ws?.close();
	} else if (m.cmd === 'config') {
		spr = m.spokesPerRev ?? spr;
		strong = m.strong ?? strong;
		maxNormal = m.maxNormal ?? maxNormal;
		zones = m.zones ?? [];
	}
};
