<script lang="ts">
	// Instrumente: kleines SailSteer + frei wählbare Datenboxen (Wind, Fahrt, Kurs, Tiefe, Umwelt).
	import { onMount } from 'svelte';
	import { settings } from '../lib/settings.svelte';
	import { own } from '../data/signalk.svelte';
	import { BOXES, readWind, type Wind } from '../lib/instruments';
	import { nmUnit, gcDist, gcBearing, fmtDist, fmtDeg, fmtSpeed } from '../lib/geo';
	import { t, isDe } from '../lib/i18n.svelte';
	import { tools } from '../radar/tools.svelte';
	import SailSteer from './SailSteer.svelte';
	import Icon from './Icon.svelte';

	let w: Wind = $state({ aws: null, awa: null, tws: null, twa: null, twd: null, calc: false });
	let tick = $state(0);
	let edit = $state(false);

	onMount(() => {
		const iv = setInterval(() => {
			w = readWind();
			tick++;
		}, 500);
		const iv2 = setInterval(loadPassage, 5 * 60e3);
		return () => {
			clearInterval(iv);
			clearInterval(iv2);
		};
	});

	// ── Passage: Etmal und Strecke seit Start aus der Kielspur des Pi, Distanz/ETA zum Ziel-Marker ──
	type Run = { dist: number; t0: number | null } | null;
	let day: Run = $state(null);
	let leg: Run = $state(null);
	const fetchRun = async (since: number): Promise<Run> => {
		try {
			const r = await fetch(`/tiles/api/track/dist?since=${since}`, { cache: 'no-store' });
			return r.ok ? await r.json() : null;
		} catch {
			return null;
		}
	};
	async function loadPassage() {
		day = await fetchRun(Date.now() - 86400e3);
		leg = settings.passageStart ? await fetchRun(settings.passageStart) : null;
	}
	$effect(() => {
		settings.passageStart;
		loadPassage();
	});
	/** Durchschnitt (m/s) über die tatsächlich aufgezeichnete Zeit */
	const avg = (r: Run) => (r && r.t0 ? r.dist / Math.max(60, (Date.now() - r.t0) / 1000) : null);
	const dur = (ms: number) => {
		const h = Math.floor(ms / 3600e3);
		return h >= 24 ? t('{d} d {h} h', { d: Math.floor(h / 24), h: h % 24 }) : `${h} h ${Math.floor(ms / 60e3) % 60} min`;
	};
	const eta = (dtg: number, speed: number | null) => {
		if (speed == null || speed < 0.25) return '—';
		const ms = (dtg / speed) * 1000;
		if (ms > 60 * 86400e3) return '—';
		return new Date(Date.now() + ms).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	};
	const dest = $derived(tools.markers.find((m) => m.id === settings.destId) ?? null);
	const toDest = $derived.by(() => {
		tick;
		if (!dest || !own.pos) return null;
		const dtg = gcDist(own.pos, dest.pos);
		const brg = gcBearing(own.pos, dest.pos);
		const vmg = own.sog != null && own.cog != null ? own.sog * Math.cos(own.cog - brg) : null;
		return { dtg, brg, vmg };
	});
	function startPassage() {
		if (settings.passageStart && !confirm(t('Start a new passage? The distance since start is reset.'))) return;
		settings.passageStart = Date.now();
	}

	const byId = (id: string) => BOXES.find((b) => b.id === id)!;
	const val = (id: string) => {
		tick;
		return byId(id).value(w);
	};
	const unit = (u: string) => (u === 'nm' ? nmUnit() : u);
	const noSpeed = $derived.by(() => {
		tick;
		return own.stw == null && own.sog == null;
	});
	const shown = $derived(settings.instBoxes.filter((id) => BOXES.some((b) => b.id === id)));

	function toggle(id: string) {
		settings.instBoxes = settings.instBoxes.includes(id) ? settings.instBoxes.filter((x) => x !== id) : [...settings.instBoxes, id];
	}
	function move(id: string, dir: -1 | 1) {
		const a = [...settings.instBoxes];
		const i = a.indexOf(id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= a.length) return;
		[a[i], a[j]] = [a[j], a[i]];
		settings.instBoxes = a;
	}
</script>

