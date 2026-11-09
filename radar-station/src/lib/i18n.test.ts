// Prüft, dass jeder im Code mit t()/tr()/tn() verwendete Text und alle dynamischen Texte (Länder, Typen, Status,
// KVR-Hinweise) eine deutsche Übersetzung haben.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DE } from './i18n.de';
import { ALL_COUNTRIES, shipTypeText, navStateText } from './ais';
import { BOXES } from './instruments';

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? files(p) : /\.(ts|svelte)$/.test(f) && !f.endsWith('.test.ts') && !f.includes('i18n.de') ? [p] : [];
	});
}

const SRC = join(__dirname, '..');
const keys = new Set<string>();
for (const f of files(SRC)) {
	const s = readFileSync(f, 'utf8');
	// t('…'), tr('…'), t("…") sowie die zwei Textargumente von tn(n, '…', '…')
	for (const m of s.matchAll(/\b(?:t|tr)\(\s*'((?:[^'\\]|\\.)+)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
	for (const m of s.matchAll(/\b(?:t|tr)\(\s*"((?:[^"\\]|\\.)+)"/g)) keys.add(m[1]);
	for (const m of s.matchAll(/\btn\([^,]+,\s*'([^']+)',\s*'([^']+)'/g)) (keys.add(m[1]), keys.add(m[2]));
	// t(cond ? 'a' : 'b') – Literale innerhalb eines t(...)-Ternärs
	for (const m of s.matchAll(/\b(?:t|tr)\(([^()]*\?[^()]*)\)/g)) for (const q of m[1].matchAll(/'([^']+)'/g)) if (!/^(head|north|course|acquire|ebl|mark|manual|B|A|true)$/.test(q[1]) || q[1] === 'manual') keys.add(q[1]);
	// Objekt-Literale mit übersetzten Werten (ADVICE, CATEGORY_LABEL, SITUATION_LABEL, motionLabel, Tabs, Presets)
	for (const block of s.matchAll(/(?:ADVICE|CATEGORY_LABEL|SITUATION_LABEL|motionLabel|NAV_STATE)[^=]*=\s*\{([\s\S]*?)\}/g))
		for (const q of block[1].matchAll(/:\s*'([^']+)'/g)) keys.add(q[1]);
	// Alarm-Voreinstellungen (label: 'Harbor' }) – Instrumenten-Kürzel (label: 'AWS', name: …) bleiben international
	for (const q of s.matchAll(/label: '([^']+)' \}/g)) keys.add(q[1]);
	for (const q of s.matchAll(/\['(?:targets|radar|alarms|settings)', '\w+', '([^']+)'\]/g)) keys.add(q[1]);
	for (const q of s.matchAll(/\['(?:base|advanced|targets|trails|installation|info)', '([^']+)'\]/g)) keys.add(q[1]);
}

describe('i18n DE', () => {
	it('found a reasonable number of UI texts', () => expect(keys.size).toBeGreaterThan(150));

	it('every UI text has a German translation', () => {
		const missing = [...keys].filter((k) => !(k in DE) && k !== '—');
		expect(missing).toEqual([]);
	});

	it('all countries, ship types and nav states are translated', () => {
		const missing: string[] = [];
		for (const c of ALL_COUNTRIES()) if (!(c in DE)) missing.push(c);
		for (const b of BOXES) if (!(b.name in DE)) missing.push(`box: ${b.name}`);
		for (let id = 20; id < 100; id++) {
			const probe: string[] = [];
			shipTypeText(id, undefined, (x) => (probe.push(x), x));
			for (const x of probe) if (!(x in DE)) missing.push(`type ${id}: ${x}`);
		}
		for (const st of ['motoring', 'anchored', 'not under command', 'restricted manouverability', 'constrained by draft', 'moored', 'aground', 'fishing', 'sailing', 'default'])
			navStateText(st, (x) => (x in DE ? x : (missing.push(x), x)));
		expect(missing).toEqual([]);
	});

	it('placeholders match between EN and DE', () => {
		const bad = Object.entries(DE).filter(([en, de]) => {
			const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
			return ph(en) !== ph(de);
		});
		expect(bad).toEqual([]);
	});
});
