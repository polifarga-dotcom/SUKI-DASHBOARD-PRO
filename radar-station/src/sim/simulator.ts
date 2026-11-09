// Demo-/Testmodus: synthetische AIS-Ziele mit typischen Begegnungen (Alarm- und Darstellungstest).
// Ziele werden relativ zur aktuellen Eigenposition erzeugt; ohne GPS bekommt das Eigenschiff eine Sim-Position.
import { own, vessels, type Vessel } from '../data/signalk.svelte';
import { D2R, KN, NM, fromLocal, toLocal, type LatLon } from '../lib/geo';

interface SimDef {
	mmsi: string;
	name: string;
	cls: Vessel['aisClass'];
	// Startposition relativ zum Bug: Peilung (°, relativ), Distanz (nm); Kurs relativ zu unserem (°), Fahrt (kn)
	relBrg: number;
	dist: number;
	relCourse: number;
	kn: number;
	type: number;
	len: number;
}

const DEFS: SimDef[] = [
	{ mmsi: '211000001', name: 'SIM HEAD-ON', cls: 'A', relBrg: 1, dist: 4, relCourse: 180, kn: 12, type: 70, len: 120 },
	{ mmsi: '211000002', name: 'SIM CROSS STBD', cls: 'A', relBrg: 50, dist: 3, relCourse: -90, kn: 14, type: 80, len: 180 },
	{ mmsi: '211000003', name: 'SIM CROSS PORT', cls: 'B', relBrg: -60, dist: 2, relCourse: 100, kn: 7, type: 36, len: 12 },
	{ mmsi: '211000004', name: 'SIM OVERTAKER', cls: 'A', relBrg: 175, dist: 1.5, relCourse: 2, kn: 16, type: 60, len: 90 },
	{ mmsi: '211000005', name: 'SIM SAFE', cls: 'A', relBrg: -20, dist: 6, relCourse: 0, kn: 5, type: 30, len: 25 },
	{ mmsi: '970000099', name: 'SART TEST', cls: 'SART', relBrg: 120, dist: 2.2, relCourse: 0, kn: 0, type: 0, len: 0 },
	{ mmsi: '992000001', name: 'SIM BUOY', cls: 'ATON', relBrg: 30, dist: 1.2, relCourse: 0, kn: 0, type: 0, len: 0 }
];

let timer: ReturnType<typeof setInterval> | undefined;
let simOwn = false;
const simPos = new Map<string, LatLon>();

export function startSim() {
	stopSim();
	const now = Date.now();
	if (!own.pos || now - own.posT > 15000) {
		simOwn = true;
		own.pos = { lat: 54.18, lon: 10.85 };
		own.posT = now;
		own.hdg = 30 * D2R;
		own.hdgT = now;
		own.cog = 30 * D2R;
		own.sog = 6 * KN;
	}
	const o = own.pos!;
	const hdg = own.hdg ?? own.cog ?? 0;
	for (const d of DEFS) {
		const b = hdg + d.relBrg * D2R;
		const x = Math.sin(b) * d.dist * NM;
		const y = Math.cos(b) * d.dist * NM;
		const id = `vessels.urn:mrn:imo:mmsi:${d.mmsi}`;
		const pos = fromLocal(o, x, y);
		simPos.set(id, pos);
		const course = d.kn ? (hdg + d.relCourse * D2R + Math.PI * 4) % (Math.PI * 2) : null;
		vessels.set(id, {
			id,
			mmsi: d.mmsi,
			name: d.name,
			callsign: 'SIM',
			shipType: d.type || null,
			shipTypeName: '',
			length: d.len || null,
			beam: d.len ? d.len / 6 : null,
			aisClass: d.cls,
			navState: d.kn ? 'motoring' : '',
			destination: 'TEST',
			pos,
			posT: now,
			cog: course,
			sog: d.kn * KN,
			hdg: course,
			rot: 0,
			track: [],
			lastT: now,
			sim: true
		});
	}
	timer = setInterval(step, 1000);
}

function step() {
	const now = Date.now();
	if (simOwn && own.pos && own.cog != null && own.sog != null) {
		own.pos = fromLocal(own.pos, Math.sin(own.cog) * own.sog, Math.cos(own.cog) * own.sog);
		own.posT = now;
		own.hdgT = now;
	}
	for (const v of vessels.values()) {
		if (!v.sim || !v.pos) continue;
		const dt = (now - v.posT) / 1000;
		if (v.cog != null && v.sog) {
			v.pos = fromLocal(v.pos, Math.sin(v.cog) * v.sog * dt, Math.cos(v.cog) * v.sog * dt);
		}
		v.posT = now;
		v.lastT = now;
		const last = v.track[v.track.length - 1];
		if (!last || now - last.t > 10000) v.track.push({ ...v.pos, t: now });
		if (own.pos && Math.hypot(...toLocal(own.pos, v.pos)) > 15 * NM) vessels.delete(v.id);
	}
}

export function stopSim() {
	clearInterval(timer);
	timer = undefined;
	for (const [k, v] of vessels) if (v.sim) vessels.delete(k);
	if (simOwn) {
		own.pos = null;
		own.posT = 0;
		simOwn = false;
	}
}