<div class="wrap scroll">
	<div class="head">
		<button class="mini" class:on={edit} onclick={() => (edit = !edit)}><Icon name="sliders" size={14} /> {edit ? t('Done') : t('Customise')}</button>
	</div>

	{#if edit}
		<section class="editor">
			<label class="chk"><input type="checkbox" bind:checked={settings.sailsteer} /> SailSteer</label>
			{#each BOXES as b (b.id)}
				{@const on = settings.instBoxes.includes(b.id)}
				<div class="erow">
					<label class="chk"><input type="checkbox" checked={on} onchange={() => toggle(b.id)} /> <b>{b.label}</b> <span class="muted">{t(b.name)}</span></label>
					{#if on}
						<span class="arrows">
							<button class="mini" onclick={() => move(b.id, -1)} aria-label={t('Move up')}>▲</button>
							<button class="mini" onclick={() => move(b.id, 1)} aria-label={t('Move down')}>▼</button>
						</span>
					{/if}
				</div>
			{/each}
		</section>
	{:else}
		{#if settings.sailsteer}
			<div class="ss">
				<SailSteer
					{w}
					calc={w.calc}
					sogTxt={val('sog')}
					stwTxt={val('stw')}
					twaTxt={val('twa')}
					twsTxt={val('tws')}
					twdTxt={val('twd')}
				/>
			</div>
		{/if}
		<div class="grid">
			{#each shown as id (id)}
				{@const b = byId(id)}
				<div class="box" class:wide={id === 'pos'}>
					<div class="bl">
						<span>{b.label}</span>
						{#if b.calc?.(w)}<span class="calc">calc</span>{/if}
					</div>
					<div class="bv num" class:posv={id === 'pos'}>{val(id)}{#if b.unit}<span class="bu">{unit(b.unit)}</span>{/if}</div>
				</div>
			{:else}
				<div class="muted empty">{t('No boxes selected – tap “Customise”.')}</div>
			{/each}
		</div>
		{#if noSpeed}<div class="muted small pad">{t('No speed data – true wind cannot be calculated.')}</div>{/if}

		<section class="pass">
			<div class="ph">
				<b>{t('Passage')}</b>
				<button class="mini" onclick={startPassage}>{settings.passageStart ? t('New passage') : t('Start passage')}</button>
			</div>
			<div class="prow"><span>{t('Day’s run (24 h)')}</span><b class="num">{fmtDist(day?.dist)} · Ø {fmtSpeed(avg(day))}</b></div>
			{#if settings.passageStart}
				<div class="prow"><span>{t('Since start')} <span class="muted">({dur(Date.now() - settings.passageStart)})</span></span><b class="num">{fmtDist(leg?.dist)} · Ø {fmtSpeed(avg(leg))}</b></div>
			{/if}
			<label class="prow">
				<span>{t('Destination')}</span>
				<select bind:value={settings.destId}>
					<option value={null}>—</option>
					{#each tools.markers as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
				</select>
			</label>
			{#if toDest}
				<div class="prow"><span>DTG · BRG</span><b class="num">{fmtDist(toDest.dtg)} · {fmtDeg(toDest.brg)}</b></div>
				<div class="prow"><span>VMG</span><b class="num">{fmtSpeed(toDest.vmg)}</b></div>
				<div class="prow"><span>{t('ETA at VMG')}</span><b class="num">{eta(toDest.dtg, toDest.vmg)}</b></div>
				<div class="prow"><span>{t('ETA at 24 h average')}</span><b class="num">{eta(toDest.dtg, avg(day))}</b></div>
			{:else if !tools.markers.length}
				<div class="muted small">{t('Place a marker on the radar (right-click or long press) and choose it as destination.')}</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.wrap { height: 100%; }
	.head { display: flex; justify-content: flex-end; padding: 8px 10px 0; }
	.mini { min-height: 28px; padding: 2px 10px; font-size: 12px; }
	.ss { padding: 6px 10px 2px; }
	.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 10px 12px; }
	.box { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px 8px; min-height: 70px; display: flex; flex-direction: column; justify-content: space-between; }
	.bl { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; font-weight: 800; letter-spacing: 0.8px; color: var(--muted); }
	.calc { font-size: 9.5px; font-weight: 700; color: var(--warn); letter-spacing: 0; border: 1px solid var(--warn); border-radius: 4px; padding: 0 4px; }
	.bv { font-size: 30px; font-weight: 800; line-height: 1.05; text-align: right; color: var(--text); white-space: nowrap; }
	.box.wide { grid-column: 1 / -1; }
	.bv.posv { font-size: 19px; white-space: pre-line; line-height: 1.2; }
	.bu { font-size: 12px; font-weight: 600; color: var(--muted); margin-left: 4px; }
	.editor { padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
	.erow { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
	.chk { display: flex; gap: 8px; align-items: center; font-size: 13px; }
	.arrows { display: flex; gap: 4px; }
	.empty { grid-column: 1 / -1; padding: 16px; text-align: center; }
	.small { font-size: 12px; }
	.pad { padding: 0 12px 12px; }
	.pass { margin: 0 10px 12px; padding: 8px 10px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; display: flex; flex-direction: column; gap: 6px; }
	.ph { display: flex; justify-content: space-between; align-items: center; }
	.prow { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; }
	.prow b { font-size: 15px; text-align: right; }
	.prow select { max-width: 50%; }
</style>
