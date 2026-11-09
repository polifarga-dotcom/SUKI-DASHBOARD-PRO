// SignalK-Client: Eigenes Schiff + AIS-Ziele (vessels.*, atons.*).
// Hochfrequente Daten liegen in normalen Objekten (Render-Loop liest direkt), die UI aktualisiert per `version`.
import type { LatLon } from '../lib/geo';

export type AisClass = 'A' | 'B' | 'ATON' | 'BASE' | 'SART' | 'UNKNOWN';

export interface TrackPoint {
	lat: number;
	lon: number;
	t: number;
}

export interface Vessel {
	id: string; // SignalK-Kontext
	mmsi: string;
	name: string;
	callsign: string;
	shipType: number | null;
	shipTypeName: string;
	length: number | null;
	beam: number | null;
	aisClass: AisClass;
	navState: string;
	destination: string;
	pos: LatLon | null;
	posT: number;
	cog: number | null;
	sog: number | null;
	hdg: number | null;
	rot: number | null;
	track: TrackPoint[];
	lastT: number;
	sim?: boolean;
}

export interface OwnShip {
	mmsi: string;
	name: string;
	pos: LatLon | null;
	posT: number;
	cog: number | null;
	sog: number | null;
	hdg: number | null;
	hdgT: number;
	rot: number | null;
	stw: number | null;
	variation: number | null;
	/** Tiefe (m) nach Rangfolge unter Kiel > unter Geber > unter Oberfläche; null = keine Daten */
	depth: number | null;
	depthKeel: boolean;
	depthT: number;
	/** Rang der aktuellen Tiefenquelle (0 = Kiel, 1 = Geber, 2 = Oberfläche) */
	depthRank: number;
	length: number;
	beam: number;
}

export const own: OwnShip = {
	mmsi: '',
	name: 'SUKI',
	pos: null,
	posT: 0,
	cog: null,
	sog: null,
	hdg: null,
	hdgT: 0,
	rot: null,
	stw: null,
	variation: null,
	depth: null,
	depthKeel: false,
	depthT: 0,
	depthRank: 9,
	length: 14.3,
	beam: 8.2
};

export const vessels = new Map<string, Vessel>();

/** Instrumentendaten des Eigenschiffs (Rohwerte SI) nach SignalK-Pfad */
export const inst: Record<string, { v: number; t: number }> = {};

export const sk = $state({ connected: false, lastMsg: 0, selfId: '', version: 0, error: '' });

const TRACK_MAX_AGE = 30 * 60 * 1000;
const TRACK_MIN_DT = 10 * 1000;

let selfCtx = '';
let ws: WebSocket | null = null;
let retry = 0;
let magHdg: number | null = null;

function vessel(ctx: string): Vessel {
	let v = vessels.get(ctx);
	if (!v) {
		const mmsi = (ctx.match(/mmsi:(\d+)/) ?? [])[1] ?? '';
		v = {
			id: ctx,
			mmsi,
			name: '',
			callsign: '',
			shipType: null,
			shipTypeName: '',
			length: null,
			beam: null,
			aisClass: ctx.startsWith('atons.') ? 'ATON' : classFromMmsi(mmsi),
			navState: '',
			destination: '',
			pos: null,
			posT: 0,
			cog: null,
			sog: null,
			hdg: null,
			rot: null,
			track: [],
			lastT: 0
		};
		vessels.set(ctx, v);
	}
	return v;
}

export function classFromMmsi(mmsi: string): AisClass {
	if (/^97[024]/.test(mmsi)) return 'SART';
	if (/^99/.test(mmsi)) return 'ATON';
	if (/^00/.test(mmsi)) return 'BASE';
	return 'UNKNOWN';
}

const isSelf = (ctx: string) => ctx === 'vessels.self' || (selfCtx !== '' && ctx === selfCtx);

function num(v: unknown): number | null {
	return typeof v === 'number' && isFinite(v) ? v : null;
}

