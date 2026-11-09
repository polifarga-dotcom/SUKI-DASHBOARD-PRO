// Geräte-Einstellungen (localStorage). Alles, was der Bediener am Gerät wählt.
import { NM } from './geo';

export type Orientation = 'head' | 'north' | 'course';
export type Motion = 'center' | 'lookahead' | 'custom';
export type Theme = 'day' | 'dusk' | 'night';
export type Palette = 'multicolor' | 'yellow' | 'green';
export type VectorMode = 'true' | 'relative';
export type AlarmPreset = 'harbor' | 'coastal' | 'offshore' | 'custom';
export type Lang = 'en' | 'de';

export interface GuardZone {
	enabled: boolean;
	/** relativ zum Bug, rad, im Uhrzeigersinn; start == end → Vollkreis */
	start: number;
	end: number;
	inner: number; // m
	outer: number; // m
	/** min. Anzahl starker Echo-Zellen je Umdrehung, ab der ausgelöst wird */
	sensitivity: number;
}

export interface Settings {
	lang: Lang;
	radarBase: string; // '/mayara' oder '/mayara-emu'
	radarId: string; // gewählte Range (z. B. nav6578A)
	radarIdB: string; // zweite Range für Dual-Range
	dualRange: boolean;
	orientation: Orientation;
	motion: Motion;
	offset: [number, number]; // custom: Bruchteil des Radius (x rechts, y unten)
	theme: Theme;
	palette: Palette;
	echoGamma: number; // Bildverstärkung in der Darstellung (0.5–2)
	trails: number; // Sekunden, 0 = aus
	rings: boolean;
	compass: boolean;
	headingLine: boolean;
	chart: boolean;
	chartOpacity: number;
	radarOpacity: number;
	aisShow: boolean;
	aisNames: boolean;
	aisVectorMin: number; // Vektorlänge in Minuten
	vectorMode: VectorMode;
	aisTrackMin: number; // Past-Track in Minuten
	hideStaticAis: boolean; // ankernde/festgemachte ausblenden (außer gefährlich)
	arpaShow: boolean;
	alarmPreset: AlarmPreset;
	cpaLimit: number; // m
	tcpaLimit: number; // s
	alarmSound: boolean;
	alarmVolume: number;
	lostTargetAlarm: boolean;
	guard: [GuardZone, GuardZone];
	aisGuard: boolean; // AIS-Ziele in Guard Zones alarmieren
	sim: boolean;
	sidePanel: boolean;
	sideTab: 'instruments' | 'targets' | 'radar' | 'layers' | 'alarms' | 'settings';
	/** Instrumenten-Tab: angezeigte Boxen (Reihenfolge) und SailSteer */
	instBoxes: string[];
	sailsteer: boolean;
	sortBy: 'danger' | 'cpa' | 'tcpa' | 'range';
	/** Karte unabhängig von der Radar-Range zoomen */
	chartZoomFree: boolean;
	/** Kielspur in Stunden, 0 = aus */
	trackHours: number;
	/** Flachwasser-Alarm in m, 0 = aus */
	shallowAlarm: number;
	/** Wachalarm: Bestätigung alle n Minuten, 0 = aus */
	watchMin: number;
	/** Wachalarm eingeschaltet (z. B. nur für die Nachtwache) */
	watchOn: boolean;
	/** Passage: Startzeit (ms, 0 = keine) und Ziel-Marker */
	passageStart: number;
	destId: number | null;
}

export const ALARM_PRESETS: Record<Exclude<AlarmPreset, 'custom'>, { cpa: number; tcpa: number; label: string }> = {
	harbor: { cpa: 0.1 * NM, tcpa: 5 * 60, label: 'Harbor' },
	coastal: { cpa: 0.5 * NM, tcpa: 20 * 60, label: 'Coastal' },
	offshore: { cpa: 2 * NM, tcpa: 30 * 60, label: 'Offshore' }
};

const zone = (enabled: boolean, inner: number, outer: number): GuardZone => ({
	enabled,
	start: -Math.PI / 4,
	end: Math.PI / 4,
	inner,
	outer,
	sensitivity: 6
});

const DEFAULTS: Settings = {
	lang: typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en',
	radarBase: '/mayara',
	radarId: 'nav6578A',
	radarIdB: 'nav6578B',
	dualRange: false,
	orientation: 'head',
	motion: 'center',
	offset: [0, 0.4],
	theme: 'dusk',
	palette: 'multicolor',
	echoGamma: 1,
	trails: 0,
	rings: true,
	compass: true,
	headingLine: true,
	chart: false,
	chartOpacity: 0.85,
	radarOpacity: 0.9,
	aisShow: true,
	aisNames: true,
	aisVectorMin: 6,
	vectorMode: 'true',
	aisTrackMin: 5,
	hideStaticAis: false,
	arpaShow: true,
	alarmPreset: 'coastal',
	cpaLimit: 0.5 * NM,
	tcpaLimit: 20 * 60,
	alarmSound: true,
	alarmVolume: 0.7,
	lostTargetAlarm: true,
	guard: [zone(false, 0.25 * NM, 0.75 * NM), { ...zone(false, 0.5 * NM, 1.5 * NM), start: 0, end: 0 }],
	aisGuard: true,
	sim: false,
	sidePanel: true,
	sideTab: 'targets',
	sortBy: 'danger',
	chartZoomFree: false,
	trackHours: 6,
	shallowAlarm: 0,
	watchMin: 15,
	watchOn: false,
	passageStart: 0,
	destId: null,
	instBoxes: ['aws', 'awa', 'tws', 'twd', 'sog', 'stw', 'dpt', 'cog'],
	sailsteer: true
};

const KEY = 'suki-radar-settings-v1';

function load(): Settings {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) {
			const s: Settings = { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
			if (!(s.watchMin > 0)) s.watchMin = DEFAULTS.watchMin; // früher hieß 0 „aus“
			return s;
		}
	} catch {
		/* privater Modus o. ä. */
	}
	return structuredClone(DEFAULTS);
}

export const settings: Settings = $state(load());

let saveTimer: ReturnType<typeof setTimeout> | undefined;
$effect.root(() => {
	$effect(() => {
		const snap = JSON.stringify(settings);
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try {
				localStorage.setItem(KEY, snap);
			} catch {
				/* ignore */
			}
		}, 300);
	});
});

export function applyAlarmPreset(p: AlarmPreset) {
	settings.alarmPreset = p;
	if (p !== 'custom') {
		settings.cpaLimit = ALARM_PRESETS[p].cpa;
		settings.tcpaLimit = ALARM_PRESETS[p].tcpa;
	}
}

export function resetSettings() {
	Object.assign(settings, structuredClone(DEFAULTS));
}
