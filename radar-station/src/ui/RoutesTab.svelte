<script lang="ts">
	// Routen und Wegpunkte (Marker): anlegen, umbenennen, Favoriten, ein-/ausblenden, bearbeiten, löschen, importieren, exportieren
	import { rt, saveRoute, deleteRoute, importFiles, exportRoutes, loadRoutes, type Route, type ExportFmt } from '../chart/routes.svelte';
	import { EXPORTS, ROUTE_COLORS, wpWeather } from '../../pi/chart-proxy/routes.mjs';
	import { tools, removeMarker } from '../radar/tools.svelte';
	import { settings } from '../lib/settings.svelte';
	import { fmtDist, fmtDeg, fmtLat, fmtLon, routeLength, toLocal, bearingOf, D2R } from '../lib/geo';
	import { t, isDe } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';
	import MarkIconPick from './MarkIconPick.svelte';
	import { MARK_ICONS, markIcon } from '../radar/markIcons';

	const FMT_KEY = 'suki.routeFmt';
	let fmt: ExportFmt = $state((() => {
		try {
			const f = localStorage.getItem(FMT_KEY);
			return f && f in EXPORTS ? (f as ExportFmt) : 'gpx';
		} catch {
			return 'gpx';
		}
	})());
	$effect(() => {
		try {
			localStorage.setItem(FMT_KEY, fmt);
		} catch {
			/* egal */
		}
	});
	let open: string | null = $state(null);

	// Favoriten wie bei den Ebenen (Stern), getrennt für Routen (r:) und Wegpunkte (m:)
	const isFav = (k: string) => settings.routeFavs.includes(k);
	const toggleFav = (k: string) => (settings.routeFavs = isFav(k) ? settings.routeFavs.filter((x) => x !== k) : [...settings.routeFavs, k]);
	const routesShown = $derived(settings.routeFavOnly ? rt.list.filter((r) => isFav('r:' + r.id)) : rt.list);
	const iconRank = (m: (typeof tools.markers)[number]) => (m.kind === 'mob' ? -1 : MARK_ICONS.findIndex((i) => i.id === markIcon(m).id));
	const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, undefined, { numeric: true });
	const marksShown = $derived(
		(settings.routeFavOnly ? tools.markers.filter((m) => isFav('m:' + m.id)) : [...tools.markers]).sort((a, b) =>
			settings.markSort === 'name' ? byName(a, b) : settings.markSort === 'icon' ? iconRank(a) - iconRank(b) || byName(a, b) : b.t - a.t
		)
	);
	let pickFor: number | null = $state(null);
	const favN = $derived(settings.routeSub === 'routes' ? rt.list.filter((r) => isFav('r:' + r.id)).length : tools.markers.filter((m) => isFav('m:' + m.id)).length);
	function renameMarker(id: number, label: string) {
		const m = tools.markers.find((x) => x.id === id);
		label = label.trim().slice(0, 40);
		if (m && label) m.label = label;
	}
	/** Name eines Routenpunkts ändern (PredictWind-Punkte tragen ihre Wetterdaten im Namen und bleiben unverändert) */
	function renameWp(r: Route, i: number, name: string) {
		name = name.trim();
		if (name !== (r.pts[i].name ?? '')) save(r, { pts: r.pts.map((p, j) => (j === i ? { lat: p.lat, lon: p.lon, ...(name ? { name } : {}) } : p)) });
	}
	let msg = $state('');
	let busy = $state(false);

	$effect(() => {
		loadRoutes();
	});

	function newRoute() {
		rt.editing = null;
		tools.measure = null;
		tools.tapMode = 'measure';
		msg = t('Tap the route points on the chart, then “Save as route”.');
	}
	function edit(r: Route) {
		rt.editing = r.id;
		tools.measure = r.pts.map((p) => ({ ...p }));
		tools.tapMode = 'measure';
		msg = t('Editing “{n}”: drag points to move them, tap the chart to add one, then “Save route”.', { n: r.name });
	}
	const save = (r: Route, patch: Partial<Route>) => saveRoute({ ...r, ...patch });
	function rename(r: Route, name: string) {
		name = name.trim();
		if (name && name !== r.name) save(r, { name });
	}
	function remove(r: Route) {
		if (confirm(t('Delete route “{n}”? This cannot be undone.', { n: r.name }))) deleteRoute(r.id);
	}
	async function onImport(e: Event) {
		const inp = e.currentTarget as HTMLInputElement;
		if (!inp.files?.length) return;
		busy = true;
		msg = '…';
		try {
			const n = await importFiles(inp.files);
			msg = n ? t('{n} route(s) imported.', { n }) : t('No route found in the file (at least 2 points needed).');
		} catch (err) {
			msg = t('Import failed: {e}', { e: String((err as Error).message ?? err) });
		}
		busy = false;
		inp.value = '';
	}
	const legs = (r: Route) =>
		r.pts.map((p, i) => {
			if (!i) return { p, crs: '', d: '' };
			const [dx, dy] = toLocal(r.pts[i - 1], p);
			return { p, crs: `${fmtDeg(bearingOf(dx, dy))}T`, d: fmtDist(Math.hypot(dx, dy)) };
		}).map((l, i) => ({ ...l, w: wpWeather(l.p.name), label: wpWeather(l.p.name) ? `WP${String(i + 1).padStart(2, '0')}` : l.p.name || `WP${String(i + 1).padStart(2, '0')}` }));

	// PredictWind-Zeiten in der Zeitzone der Datei (dort steht z. B. +0200)
	const when = (eta: number, off: number) =>
		new Date(eta + off * 6e4).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	const tz = (off: number) => (off ? `UTC${off > 0 ? '+' : '−'}${Math.abs(off / 60)}` : 'UTC');
	const num = (v: number, d = 1) => v.toLocaleString(isDe() ? 'de-DE' : 'en-GB', { maximumFractionDigits: d });
	/** Windstärke: ruhig / gut / frisch / stark */
	const windCls = (kn: number) => (kn >= 25 ? 'alarm' : kn >= 18 ? 'warn' : kn >= 8 ? 'ok' : 'calm');
	const KNOWN = new Set(['TWS', 'TWD', 'TWA', 'Pres']);
	/** Übersicht einer Route mit Zeit/Wetter an den Wegpunkten */
	function summary(r: Route) {
		const ws = r.pts.map((p) => wpWeather(p.name)).filter((w) => !!w);
		if (ws.length < 2) return null;
		const a = ws[0], b = ws[ws.length - 1];
		const mins = Math.round((b.eta - a.eta) / 6e4);
		const tws = ws.map((w) => w.vals.TWS).filter((v) => v != null);
		const pres = ws.map((w) => w.vals.Pres).filter((v) => v != null);
		return {
			dep: when(a.eta, a.off), arr: when(b.eta, b.off), tz: tz(a.off),
			dur: `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`,
			tws: tws.length ? `${num(Math.min(...tws))}–${num(Math.max(...tws))} kn` : '',
			twsMax: tws.length ? Math.max(...tws) : 0,
			pres: pres.length ? `${num(Math.min(...pres), 0)}–${num(Math.max(...pres), 0)} hPa` : ''
		};
	}
