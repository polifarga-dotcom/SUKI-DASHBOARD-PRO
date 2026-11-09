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
	import { dec } from '../lib/geo';
	import Icon from './Icon.svelte';

	let open = $state<string | null>(null);
	let presetName = $state('');
	let coralVersion = $state(0);

	const KIND: Record<string, string> = { satellite: 'Satellite', depth: 'Depth', overlay: 'Overlay', base: 'Map' };
	const name = (id: string) => (id === 'coral' ? 'Allen Coral Atlas' : (provider(id)?.name ?? id));
	const kind = (id: string) => (id === 'coral' ? 'Reef' : KIND[provider(id)?.kind ?? ''] ?? '');
	const pct = (v: number) => `${Math.round(v * 100)} %`;
	// Anzeige oben → unten (oberste Ebene zuerst)
	const shown = $derived([...chartCfg.layers].reverse());
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

<div class="wrap scroll">
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
		{#each shown as l (l.id)}
			{@const p = provider(l.id)}
			{@const ok = usable(l.id)}
			<div class="layer" class:off={!l.on}>
				<div class="lrow">
					<input type="checkbox" bind:checked={l.on} disabled={!ok} aria-label={name(l.id)} />
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
							{#if p.status && !p.status.ok}<div class="err small">{p.status.err}</div>{/if}
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
				<button class="plain pname" onclick={() => applyPreset(pr.name)}>{pr.name}</button>
				<button class="mini" onclick={() => deletePreset(pr.name)} aria-label={t('Delete')}><Icon name="trash" size={14} /></button>
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
	.pname { font-weight: 600; color: var(--accent); }
	.job { display: grid; grid-template-columns: 1fr; gap: 2px; }
	.job progress { width: 100%; accent-color: var(--accent); }
	.cache { display: flex; flex-direction: column; gap: 4px; }
	.filebtn { display: inline-flex; gap: 6px; align-items: center; align-self: flex-start; background: var(--btn); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 13px; }
	.filebtn input { display: none; }
</style>
