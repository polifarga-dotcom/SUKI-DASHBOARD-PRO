<script lang="ts">
	// Tipp auf eine freie Stelle der Karte: alle Werte der aktiven Wetter-Ebenen an diesem Punkt als Text.
	import { wx, fields, wxModel, activeWx, wxRunText } from '../chart/weather.svelte';
	import { sample, sampleX, timeIndex, type WxExtra } from '../chart/wxField';
	import { dec, fmtLat, fmtLon, fmtDist, fmtDeg, bearingOf, toLocal, KN, type LatLon } from '../lib/geo';
	import { own } from '../data/signalk.svelte';
	import { t, isDe } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let { pos, sx, sy, onclose }: { pos: LatLon; sx: number; sy: number; onclose: () => void } = $props();

	const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
	const dir = (d: number) => `${String(Math.round(d) % 360).padStart(3, '0')}° ${COMPASS[Math.round(d / 22.5) % 16]}`;

	const groups = $derived.by(() => {
		wx.version;
		wx.time;
		return activeWx().map((l) => {
			const m = wxModel(l.id)!;
			const f = fields.get(m.id);
			const ti = f ? timeIndex(f, wx.time) : -1;
			const s = f ? sample(f, ti, pos.lat, pos.lon) : null;
			const rows: [string, string][] = [];
			if (!f) rows.push([t('loading…'), '']);
			else if (ti < 0) rows.push([t('no data at this time'), '']);
			else if (!s) rows.push([t('no data here'), '']);
			else if (m.kind === 'wind') {
				rows.push([t('Wind'), `${dec(s.s, 0)} kn ${t('from')} ${dir(s.dir)}`]);
				if (s.p != null) rows.push([t('Gusts'), `${dec(s.p, 0)} kn`]);
				if (s.q != null) rows.push([t('Air pressure'), `${dec(s.q, 0)} hPa`]);
				const xv = (k: WxExtra) => (f.x?.[k] ? sampleX(f, k, ti, pos.lat, pos.lon) : null);
				const rain = xv('rain'), cloud = xv('cloud'), cape = xv('cape'), temp = xv('temp');
				if (rain != null) rows.push([t('Rain'), `${dec(rain, 1)} mm/h`]);
				if (cloud != null) rows.push([t('Clouds'), `${dec(cloud, 0)} %`]);
				if (cape != null) rows.push([t('CAPE'), `${dec(cape, 0)} J/kg`]);
				if (temp != null) rows.push([t('Temperature'), `${dec(temp, 1)} °C`]);
			} else if (m.kind === 'wave') {
				rows.push([t('Wave height'), `${dec(s.s, 1)} m ${t('from')} ${dir(s.dir)}`]);
				if (s.p != null) rows.push([t('Wave period'), `${dec(s.p, 0)} s`]);
			} else rows.push([t('Current'), `${dec(s.s, 1)} kn ${t('towards')} ${dir(s.dir)}`]);
			return { name: m.name, rows, run: wxRunText(l.id) };
		});
	});
	// Durchschnittsfahrt der letzten Stunde aus der Kielspur des Pi (m/s), für die Zeit bis zum Punkt
	const AVG_WINDOW = 3600e3;
	let avg = $state<number | null>(null);
	$effect(() => {
		fetch(`/tiles/api/track/dist?since=${Date.now() - AVG_WINDOW}`, { cache: 'no-store' })
			.then((r) => (r.ok ? r.json() : null))
			.then((r: { dist: number; t0: number | null } | null) => (avg = r?.t0 ? r.dist / Math.max(60, (Date.now() - r.t0) / 1000) : null))
			.catch(() => (avg = null));
	});
	const MOVING = 0.5 * KN;
	/** Entfernung, rechtweisender Kurs und (in Fahrt) Zeit bis zum Punkt vom eigenen Schiff (folgt der Bootsposition) */
	const leg = $derived.by(() => {
		if (!own.pos) return null;
		const [x, y] = toLocal(own.pos, pos);
		const d = Math.hypot(x, y);
		let ttd = '';
		if ((own.sog ?? 0) >= MOVING && avg != null && avg >= MOVING) {
			const min = Math.round(d / avg / 60);
			ttd = min >= 48 * 60 ? t('{d} d {h} h', { d: Math.floor(min / 1440), h: Math.floor(min / 60) % 24 }) : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
			const at = new Date(Date.now() + min * 6e4).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
			ttd = `${ttd} (${at}, Ø ${dec(avg / KN, 1)} kn)`;
		}
		return { d: fmtDist(d), c: `${fmtDeg(bearingOf(x, y))}T`, ttd };
	});
	const when = $derived(new Date(wx.time).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
</script>

<div
	class="wxpop"
	style="left:min({sx + 12}px, calc(100% - 292px)); top:min({sy + 12}px, calc(100% - 300px))"
	onpointerdown={(e) => e.stopPropagation()}
	onwheel={(e) => e.stopPropagation()}
	role="dialog" tabindex="-1"
	aria-label={t('Weather at this point')}
>
	<div class="head">
		<b>{groups.length ? when : t('Chart position')}</b>
		<button class="mini" onclick={onclose} aria-label={t('Close')}><Icon name="x" size={14} /></button>
	</div>
	{#if leg}<div class="leg num"><span>{t('Distance')} <b>{leg.d}</b></span><span>{t('Course')} <b>{leg.c}</b></span></div>
		{#if leg.ttd}<div class="num">TTD <b>{leg.ttd}</b></div>{/if}{/if}
	<div class="muted small num">{fmtLat(pos.lat)} {fmtLon(pos.lon)}</div>
	{#each groups as g}
		<div class="model">{g.name}</div>
		{#if g.run}<div class="muted small">{g.run}</div>{/if}
		<dl>
			{#each g.rows as [k, v]}<dt>{k}</dt><dd class="num">{v}</dd>{/each}
		</dl>
	{/each}
</div>

<style>
	.wxpop {
		position: absolute;
		z-index: 22;
		width: 280px;
		max-height: 290px;
		overflow-y: auto;
		padding: 8px 12px 10px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--panel) 94%, transparent);
		border: 1px solid var(--line);
		border-left: 4px solid var(--accent);
		box-shadow: 0 8px 24px #0009;
		color: var(--text);
		font-size: 13px;
	}
	.head { display: flex; align-items: center; justify-content: space-between; }
	.leg { display: flex; gap: 14px; margin: 2px 0; }
	.mini { min-height: 26px; padding: 2px 6px; }
	.model { margin-top: 6px; font-weight: 700; font-size: 12px; color: var(--accent); }
	dl { display: grid; grid-template-columns: auto 1fr; gap: 1px 12px; margin: 2px 0 0; }
	dt { color: var(--muted); }
	dd { margin: 0; font-weight: 600; }
	.small { font-size: 11px; }
	.muted { color: var(--muted); }
</style>
