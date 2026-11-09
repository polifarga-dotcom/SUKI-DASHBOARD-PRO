<script lang="ts">
	import { settings } from '../lib/settings.svelte';
	import { targets, ui, visibleTargets, sortTargets, type Target } from '../collision/targets.svelte';
	import { SITUATION_LABEL } from '../collision/cpa';
	import { cancelTarget } from '../data/mayara.svelte';
	import { fmtDeg, fmtDist, fmtSpeed, fmtTime, fmtLat, fmtLon, R2D } from '../lib/geo';
	import { countryOf, shipTypeText, navStateText } from '../lib/ais';
	import { t } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	const list = $derived.by(() => {
		ui.version;
		return sortTargets(visibleTargets(), settings.sortBy).slice(0, 150);
	});
	const sel = $derived.by(() => {
		ui.version;
		return ui.selected ? (targets.byKey.get(ui.selected) ?? null) : null;
	});
	const counts = $derived.by(() => {
		ui.version;
		const l = visibleTargets();
		return { all: l.length, danger: l.filter((x) => x.danger === 'dangerous').length, arpa: l.filter((x) => x.kind === 'arpa').length };
	});

	const cls = (x: Target) => (x.lost ? 'lost' : x.danger);
	const sit = (x: Target) => t(SITUATION_LABEL[x.situation]);
	const typeName = (x: Target) => {
		if (x.kind === 'arpa')
			return `ARPA · ${t(x.arpa?.acquisition === 'manual' ? 'manual' : 'auto')}${x.arpa?.sourceZone ? ' · ' + t('Zone {n}', { n: x.arpa.sourceZone }) : ''}`;
		const v = x.vessel;
		const c = x.aisClass === 'A' ? t('Class A') : x.aisClass === 'B' ? t('Class B') : x.aisClass === 'ATON' ? 'AtoN' : x.aisClass === 'BASE' ? t('Base station') : x.aisClass === 'SART' ? 'SART' : 'AIS';
		const ty = v?.shipType != null || v?.shipTypeName ? shipTypeText(v?.shipType, v?.shipTypeName, t) : '';
		return [c, ty].filter(Boolean).join(' · ');
	};
</script>