function applyOwn(path: string, value: any, t: number) {
	switch (path) {
		case 'navigation.position':
			if (value && num(value.latitude) != null && num(value.longitude) != null) {
				own.pos = { lat: value.latitude, lon: value.longitude };
				own.posT = t;
			}
			break;
		case 'navigation.courseOverGroundTrue':
			own.cog = num(value);
			break;
		case 'navigation.speedOverGround':
			own.sog = num(value);
			break;
		case 'navigation.headingTrue':
			if (num(value) != null) {
				own.hdg = value;
				own.hdgT = t;
			}
			break;
		case 'navigation.headingMagnetic':
			magHdg = num(value);
			// nur als Ersatz, wenn kein headingTrue kommt
			if (magHdg != null && Date.now() - own.hdgT > 3000) {
				own.hdg = magHdg + (own.variation ?? 0);
				own.hdgT = t - 2500;
			}
			break;
		case 'navigation.magneticVariation':
			own.variation = num(value);
			break;
		case 'navigation.rateOfTurn':
			own.rot = num(value);
			break;
		case 'navigation.speedThroughWater':
			own.stw = num(value);
			break;
		case 'environment.depth.belowKeel':
		case 'environment.depth.belowTransducer':
		case 'environment.depth.belowSurface': {
			// bessere Quelle gewinnt; schlechtere nur, wenn die bessere 10 s schweigt
			const rank = path.endsWith('belowKeel') ? 0 : path.endsWith('belowTransducer') ? 1 : 2;
			if (num(value) != null && (rank <= own.depthRank || t - own.depthT > 10000)) {
				own.depth = value;
				own.depthKeel = rank === 0;
				own.depthRank = rank;
				own.depthT = t;
			}
			break;
		}
		case 'environment.wind.speedApparent':
		case 'environment.wind.angleApparent':
		case 'environment.wind.speedTrue':
		case 'environment.wind.angleTrueWater':
		case 'environment.wind.directionTrue':
		case 'environment.water.temperature':
		case 'environment.outside.temperature':
		case 'environment.outside.pressure':
		case 'steering.rudderAngle':
		case 'navigation.log':
		case 'navigation.trip.log':
		case 'performance.velocityMadeGood':
			if (num(value) != null) inst[path] = { v: value, t };
			break;
		case 'navigation.attitude':
			if (value && num(value.roll) != null) inst['navigation.attitude.roll'] = { v: value.roll, t };
			break;
		case 'name':
			if (typeof value === 'string') own.name = value;
			break;
		case 'mmsi':
			if (typeof value === 'string') own.mmsi = value;
			break;
		case 'design.length':
			if (value && num(value.overall)) own.length = value.overall;
			break;
		case 'design.beam':
			if (num(value)) own.beam = value;
			break;
	}
}

function applyTarget(v: Vessel, path: string, value: any, t: number) {
	v.lastT = Math.max(v.lastT, t);
	switch (path) {
		case '':
			if (value && typeof value === 'object') {
				if (typeof value.name === 'string') v.name = value.name.trim();
				if (typeof value.mmsi === 'string') v.mmsi = value.mmsi;
				if (value.communication?.callsignVhf) v.callsign = value.communication.callsignVhf;
			}
			break;
		case 'name':
			if (typeof value === 'string') v.name = value.trim();
			break;
		case 'mmsi':
			if (typeof value === 'string') v.mmsi = value;
			break;
		case 'communication.callsignVhf':
			if (typeof value === 'string') v.callsign = value;
			break;
		case 'navigation.position':
			if (value && num(value.latitude) != null && num(value.longitude) != null) {
				v.pos = { lat: value.latitude, lon: value.longitude };
				v.posT = t;
				const last = v.track[v.track.length - 1];
				if (!last || t - last.t > TRACK_MIN_DT) v.track.push({ lat: value.latitude, lon: value.longitude, t });
				while (v.track.length && t - v.track[0].t > TRACK_MAX_AGE) v.track.shift();
			}
			break;
		case 'navigation.courseOverGroundTrue':
			v.cog = num(value);
			break;
		case 'navigation.speedOverGround':
			v.sog = num(value);
			break;
		case 'navigation.headingTrue':
			v.hdg = num(value);
			break;
		case 'navigation.rateOfTurn':
			v.rot = num(value);
			break;
		case 'navigation.state':
			if (typeof value === 'string') v.navState = value;
			break;
		case 'navigation.destination.commonName':
			if (typeof value === 'string') v.destination = value;
			break;
		case 'design.aisShipType':
			if (value) {
				v.shipType = num(value.id);
				v.shipTypeName = value.name ?? '';
			}
			break;
		case 'design.length':
			if (value) v.length = num(value.overall);
			break;
		case 'design.beam':
			v.beam = num(value);
			break;
		case 'sensors.ais.class':
			if (value === 'A' || value === 'B') v.aisClass = value;
			else if (value === 'BASE') v.aisClass = 'BASE';
			else if (value === 'ATON') v.aisClass = 'ATON';
			break;
		case 'atonType':
			v.aisClass = 'ATON';
			if (value?.name) v.shipTypeName = value.name;
			break;
	}
	if (v.aisClass === 'UNKNOWN' && v.mmsi) {
		const c = classFromMmsi(v.mmsi);
		if (c !== 'UNKNOWN') v.aisClass = c;
	}
}

/** Uhrzeitversatz Server − Browser (aus der Begrüßung), damit Zeitstempel vergleichbar sind */
let clockOffset = 0;

