// Kielspur-Speicher: eine JSONL-Datei je UTC-Tag (YYYY-MM-DD.jsonl, Zeilen [t, lat, lon]).
// Nur anhängen (kein Neuschreiben großer Dateien), alte Tage werden ganz gelöscht.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DAY = 86400e3;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const isDayFile = (f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f);

export function trackStore(dir) {
	const days = async () => (await fs.readdir(dir).catch(() => [])).filter(isDayFile).sort();

	return {
		async init() {
			await fs.mkdir(dir, { recursive: true });
		},
		append: (p) => fs.appendFile(path.join(dir, `${dayKey(p[0])}.jsonl`), JSON.stringify(p) + '\n'),
		/** Punkte mit t > after (nur die betroffenen Tagesdateien werden gelesen) */
		async read(after) {
			const from = dayKey(Math.max(0, after));
			const out = [];
			for (const f of await days()) {
				if (f.slice(0, 10) < from) continue;
				const txt = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
				for (const line of txt.split('\n')) {
					if (!line) continue;
					try {
						const p = JSON.parse(line);
						if (p[0] > after) out.push(p);
					} catch {
						/* abgeschnittene Zeile nach Stromausfall */
					}
				}
			}
			return out;
		},
		/** löscht ganze Tage, die vollständig älter als maxDays sind */
		async prune(maxDays, now = Date.now()) {
			const keep = dayKey(now - maxDays * DAY);
			for (const f of await days()) if (f.slice(0, 10) < keep) await fs.rm(path.join(dir, f), { force: true });
		},
		async clear() {
			for (const f of await days()) await fs.rm(path.join(dir, f), { force: true });
		},
		async info() {
			const list = await days();
			let bytes = 0;
			for (const f of list) bytes += (await fs.stat(path.join(dir, f))).size;
			return { bytes, files: list.length, first: list[0]?.slice(0, 10) ?? null };
		}
	};
}

/** Strecke über Grund (m) entlang der Punkte; Sprünge > 30 kn gelten als GPS-Ausreißer und zählen nicht */
export function trackDistance(pts) {
	const R = 6371008.8;
	const rad = Math.PI / 180;
	let d = 0;
	for (let i = 1; i < pts.length; i++) {
		const [t0, la0, lo0] = pts[i - 1];
		const [t1, la1, lo1] = pts[i];
		const h = Math.sin(((la1 - la0) * rad) / 2) ** 2 + Math.cos(la0 * rad) * Math.cos(la1 * rad) * Math.sin(((lo1 - lo0) * rad) / 2) ** 2;
		const s = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
		if (s / Math.max(1, (t1 - t0) / 1000) <= 30 * 0.5144) d += s;
	}
	return d;
}
