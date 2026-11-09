// Zweisprachigkeit EN/DE. Der englische Text ist der Schlüssel; DE kommt aus dem Wörterbuch (i18n.de.ts).
// t() liest settings.lang → in Svelte-Templates und $derived automatisch reaktiv.
import { settings } from './settings.svelte';
import { setNumberLocale } from './geo';
import { DE } from './i18n.de';

export function t(key: string, p?: Record<string, string | number>): string {
	let s = settings.lang === 'de' ? (DE[key] ?? key) : key;
	if (p) s = s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));
	return s;
}

/** Einzahl/Mehrzahl: tn(n, Text für 1, Text für mehrere, Parameter) */
export const tn = (n: number, one: string, many: string, p?: Record<string, string | number>) => t(n === 1 ? one : many, { n, ...p });

export const isDe = () => settings.lang === 'de';

/** Uhrzeit im Sprachformat */
export const timeFmt = (d: Date | number, sec = false) =>
	new Date(d).toLocaleTimeString(settings.lang === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined });

setNumberLocale(() => settings.lang);

$effect.root(() => {
	$effect(() => {
		document.documentElement.lang = settings.lang;
	});
});