export function applyDelta(msg: any) {
	if (msg.self && typeof msg.self === 'string') {
		selfCtx = msg.self.startsWith('vessels.') ? msg.self : 'vessels.' + msg.self;
		sk.selfId = selfCtx;
		const st = Date.parse(msg.timestamp ?? '');
		if (st) clockOffset = st - Date.now();
		return;
	}
	const ctx: string = msg.context ?? 'vessels.self';
	if (!msg.updates) return;
	const self = isSelf(ctx);
	if (!self && !ctx.startsWith('vessels.') && !ctx.startsWith('atons.')) return;
	const now = Date.now();
	for (const u of msg.updates) {
		// Zeit aus SignalK (auf Browserzeit umgerechnet): zwischengespeicherte Altwerte beim Verbinden
		// bleiben so alt, wie sie sind – sonst erschienen stundenalte AIS-Positionen als aktuell
		const ts = Date.parse(u.timestamp ?? '');
		const t = ts ? Math.min(ts - clockOffset, now) : now;
		for (const pv of u.values ?? []) {
			if (self) applyOwn(pv.path, pv.value, t);
			else applyTarget(vessel(ctx), pv.path, pv.value, t);
		}
	}
	sk.lastMsg = Date.now();
}

const SUB_PATHS = [
	'navigation.position',
	'navigation.courseOverGroundTrue',
	'navigation.speedOverGround',
	'navigation.headingTrue',
	'navigation.headingMagnetic',
	'navigation.magneticVariation',
	'navigation.rateOfTurn',
	'navigation.speedThroughWater',
	'navigation.state',
	'navigation.destination.commonName',
	'name',
	'mmsi',
	'communication.callsignVhf',
	'design.aisShipType',
	'design.length',
	'design.beam',
	'sensors.ais.class',
	'atonType',
	'environment.depth.belowKeel',
	'environment.depth.belowTransducer',
	'environment.depth.belowSurface',
	'environment.wind.speedApparent',
	'environment.wind.angleApparent',
	'environment.wind.speedTrue',
	'environment.wind.angleTrueWater',
	'environment.wind.directionTrue',
	'environment.water.temperature',
	'environment.outside.temperature',
	'environment.outside.pressure',
	'steering.rudderAngle',
	'navigation.attitude',
	'navigation.log',
	'navigation.trip.log',
	'performance.velocityMadeGood',
	''
];

let lastRx = 0;
let connectStart = 0;
let watchdog: ReturnType<typeof setInterval> | undefined;

/**
 * Verbindung verwerfen und sofort neu aufbauen. Nötig, weil iPad/Safari nach Hintergrund oder Display-aus
 * Verbindungen oft „tot“ lässt, ohne close zu melden – die App würde sonst ewig auf Daten warten.
 */
export function reconnectSignalK() {
	const old = ws;
	ws = null;
	sk.connected = false;
	if (old) {
		old.onopen = old.onmessage = old.onerror = old.onclose = null;
		try {
			old.close();
		} catch {
			/* ignore */
		}
	}
	connectSignalK();
}

/** Sekunden seit der letzten Nachricht von SignalK */
export const signalKSilence = () => (lastRx ? (Date.now() - lastRx) / 1000 : Infinity);

export function connectSignalK() {
	// Wächter: 15 s keine Nachricht (SignalK sendet sonst mehrmals pro Sekunde) → neu verbinden
	watchdog ??= setInterval(() => {
		const s = ws;
		if (!s) return;
		if (s.readyState === WebSocket.OPEN && Date.now() - lastRx > 15000) reconnectSignalK();
		else if (s.readyState === WebSocket.CONNECTING && Date.now() - connectStart > 15000) reconnectSignalK();
	}, 5000);
	connectStart = Date.now();
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	const sock = new WebSocket(`${proto}://${location.host}/signalk/v1/stream?subscribe=none&sendCachedValues=true`);
	ws = sock;
	sock.onopen = () => {
		retry = 0;
		lastRx = Date.now();
		sk.connected = true;
		sk.error = '';
		const sub = (context: string) =>
			sock.send(JSON.stringify({ context, subscribe: SUB_PATHS.map((path) => ({ path, policy: 'instant', minPeriod: 200 })) }));
		// sendCachedValues=true: SignalK schickt auf jedes Abo sofort alle bekannten Werte (Namen, Schiffsdaten)
		sub('vessels.self');
		sub('vessels.*');
		sub('atons.*');
	};
	sock.onmessage = (e) => {
		lastRx = Date.now();
		try {
			applyDelta(JSON.parse(e.data));
		} catch {
			/* kaputte Nachricht */
		}
	};
	sock.onclose = () => {
		if (ws !== sock) return; // ersetzt
		sk.connected = false;
		ws = null;
		setTimeout(connectSignalK, Math.min(10000, 1000 * 2 ** retry++));
	};
	sock.onerror = () => {
		sk.error = 'SignalK not reachable';
	};
}

/** Alte Ziele entfernen (nach 20 min ohne Position) */
export function pruneVessels(now = Date.now()) {
	for (const [k, v] of vessels) if (!v.sim && now - Math.max(v.posT, v.lastT) > 20 * 60 * 1000) vessels.delete(k);
}

export const ownHeading = () => (own.hdg ?? own.cog ?? null);
export const ownFresh = () => own.pos != null && Date.now() - own.posT < 15000;
