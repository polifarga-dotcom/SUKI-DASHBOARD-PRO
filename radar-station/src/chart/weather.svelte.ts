// Wetter-Ebenen: Modell-Katalog vom Pi, geladene Felder je Ebene, gemeinsame Vorhersagezeit (Zeitregler).
// Ebenen-IDs in chartCfg.layers: 'wx:<modell>' – damit gelten Deckkraft, Reihenfolge und Presets wie für Satellitenbilder.
import { chartCfg } from './layers.svelte';
import { settings } from '../lib/settings.svelte';
import { prepare, tEnd, type WxField, type WxModel } from './wxField';
import type { LatLon } from '../lib/geo';
import { isDe, t } from '../lib/i18n.svelte';

export const isWx = (id: string) => id.startsWith('wx:');
export const wxId = (id: string) => id.slice(3);

const HOUR = 3600e3;
const hourNow = () => Math.round(Date.now() / HOUR) * HOUR;

export const wx = $state({
	models: [] as WxModel[],
	/** angezeigte Vorhersagezeit (ms) */
	time: hourNow(),
	/** true: Zeit läuft mit der Uhr mit (Regler auf „jetzt“) */
	live: true,
	/** zählt hoch, wenn ein Feld neu geladen wurde (Neuzeichnen) */
	version: 0,
	status: {} as Record<string, WxStatus>,
	/** Open-Meteo-Verbrauch laut Pi */
	usage: null as null | { used: Record<string, number>; limits: Record<string, number>; paid?: { key: boolean; used: Record<string, number>; limits: Record<string, number> } }
});

export interface WxStatus {
	loading: boolean;
	error: string;
	/** quota | outside | api | network | queued | pi */
	code?: string;
	resetAt?: number | null;
	stale: boolean;
	fetched: number;
	run?: number | null;
	every?: number;
	next?: number | null;
}

