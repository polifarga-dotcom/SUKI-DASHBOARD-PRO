// Canvas2D-Overlay über dem Radarbild: Ringe, Kompassrose, Headingline, Eigenschiff, AIS/ARPA, Vektoren,
// Tracks, CPA-Punkte, EBL/VRM, Guard Zones, Marker, Cursor.
import { D2R, bearingOf, fmtDeg, fmtDist, norm2pi, numStr, ringStep, toLocal, NM, KN, dec, type LatLon } from '../lib/geo';
import type { Settings, Theme } from '../lib/settings.svelte';
import type { OwnShip } from '../data/signalk.svelte';
import type { Target } from '../collision/targets.svelte';
import type { Ebl, Marker } from './tools.svelte';
import { toScreen, type View } from './view';
import { squallEncounter, squallPos, squallVel, type Squall } from '../collision/squall';

export interface OverlayInput {
	view: View;
	range: number; // am Radar eingestellte Range (m)
	s: Settings;
	own: OwnShip;
	heading: number | null;
	targets: Target[];
	selected: string | null;
	ebl: Ebl[];
	markers: Marker[];
	squalls: Squall[];
	cursor: LatLon | null;
	guardHit: [boolean, boolean];
	/** Ziele mit aktivem Alarm (true = noch nicht quittiert → pulsiert) */
	alarmKeys: Map<string, boolean>;
	track: [number, number, number][];
	measure: { a: LatLon; b: LatLon | null } | null;
	alignFirst: LatLon | null;
	now: number;
	label: string; // z. B. „A“ im Dual-Range-Modus
}

interface Colors {
	ring: string;
	ringText: string;
	heading: string;
	own: string;
	safe: string;
	caution: string;
	danger: string;
	lost: string;
	aton: string;
	arpa: string;
	text: string;
	textBg: string;
	ebl: string;
	vrm: string;
	guard: string;
	guardHit: string;
	compass: string;
	track: string;
	mark: string;
	ownTrack: string;
	ownFill: string;
	guardFill: string;
	guardFillHit: string;
}

const COLORS: Record<Theme, Colors> = {
	day: {
		ring: 'rgba(160,200,230,.32)',
		ringText: 'rgba(200,225,245,.85)',
		heading: 'rgba(255,255,255,.75)',
		own: '#ffffff',
		safe: '#39d98a',
		caution: '#ffb020',
		danger: '#ff3b3b',
		lost: '#9aa4ae',
		aton: '#c084fc',
		arpa: '#4fc3ff',
		text: '#e9f2fa',
		textBg: 'rgba(5,10,18,.62)',
		ebl: '#ffd23f',
		vrm: '#ffd23f',
		guard: 'rgba(255,210,63,.55)',
		guardHit: 'rgba(255,59,59,.9)',
		compass: 'rgba(200,225,245,.7)',
		track: 'rgba(200,225,245,.45)',
		mark: '#ff8a3d',
		ownTrack: '#ff4fd8',
		ownFill: 'rgba(255,255,255,.08)',
		guardFill: 'rgba(255,210,63,.06)',
		guardFillHit: 'rgba(255,59,59,.18)'
	},
	dusk: {
		ring: 'rgba(120,170,210,.28)',
		ringText: 'rgba(170,205,235,.8)',
		heading: 'rgba(230,240,250,.6)',
		own: '#e9f2fa',
		safe: '#2fc77e',
		caution: '#f5a623',
		danger: '#ff4040',
		lost: '#8892a0',
		aton: '#b48cf2',
		arpa: '#43b6f0',
		text: '#d8e6f2',
		textBg: 'rgba(3,7,12,.6)',
		ebl: '#f2c94c',
		vrm: '#f2c94c',
		guard: 'rgba(242,201,76,.45)',
		guardHit: 'rgba(255,64,64,.85)',
		compass: 'rgba(170,205,235,.6)',
		track: 'rgba(170,205,235,.4)',
		mark: '#ff8a3d',
		ownTrack: '#e04bc4',
		ownFill: 'rgba(255,255,255,.06)',
		guardFill: 'rgba(242,201,76,.05)',
		guardFillHit: 'rgba(255,64,64,.18)'
	},
	night: {
		ring: 'rgba(150,30,20,.45)',
		ringText: 'rgba(190,50,35,.85)',
		heading: 'rgba(200,50,35,.7)',
		own: '#d0402c',
		safe: '#a8321f',
		caution: '#d4572a',
		danger: '#ff3b1f',
		lost: '#6a2418',
		aton: '#8f2a1c',
		arpa: '#b23a26',
		text: '#c8442e',
		textBg: 'rgba(0,0,0,.7)',
		ebl: '#d65a32',
		vrm: '#d65a32',
		guard: 'rgba(180,50,30,.5)',
		guardHit: 'rgba(255,59,31,.9)',
		compass: 'rgba(170,45,30,.7)',
		track: 'rgba(150,40,25,.5)',
		mark: '#c84a2a',
		ownTrack: '#8f2a1c',
		ownFill: 'rgba(208,64,44,.10)',
		guardFill: 'rgba(180,50,30,.06)',
		guardFillHit: 'rgba(255,59,31,.20)'
	}
};

