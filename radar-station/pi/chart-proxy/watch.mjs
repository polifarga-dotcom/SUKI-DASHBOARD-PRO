// Wachplaner: Vorlagen, Kalenderrechnung und Prüfung. Eine Datei für Pi (chart-proxy) und App (Vite-Import),
// damit Kalender, Kopfzeile, MFD und Node-RED dieselbe Rechnung sehen. Zeiten in Bordzeit (IANA-Zeitzone tz).
// Modell: Tagesmuster aus Wachbeginnen (Minuten ab 00:00; eine Wache endet beim nächsten Beginn),
//   rotate  = Wachen laufen über Tagesgrenzen fort (ungerade Anzahl → Nachtwachen wandern täglich)
//   fixed   = jeden Tag gleich (Einheit i bekommt Wachen i, i+n, …)
//   rolling = Staffelwache: alle `shift` Minuten wechselt eine Person, jede steht `on` × shift.

const H = 60;
export const PRESETS = [
	{ id: 'classic48', name: '4 on / 8 off with dog watches', units: 3, mode: 'rotate', starts: [0, 4, 8, 12, 16, 18, 20].map((h) => h * H),
		info: 'Traditional three-watch system. Each watch has 4 hours on and 8 hours off; the two short dog watches (16–18, 18–20) make 7 watches a day, so the night watches move on every day. Good rest, needs 3 watches (6 or more crew).' },
	{ id: 'merchant48', name: '4 on / 8 off fixed', units: 3, mode: 'fixed', starts: [0, 4, 8, 12, 16, 20].map((h) => h * H),
		info: 'Merchant-ship system: every watch keeps the same hours each day (A 00–04 + 12–16, B 04–08 + 16–20, C 08–12 + 20–24). Steady sleep rhythm, but the same watch always has the 00–04 graveyard watch.' },
	{ id: 'twoDog', name: '4 on / 4 off (port & starboard)', units: 2, mode: 'rotate', starts: [0, 4, 8, 12, 16, 18, 20].map((h) => h * H),
		info: 'Two watches alternate 4 hours on, 4 hours off; the dog watches swap the hours every day. Classic for small crews (2 watches), but rest never exceeds about 4 hours.' },
	{ id: 'swedish', name: 'Swedish watch system', units: 2, mode: 'rotate', starts: [3, 7, 13, 19, 23].map((h) => h * H),
		info: 'Two watches with 6-hour day watches (07–13, 13–19) and 4-hour night watches (19–23, 23–03, 03–07). Five watches a day, so the night watches rotate; long daytime rest for real sleep.' },
	{ id: 'three6', name: '3 on / 6 off', units: 3, mode: 'rotate', starts: [0, 3, 6, 9, 12, 15, 18, 21].map((h) => h * H),
		info: 'Three watches of 3 hours, 6 hours off. Eight watches a day for three watches, so the times shift every day. Short, alert watches – good for night sailing with a larger crew.' },
	{ id: 'two4', name: '2 on / 4 off', units: 3, mode: 'fixed', starts: Array.from({ length: 12 }, (_, i) => i * 2 * H),
		info: 'Three watches of only 2 hours, 4 hours off, same times every day. For cold, rain or heavy weather and helming by hand, when concentration fades quickly.' },
	{ id: 'three3', name: '3 on / 3 off (short-handed)', units: 2, mode: 'fixed', starts: [0, 3, 6, 9, 12, 15, 18, 21].map((h) => h * H),
		info: 'Two people or two watches alternate every 3 hours, same times every day. Typical for a couple on passage; tiring over several days.' },
	{ id: 'three9', name: '3 on / 9 off', units: 4, mode: 'fixed', starts: [0, 3, 6, 9, 12, 15, 18, 21].map((h) => h * H),
		info: 'For four people standing watch alone: eight 3-hour watches a day, each person has two of them at the same times every day (e.g. 00–03 and 12–15) with 9 hours off in between. Popular on cruising yachts with four crew and an autopilot.' },
	{ id: 'four12', name: '4 on / 12 off', units: 4, mode: 'rotate', starts: [0, 4, 8, 12, 16, 20].map((h) => h * H),
		info: 'Four people (or four watches) stand 4 hours each and have 12 hours off. Six watches a day for four watches, so the watch times change every day and nobody keeps the 00–04 watch for long. Lots of rest, one person alone on watch.' },
	{ id: 'rolling', name: 'Rolling watch', units: 0, mode: 'rolling', starts: [0], shift: 60, on: 2,
		info: 'Staggered watch for individual crew: every hour one person comes on and stands 2 hours, so two are always on watch and one of them is fresh and the other already knows the situation.' },
	{ id: 'custom', name: 'Custom pattern', units: 0, mode: 'rotate', starts: [0, 4 * H, 8 * H, 12 * H, 16 * H, 20 * H],
		info: 'Own pattern: set the start times of the watches for one day, the order of teams or people and whether the watches rotate, stay fixed or roll.' }
];
export const COLORS = ['#2f8fff', '#22c55e', '#f2b705', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#ec4899'];
export const MAX_CREW = 8;

// ── Zeitzone ────────────────────────────────────────────────────────────────
const fmts = new Map();
function parts(t, tz) {
	let f = fmts.get(tz);
	if (!f) fmts.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })));
	const o = {};
	for (const p of f.formatToParts(t)) o[p.type] = +p.value;
	return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute };
}
const offset = (t, tz) => {
	const p = parts(t, tz);
	return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(t / 6e4) * 6e4) / 6e4;
};
/** Wandzeit (Datum + Minuten ab Mitternacht) in tz → Epoche ms */
export function zoned(y, m, d, min, tz) {
	const g = Date.UTC(y, m - 1, d, 0, min);
	const o1 = offset(g, tz);
	let t = g - o1 * 6e4;
	const o2 = offset(t, tz);
	if (o2 !== o1) t = g - o2 * 6e4;
	return t;
}
export const validTz = (tz) => {
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};
/** Kalendertag in Bordzeit */
export const dayOf = (t, tz) => {
	const p = parts(t, tz);
	return { y: p.y, m: p.m, d: p.d };
};
/** HH:MM in Bordzeit */
export const hhmm = (t, tz) => {
	const p = parts(t, tz);
	return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};

