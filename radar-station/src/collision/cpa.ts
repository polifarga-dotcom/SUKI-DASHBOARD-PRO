// Kollisionsrechnung in der lokalen Ebene (Ost/Nord, m) um das eigene Schiff.
import { D2R, normPi, norm2pi, velocity } from '../lib/geo';

export interface Motion {
	course: number | null; // rad true
	speed: number | null; // m/s
}

export interface Encounter {
	cpa: number; // m
	tcpa: number; // s (negativ = bereits vorbei)
	/** Position des Ziels relativ zu uns im CPA (m) */
	cpaX: number;
	cpaY: number;
	/** Bow Crossing Range (m): + = Ziel kreuzt vor dem Bug, − = achteraus; null = kreuzt nicht */
	bcr: number | null;
	bct: number | null; // s bis zur Kreuzung unserer Kurslinie
	closing: boolean;
}

export type Situation = 'head-on' | 'crossing-give-way' | 'crossing-stand-on' | 'overtaking' | 'overtaken' | 'none';

const vel = (m: Motion): [number, number] => (m.course == null || m.speed == null ? [0, 0] : velocity(m.course, m.speed));

/**
 * @param px,py Zielposition relativ zu uns (m, Ost/Nord)
 */
export function encounter(px: number, py: number, own: Motion, tgt: Motion): Encounter {
	const [ox, oy] = vel(own);
	const [tx, ty] = vel(tgt);
	const vx = tx - ox;
	const vy = ty - oy;
	const v2 = vx * vx + vy * vy;
	let tcpa = 0;
	if (v2 > 1e-6) tcpa = -(px * vx + py * vy) / v2;
	const cx = px + vx * tcpa;
	const cy = py + vy * tcpa;
	const cpa = v2 > 1e-6 ? Math.hypot(cx, cy) : Math.hypot(px, py);

	// Bow crossing: wann liegt das Ziel (relativ) auf unserer Kurslinie?
	let bcr: number | null = null;
	let bct: number | null = null;
	const sOwn = own.speed ?? 0;
	if (own.course != null && sOwn > 0.25) {
		const ux = Math.sin(own.course);
		const uy = Math.cos(own.course);
		const nx = uy; // Normale (Steuerbord)
		const ny = -ux;
		const vn = vx * nx + vy * ny;
		const pn = px * nx + py * ny;
		if (Math.abs(vn) > 1e-3) {
			const t = -pn / vn;
			if (t > 0) {
				bct = t;
				bcr = (px + vx * t) * ux + (py + vy * t) * uy;
			}
		}
	}
	return { cpa, tcpa: v2 > 1e-6 ? tcpa : Infinity, cpaX: cx, cpaY: cy, bcr, bct, closing: tcpa > 0 };
}

/**
 * Begegnungslage nach KVR/COLREG (Maschinenfahrzeuge, Regeln 13–15) aus unserer Sicht.
 * @param brg wahre Peilung zum Ziel (rad)
 */
export function situation(brg: number, own: Motion, tgt: Motion, enc: Encounter): Situation {
	if (!enc.closing || own.course == null) return 'none';
	const ownSpd = own.speed ?? 0;
	const tgtSpd = tgt.speed ?? 0;
	if (ownSpd < 0.25) return 'none'; // stillliegend (Anker/Hafen): keine Ausweichpflicht-Klassifikation
	const relBrg = norm2pi(brg - own.course); // Peilung des Ziels relativ zu unserem Bug
	// Unsere Peilung vom Ziel aus, relativ zu dessen Kurs
	const tgtCourse = tgt.course ?? 0;
	const relFromTgt = norm2pi(brg + Math.PI - tgtCourse);
	const courseDiff = Math.abs(normPi(tgtCourse - own.course));
	const ABAFT = 112.5 * D2R;

	if (tgtSpd >= 0.25 && courseDiff > (180 - 10) * D2R && (relBrg < 10 * D2R || relBrg > 350 * D2R)) return 'head-on';
	// wir kommen von achterlicher als 22,5° hinter dessen Querab → wir überholen
	if (relFromTgt > ABAFT && relFromTgt < Math.PI * 2 - ABAFT && ownSpd > tgtSpd) return 'overtaking';
	// Ziel kommt von achterlicher als 22,5° hinter unserem Querab → wir werden überholt
	if (relBrg > ABAFT && relBrg < Math.PI * 2 - ABAFT && tgtSpd > ownSpd) return 'overtaken';
	if (relBrg <= ABAFT) return 'crossing-give-way'; // Ziel an Steuerbord
	return 'crossing-stand-on'; // Ziel an Backbord
}

export const SITUATION_LABEL: Record<Situation, string> = {
	'head-on': 'Head-on',
	'crossing-give-way': 'Crossing · give way',
	'crossing-stand-on': 'Crossing · stand on',
	overtaking: 'Overtaking',
	overtaken: 'Being overtaken',
	none: ''
};

export type Danger = 'dangerous' | 'caution' | 'safe';

export function dangerLevel(enc: Encounter, cpaLimit: number, tcpaLimit: number): Danger {
	if (!isFinite(enc.tcpa) || enc.tcpa < 0) return 'safe';
	if (enc.cpa < cpaLimit && enc.tcpa < tcpaLimit) return 'dangerous';
	if (enc.cpa < cpaLimit * 2 && enc.tcpa < tcpaLimit * 1.5) return 'caution';
	return 'safe';
}