</script>

{#snippet star(k: string)}
	<button class="fav plain" class:faved={isFav(k)} title={t('Favourite')} aria-label={t('Favourite')} aria-pressed={isFav(k)} onclick={() => toggleFav(k)}>
		<Icon name="star" size={18} />
	</button>
{/snippet}

<div class="wrap scroll">
	<section class="top">
		<div class="seg">
			<button class:on={settings.routeSub === 'routes'} onclick={() => (settings.routeSub = 'routes')}><Icon name="route" size={14} /> {t('Routes')} ({rt.list.length})</button>
			<button class:on={settings.routeSub === 'wps'} onclick={() => (settings.routeSub = 'wps')}>{t('Waypoints')} ({tools.markers.length})</button>
		</div>
		<div class="seg">
			<button class:on={!settings.routeFavOnly} onclick={() => (settings.routeFavOnly = false)}>{t('All')}</button>
			<button class:on={settings.routeFavOnly} onclick={() => (settings.routeFavOnly = true)}><Icon name="star" size={14} /> {t('Favourites only ({n})', { n: favN })}</button>
		</div>
	</section>

{#if settings.routeSub === 'wps'}
	{#if tools.markers.length > 1}
		<section class="top">
			<span class="muted small">{t('Sort')}</span>
			<div class="seg">
				<button class:on={settings.markSort === 'time'} onclick={() => (settings.markSort = 'time')}>{t('Newest')}</button>
				<button class:on={settings.markSort === 'name'} onclick={() => (settings.markSort = 'name')}>{t('Name')}</button>
				<button class:on={settings.markSort === 'icon'} onclick={() => (settings.markSort = 'icon')}>{t('Symbol')}</button>
			</div>
		</section>
	{/if}
	{#each marksShown as m, i (m.id)}
		{#if settings.markSort === 'icon' && markIcon(m).id !== (i ? markIcon(marksShown[i - 1]).id : '')}<div class="grp">{t(markIcon(m).label)}</div>{/if}
		<section class="mk">
			<div class="head">
				{@render star('m:' + m.id)}
				<button class="mini ic" class:on={pickFor === m.id} disabled={m.kind === 'mob'} onclick={() => (pickFor = pickFor === m.id ? null : m.id)} title={t('Symbol')} aria-label={t('Symbol')} aria-expanded={pickFor === m.id}><Icon name={markIcon(m).icon} size={16} /></button>
				<input type="text" value={m.label} maxlength="40" onchange={(e) => renameMarker(m.id, e.currentTarget.value)} aria-label={t('Waypoint name')} />
				<button class="mini" onclick={() => removeMarker(m.id)} aria-label={t('Delete marker')}><Icon name="trash" size={14} /></button>
			</div>
			{#if pickFor === m.id}<MarkIconPick value={m.icon} onpick={(id) => ((m.icon = id), (pickFor = null))} />{/if}
			<div class="muted small num">{t(markIcon(m).label)} · {fmtLat(m.pos.lat)} {fmtLon(m.pos.lon)}</div>
		</section>
	{:else}
		<div class="muted empty">{settings.routeFavOnly ? t('No favourites yet – tap the star next to an entry under “All”.') : t('None. Long-press / right-click the radar to place one.')}</div>
	{/each}
	<div class="muted small hint">{t('Waypoints (markers) are stored on this device.')}</div>
{:else}
	<section>
		<div class="btns">
			<button onclick={newRoute}><Icon name="plus" size={16} /> {t('New route')}</button>
			<label class="btn" class:dis={busy}>
				<Icon name="upload" size={16} /> {t('Import')}
				<input type="file" accept=".gpx,.kml,.kmz,.geojson,.json,.csv,.txt,.nmea" multiple onchange={onImport} disabled={busy} hidden />
			</label>
		</div>
		<div class="muted small">{t('Import: GPX, KML/KMZ, GeoJSON, CSV, NMEA 0183. Routes are stored on the Pi and visible on all devices.')}</div>
		{#if msg}<div class="small note">{msg}</div>{/if}
		{#if rt.err}<div class="small err">{t(rt.err)}</div>{/if}
		<label class="ctl">
			<span>{t('Export format')}</span>
			<select bind:value={fmt}>{#each Object.entries(EXPORTS) as [k, x]}<option value={k}>{x.label}</option>{/each}</select>
		</label>
		{#if rt.list.length > 1}<button class="mini" onclick={() => exportRoutes(rt.list, fmt)}><Icon name="download" size={14} /> {t('Export all routes')}</button>{/if}
	</section>

	{#each routesShown as r (r.id)}
		<section class="route" class:editing={rt.editing === r.id}>
			<div class="head">
				{@render star('r:' + r.id)}
				<button class="dot" style:background={r.color} onclick={() => save(r, { color: ROUTE_COLORS[(ROUTE_COLORS.indexOf(r.color) + 1) % ROUTE_COLORS.length] })} title={t('Change colour')} aria-label={t('Change colour')}></button>
				<input type="text" value={r.name} maxlength="60" onchange={(e) => rename(r, e.currentTarget.value)} aria-label={t('Route name')} />
				<button class="mini ic" class:off={!r.show} onclick={() => save(r, { show: !r.show })} title={r.show ? t('Hide on chart') : t('Show on chart')} aria-label={t('Show on chart')}><Icon name="eye" size={15} /></button>
			</div>
			<button class="meta muted small" onclick={() => (open = open === r.id ? null : r.id)}>
				{t('{n} waypoints', { n: r.pts.length })} · {fmtDist(routeLength(r.pts))} · {open === r.id ? t('hide waypoints') : t('show waypoints')}
			</button>
			{#if open === r.id}
				{@const s = summary(r)}
				{#if s}
					<div class="sum small">
						<div><span class="muted">{t('Departure')}</span> <b>{s.dep}</b></div>
						<div><span class="muted">{t('Arrival')}</span> <b>{s.arr}</b> <span class="muted">({s.tz})</span></div>
						<div><span class="muted">{t('Duration')}</span> <b>{s.dur}</b></div>
						{#if s.tws}<div><span class="muted">{t('Wind')}</span> <b class={windCls(s.twsMax)}>{s.tws}</b></div>{/if}
						{#if s.pres}<div><span class="muted">{t('Pressure')}</span> <b>{s.pres}</b></div>{/if}
					</div>
				{/if}
				<div class="wps num">
					{#each legs(r) as l, i}
						<div class="wp">
							<div class="l1">
								{#if l.w}<b>{l.label}</b>{:else}<input class="wpname" type="text" value={l.p.name ?? ''} placeholder={l.label} maxlength="40" onchange={(e) => renameWp(r, i, e.currentTarget.value)} aria-label={t('Waypoint name')} />{/if}
								{#if l.w}<span>{when(l.w.eta, l.w.off)}</span>{/if}
								{#if l.crs}<span class="muted leg">{t('leg')} {l.crs} · {l.d}</span>{/if}
							</div>
							{#if l.w}
								<div class="chips">
									{#if l.w.vals.TWS != null}<span class="chip {windCls(l.w.vals.TWS)}">{t('Wind {s} kn from {d}', { s: num(l.w.vals.TWS), d: l.w.vals.TWD != null ? fmtDeg(l.w.vals.TWD * D2R) : '—' })}</span>{/if}
									{#if l.w.vals.TWA != null}<span class="chip">{t('TWA {a}', { a: fmtDeg(l.w.vals.TWA * D2R) })} {l.w.side === 'S' ? t('starboard') : l.w.side === 'P' ? t('port') : ''}</span>{/if}
									{#if l.w.vals.Pres != null}<span class="chip">{num(l.w.vals.Pres, 0)} hPa</span>{/if}
									{#each Object.entries(l.w.vals).filter(([k]) => !KNOWN.has(k)) as [k, v]}<span class="chip">{k} {num(v)}</span>{/each}
								</div>
							{/if}
							<div class="muted pos">{fmtLat(l.p.lat)} {fmtLon(l.p.lon)}</div>
						</div>
					{/each}
				</div>
			{/if}
			<div class="btns">
				<button class="mini" onclick={() => edit(r)}><Icon name="measure" size={14} /> {t('Edit on chart')}</button>
				<button class="mini" onclick={() => exportRoutes([r], fmt)}><Icon name="download" size={14} /> {t('Export')}</button>
				<button class="mini" onclick={() => remove(r)} aria-label={t('Delete')}><Icon name="trash" size={14} /></button>
			</div>
		</section>
	{:else}
		<div class="muted empty">{settings.routeFavOnly ? t('No favourites yet – tap the star next to an entry under “All”.') : t('No routes yet. Create one on the chart or import a file.')}</div>
	{/each}
{/if}
</div>

<style>
	.wrap { height: 100%; }
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.small { font-size: 12px; }
	.err { color: var(--alarm); }
	.note { color: var(--accent); }
	.btns { display: flex; gap: 6px; flex-wrap: wrap; }
	.btn { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; border: 1px solid var(--line); border-radius: 8px; background: var(--btn); padding: 6px 12px; min-height: 36px; font-size: 14px; }
	.btn.dis { opacity: 0.5; pointer-events: none; }
	.ctl { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
	.route.editing { background: var(--btn-hi); }
	.head { display: flex; gap: 8px; align-items: center; }
	.head input { flex: 1; min-width: 0; font: inherit; font-weight: 700; color: var(--text); background: var(--btn); border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; min-height: 32px; }
	.dot { width: 22px; height: 22px; min-height: 22px; padding: 0; border-radius: 50%; border: 2px solid var(--line); flex: none; }
	.ic.off { opacity: 0.4; }
	.meta { text-align: left; border: 0; background: transparent; padding: 0; min-height: 0; justify-content: flex-start; }
	.wps { display: flex; flex-direction: column; font-size: 12.5px; border: 1px solid var(--line); border-radius: 8px; }
	.wp { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
	.wp:last-child { border-bottom: 0; }
	.l1 { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
	.leg { margin-left: auto; }
	.chips { display: flex; flex-wrap: wrap; gap: 4px; }
	.chip { padding: 1px 7px; border-radius: 10px; background: var(--btn); border: 1px solid var(--line); }
	.chip.calm { color: var(--muted); }
	.chip.ok { border-color: var(--ok); }
	.chip.warn { border-color: var(--warn); color: var(--warn); font-weight: 700; }
	.chip.alarm { border-color: var(--alarm); color: var(--alarm); font-weight: 700; }
	b.warn { color: var(--warn); }
	b.alarm { color: var(--alarm); }
	.pos { font-size: 11px; }
	.sum { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
	.empty { padding: 20px; text-align: center; }
	.top { flex-direction: row; flex-wrap: wrap; gap: 6px; }
	.hint { padding: 8px 12px; }
	.top { align-items: center; }
	.grp { padding: 8px 12px 2px; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
	.ic.on { background: var(--accent); color: #000; }
	.wpname { font: inherit; font-weight: 700; color: var(--text); background: var(--btn); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; width: 12em; max-width: 100%; }
	.plain { background: transparent; border: 0; padding: 0; min-height: 0; }
	.fav { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; min-height: 28px; padding: 0; color: var(--muted); cursor: pointer; flex: none; }
	.fav.faved { color: #f2b705; }
	.fav.faved :global(svg path) { fill: currentColor; }
</style>