<div class="wrap">
	{#if sel}
		<section class="detail {cls(sel)}">
			<header>
				<div>
					<div class="name">{sel.label}</div>
					<div class="muted small">{typeName(sel)}</div>
				</div>
				<button onclick={() => (ui.selected = null)} aria-label={t('Close')}><Icon name="x" /></button>
			</header>
			{#if sel.situation !== 'none' && sel.danger !== 'safe'}
				<div class="sit">{sit(sel)}</div>
			{/if}
			<div class="grid num">
				<span>{t('Range')}</span><b>{fmtDist(sel.range)}</b>
				<span>{t('Bearing')}</span><b>{fmtDeg(sel.bearing)}T</b>
				<span>CPA</span><b>{sel.enc && sel.enc.tcpa > 0 ? fmtDist(sel.enc.cpa) : '—'}</b>
				<span>TCPA</span><b>{sel.enc && sel.enc.tcpa > 0 && isFinite(sel.enc.tcpa) ? fmtTime(sel.enc.tcpa) : t('opening')}</b>
				<span>BCR</span><b>{sel.enc?.bcr != null ? `${fmtDist(Math.abs(sel.enc.bcr))} ${t(sel.enc.bcr >= 0 ? 'ahead' : 'astern')}` : '—'}</b>
				<span>BCT</span><b>{sel.enc?.bct != null ? fmtTime(sel.enc.bct) : '—'}</b>
				<span>COG</span><b>{fmtDeg(sel.cog)}</b>
				<span>SOG</span><b>{fmtSpeed(sel.sog)}</b>
				{#if sel.kind === 'ais'}
					<span>HDG</span><b>{fmtDeg(sel.hdg)}</b>
					<span>ROT</span><b>{sel.vessel?.rot != null ? `${(sel.vessel.rot * R2D * 60).toFixed(0)}°/min` : '—'}</b>
					<span>MMSI</span><b>{sel.vessel?.mmsi}</b>
					<span>{t('Country')}</span><b>{countryOf(sel.vessel?.mmsi, t)}</b>
					<span>{t('Call sign')}</span><b>{sel.vessel?.callsign || '—'}</b>
					<span>{t('Length')}</span><b>{sel.vessel?.length ? `${sel.vessel.length} m` : '—'}</b>
					<span>{t('Status')}</span><b>{navStateText(sel.vessel?.navState, t)}</b>
					<span>{t('Destination')}</span><b>{sel.vessel?.destination || '—'}</b>
					<span>Radar</span><b>{sel.radarMatch != null ? t('confirmed (T{n})', { n: sel.radarMatch % 1000000 }) : '—'}</b>
				{:else}
					<span>{t('Status')}</span><b>{t(sel.arpa?.status ?? '—')}</b>
				{/if}
				<span>{t('Position')}</span><b class="small">{fmtLat(sel.pos.lat)}<br />{fmtLon(sel.pos.lon)}</b>
				<span>{t('Age')}</span><b>{fmtTime(sel.ageS)}</b>
			</div>
			{#if sel.kind === 'arpa' && sel.arpa}
				<button class="danger-btn" onclick={() => { cancelTarget(sel.arpa!.radarId, sel.arpa!.id); ui.selected = null; }}><Icon name="trash" /> {t('Cancel target')}</button>
			{/if}
		</section>
	{/if}

	<div class="bar">
		<span class="num"><b>{counts.all}</b> <span class="muted">{t('targets')}</span> · <b class="d">{counts.danger}</b> <span class="muted">{t('dangerous')}</span> · <b>{counts.arpa}</b> <span class="muted">ARPA</span></span>
		<select bind:value={settings.sortBy} aria-label={t('Sort')}>
			<option value="danger">{t('Danger')}</option>
			<option value="cpa">CPA</option>
			<option value="tcpa">TCPA</option>
			<option value="range">{t('Range')}</option>
		</select>
	</div>
	<div class="list scroll">
		<div class="row head muted">
			<span></span><span>{t('Name')}</span><span>{t('Range')}</span><span>{t('Brg')}</span><span>CPA</span><span>TCPA</span>
		</div>
		{#each list as x (x.key)}
			<button class="row {cls(x)}" class:sel={x.key === ui.selected} onclick={() => (ui.selected = x.key)}>
				<span class="sym" class:arpa={x.kind === 'arpa'}></span>
				<span class="nm">
					{x.label}{#if x.radarMatch != null}<span class="muted"> ◦R</span>{/if}
					{#if x.situation !== 'none' && x.danger !== 'safe'}<small>{sit(x)}</small>{/if}
				</span>
				<span class="num">{fmtDist(x.range)}</span>
				<span class="num">{fmtDeg(x.bearing)}</span>
				<span class="num">{x.enc && x.enc.tcpa > 0 ? fmtDist(x.enc.cpa) : '—'}</span>
				<span class="num">{x.enc && x.enc.tcpa > 0 && isFinite(x.enc.tcpa) ? fmtTime(x.enc.tcpa) : '—'}</span>
			</button>
		{:else}
			<div class="muted empty">{t('No targets')}</div>
		{/each}
	</div>
</div>

<style>
	.wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
	.small { font-size: 12px; }
	.detail { padding: 12px; border-bottom: 1px solid var(--line); border-left: 4px solid var(--ok); background: var(--panel-2); }
	.detail.dangerous { border-left-color: var(--alarm); }
	.detail.caution { border-left-color: var(--warn); }
	.detail.lost { border-left-color: var(--muted); }
	.detail header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
	.name { font-size: 18px; font-weight: 700; }
	.sit { margin-top: 6px; font-weight: 700; color: var(--warn); }
	.detail.dangerous .sit { color: var(--alarm); }
	.grid { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 3px 10px; margin-top: 10px; font-size: 13px; }
	.grid span { color: var(--muted); }
	.danger-btn { margin-top: 10px; width: 100%; }
	.bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; gap: 8px; border-bottom: 1px solid var(--line); }
	.d { color: var(--alarm); }
	.list { flex: 1; min-height: 0; }
	.row {
		display: grid;
		grid-template-columns: 14px 1fr 70px 46px 70px 56px;
		gap: 6px;
		align-items: center;
		width: 100%;
		text-align: left;
		border: 0;
		border-bottom: 1px solid var(--line);
		border-radius: 0;
		background: transparent;
		padding: 7px 10px;
		font-size: 13px;
		min-height: 40px;
	}
	.row.head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; min-height: 0; padding: 5px 10px; }
	.row.sel { background: var(--btn-hi); }
	.row.dangerous { color: var(--alarm); font-weight: 600; }
	.row.caution { color: var(--warn); }
	.row.lost { color: var(--muted); }
	.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; flex-direction: column; }
	.nm small { font-size: 10.5px; opacity: 0.85; }
	.sym { width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 12px solid currentColor; color: var(--ok); }
	.row.dangerous .sym { color: var(--alarm); }
	.row.caution .sym { color: var(--warn); }
	.row.lost .sym { color: var(--muted); }
	.sym.arpa { width: 11px; height: 11px; border: 2px solid var(--arpa); border-radius: 50%; }
	.empty { padding: 20px; text-align: center; }
</style>