const utc = (ms: number, withDay = false) =>
	new Date(ms).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { ...(withDay ? { weekday: 'short', day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

/** verständliche Fehlermeldung je Ursache; short = für die Ebenenzeile */
export function wxErrorText(id: string, short = false) {
	const st = wx.status[wxId(id)];
	if (!st) return '';
	if (st.code === 'queued') return t(short ? 'waiting…' : 'Waiting in the Pi queue (Open-Meteo allows 600 points per minute) – loads automatically.');
	if (!st.error) return '';
	const m = wxModel(id);
	const old = st.stale ? ' ' + t('Showing the stored forecast.') : '';
	switch (st.code) {
		case 'quota':
			return short
				? t('quota used up')
				: t('Open-Meteo quota used up – new data from {t}.', { t: st.resetAt ? utc(st.resetAt, st.resetAt - Date.now() > 3 * 3600e3) : '?' }) + old;
		case 'outside':
			return short ? t('outside area') : t('Outside the model area ({r}). Move the chart into the area.', { r: m ? wxRegion(m) : '' });
		case 'network':
			return short ? t('offline') : t('Open-Meteo not reachable (internet down?).') + old;
		case 'pi':
			return short ? t('Pi not reachable') : t('Pi not reachable.');
		default:
			return short ? t('API error') : t('Open-Meteo API error: {e}', { e: st.error }) + old;
	}
}

/** geladene Felder (bewusst nicht reaktiv: groß) */
export const fields = new Map<string, WxField>();
const req = new Map<string, { lat: number; lon: number; r: number; at: number }>();

export const wxModel = (id: string) => wx.models.find((m) => m.id === wxId(id));
/** Kurzbeschreibung in der UI-Sprache */
export const wxRegion = (m: WxModel) => (isDe() ? m.region_de : m.region) ?? '';
/** Auflösung aus der Kurzinfo, z. B. „2,5 km“ oder „13–25 km“; leer, wenn keine Angabe */
export const wxKm = (m: WxModel) => {
	const k = m.info.match(/(\d+(?:\.\d+)?(?:[–-]\d+(?:\.\d+)?)?)\s*km/)?.[1];
	return k ? `${isDe() ? k.replace(/\./g, ',') : k} km` : '';
};
/** Kurzbeschreibung in der UI-Sprache, mit Nutzungsgebiet vorneweg */
export const wxAbout = (m: WxModel) => [wxRegion(m) && `${t('Area')}: ${wxRegion(m)}.`, (isDe() ? m.about_de : m.about) ?? ''].filter(Boolean).join(' ');

/** Datenstand = Modelllauf beim Wetterdienst, z. B. „Fr., 20.11., 00:00 UTC“; leer, wenn unbekannt */
export function wxRunText(id: string) {
	const st = wx.status[wxId(id)];
	if (!st?.run) return '';
	const d = new Date(st.run).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
	return (
		t('Model run {d} UTC', { d }) +
		(st.every ? ' · ' + t('new run every {h} h', { h: Math.round(st.every / 3600e3) }) : '') +
		(st.next && st.next > Date.now() ? ' · ' + t('next about {t}', { t: utc(st.next) }) : '')
	);
}

export const activeWx = () => chartCfg.layers.filter((l) => l.on && isWx(l.id) && wxModel(l.id));

export async function loadWxModels() {
	try {
		const r = await fetch('/tiles/api/wx/models', { cache: 'no-store' });
		if (!r.ok) return;
		wx.models = await r.json();
		// neue Modelle oben anhängen (über Satellitenbildern), aus
		for (const m of wx.models) if (!chartCfg.layers.some((l) => l.id === 'wx:' + m.id)) chartCfg.layers.push({ id: 'wx:' + m.id, on: false, opacity: 0.7, dx: 0, dy: 0 });
	} catch {
		/* Pi nicht erreichbar */
	}
}

/** Gebietsgrößen (Halbseite sm): gestuft, damit der Pi-Cache trifft; das Gitter hat immer ≤ 15 × 15 Punkte */
export const WX_STEPS = [25, 50, 100, 200, 400, 800, 1600];
type Area = { lat: number; lon: number; r: number };

/** benötigtes Gebiet: sichtbarer Ausschnitt (mind. die eingestellte Größe), sonst um das Schiff */
export function wxArea(pos: LatLon | null, bbox: [number, number, number, number] | null, minR: number): Area | null {
	// shortcut: Ausschnitt über die Datumsgrenze wird nicht behandelt (bbox wäre fast 360° breit) – erst relevant im Pazifik
	if (bbox && bbox[2] - bbox[0] < 180) {
		const lat = (bbox[1] + bbox[3]) / 2;
		const lon = (bbox[0] + bbox[2]) / 2;
		const half = Math.max(((bbox[3] - bbox[1]) / 2) * 60, ((bbox[2] - bbox[0]) / 2) * 60 * Math.cos((lat * Math.PI) / 180));
		const r = WX_STEPS.find((s) => s >= Math.max(half, minR)) ?? WX_STEPS[WX_STEPS.length - 1];
		return { lat: Math.max(-80, Math.min(80, lat)), lon, r };
	}
	return pos ? { lat: pos.lat, lon: pos.lon, r: WX_STEPS.find((s) => s >= minR) ?? minR } : null;
}

/** Abstand zweier Gebietsmitten in sm */
const distNm = (a: Area, b: Area) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) * 60;

/** neu laden? anderes Gebiet (Zoom) oder Ausschnitt reicht über das geladene Gebiet hinaus */
export function wxNeedsReload(last: Area | undefined, want: Area) {
	return !last || last.r !== want.r || distNm(last, want) > want.r * 0.35;
}

const pending = new Map<string, Area & { t: number }>();

/** fehlende/veraltete Felder für die aktiven Ebenen laden – dynamisch für den sichtbaren Ausschnitt */
export function ensureWx(pos: LatLon | null, bbox: [number, number, number, number] | null = null) {
	const want = wxArea(pos, bbox, settings.wxRadius);
	if (!want) return;
	for (const l of activeWx()) {
		const id = wxId(l.id);
		const last = req.get(id);
		const st = wx.status[id];
		if (st?.loading) continue;
		const failed = st?.error || st?.code === 'queued';
		// Pi nach 1 h fragen (kostet kein Kontingent: der Pi ruft nur bei neuem Modelllauf ab), bei Fehler eher
		const stale = last && (Date.now() - last.at > HOUR || (failed && st?.code !== 'outside'));
		if (!wxNeedsReload(last, want) && !stale) {
			pending.delete(id);
			continue;
		}
		const moved = wxNeedsReload(last, want);
		if (last && !moved && st?.code === 'quota' && Date.now() < (st.resetAt ?? 0)) continue; // bis das Kontingent frei ist
		if (last && !moved && failed && Date.now() - last.at < (st?.code === 'queued' ? 10e3 : 60e3)) continue;
		// erst laden, wenn der Ausschnitt ~1,5 s ruht (nicht bei jedem Zoomschritt einen Abruf verbrauchen)
		const p = pending.get(id);
		if (last && (!p || p.r !== want.r || distNm(p, want) > want.r * 0.05)) {
			pending.set(id, { ...want, t: Date.now() });
			continue;
		}
		if (last && Date.now() - p!.t < 1500) continue;
		pending.delete(id);
		req.set(id, { ...want, at: Date.now() });
		load(id, want, want.r);
	}
}

async function load(id: string, pos: LatLon, r: number) {
	wx.status[id] = { ...(wx.status[id] ?? { stale: false, fetched: 0, error: '' }), loading: true };
	let j: any;
	try {
		const res = await fetch(`/tiles/api/wx?model=${id}&lat=${pos.lat.toFixed(3)}&lon=${pos.lon.toFixed(3)}&r=${r}`);
		j = await res.json().catch(() => ({ error: `HTTP ${res.status}`, code: res.status >= 500 ? 'pi' : 'api' }));
		if (!res.ok) throw j;
	} catch (e) {
		const x = (e ?? {}) as { error?: string; code?: string; resetAt?: number | null; message?: string };
		wx.status[id] = { ...wx.status[id], loading: false, error: x.error ?? x.message ?? 'error', code: x.error ? (x.code ?? 'api') : 'pi', resetAt: x.resetAt ?? null };
		loadUsage();
		return;
	}
	if (j.pending) {
		wx.status[id] = { ...wx.status[id], loading: false, error: '', code: 'queued' };
		return;
	}
	const f = prepare(j as WxField);
	fields.set(id, f);
	wx.status[id] = { loading: false, error: f.error ?? '', code: f.code, resetAt: f.resetAt, stale: !!f.stale, fetched: f.fetched, run: f.run, every: f.every, next: f.next };
	clampTime();
	wx.version++;
	loadUsage();
}

/** Open-Meteo-Verbrauch vom Pi (für die Anzeige im Ebenen-Tab) */
export async function loadUsage() {
	try {
		const r = await fetch('/tiles/api/wx/usage', { cache: 'no-store' });
		if (r.ok) wx.usage = await r.json();
	} catch {
		/* egal */
	}
}

/** Zeitachse: Vereinigung der Zeiträume aller aktiven, geladenen Modelle */
export function wxRange(): [number, number] | null {
	let a = Infinity, b = -Infinity;
	for (const l of activeWx()) {
		const f = fields.get(wxId(l.id));
		if (!f || !f.nt) continue;
		a = Math.min(a, f.t0);
		b = Math.max(b, tEnd(f));
	}
	return a <= b ? [a, b] : null;
}

function clampTime() {
	const rg = wxRange();
	if (!rg) return;
	const t = wx.live ? hourNow() : wx.time;
	wx.time = Math.min(rg[1], Math.max(rg[0], t));
}

export function setWxTime(t: number) {
	wx.time = Math.round(t / HOUR) * HOUR;
	wx.live = wx.time === hourNow();
}

/** im Sekundentakt aufrufen: „jetzt“ läuft mit */
export function tickWx() {
	if (wx.live && wx.time !== hourNow()) {
		wx.time = hourNow();
		clampTime();
	}
}
