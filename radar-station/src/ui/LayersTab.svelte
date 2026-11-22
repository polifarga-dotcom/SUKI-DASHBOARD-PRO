<script lang="ts">
	// Ebenen der Kartenunterlage: Basis, Satellitenbilder, Tiefen, Coral Atlas, Seezeichen; Deckkraft, Reihenfolge,
	// Ausrichtung, Anbieter-Optionen, Presets, Offline-Revier.
	import { onMount } from 'svelte';
	import { settings } from '../lib/settings.svelte';
	import {
		chartCfg,
		providers,
		provider,
		usable,
		moveLayer,
		savePreset,
		applyPreset,
		deletePreset,
		putOptions,
		prefetchEstimate,
		prefetchStart,
		prefetchJobs,
		prefetchCancel,
		cacheInfo,
		cacheClear,
		type PrefetchJob
	} from '../chart/layers.svelte';
	import { CORAL_CLASSES, coralState, uploadCoral, deleteCoral } from '../chart/coralLayer';
	import { tools } from '../radar/tools.svelte';
	import { t } from '../lib/i18n.svelte';
	import { dec, fmtRange } from '../lib/geo';
	import Icon from './Icon.svelte';
	import { wx, fields, wxModel, wxId, isWx, wxAbout, wxRunText, wxRegion, wxErrorText, loadUsage, wxKm } from '../chart/weather.svelte';
	import { SCALES, UNIT, EXTRAS, type WxKind, type WxExtra } from '../chart/wxField';
	import { anch, ANCH_COLOR } from '../chart/anchorages.svelte';
	import { coast } from '../chart/coast.svelte';
	import { pwDelete } from '../chart/pw.svelte';
	import PwSync from './PwSync.svelte';

	let open = $state<string | null>(null);
	let presetName = $state('');
	let savedPreset = $state(''); // kurz Haken anzeigen nach dem Überschreiben
	function overwrite(name: string) {
		savePreset(name);
		savedPreset = name;
		setTimeout(() => savedPreset === name && (savedPreset = ''), 1500);
	}
	let coralVersion = $state(0);

	const KIND: Record<string, string> = { satellite: 'Satellite', depth: 'Depth', overlay: 'Overlay', base: 'Map' };
	const name = (id: string) => (id === 'coral' ? 'Allen Coral Atlas' : id === 'anch' ? t('Anchorages (OSM + own)') : id === 'coast' ? t('Coastline (outline only)') : (provider(id)?.name ?? id));
	const kind = (id: string) => (id === 'coral' ? 'Reef' : id === 'anch' ? 'Anchorage' : id === 'coast' ? 'Overlay' : KIND[provider(id)?.kind ?? ''] ?? '');
	const pct = (v: number) => `${Math.round(v * 100)} %`;
	// Anzeige oben → unten (oberste Ebene zuerst)
	const allLayers = $derived([...chartCfg.layers].reverse().filter((l) => !isWx(l.id)));
	const shown = $derived(settings.layerFavOnly ? allLayers.filter((l) => settings.wxFavs.includes(l.id)) : allLayers);
	const favCount = (ls: { id: string }[]) => ls.filter((l) => settings.wxFavs.includes(l.id)).length;
	const wxAll = $derived([...chartCfg.layers].reverse().filter((l) => isWx(l.id) && wxModel(l.id)));
	const wxShown = $derived(settings.wxFavOnly ? wxAll.filter((l) => settings.wxFavs.includes(l.id)) : wxAll);
	const wxApi = $derived(wxShown.filter((l) => !wxModel(l.id)!.grib));
	const wxGrib = $derived(wxShown.filter((l) => wxModel(l.id)!.grib));
	const apiAll = $derived(wxAll.filter((l) => !wxModel(l.id)!.grib));
	const gribAll = $derived(wxAll.filter((l) => wxModel(l.id)!.grib));
	async function deleteGrib(id: string, name: string) {
		if (confirm(t('Delete the GRIB files of “{n}” on the Pi?', { n: name }))) await pwDelete(wxId(id));
	}
	const toggleFav = (id: string, on: boolean) => (settings.wxFavs = on ? [...settings.wxFavs, id] : settings.wxFavs.filter((x) => x !== id));
	const WX_KIND: Record<WxKind, string> = { wind: 'Wind', wave: 'Waves', current: 'Current' };
	const EXTRA_LABEL: Record<WxExtra | 'gust', string> = { gust: 'Gusts', rain: 'Rain', cloud: 'Clouds', cape: 'CAPE', temp: 'Temperature' };
	/** Zusatzwerte, die das geladene Feld dieses Modells hat (Regen, Wolken, CAPE, Temperatur) */
	const extrasOf = (id: string): (WxExtra | 'gust')[] => {
		wx.version;
		const f = fields.get(wxId(id));
		if (!f) return [];
		const gust = f.kind === 'wind' && f.p?.some((v) => v != null) ? (['gust'] as const) : [];
		return [...gust, ...EXTRAS.filter((k) => f.x?.[k])];
	};
	/** angezeigte Farbfläche: gewählter Zusatzwert, falls vorhanden, sonst Wind/Welle/Strömung */
	const fillKey = (l: { id: string; fill?: WxExtra | 'gust' }, kind: WxKind): WxKind | WxExtra => (l.fill && l.fill !== 'gust' && extrasOf(l.id).includes(l.fill) ? l.fill : kind);
	const scaleCss = (k: WxKind | WxExtra) => {
		const st = SCALES[k];
		return `linear-gradient(90deg, ${st.map(([, c], i) => `rgb(${c.join(',')}) ${(i / (st.length - 1)) * 100}%`).join(', ')})`;
	};
	const ago = (ms: number) => {
		const m = Math.round((Date.now() - ms) / 60000);
		return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
	};
	const bases = $derived(providers.list.filter((p) => p.kind === 'base' || (p.kind === 'satellite' && p.mode !== 'direct')));

	function startAlign(id: string) {
		tools.align = { layer: id, first: null };
		tools.tapMode = 'align';
	}

	// ── Offline-Revier ──
	let pfProvider = $state('eox');
	let pfZmin = $state(10);
	let pfZmax = $state(15);
	let estimate = $state<null | { total: number; estMB: number; limit: number; error?: string }>(null);
	let jobs = $state<PrefetchJob[]>([]);
	let cache = $state<Record<string, { bytes: number; files: number }>>({});
	const prefetchable = $derived(providers.list.filter((p) => p.prefetch && p.mode === 'cache' && (!p.needsKey || p.keySet)));
	const mb = (b: number) => `${dec(b / 1048576, 1)} MB`;

	async function refreshJobs() {
		const j = await prefetchJobs();
		if (Array.isArray(j)) jobs = j;
		const c = await cacheInfo();
		if (!c.error) cache = c;
	}
	async function estimateArea() {
		estimate = null;
		if (!tools.viewBBox) return;
		estimate = await prefetchEstimate(pfProvider, tools.viewBBox, pfZmin, pfZmax);
	}
	async function startArea() {
		if (!tools.viewBBox) return;
		const r = await prefetchStart(pfProvider, tools.viewBBox, pfZmin, pfZmax);
		if (r.error) estimate = { total: 0, estMB: 0, limit: 0, error: r.error };
		refreshJobs();
	}

	onMount(() => {
		refreshJobs();
		loadUsage();
		const iv = setInterval(() => {
			if (jobs.some((j) => j.state === 'running')) refreshJobs();
			coralVersion++;
		}, 2000);
		return () => clearInterval(iv);
	});

	// ── Coral Atlas Import ──
	let coralMsg = $state('');
	async function importCoral(e: Event) {
		const input = e.target as HTMLInputElement;
		const f = input.files?.[0];
		if (!f) return;
		const n = f.name.replace(/\.(geo)?json$/i, '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'reef';
		coralMsg = t('Uploading…');
		const r = await uploadCoral(n, f);
		coralMsg = r.ok ? t('{n} areas imported.', { n: r.features ?? 0 }) : t('Import failed: {e}', { e: r.error ?? '' });
		input.value = '';
		chartCfg.rev++;
	}
	async function removeCoral(n: string) {
		await deleteCoral(n);
		chartCfg.rev++;
	}
	const coralLegend = $derived.by(() => {
		coralVersion;
		return CORAL_CLASSES.filter(([c]) => coralState.classes.has(c));
	});
</script>

{#snippet star(id: string)}
	<button class="fav plain" class:faved={settings.wxFavs.includes(id)} title={t('Favourite')} aria-label={t('Favourite')} aria-pressed={settings.wxFavs.includes(id)} onclick={() => toggleFav(id, !settings.wxFavs.includes(id))}>
		<Icon name="star" size={18} />
	</button>
{/snippet}

{#snippet wxRow(l: (typeof wxAll)[number])}
	{@const m = wxModel(l.id)!}
	{@const st = wx.status[wxId(l.id)]}
	<div class="layer" class:off={!l.on}>
		<div class="lrow">
			<input type="checkbox" bind:checked={l.on} aria-label={m.name} />
			{@render star(l.id)}
			<button class="lname plain" title={wxAbout(m)} onclick={() => (open = open === l.id ? null : l.id)}>
				{m.name} <span class="badge">{t(WX_KIND[m.kind])}</span>{#if wxKm(m)}<span class="resv">{wxKm(m)}</span>{/if}
				{#if l.on && st?.loading}<span class="muted small">{t('loading…')}</span>{/if}
				{#if l.on && wxErrorText(l.id, true)}<span class="err small">{wxErrorText(l.id, true)}</span>{/if}
			</button>
			<span class="num pctv">{pct(l.opacity)}</span>
			<button class="mini" onclick={() => moveLayer(l.id, 1)} aria-label={t('Move up')}>▲</button>
			<button class="mini" onclick={() => moveLayer(l.id, -1)} aria-label={t('Move down')}>▼</button>
		</div>
		{#if wxRegion(m)}<div class="muted small">{wxRegion(m)}</div>{/if}
		{#if l.on && wxRunText(l.id)}<div class="muted small num">{wxRunText(l.id)}</div>{/if}
		{#if l.on}<input type="range" min="0" max="1" step="0.05" bind:value={l.opacity} aria-label={t('Opacity')} />{/if}
		{#if l.on && extrasOf(l.id).length}
			<div class="seg fillsel" role="radiogroup" aria-label={t('Colour fill')}>
				<button class:on={!l.fill} onclick={() => (l.fill = undefined)}>{t(WX_KIND[m.kind])}</button>
				{#each extrasOf(l.id) as k}<button class:on={l.fill === k} onclick={() => (l.fill = k)}>{t(EXTRA_LABEL[k])}</button>{/each}
			</div>
			{@const fk = fillKey(l, m.kind)}
			<div class="wxscale" style="background:{scaleCss(fk)}"></div>
			<div class="wxaxis small num">{#each SCALES[fk] as [v]}<span>{v}</span>{/each}<span>{UNIT[fk]}</span></div>
		{/if}
		{#if open === l.id}
			<div class="details">
				<div class="muted small">{t(m.info)}</div>
				{#if wxAbout(m)}<div class="small">{wxAbout(m)}</div>{/if}
				<label class="ctl">
					<span>{t('Display')}</span>
					<select value={l.mode ?? 'static'} onchange={(e) => (l.mode = (e.target as HTMLSelectElement).value as 'static' | 'animated' | 'both')}>
						<option value="static">{t(m.kind === 'wind' ? 'Static (barbs)' : 'Static (arrows)')}</option>
						<option value="animated">{t('Animated (streamlines)')}</option>
						<option value="both">{t('Both')}</option>
					</select>
				</label>
				{#if m.kind === 'wind'}<label class="chk"><input type="checkbox" bind:checked={l.isobars} /> {t('Isobars (air pressure, 2 hPa)')}</label>{/if}
				{#if !(l.on && extrasOf(l.id).length)}
					<div class="wxscale" style="background:{scaleCss(m.kind)}"></div>
					<div class="wxaxis small num">{#each SCALES[m.kind] as [v]}<span>{v}</span>{/each}<span>{UNIT[m.kind]}</span></div>
				{/if}
				{#if l.fill === 'cape'}<div class="muted small">{t('CAPE: energy available for thunderstorms. Below 100 J/kg nothing is drawn; from about 1000 J/kg thunderstorms and squalls are likely if something triggers them.')}</div>{/if}
				{#if l.fill === 'rain'}<div class="muted small">{t('Rain: precipitation rate in mm per hour; below 0.1 mm/h nothing is drawn.')}</div>{/if}
				<div class="muted small">{t(m.kind === 'wind' ? 'Wind barbs: half = 5 kn, full = 10 kn, flag = 50 kn; the staff points to where the wind comes from.' : m.kind === 'wave' ? 'Arrows: direction the waves travel; colour = significant wave height.' : 'Arrows: direction the current flows; length and colour = speed.')}</div>
				{#if st?.fetched}<div class="muted small">{t('Model data from {t} ago', { t: ago(st.fetched) })}</div>{/if}
				{#if wxErrorText(l.id)}<div class="err small">{wxErrorText(l.id)}</div>{/if}
				{#if m.grib}<button class="mini del" onclick={() => deleteGrib(l.id, m.name)}><Icon name="trash" size={14} /> {t('Delete GRIB files')}</button>{/if}
			</div>
		{/if}
	</div>
{/snippet}

<div class="wrap scroll">
	<section class="subtabs">
		<div class="seg">
			<button class:on={settings.layerSub === 'charts'} onclick={() => (settings.layerSub = 'charts')}><Icon name="map" size={14} /> {t('Charts')}</button>
			<button class:on={settings.layerSub === 'wx'} onclick={() => (settings.layerSub = 'wx')} title={t('Weather API')}><Icon name="cloud" size={14} /> {t('Weather')}</button>
			<button class:on={settings.layerSub === 'grib'} onclick={() => (settings.layerSub = 'grib')} title={t('PredictWind GRIB')}><Icon name="download" size={14} /> GRIB ({gribAll.length})</button>
		</div>
	</section>

{#if settings.layerSub === 'wx'}
	<section>
		<b>{t('Weather (Open-Meteo)')}</b>
		<div class="muted small">{t('Forecast models from Open-Meteo, fetched by the Pi and kept for offline use. Several can be stacked; a time slider appears on the radar screen.')}</div>
		{#if wx.usage}
			{@const u = wx.usage}
			<div class="muted small num" class:err={u.used.day > u.limits.day * 0.8 || u.used.hour > u.limits.hour * 0.8}>
				{t('Open-Meteo used: hour {h} / {H} · today {d} / {D}', { h: u.used.hour.toLocaleString(), H: u.limits.hour.toLocaleString(), d: u.used.day.toLocaleString(), D: u.limits.day.toLocaleString() })}
			</div>
			{#if u.paid?.key}
				<div class="muted small num">{t('Paid API (only when free is used up): month {m} / {M}', { m: u.paid.used.month.toLocaleString(), M: u.paid.limits.month.toLocaleString() })}</div>
			{/if}
			<div class="muted small">{t('Every grid point counts (one weather picture ≈ 225). The Pi only fetches again when the weather service has published a new model run; until then everything comes from its store.')}</div>
		{/if}
		<div class="muted small">{t('Each active model costs about 260 of the 10 000 free requests per day and is refreshed every 6 h.')}</div>
		<label class="ctl">
			<span>{t('Area around the boat')}</span>
			<select bind:value={settings.wxRadius}>
				{#each [25, 50, 100, 200, 400] as r}<option value={r}>± {r} nm</option>{/each}
			</select>
		</label>
		<div class="seg">
			<button class:on={!settings.wxFavOnly} onclick={() => (settings.wxFavOnly = false)}>{t('All models')}</button>
			<button class:on={settings.wxFavOnly} onclick={() => (settings.wxFavOnly = true)}><Icon name="star" size={14} /> {t('Favourites only ({n})', { n: favCount(apiAll) })}</button>
		</div>
		{#if settings.wxFavOnly && !wxApi.length}<div class="muted small">{t('No favourites yet – tap the star next to a model under “All models”.')}</div>{/if}
		{#each wxApi as l (l.id)}{@render wxRow(l)}{/each}
	</section>
{:else if settings.layerSub === 'grib'}
	<PwSync />
	<section>
		<b>{t('PredictWind models')}</b>
		{#if !gribAll.length}<div class="muted small">{t('No GRIB files on the Pi yet. Download them in the PredictWind Offshore App; they arrive automatically from a Mac with sync set up, or upload them below.')}</div>{/if}
		<label class="ctl">
			<span>{t('Area around the boat')}</span>
			<select bind:value={settings.wxRadius}>
				{#each [25, 50, 100, 200, 400] as r}<option value={r}>± {r} nm</option>{/each}
			</select>
		</label>
		<div class="seg">
			<button class:on={!settings.wxFavOnly} onclick={() => (settings.wxFavOnly = false)}>{t('All models')}</button>
			<button class:on={settings.wxFavOnly} onclick={() => (settings.wxFavOnly = true)}><Icon name="star" size={14} /> {t('Favourites only ({n})', { n: favCount(gribAll) })}</button>
		</div>
		{#if settings.wxFavOnly && !wxGrib.length}<div class="muted small">{t('No favourites yet – tap the star next to a model under “All models”.')}</div>{/if}
		{#each wxGrib as l (l.id)}{@render wxRow(l)}{/each}
	</section>
{:else}
	<section>
		<div class="title">
			<b>{t('Chart')}</b>
			<label class="chk"><input type="checkbox" bind:checked={settings.chart} /> {t('Show')}</label>
		</div>
		{#if providers.error}<div class="err small">{t(providers.error)}</div>{/if}
		<label class="ctl">
			<span>{t('Base map')}</span>
			<select bind:value={chartCfg.base}>
				<option value="none">{t('None')}</option>
				{#each bases as p}<option value={p.id} disabled={!usable(p.id)}>{p.name}{p.resolution && p.kind === 'satellite' ? ' · ' + t(p.resolution) : ''}{usable(p.id) ? '' : ' – ' + t('key missing')}</option>{/each}
			</select>
		</label>
		{#if chartCfg.base !== 'none'}
			<label class="ctl"><span>{t('Opacity')} <b class="num">{pct(chartCfg.baseOpacity)}</b></span><input type="range" min="0" max="1" step="0.05" bind:value={chartCfg.baseOpacity} /></label>
		{/if}
		<label class="chk"><input type="checkbox" bind:checked={settings.chartZoomFree} /> {t('Zoom chart independently of the radar range')}</label>
		<label class="ctl"><span>{t('Whole chart')} <b class="num">{pct(settings.chartOpacity)}</b></span><input type="range" min="0.2" max="1" step="0.05" bind:value={settings.chartOpacity} /></label>
		<label class="ctl"><span>{t('Radar opacity')} <b class="num">{pct(settings.radarOpacity)}</b></span><input type="range" min="0" max="1" step="0.05" bind:value={settings.radarOpacity} /></label>
	</section>

	<section>
		<b>{t('Layers')}</b>
		<div class="muted small">{t('Top of the list is drawn on top. Satellite images are often offset by 5–30 m – use “Align”.')}</div>
		<div class="layer">
			<div class="lrow">
				<input type="checkbox" bind:checked={chartCfg.seamarks} aria-label="OpenSeaMap" />
				<span class="lname">OpenSeaMap <span class="badge">{t('Seamarks')}</span></span>
			</div>
			{#if chartCfg.seamarks}<input type="range" min="0" max="1" step="0.05" bind:value={chartCfg.seamarkOpacity} aria-label={t('Opacity')} />{/if}
		</div>
		<div class="seg">
			<button class:on={!settings.layerFavOnly} onclick={() => (settings.layerFavOnly = false)}>{t('All layers')}</button>
			<button class:on={settings.layerFavOnly} onclick={() => (settings.layerFavOnly = true)}><Icon name="star" size={14} /> {t('Favourites only ({n})', { n: favCount(allLayers) })}</button>
		</div>
		{#if settings.layerFavOnly && !shown.length}<div class="muted small">{t('No favourites yet – tap the star next to a layer under “All layers”.')}</div>{/if}
		{#each shown as l (l.id)}
			{@const p = provider(l.id)}
			{@const ok = usable(l.id)}
			<div class="layer" class:off={!l.on}>
				<div class="lrow">
					<input type="checkbox" bind:checked={l.on} disabled={!ok} aria-label={name(l.id)} />
					{@render star(l.id)}
					<button class="lname plain" onclick={() => (open = open === l.id ? null : l.id)}>
						{name(l.id)} <span class="badge">{t(kind(l.id))}</span>
						{#if p?.resolution}<span class="resv">{t(p.resolution)}</span>{/if}
						{#if !ok}<span class="warn small">{t('key missing')}</span>{/if}
						{#if p?.status && !p.status.ok}<span class="err small">{t('error')}</span>{/if}
					</button>
					<span class="num pctv">{pct(l.opacity)}</span>
					<button class="mini" onclick={() => moveLayer(l.id, 1)} aria-label={t('Move up')}>▲</button>
					<button class="mini" onclick={() => moveLayer(l.id, -1)} aria-label={t('Move down')}>▼</button>
				</div>
				{#if l.on}<input type="range" min="0" max="1" step="0.05" bind:value={l.opacity} aria-label={t('Opacity')} />{/if}
				{#if open === l.id}
					<div class="details">
						{#if p?.info}<div class="muted small">{t(p.info)}</div>{/if}
						{#if p}
							<div class="muted small">{t(p.mode === 'cache' ? 'Stored on the Pi, works offline' : p.mode === 'live' ? 'Live only (provider terms)' : 'Loaded directly by the browser (provider terms)')}</div>
							{#each Object.entries(p.options) as [k, d]}
								<label class="ctl">
									<span>{t(k)}</span>
									{#if d.type === 'select'}
										<select value={String(p.values[k])} onchange={(e) => putOptions(p.id, { [k]: (e.target as HTMLSelectElement).value })}>
											{#each d.values ?? [] as v}<option value={v}>{v}</option>{/each}
										</select>
									{:else}
										<input type={d.type === 'number' ? 'number' : 'text'} min={d.min} max={d.max} value={p.values[k]} onchange={(e) => putOptions(p.id, { [k]: (e.target as HTMLInputElement).value })} />
									{/if}
								</label>
							{/each}
							{#if p.status && !p.status.ok}<div class="err small">{t(p.status.err ?? '')}</div>{/if}
						{/if}
						{#if l.id === 'anch'}
							<div class="legend">
								<span><i style="background:{ANCH_COLOR.anchorage}"></i>{t('Anchorage')}</span>
								<span><i style="background:{ANCH_COLOR.mooring}"></i>{t('Mooring buoy')}</span>
								<span><i style="background:{ANCH_COLOR.marina}"></i>{t('Marina')}</span>
								<span><i style="background:{ANCH_COLOR.own}"></i>{t('My anchorages')} ({anch.own.length})</span>
							</div>
							<div class="muted small">{t('From OpenStreetMap: often official anchorage areas, cruising anchorages only where someone mapped them. Tap a symbol for details; long-press / right-click the chart → “Save anchorage here” for your own.')}</div>
							<div class="muted small">{anch.tooWide ? t('Zoom in to load anchorages (area too large).') : anch.loading ? t('loading…') : t('{n} OSM entries loaded', { n: anch.count })}</div>
							{#if anch.error}<div class="err small">{t('OpenStreetMap server busy or offline – retrying in 2 min.')} ({anch.error})</div>{/if}
						{/if}
						{#if l.id === 'coast'}
							<div class="muted small">{t('White coastline with dark edge, always drawn above the weather. Far out: Natural Earth (about 1 km accurate); zoomed in: OpenStreetMap coastline (harbour accurate), stored on the Pi.')}</div>
							<div class="muted small">{!coast.ne ? t('loading…') : coast.tooWide ? t('Overview: Natural Earth') : coast.loading ? t('loading…') : t('{n} OSM coastline pieces loaded', { n: coast.count })}</div>
							{#if coast.error}<div class="err small">{t('OpenStreetMap server busy or offline – retrying in 2 min.')} ({coast.error})</div>{/if}
						{/if}
						{#if l.id === 'coral'}
							<div class="legend">
								{#each coralLegend as [c, col]}<span><i style="background:{col}"></i>{t(c)}</span>{:else}<span class="muted small">{t('No reef data imported yet.')}</span>{/each}
							</div>
						{/if}
						<div class="offs">
							<span class="small">{t('Offset')}</span>
							<label class="small">{t('N')} <input type="number" step="1" bind:value={l.dy} /></label>
							<label class="small">{t('E')} <input type="number" step="1" bind:value={l.dx} /> m</label>
							<button class="mini" onclick={() => startAlign(l.id)} disabled={!l.on}>{t('Align')}</button>
							{#if l.dx || l.dy}<button class="mini" onclick={() => ((l.dx = 0), (l.dy = 0))}>{t('Reset')}</button>{/if}
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</section>

	<section>
		<b>{t('Presets')}</b>
		{#each chartCfg.presets as pr (pr.name)}
			<div class="preset">
				<button class="plain pname" onclick={() => applyPreset(pr.name)}>{pr.name}{#if pr.view}<span class="muted small num">{' · '}{fmtRange(pr.view.range)} · {t('Radar')} {pct(pr.view.radarOpacity)}</span>{/if}</button>
				<div class="btns">
					<button class="mini" onclick={() => overwrite(pr.name)} aria-label={t('Save current settings into this preset')} title={t('Save current settings into this preset')}><Icon name={savedPreset === pr.name ? 'check' : 'save'} size={14} /></button>
					<button class="mini" onclick={() => deletePreset(pr.name)} aria-label={t('Delete')}><Icon name="trash" size={14} /></button>
				</div>
			</div>
		{:else}
			<div class="muted small">{t('Save the current layer setup, e.g. “Reef day”.')}</div>
		{/each}
		<div class="row">
			<input type="text" bind:value={presetName} placeholder={t('Name')} />
			<button class="mini" disabled={!presetName.trim()} onclick={() => { savePreset(presetName.trim()); presetName = ''; }}>{t('Save')}</button>
		</div>
	</section>

	<section>
		<b>{t('Offline area')}</b>
		<div class="muted small">{t('Downloads the visible area to the Pi so it works without internet. Only providers whose terms allow it.')}</div>
		<label class="ctl"><span>{t('Provider')}</span>
			<select bind:value={pfProvider} onchange={() => (estimate = null)}>
				{#each prefetchable as p}<option value={p.id}>{p.name}</option>{/each}
			</select>
		</label>
		<div class="two">
			<label class="ctl"><span>{t('Zoom from')}</span><input type="number" min="1" max="20" bind:value={pfZmin} onchange={() => (estimate = null)} /></label>
			<label class="ctl"><span>{t('Zoom to')}</span><input type="number" min="1" max="20" bind:value={pfZmax} onchange={() => (estimate = null)} /></label>
		</div>
		<div class="muted small">{t('Zoom 13 ≈ 3 nm range, 16 ≈ 1/4 nm.')}</div>
		<div class="row">
			<button class="mini" onclick={estimateArea} disabled={!tools.viewBBox}>{t('Estimate')}</button>
			{#if estimate && !estimate.error && estimate.total <= estimate.limit}<button class="mini on" onclick={startArea}>{t('Download {n} tiles', { n: estimate.total })}</button>{/if}
		</div>
		{#if estimate}
			{#if estimate.error}<div class="err small">{t(estimate.error)}</div>
			{:else}<div class="small num">{t('{n} tiles, approx. {m} MB', { n: estimate.total, m: estimate.estMB })}{estimate.total > estimate.limit ? ' – ' + t('too many, zoom in or reduce zoom levels') : ''}</div>{/if}
		{/if}
		{#each jobs as j (j.id)}
			<div class="job small num">
				<span>{provider(j.provider)?.name ?? j.provider} · z{j.zmin}–{j.zmax}</span>
				<progress max={j.total} value={j.done}></progress>
				<span>{j.done}/{j.total}{j.failed ? ` · ${j.failed} ${t('failed')}` : ''}</span>
				{#if j.state === 'running'}<button class="mini" onclick={() => prefetchCancel(j.id).then(refreshJobs)}>{t('Cancel')}</button>{:else}<span class="muted">{t(j.state)}</span>{/if}
			</div>
		{/each}
		<div class="cache small num">
			{#each Object.entries(cache) as [id, c]}
				{#if c.files}
					<div class="row"><span>{provider(id)?.name ?? id}: {mb(c.bytes)} ({c.files})</span><button class="mini" onclick={() => cacheClear(id).then(refreshJobs)}>{t('Clear')}</button></div>
				{/if}
			{/each}
		</div>
	</section>

	<section>
		<b>Allen Coral Atlas</b>
		<div class="muted small">{t('Download Geomorphic and/or Benthic maps as GeoJSON for your area on allencoralatlas.org (free account), then import them here.')}</div>
		<label class="filebtn"><Icon name="plus" size={14} /> {t('Import GeoJSON')}<input type="file" accept=".geojson,.json,application/geo+json" onchange={importCoral} /></label>
		{#if coralMsg}<div class="small">{coralMsg}</div>{/if}
		{#key coralVersion}
			{#each coralState.files as f}
				<div class="row small"><span>{f}</span><button class="mini" onclick={() => removeCoral(f)} aria-label={t('Delete')}><Icon name="trash" size={14} /></button></div>
			{/each}
		{/key}
	</section>
{/if}
</div>

<style>
	.wrap { height: 100%; }
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.title { display: flex; justify-content: space-between; align-items: center; }
	.small { font-size: 12px; }
	.err { color: var(--alarm); }
	.warn { color: var(--warn); }
	.ctl { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
	.chk { display: flex; gap: 8px; align-items: center; font-size: 13px; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.row { display: flex; gap: 6px; align-items: center; justify-content: space-between; }
	.row input[type='text'] { flex: 1; }
	input[type='text'], input[type='number'] { font: inherit; color: var(--text); background: var(--btn); border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; min-height: 32px; width: 100%; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; }
	.plain { background: transparent; border: 0; padding: 0; min-height: 0; justify-content: flex-start; text-align: left; }
	.layer { border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
	.layer.off { opacity: 0.75; }
	.lrow { display: flex; align-items: center; gap: 8px; }
	.lname { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; font-weight: 600; }
	.badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
	.resv { font-size: 11px; font-weight: 600; color: var(--accent); }
	.pctv { font-size: 12px; color: var(--muted); min-width: 38px; text-align: right; }
	.details { display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
	.offs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.offs input { width: 64px; min-height: 28px; padding: 2px 6px; }
	.legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11.5px; }
	.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
	.preset { display: flex; justify-content: space-between; align-items: center; }
	.preset .btns { display: flex; gap: 4px; }
	.pname { font-weight: 600; color: var(--accent); }
	.job { display: grid; grid-template-columns: 1fr; gap: 2px; }
	.job progress { width: 100%; accent-color: var(--accent); }
	.cache { display: flex; flex-direction: column; gap: 4px; }
	.filebtn { display: inline-flex; gap: 6px; align-items: center; align-self: flex-start; background: var(--btn); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 13px; }
	.filebtn input { display: none; }
	.wxscale { height: 10px; border-radius: 3px; }
	.fav { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; min-height: 28px; padding: 0; color: var(--muted); cursor: pointer; }
	.fav.faved { color: #f2b705; }
	.fav.faved :global(svg path) { fill: currentColor; }
	.subtabs { position: sticky; top: 0; z-index: 2; background: var(--panel); }
	.subtabs .seg { display: flex; flex-wrap: nowrap; }
	.subtabs .seg button { white-space: nowrap; flex: 1; justify-content: center; }
	.del { align-self: flex-start; display: inline-flex; gap: 4px; align-items: center; }
	.fillsel { flex-wrap: wrap; align-self: flex-start; }
	.fillsel button { min-height: 28px; font-size: 12px; padding: 2px 8px; }
	.wxaxis { display: flex; justify-content: space-between; color: var(--muted); }
</style>