export function drawOverlay(ctx: CanvasRenderingContext2D, I: OverlayInput) {
	const { view: v, s } = I;
	const C = COLORS[s.theme];
	const W = v.width;
	const H = v.height;
	ctx.save();
	ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
	ctx.clearRect(0, 0, W, H);
	const R = I.range * v.ppm; // Radius der Range in px
	const font = (px: number, w = 500) => `${w} ${px}px ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif`;

	// ── Range-Ringe ──
	if (s.rings && I.range > 0) {
		const { step, count } = ringStep(I.range);
		ctx.strokeStyle = C.ring;
		ctx.lineWidth = 1;
		ctx.font = font(11);
		ctx.fillStyle = C.ringText;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'bottom';
		for (let i = 1; i <= count; i++) {
			const r = step * i * v.ppm;
			ctx.beginPath();
			ctx.arc(v.cx, v.cy, r, 0, Math.PI * 2);
			ctx.stroke();
			// Beschriftung bei 45° links oben, nicht über der Headingline
			const a = -Math.PI * 0.75;
			ctx.fillText(ringLabel(step * i), v.cx + Math.cos(a) * r + 3, v.cy + Math.sin(a) * r - 2);
		}
	}

	// ── Kompassrose am äußeren Ring ──
	if (s.compass && I.range > 0) {
		ctx.strokeStyle = C.compass;
		ctx.fillStyle = C.compass;
		ctx.font = font(11, 600);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		for (let d = 0; d < 360; d += 5) {
			const a = (d * D2R - v.up) - Math.PI / 2;
			const len = d % 30 === 0 ? 10 : d % 10 === 0 ? 6 : 3;
			const x0 = v.cx + Math.cos(a) * R;
			const y0 = v.cy + Math.sin(a) * R;
			ctx.beginPath();
			ctx.moveTo(x0, y0);
			ctx.lineTo(v.cx + Math.cos(a) * (R - len), v.cy + Math.sin(a) * (R - len));
			ctx.stroke();
			if (d % 30 === 0) {
				const tx = v.cx + Math.cos(a) * (R - 20);
				const ty = v.cy + Math.sin(a) * (R - 20);
				if (tx > 8 && tx < W - 8 && ty > 8 && ty < H - 8) ctx.fillText(d === 0 ? 'N' : String(d).padStart(3, '0'), tx, ty);
			}
		}
	}

	// ── Guard Zones (relativ zum Bug) ──
	const hdg = I.heading ?? 0;
	for (let z = 0; z < 2; z++) {
		const g = s.guard[z];
		if (!g.enabled) continue;
		const full = Math.abs(norm2pi(g.end - g.start)) < 1e-6;
		const a0 = hdg + g.start - v.up - Math.PI / 2;
		const a1 = full ? a0 + Math.PI * 2 : hdg + g.end - v.up - Math.PI / 2;
		const end = full ? a1 : a0 + norm2pi(g.end - g.start);
		ctx.beginPath();
		ctx.arc(v.cx, v.cy, g.outer * v.ppm, a0, end);
		ctx.arc(v.cx, v.cy, g.inner * v.ppm, end, a0, true);
		ctx.closePath();
		const hit = I.guardHit[z];
		ctx.fillStyle = hit && Math.floor(I.now / 400) % 2 ? C.guardFillHit : C.guardFill;
		ctx.fill();
		ctx.setLineDash([6, 4]);
		ctx.strokeStyle = hit ? C.guardHit : C.guard;
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.setLineDash([]);
	}

	// ── Headingline + eigener COG-Vektor ──
	if (s.headingLine && I.heading != null) {
		const a = I.heading - v.up - Math.PI / 2;
		ctx.strokeStyle = C.heading;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(v.cx, v.cy);
		const far = Math.hypot(W, H) * 1.5;
		ctx.lineTo(v.cx + Math.cos(a) * far, v.cy + Math.sin(a) * far);
		ctx.stroke();
	}
	const own = I.own;
	if (own.cog != null && own.sog != null && own.sog > 0.3 && s.vectorMode === 'true') {
		const L = own.sog * s.aisVectorMin * 60;
		const [ex, ey] = toScreen(v, Math.sin(own.cog) * L, Math.cos(own.cog) * L);
		ctx.strokeStyle = C.own;
		ctx.lineWidth = 2;
		ctx.setLineDash([8, 5]);
		ctx.beginPath();
		ctx.moveTo(v.cx, v.cy);
		ctx.lineTo(ex, ey);
		ctx.stroke();
		ctx.setLineDash([]);
	}

	// ── Kielspur ──
	if (own.pos && I.track.length > 1) {
		ctx.strokeStyle = C.ownTrack;
		ctx.lineWidth = 2;
		ctx.lineJoin = 'round';
		ctx.beginPath();
		// Punkte, die weniger als 3 px vom zuletzt gezeichneten liegen, auslassen (lange Spuren bleiben billig)
		let px = NaN;
		let py = NaN;
		for (let i = 0; i < I.track.length; i++) {
			const [, lat, lon] = I.track[i];
			const [sx, sy] = toScreen(v, ...toLocal(own.pos!, { lat, lon }));
			if (i && i < I.track.length - 1 && Math.abs(sx - px) < 3 && Math.abs(sy - py) < 3) continue;
			i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
			px = sx;
			py = sy;
		}
		ctx.lineTo(v.cx, v.cy);
		ctx.stroke();
	}

	// ── Marker / MOB ──
	if (own.pos) {
		for (const m of I.markers) {
			if (m.kind !== 'mob') continue;
			const [x, y] = toLocal(own.pos, m.pos);
			const [sx, sy] = toScreen(v, x, y);
			ctx.strokeStyle = C.danger;
			ctx.lineWidth = 2;
			ctx.setLineDash([8, 6]);
			ctx.beginPath();
			ctx.moveTo(v.cx, v.cy);
			ctx.lineTo(sx, sy);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		for (const m of I.markers) {
			const [x, y] = toLocal(own.pos, m.pos);
			const [sx, sy] = toScreen(v, x, y);
			if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
			ctx.strokeStyle = m.kind === 'mob' ? C.danger : C.mark;
			ctx.lineWidth = 2;
			ctx.beginPath();
			if (m.kind === 'mob') {
				ctx.arc(sx, sy, 9, 0, Math.PI * 2);
				ctx.moveTo(sx - 6, sy - 6);
				ctx.lineTo(sx + 6, sy + 6);
				ctx.moveTo(sx + 6, sy - 6);
				ctx.lineTo(sx - 6, sy + 6);
			} else {
				ctx.moveTo(sx, sy - 9);
				ctx.lineTo(sx + 7, sy);
				ctx.lineTo(sx, sy + 9);
				ctx.lineTo(sx - 7, sy);
				ctx.closePath();
			}
			ctx.stroke();
			label(ctx, C, font(11, 600), m.label, sx + 11, sy - 11);
		}
	}

	// ── Squalls: vermutete Position, frühere Markierungen, Zugvektor, Eintreffen ──
	if (own.pos)
		I.squalls.forEach((sq, i) => {
			const [x, y] = toLocal(own.pos!, squallPos(sq, I.now));
			const [sx, sy] = toScreen(v, x, y);
			ctx.strokeStyle = C.caution;
			ctx.fillStyle = C.caution;
			ctx.lineWidth = 2;
			for (const f of sq.fixes) {
				const [fx, fy] = toScreen(v, ...toLocal(own.pos!, f.pos));
				ctx.fillRect(fx - 2, fy - 2, 4, 4);
			}
			ctx.setLineDash([5, 4]);
			ctx.beginPath();
			ctx.arc(sx, sy, 16, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
			const vel = squallVel(sq);
			let txt = `SQ${i + 1}`;
			if (vel) {
				const T = I.s.aisVectorMin * 60;
				const [ex, ey] = toScreen(v, x + vel[0] * T, y + vel[1] * T);
				ctx.beginPath();
				ctx.moveTo(sx, sy);
				ctx.lineTo(ex, ey);
				ctx.stroke();
				txt += ` ${dec(Math.hypot(vel[0], vel[1]) / KN, 0)} kn`;
				const e = squallEncounter(sq, own.pos!, { course: own.cog, speed: own.sog }, I.now);
				if (e && e.tcpa > 0 && e.tcpa < 3 * 3600) txt += ` · ${fmtDist(e.cpa)} / ${Math.round(e.tcpa / 60)} min`;
			} else txt += ' ?';
			label(ctx, C, font(11, 700), txt, sx + 18, sy - 14);
		});

	// ── Ziele ──
	// platzierte Namensschilder in einem 64-px-Raster: nur Nachbarzellen prüfen (bei ~500 AIS-Zielen wichtig)
	const CELL = 64;
	const grid = new Map<number, [number, number, number, number][]>();
	const cellKey = (cx: number, cy: number) => cx * 4096 + cy;
	const order = [...I.targets].sort((a, b) => rank(b) - rank(a)); // gefährliche zuletzt = oben
	const labelsFirst = [...order].reverse();
	const pts = new Map<string, [number, number]>();
	const dt = (I.now - (I.targets[0]?.t ?? I.now)) / 1000;
	for (const t of order) {
		// zwischen den 2-Hz-Berechnungen flüssig weiterbewegen (Relativbewegung)
		let x = t.x;
		let y = t.y;
		if (t.cog != null && t.sog != null && t.sog > 0.26) {
			x += Math.sin(t.cog) * t.sog * dt;
			y += Math.cos(t.cog) * t.sog * dt;
		}
		if (own.cog != null && own.sog != null && own.sog > 0.26) {
			x -= Math.sin(own.cog) * own.sog * dt;
			y -= Math.cos(own.cog) * own.sog * dt;
		}
		const [sx, sy] = toScreen(v, x, y);
		if (sx < -60 || sy < -60 || sx > W + 60 || sy > H + 60) continue;
		pts.set(t.key, [sx, sy]);
		const col = t.lost ? C.lost : t.danger === 'dangerous' ? C.danger : t.danger === 'caution' ? C.caution : t.kind === 'arpa' ? C.arpa : t.aisClass === 'ATON' ? C.aton : C.safe;
		const flash = t.danger === 'dangerous' && !t.lost && Math.floor(I.now / 500) % 2 === 0;

		// Past-Track
		if (own.pos && t.kind === 'ais' && t.vessel && s.aisTrackMin > 0 && t.vessel.track.length > 1) {
			const since = I.now - s.aisTrackMin * 60000;
			ctx.fillStyle = C.track;
			for (const p of t.vessel.track) {
				if (p.t < since) continue;
				const [tx, ty] = toLocal(own.pos, p);
				const [px, py] = toScreen(v, tx, ty);
				ctx.fillRect(px - 1, py - 1, 2, 2);
			}
		} else if (own.pos && t.kind === 'arpa' && t.arpa?.track && t.arpa.track.length > 1) {
			ctx.fillStyle = C.track;
			for (const p of t.arpa.track) {
				const [tx, ty] = toLocal(own.pos, p);
				const [px, py] = toScreen(v, tx, ty);
				ctx.fillRect(px - 1, py - 1, 2, 2);
			}
		}

		// Vektor
		if (t.cog != null && t.sog != null && t.sog > 0.25 && !t.lost) {
			const L = s.aisVectorMin * 60;
			let vx = Math.sin(t.cog) * t.sog;
			let vy = Math.cos(t.cog) * t.sog;
			if (s.vectorMode === 'relative' && own.cog != null && own.sog != null) {
				vx -= Math.sin(own.cog) * own.sog;
				vy -= Math.cos(own.cog) * own.sog;
			}
			const [ex, ey] = toScreen(v, x + vx * L, y + vy * L);
			ctx.strokeStyle = col;
			ctx.lineWidth = t.danger === 'dangerous' ? 2 : 1.3;
			ctx.beginPath();
			ctx.moveTo(sx, sy);
			ctx.lineTo(ex, ey);
			ctx.stroke();
		}

		// CPA-Punkte (nur gefährlich/Vorsicht/ausgewählt, zukünftig)
		if (t.enc && t.enc.tcpa > 0 && isFinite(t.enc.tcpa) && (t.danger !== 'safe' || t.key === I.selected) && own.cog != null && own.sog != null) {
			const tc = t.enc.tcpa;
			// gleiche Schwelle wie in der CPA-Rechnung: unter ~0,5 kn gilt das Eigenschiff als stillstehend
			const sp = own.sog > 0.26 ? own.sog : 0;
			const ox = Math.sin(own.cog) * sp * tc;
			const oy = Math.cos(own.cog) * sp * tc;
			const [ax, ay] = toScreen(v, ox, oy);
			const [bx, by] = toScreen(v, ox + t.enc.cpaX, oy + t.enc.cpaY);
			ctx.strokeStyle = col;
			ctx.setLineDash([3, 3]);
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(ax, ay);
			ctx.lineTo(bx, by);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = col;
			ctx.beginPath();
			ctx.arc(bx, by, 3, 0, Math.PI * 2);
			ctx.fill();
			ctx.strokeRect(ax - 3, ay - 3, 6, 6);
		}

		drawSymbol(ctx, v, t, sx, sy, col, flash, C);

		// Alarmziel: Ring, pulsiert bis zur Quittierung
		const al = I.alarmKeys.get(t.key);
		if (al !== undefined) {
			const ph = (I.now % 1000) / 1000;
			ctx.strokeStyle = C.danger;
			ctx.lineWidth = 2.5;
			ctx.globalAlpha = al ? 1 - ph * 0.7 : 0.8;
			ctx.beginPath();
			ctx.arc(sx, sy, al ? 20 + ph * 12 : 20, 0, Math.PI * 2);
			ctx.stroke();
			ctx.globalAlpha = 1;
		}

		if (t.key === I.selected) {
			ctx.strokeStyle = C.text;
			ctx.lineWidth = 1.5;
			const k = 15;
			const q = 6;
			for (const [dx, dy] of [
				[-1, -1],
				[1, -1],
				[1, 1],
				[-1, 1]
			]) {
				ctx.beginPath();
				ctx.moveTo(sx + dx * k, sy + dy * (k - q));
				ctx.lineTo(sx + dx * k, sy + dy * k);
				ctx.lineTo(sx + dx * (k - q), sy + dy * k);
				ctx.stroke();
			}
		}
	}

	// Namen mit Überlappungsunterdrückung (Gefährliche und Nahe zuerst)
	if (s.aisNames) {
		ctx.font = font(11, 600);
		for (const t of labelsFirst) {
			const p = pts.get(t.key);
			if (!p) continue;
			const txt = t.radarMatch != null ? `${t.label} ◦` : t.label;
			const w = ctx.measureText(txt).width + 6;
			const bx = p[0] + 12;
			const by = p[1] - 18;
			const c0 = Math.floor(bx / CELL);
			const c1 = Math.floor((bx + w) / CELL);
			const r0 = Math.floor(by / CELL);
			const r1 = Math.floor((by + 15) / CELL);
			let hit = false;
			for (let cx = c0; cx <= c1 && !hit; cx++)
				for (let cy = r0; cy <= r1 && !hit; cy++)
					hit = !!grid.get(cellKey(cx, cy))?.some(([x, y, ww, hh]) => bx < x + ww && bx + w > x && by < y + hh && by + 15 > y);
			if (hit) continue;
			const box: [number, number, number, number] = [bx, by, w, 15];
			for (let cx = c0; cx <= c1; cx++)
				for (let cy = r0; cy <= r1; cy++) {
					const k = cellKey(cx, cy);
					const arr = grid.get(k);
					if (arr) arr.push(box);
					else grid.set(k, [box]);
				}
			label(ctx, C, ctx.font, txt, bx, by + 12, t.danger === 'dangerous' ? C.danger : undefined);
		}
	}

	// ── EBL / VRM ──
	ctx.font = font(11, 700);
	I.ebl.forEach((e, i) => {
		if (!e.on) return;
		const brg = e.relative ? hdg + e.brg : e.brg;
		const a = brg - v.up - Math.PI / 2;
		ctx.strokeStyle = C.ebl;
		ctx.lineWidth = 1.5;
		ctx.setLineDash(i === 0 ? [10, 6] : [3, 5]);
		ctx.beginPath();
		ctx.moveTo(v.cx, v.cy);
		const far = Math.hypot(W, H) * 1.5;
		ctx.lineTo(v.cx + Math.cos(a) * far, v.cy + Math.sin(a) * far);
		ctx.stroke();
		if (e.vrm > 0) {
			ctx.strokeStyle = C.vrm;
			ctx.beginPath();
			ctx.arc(v.cx, v.cy, e.vrm * v.ppm, 0, Math.PI * 2);
			ctx.stroke();
			const lx = v.cx + Math.cos(a) * e.vrm * v.ppm;
			const ly = v.cy + Math.sin(a) * e.vrm * v.ppm;
			ctx.setLineDash([]);
			label(ctx, C, ctx.font, `${i + 1}`, lx + 6, ly - 6, C.ebl);
		}
		ctx.setLineDash([]);
	});

	// ── Eigenschiff (maßstäblich ab großem Zoom, sonst Symbol) ──
	const hd = I.heading ?? own.cog ?? 0;
	const lenPx = own.length * v.ppm;
	ctx.save();
	ctx.translate(v.cx, v.cy);
	ctx.rotate(hd - v.up);
	ctx.strokeStyle = C.own;
	ctx.fillStyle = C.ownFill;
	ctx.lineWidth = 2;
	if (lenPx > 26) {
		// Trimaran-Umriss (Neel 47): Haupt- + Schwimmer
		const L = lenPx;
		const B = own.beam * v.ppm;
		ctx.beginPath();
		ctx.moveTo(0, -L / 2);
		ctx.quadraticCurveTo(L * 0.09, -L * 0.15, L * 0.08, L / 2);
		ctx.lineTo(-L * 0.08, L / 2);
		ctx.quadraticCurveTo(-L * 0.09, -L * 0.15, 0, -L / 2);
		ctx.fill();
		ctx.stroke();
		for (const sgn of [-1, 1]) {
			ctx.beginPath();
			ctx.ellipse((sgn * B) / 2 - sgn * B * 0.04, L * 0.05, B * 0.05, L * 0.38, 0, 0, Math.PI * 2);
			ctx.stroke();
		}
	} else {
		ctx.beginPath();
		ctx.moveTo(0, -13);
		ctx.lineTo(8, 9);
		ctx.lineTo(0, 5);
		ctx.lineTo(-8, 9);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
	}
	ctx.restore();

	// ── Messstrecke ──
	if (own.pos && I.measure) {
		const pa = toScreen(v, ...toLocal(own.pos, I.measure.a));
		ctx.strokeStyle = C.ebl;
		ctx.fillStyle = C.ebl;
		ctx.lineWidth = 2;
		if (I.measure.b) {
			const pb = toScreen(v, ...toLocal(own.pos, I.measure.b));
			ctx.setLineDash([10, 5]);
			ctx.beginPath();
			ctx.moveTo(pa[0], pa[1]);
			ctx.lineTo(pb[0], pb[1]);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.beginPath();
			ctx.arc(pb[0], pb[1], 4, 0, Math.PI * 2);
			ctx.fill();
			const [dx, dy] = toLocal(I.measure.a, I.measure.b);
			label(ctx, C, font(12, 700), `${fmtDeg(bearingOf(dx, dy))}T · ${fmtDist(Math.hypot(dx, dy))}`, (pa[0] + pb[0]) / 2 + 8, (pa[1] + pb[1]) / 2 - 8, C.ebl);
		}
		ctx.beginPath();
		ctx.arc(pa[0], pa[1], 4, 0, Math.PI * 2);
		ctx.fill();
	}

	// ── Ausrichten: erster Punkt ──
	if (own.pos && I.alignFirst) {
		const [ax, ay] = toScreen(v, ...toLocal(own.pos, I.alignFirst));
		ctx.strokeStyle = C.ebl;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(ax, ay, 12, 0, Math.PI * 2);
		ctx.moveTo(ax - 18, ay);
		ctx.lineTo(ax + 18, ay);
		ctx.moveTo(ax, ay - 18);
		ctx.lineTo(ax, ay + 18);
		ctx.stroke();
	}

	// ── Maßstabsleiste ──
	{
		const target = 110 / v.ppm; // m für ca. 110 px
		const nice = (m: number) => {
			if (m >= 0.2 * NM) {
				const nm = m / NM;
				const p = 10 ** Math.floor(Math.log10(nm));
				const f = nm / p;
				return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p * NM;
			}
			const p = 10 ** Math.floor(Math.log10(m));
			const f = m / p;
			return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
		};
		const len = nice(target);
		const px = len * v.ppm;
		const x0 = W / 2 - px / 2;
		const y0 = H - 22;
		ctx.strokeStyle = C.ringText;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(x0, y0 - 5);
		ctx.lineTo(x0, y0);
		ctx.lineTo(x0 + px, y0);
		ctx.lineTo(x0 + px, y0 - 5);
		ctx.stroke();
		ctx.font = font(11, 600);
		ctx.fillStyle = C.ringText;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'bottom';
		ctx.fillText(fmtDist(len), W / 2, y0 - 3);
	}

	// ── Cursor ──
	if (I.cursor && own.pos) {
		const [sx, sy] = toScreen(v, ...toLocal(own.pos, I.cursor));
		ctx.strokeStyle = C.text;
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.moveTo(sx - 14, sy);
		ctx.lineTo(sx - 4, sy);
		ctx.moveTo(sx + 4, sy);
		ctx.lineTo(sx + 14, sy);
		ctx.moveTo(sx, sy - 14);
		ctx.lineTo(sx, sy - 4);
		ctx.moveTo(sx, sy + 4);
		ctx.lineTo(sx, sy + 14);
		ctx.stroke();
	}

	ctx.restore();
}

function ringLabel(m: number) {
	const nm = m / NM;
	if (nm < 0.25) return `${Math.round(m)} m`;
	return numStr(+nm.toFixed(nm < 1 ? 3 : 2));
}

function rank(t: Target) {
	return t.danger === 'dangerous' ? 0 : t.danger === 'caution' ? 1 : t.lost ? 3 : 2;
}

function label(ctx: CanvasRenderingContext2D, C: Colors, f: string, txt: string, x: number, y: number, color?: string) {
	ctx.font = f;
	const w = ctx.measureText(txt).width;
	ctx.fillStyle = C.textBg;
	ctx.fillRect(x - 3, y - 12, w + 6, 15);
	ctx.fillStyle = color ?? C.text;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';
	ctx.fillText(txt, x, y);
}

function drawSymbol(ctx: CanvasRenderingContext2D, v: View, t: Target, sx: number, sy: number, col: string, flash: boolean, C: Colors) {
	ctx.save();
	ctx.translate(sx, sy);
	ctx.strokeStyle = col;
	ctx.fillStyle = flash ? col : 'rgba(0,0,0,.35)';
	ctx.lineWidth = t.danger === 'dangerous' ? 2.4 : 1.6;
	if (t.kind === 'arpa') {
		ctx.beginPath();
		if (t.arpa?.status === 'acquiring') ctx.setLineDash([3, 3]);
		ctx.arc(0, 0, 8, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.setLineDash([]);
		if (t.lost) cross(ctx, 8);
		ctx.restore();
		return;
	}
	switch (t.aisClass) {
		case 'SART': {
			ctx.beginPath();
			ctx.arc(0, 0, 10, 0, Math.PI * 2);
			ctx.stroke();
			cross(ctx, 7);
			break;
		}
		case 'ATON': {
			ctx.beginPath();
			ctx.moveTo(0, -9);
			ctx.lineTo(9, 0);
			ctx.lineTo(0, 9);
			ctx.lineTo(-9, 0);
			ctx.closePath();
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(0, 0, 2, 0, Math.PI * 2);
			ctx.fillStyle = col;
			ctx.fill();
			break;
		}
		case 'BASE': {
			ctx.strokeRect(-7, -7, 14, 14);
			cross(ctx, 7);
			break;
		}
		default: {
			// Dreieck nach Heading (sonst COG); Klasse B schmaler
			const dir = t.hdg ?? t.cog ?? 0;
			ctx.rotate(dir - v.up);
			const b = t.aisClass === 'B' ? 5 : 7;
			const L = t.aisClass === 'B' ? 11 : 13;
			ctx.beginPath();
			ctx.moveTo(0, -L);
			ctx.lineTo(b, L * 0.6);
			ctx.lineTo(-b, L * 0.6);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
			// Heading-Linie, Drehrate als Haken
			if (t.hdg != null && !t.moored) {
				ctx.beginPath();
				ctx.moveTo(0, -L);
				ctx.lineTo(0, -L - 8);
				const rot = t.vessel?.rot ?? 0;
				if (Math.abs(rot) > 0.5 * D2R / 60 * 60) ctx.lineTo(rot > 0 ? 5 : -5, -L - 8);
				ctx.stroke();
			}
			if (t.lost) {
				ctx.rotate(-(dir - v.up));
				cross(ctx, 11);
			}
			if (t.radarMatch != null) {
				ctx.rotate(t.lost ? 0 : -(dir - v.up));
				ctx.strokeStyle = C.arpa;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(0, 0, 16, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
	}
	ctx.restore();
}

function cross(ctx: CanvasRenderingContext2D, r: number) {
	ctx.beginPath();
	ctx.moveTo(-r, -r);
	ctx.lineTo(r, r);
	ctx.moveTo(r, -r);
	ctx.lineTo(-r, r);
	ctx.stroke();
}

export const RANGE_NM_DEFAULT = 3 * NM;