// ── Kalender ────────────────────────────────────────────────────────────────
const mod = (a, n) => ((a % n) + n) % n;

/** Wachen im Zeitraum [from, to): { start, end, units: [{t:'team'|'person', id}], members: [crewId] } */
export function schedule(doc, from, to) {
	const m = doc?.model, tz = doc?.tz || 'UTC', out = [];
	const units = m?.units ?? [];
	if (!units.length || !m.starts?.length || !/^\d{4}-\d\d-\d\d$/.test(m.start ?? '')) return out;
	const n = units.length;
	const [sy, sm, sd] = m.start.split('-').map(Number);
	const s0 = Date.UTC(sy, sm - 1, sd);
	const ov = new Map((doc.overrides ?? []).map((o) => [o.start, o.units]));
	const team = new Map((doc.teams ?? []).map((t) => [t.id, t]));
	const members = (us) => [...new Set(us.flatMap((u) => (u.t === 'team' ? (team.get(u.id)?.members ?? []) : [u.id])))];
	const push = (start, end, u) => {
		if (end <= from || start >= to) return;
		const us = ov.get(start) ?? u;
		out.push({ start, end, units: us, members: members(us) });
	};
	const f = parts(from - 2 * 864e5, tz);
	for (let k = 0; k < 400; k++) {
		const dU = Date.UTC(f.y, f.m - 1, f.d + k);
		const D = new Date(dU);
		const [y, mo, d] = [D.getUTCFullYear(), D.getUTCMonth() + 1, D.getUTCDate()];
		if (zoned(y, mo, d, 0, tz) > to) break;
		const di = Math.round((dU - s0) / 864e5);
		if (m.mode === 'rolling') {
			const S = 1440 / m.shift;
			for (let i = 0; i < S; i++) {
				const st = zoned(y, mo, d, m.starts[0] + i * m.shift, tz);
				push(st, st + m.on * m.shift * 6e4, [units[mod(di * S + i, n)]]);
			}
			continue;
		}
		const B = m.starts.length;
		const N = new Date(dU + 864e5);
		for (let i = 0; i < B; i++) {
			const st = zoned(y, mo, d, m.starts[i], tz);
			const en = i < B - 1 ? zoned(y, mo, d, m.starts[i + 1], tz) : zoned(N.getUTCFullYear(), N.getUTCMonth() + 1, N.getUTCDate(), m.starts[0], tz);
			push(st, en, [units[m.mode === 'fixed' ? i % n : mod(di * B + i, n)]]);
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

export const unitName = (doc, u) =>
	u.t === 'team' ? (doc.teams?.find((t) => t.id === u.id)?.name ?? '?') : (doc.crew?.find((c) => c.id === u.id)?.name ?? '?');
/** Pause davor/danach einer Wache e: Abstand zur vorigen/nächsten Wache eines ihrer Wachgänger in all
 *  (Minuten; null = nicht in all, also all ±2 Tage um die Anzeige rechnen) */
export function restOf(all, e) {
	const shares = (x) => x.members.some((m) => e.members.includes(m));
	const prev = all.filter((x) => x.end <= e.start && shares(x)).reduce((m, x) => Math.max(m, x.end), -Infinity);
	const next = all.filter((x) => x.start >= e.end && shares(x)).reduce((m, x) => Math.min(m, x.start), Infinity);
	return { rb: Number.isFinite(prev) ? Math.round((e.start - prev) / 6e4) : null, ra: Number.isFinite(next) ? Math.round((next - e.end) / 6e4) : null };
}
/** Pausendauer kurz: 8h, 7h30, ? */
export const restText = (m) => (m == null ? '?' : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`);

/** Wachen als flache Liste für Kalender auf Displays: s/e Epoche, l Name, c Farbe, n Spur (Staffelwache) */
export function watchList(doc, from, to) {
	if (doc.active === false) return [];
	const m = doc.model, lanes = m.mode === 'rolling' ? (m.on ?? 1) : 1;
	const color = (u) => (u?.t === 'team' ? doc.teams?.find((x) => x.id === u.id)?.color : doc.crew?.find((c) => c.id === u?.id)?.color) ?? '#888888';
	const all = schedule(doc, from - 2 * 864e5, to + 2 * 864e5);
	return all.filter((e) => e.end > from && e.start < to).map((e) => ({
		...restOf(all, e),
		s: e.start,
		e: e.end,
		l: m.mode === 'rolling' ? crewNames(doc, e.members).join(' + ') : e.units.map((u) => unitName(doc, u)).join(' + '),
		c: color(e.units[0] ?? { t: 'person', id: e.members[0] }),
		n: lanes > 1 ? Math.round(e.start / (m.shift * 6e4)) % lanes : 0
	}));
}
const crewNames = (doc, ids) => ids.map((id) => doc.crew?.find((c) => c.id === id)?.name).filter(Boolean);

/** Für Kopfzeile, MFD und Node-RED: wer hat jetzt Wache, wer als Nächstes, wann ist Wechsel (Hinweis 10 min vorher) */
export function watchNow(doc, t = Date.now()) {
	if (doc.active === false) return { on: false }; // Plan gestoppt
	const es = schedule(doc, t - 864e5, t + 2 * 864e5);
	const cur = es.filter((e) => e.start <= t && t < e.end);
	const nxt = es.find((e) => e.start > t);
	if (!cur.length && !nxt) return { on: false };
	const at = nxt?.start ?? null;
	const nextAll = nxt ? es.filter((e) => e.start === at) : [];
	const desc = (list) => {
		const units = list.flatMap((e) => e.units);
		const names = crewNames(doc, [...new Set(list.flatMap((e) => e.members))]);
		const label = doc.model.mode === 'rolling' ? names.join(' + ') : units.map((u) => unitName(doc, u)).join(' + ');
		return { label, names };
	};
	return {
		on: true,
		tz: doc.tz,
		now: cur.length ? desc(cur) : null,
		next: nextAll.length ? desc(nextAll) : null,
		at,
		atText: at != null ? hhmm(at, doc.tz) : '',
		inMin: at != null ? Math.ceil((at - t) / 6e4) : null,
		soon: at != null && at - t <= 10 * 6e4
	};
}

// ── Prüfung (Eingabe vom Netz) ──────────────────────────────────────────────
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const ID = /^[\w-]{1,24}$/;

/** gültiges Plan-Dokument oder Fehlertext */
export function cleanWatch(d, now = Date.now()) {
	if (!d || typeof d !== 'object') return 'no plan';
	const tz = str(d.tz, 64) || 'UTC';
	if (!validTz(tz)) return 'unknown time zone';
	if (!Array.isArray(d.crew) || d.crew.length > MAX_CREW) return `at most ${MAX_CREW} crew`;
	const crew = [];
	for (const c of d.crew) {
		if (!ID.test(c?.id ?? '') || crew.some((x) => x.id === c.id)) return 'bad crew id';
		const name = str(c.name, 30);
		if (!name) return 'crew name missing';
		crew.push({ id: c.id, name, color: /^#[0-9a-f]{6}$/i.test(c.color ?? '') ? c.color : COLORS[crew.length], role: ['skipper', 'leader', 'crew'].includes(c.role) ? c.role : 'crew' });
	}
	const ids = new Set(crew.map((c) => c.id));
	if (!Array.isArray(d.teams ?? []) || (d.teams ?? []).length > MAX_CREW) return `at most ${MAX_CREW} teams`;
	const teams = [];
	for (const t of d.teams ?? []) {
		if (!ID.test(t?.id ?? '') || teams.some((x) => x.id === t.id)) return 'bad team id';
		teams.push({ id: t.id, name: str(t.name, 30) || 'Team', color: /^#[0-9a-f]{6}$/i.test(t.color ?? '') ? t.color : COLORS[teams.length], members: [...new Set(t.members ?? [])].filter((m) => ids.has(m)) });
	}
	const tids = new Set(teams.map((t) => t.id));
	const okUnit = (u) => u && ((u.t === 'team' && tids.has(u.id)) || (u.t === 'person' && ids.has(u.id)));
	const m = d.model ?? {};
	if (!['rotate', 'fixed', 'rolling'].includes(m.mode)) return 'bad mode';
	const starts = [...new Set((m.starts ?? []).map(Number))].sort((a, b) => a - b);
	if (!starts.length || starts.length > 48 || !starts.every((s) => Number.isInteger(s) && s >= 0 && s < 1440)) return 'watch start times 00:00–23:59, 1–48 watches';
	if (!Array.isArray(m.units) || m.units.length > 16 || !m.units.every(okUnit)) return 'bad watch order';
	if (!/^\d{4}-\d\d-\d\d$/.test(m.start ?? '')) return 'bad start date';
	const model = { preset: str(m.preset, 20), mode: m.mode, starts, units: m.units.map((u) => ({ t: u.t, id: u.id })), start: m.start };
	if (m.mode === 'rolling') {
		if (!(1440 % m.shift === 0 && m.shift >= 30 && m.shift <= 360)) return 'change interval must divide the day (30–360 min)';
		if (!(Number.isInteger(m.on) && m.on >= 1 && m.on <= 4)) return 'people on watch 1–4';
		Object.assign(model, { shift: m.shift, on: m.on, starts: [starts[0]] });
	}
	// Ausnahmen: nur gültige, alte (> 14 Tage) fallen weg
	const overrides = (d.overrides ?? [])
		.filter((o) => Number.isFinite(o?.start) && o.start > now - 14 * 864e5 && Array.isArray(o.units) && o.units.length && o.units.length <= 8 && o.units.every(okUnit))
		.slice(0, 300)
		.map((o) => ({ start: o.start, units: o.units.map((u) => ({ t: u.t, id: u.id })) }));
	return { rev: Number.isInteger(d.rev) ? d.rev : 0, active: d.active !== false, tz, crew, teams, model, overrides };
}

export const emptyPlan = (tz = 'UTC', today = new Date().toISOString().slice(0, 10)) => ({
	rev: 0,
	active: false,
	tz,
	crew: [],
	teams: [],
	model: { preset: 'classic48', mode: 'rotate', starts: PRESETS[0].starts, units: [], start: today },
	overrides: []
});
