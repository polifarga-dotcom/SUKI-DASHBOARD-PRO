<script lang="ts">
	// Infofenster zu einem Ankerplatz: OSM-Eintrag (nur lesen, als eigenen übernehmen) oder eigener Platz (bearbeiten).
	import { untrack } from 'svelte';
	import { ANCH_COLOR, BOTTOMS, DIRS, deleteOwn, newOwn, saveOwn, type OsmAnch, type OwnAnch } from '../chart/anchorages.svelte';
	import { fmtLat, fmtLon } from '../lib/geo';
	import { t } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let { osm = null, own = null, create = null, sx, sy, onclose }: { osm?: OsmAnch | null; own?: OwnAnch | null; create?: OwnAnch | null; sx: number; sy: number; onclose: () => void } = $props();

	// eigener Platz: Arbeitskopie (Speichern erst auf Knopfdruck)
	const start = untrack(() => own ?? create); // Arbeitskopie: nur der Anfangswert (Popup wird je Platz neu erzeugt)
	let edit = $state<OwnAnch | null>(start ? { ...start, shelter: [...start.shelter] } : null);
	let msg = $state('');

	const KIND: Record<string, string> = { anchorage: 'Anchorage', berth: 'Anchor berth', mooring: 'Mooring buoy', marina: 'Marina' };
	const TAG_LABEL: Record<string, string> = {
		'seamark:anchorage:category': 'Category',
		'seamark:information': 'Information',
		description: 'Description',
		note: 'Note',
		depth: 'Depth',
		website: 'Website',
		url: 'Website',
		phone: 'Phone',
		vhf: 'VHF',
		'seamark:radio_station:channel': 'VHF',
		capacity: 'Berths',
		fee: 'Fee',
		opening_hours: 'Opening hours'
	};
	const rows = $derived(
		osm
			? Object.entries(osm.tags)
					.map(([k, v]) => [TAG_LABEL[k] ?? (/nature_of_surface/.test(k) ? 'Bottom' : /depth/.test(k) ? 'Depth' : ''), v.replace(/_/g, ' ')] as [string, string])
					.filter(([k]) => k)
			: []
	);
	const osmUrl = $derived(osm ? `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[osm.id[0]]}/${osm.id.slice(1)}` : '');

	async function save() {
		if (!edit) return;
		msg = t('Saving…');
		try {
			await saveOwn(edit);
			onclose();
		} catch (e) {
			msg = t('Could not save: {e}', { e: String((e as Error).message ?? e) });
		}
	}
	async function remove() {
		if (!edit || !confirm(t('Delete this anchorage?'))) return;
		await deleteOwn(edit.id);
		onclose();
	}
	const toggle = (d: string) => edit && (edit.shelter = edit.shelter.includes(d) ? edit.shelter.filter((x) => x !== d) : [...edit.shelter, d]);
</script>

<div
	class="anpop"
	style="left:min({sx + 12}px, calc(100% - 312px)); top:min({sy + 12}px, calc(100% - 430px)); border-left-color:{edit ? ANCH_COLOR.own : ANCH_COLOR[osm?.kind ?? 'anchorage']}"
	onpointerdown={(e) => e.stopPropagation()}
	onwheel={(e) => e.stopPropagation()}
	role="dialog" tabindex="-1"
	aria-label={t('Anchorage')}
>
	<div class="head">
		<Icon name="anchor" size={16} />
		<b>{edit ? edit.name || t('My anchorage') : osm?.name || t(KIND[osm?.kind ?? 'anchorage'])}</b>
		<button class="mini" onclick={onclose} aria-label={t('Close')}><Icon name="x" size={14} /></button>
	</div>
	{#if osm && !edit}
		<div class="muted small">{t(KIND[osm.kind])} · OpenStreetMap · {fmtLat(osm.lat)} {fmtLon(osm.lon)}</div>
		{#if rows.length}
			<dl>{#each rows as [k, v]}<dt>{t(k)}</dt><dd>{v}</dd>{/each}</dl>
		{:else}
			<div class="muted small">{t('No further details in OpenStreetMap.')}</div>
		{/if}
		<div class="muted small">{t('Community data: check depth, holding and local rules yourself.')}</div>
		<div class="btns">
			<button class="mini" onclick={() => (edit = newOwn({ lat: osm!.lat, lon: osm!.lon }, '', osm!))}><Icon name="plus" size={14} /> {t('Save as my anchorage')}</button>
			<a class="mini btnlink" href={osmUrl} target="_blank" rel="noopener noreferrer">OSM</a>
		</div>
	{:else if edit}
		<div class="muted small num">{fmtLat(edit.lat)} {fmtLon(edit.lon)}</div>
		<label class="f"><span>{t('Name')}</span><input type="text" maxlength="80" bind:value={edit.name} /></label>
		<div class="two">
			<label class="f"><span>{t('Depth')} (m)</span><input type="number" min="0" max="100" step="0.5" value={edit.depth ?? ''} oninput={(e) => (edit!.depth = (e.target as HTMLInputElement).value === '' ? null : Number((e.target as HTMLInputElement).value))} /></label>
			<label class="f"><span>{t('Bottom')}</span>
				<select bind:value={edit.bottom}>
					<option value="">—</option>
					{#each BOTTOMS as b}<option value={b}>{t(b)}</option>{/each}
				</select>
			</label>
		</div>
		<div class="f"><span>{t('Good shelter with wind from')}</span>
			<div class="dirs">{#each DIRS as d}<button class="mini" class:on={edit.shelter.includes(d)} onclick={() => toggle(d)}>{t(d)}</button>{/each}</div>
		</div>
		<label class="f"><span>{t('Note')}</span><textarea rows="3" maxlength="2000" bind:value={edit.note}></textarea></label>
		{#if msg}<div class="small">{msg}</div>{/if}
		<div class="btns">
			<button class="mini primary" onclick={save}><Icon name="check" size={14} /> {t('Save')}</button>
			{#if own}<button class="mini" onclick={remove}><Icon name="trash" size={14} /> {t('Delete')}</button>{/if}
		</div>
	{/if}
</div>

<style>
	.anpop {
		position: absolute;
		z-index: 23;
		width: 300px;
		max-height: 420px;
		overflow-y: auto;
		padding: 8px 12px 10px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--panel) 96%, transparent);
		border: 1px solid var(--line);
		border-left: 4px solid;
		box-shadow: 0 8px 24px #0009;
		color: var(--text);
		font-size: 13px;
	}
	.head { display: flex; align-items: center; gap: 6px; }
	.head b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; }
	.mini.on { background: var(--accent); color: #000; }
	dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 6px 0; }
	dt { color: var(--muted); }
	dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
	.f { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
	.f > span { color: var(--muted); font-size: 11px; }
	.f input, .f select, .f textarea { width: 100%; box-sizing: border-box; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.dirs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
	.btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
	.btnlink { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 6px; color: var(--text); text-decoration: none; }
	.small { font-size: 11px; }
	.muted { color: var(--muted); }
</style>
