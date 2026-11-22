<script lang="ts">
	// Wachkalender (Vollbild): Woche oder Tag in Ortszeit (nur Anzeige, Plan in UTC). Tipp auf eine Wache → anders einteilen (Ausnahme).
	import { schedule, zoned, dayOf, hhmm, unitName, restOf, restText, offAt, type Unit, type Watch } from '../../pi/chart-proxy/watch.mjs';
	import { wp, commit, showTz } from '../watch/watch.svelte';
	import { t, isDe } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let { now }: { now: number } = $props();
	const doc = $derived(wp.doc!);
	let view = $state<'week' | 'day'>(innerWidth < 900 ? 'day' : 'week');
	let shift = $state(0); // Wochen bzw. Tage ab heute
	let pick = $state<Watch | null>(null);

	const tz = $derived(showTz());
	const HOUR = 30; // px je Stunde
	const today = $derived(dayOf(now, tz));
	/** Tage der Ansicht (UTC-Mitternacht des Bordkalendertags) */
	const days = $derived.by(() => {
		const base = Date.UTC(today.y, today.m - 1, today.d);
		if (view === 'day') return [base + shift * 864e5];
		const wd = (new Date(base).getUTCDay() + 6) % 7; // Montag = 0
		return Array.from({ length: 7 }, (_, i) => base + (shift * 7 - wd + i) * 864e5);
	});
	const bounds = (dU: number) => {
		const a = new Date(dU), b = new Date(dU + 864e5);
		return [zoned(a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate(), 0, tz), zoned(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate(), 0, tz)];
	};
	const cols = $derived(days.map((dU) => ({ dU, b: bounds(dU) })));
	const watches = $derived(schedule(doc, cols[0].b[0], cols[cols.length - 1].b[1]));
	// ±2 Tage drumherum, damit die Pause vor/nach jeder sichtbaren Wache bekannt ist
	const around = $derived(schedule(doc, cols[0].b[0] - 2 * 864e5, cols[cols.length - 1].b[1] + 2 * 864e5));
	const rest = (w: Watch) => { const r = restOf(around, w); return { rb: restText(r.rb), ra: restText(r.ra) }; };
	const lanes = $derived(doc.model.mode === 'rolling' ? (doc.model.on ?? 1) : 1);
	const loc = () => (isDe() ? 'de-DE' : 'en-GB');
	const dayName = (dU: number) => new Date(dU).toLocaleDateString(loc(), { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'numeric' });
	const title = $derived(
		view === 'day'
			? new Date(days[0]).toLocaleDateString(loc(), { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
			: `${new Date(days[0]).toLocaleDateString(loc(), { timeZone: 'UTC', day: 'numeric', month: 'short' })} – ${new Date(days[6]).toLocaleDateString(loc(), { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })}`
	);
	const isOverride = (w: Watch) => doc.overrides.some((o) => o.start === w.start);
	const colorOf = (w: Watch) => {
		const u = w.units[0];
		if (!u) return '#888';
		return (u.t === 'team' ? doc.teams.find((x) => x.id === u.id)?.color : doc.crew.find((c) => c.id === u.id)?.color) ?? '#888';
	};
	const names = (w: Watch) => w.members.map((m) => doc.crew.find((c) => c.id === m)?.name).filter(Boolean).join(', ');
	const label = (w: Watch) => (doc.model.mode === 'rolling' ? names(w) : w.units.map((u) => unitName(doc, u)).join(' + '));
	/** Teilstücke einer Wache je Tagesspalte (Wachen über Mitternacht werden geteilt) */
	function pieces(col: { b: number[] }) {
		const [s, e] = col.b;
		return watches
			.map((w, i) => ({ w, i, a: Math.max(w.start, s), z: Math.min(w.end, e) }))
			.filter((p) => p.z > p.a)
			.map((p) => ({ ...p, top: ((p.a - s) / (e - s)) * 24 * HOUR, h: ((p.z - p.a) / (e - s)) * 24 * HOUR, lane: lanes > 1 ? p.i % lanes : 0 }));
	}
	const allUnits = $derived<Unit[]>([...doc.teams.map((x) => ({ t: 'team' as const, id: x.id })), ...doc.crew.map((c) => ({ t: 'person' as const, id: c.id }))]);
	function assign(w: Watch, u: Unit | null) {
		if (doc.active !== false && !confirm(t('The watch plan is running. Change this watch?'))) return;
		doc.overrides = doc.overrides.filter((o) => o.start !== w.start);
		if (u) doc.overrides.push({ start: w.start, units: [u] });
		commit();
		pick = null;
	}
	const close = () => ((wp.calendar = false), (pick = null));
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div class="cal" role="dialog" aria-modal="true" aria-label={t('Watch calendar')}>
	<header>
		<b><Icon name="calendar" size={18} /> {t('Watch calendar')}</b>
		<div class="nav">
			<button onclick={() => shift--} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
			<button onclick={() => (shift = 0)}>{t('Today')}</button>
			<button onclick={() => shift++} aria-label={t('Forward')}><Icon name="chevronRight" /></button>
			<span class="ttl">{title}</span>
		</div>
		<div class="seg">
			<button class:on={view === 'week'} onclick={() => ((view = 'week'), (shift = 0))}>{t('Week')}</button>
			<button class:on={view === 'day'} onclick={() => ((view = 'day'), (shift = 0))}>{t('Day')}</button>
		</div>
		<span class="muted small">{t('Local time {z} · plan in UTC', { z: tz })}</span>
		<button onclick={close} aria-label={t('Close')}><Icon name="x" /></button>
	</header>

	<div class="legend small">
		{#each doc.model.mode === 'rolling' || !doc.model.units.some((u) => u.t === 'team') ? doc.crew : doc.teams as x (x.id)}
			<span><i style="background:{x.color}"></i>{x.name}</span>
		{/each}
		<span class="muted">{t('Tap a watch to assign it to someone else.')}</span>
	</div>

	<div class="grid scroll">
		<div class="hdr" style="grid-template-columns: 48px repeat({cols.length}, 1fr)">
			<span></span>
			{#each cols as c (c.dU)}{@const off = offAt(doc, (c.b[0] + c.b[1]) / 2)}<span class:today={c.b[0] <= now && now < c.b[1]}>{dayName(c.dU)}{#if off}<small class="off">{t('off: {n}', { n: unitName(doc, off) })}</small>{/if}</span>{/each}
		</div>
		<div class="body" style="grid-template-columns: 48px repeat({cols.length}, 1fr); height:{24 * HOUR}px">
			<div class="hours">{#each Array.from({ length: 24 }, (_, h) => h) as h}<span style="top:{h * HOUR}px">{String(h).padStart(2, '0')}</span>{/each}</div>
			{#each cols as c (c.dU)}
				<div class="col">
					{#each Array.from({ length: 24 }, (_, h) => h) as h}<div class="hl" style="top:{h * HOUR}px"></div>{/each}
					{#each pieces(c) as p (p.w.start + '-' + p.i)}
						<button
							class="blk"
							class:ovr={isOverride(p.w)}
							class:cur={p.w.start <= now && now < p.w.end}
							style="top:{p.top}px; height:{p.h - 2}px; left:{(p.lane / lanes) * 100}%; width:calc({100 / lanes}% - 3px); --c:{colorOf(p.w)}"
							onclick={() => (pick = p.w)}
							title="{hhmm(p.w.start, tz)}–{hhmm(p.w.end, tz)} {label(p.w)}"
						>
							<b>{label(p.w)}</b>
							{#if p.h > 30}<span class="num">{hhmm(p.w.start, tz)}–{hhmm(p.w.end, tz)}</span>{/if}
							{#if p.h > 60}{@const r = rest(p.w)}<span>{t('from {h} rest', { h: r.rb })}</span><span>{t('then {h} rest', { h: r.ra })}</span>{/if}
							{#if view === 'day' && p.h > 46 && doc.model.mode !== 'rolling'}<span>{names(p.w)}</span>{/if}
						</button>
					{/each}
					{#if c.b[0] <= now && now < c.b[1]}<div class="nowline" style="top:{((now - c.b[0]) / (c.b[1] - c.b[0])) * 24 * HOUR}px"></div>{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if pick}
		{@const w = pick}
		{@const r = rest(w)}
		<div class="pick" role="dialog" aria-label={t('Assign watch')}>
			<div class="title">
				<b>{new Date(w.start).toLocaleDateString(loc(), { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric' })} {hhmm(w.start, tz)}–{hhmm(w.end, tz)}</b>
				<button class="mini" onclick={() => (pick = null)} aria-label={t('Close')}><Icon name="x" size={14} /></button>
			</div>
			<div class="small muted">{t('Planned: {n}', { n: label(w) })}</div>
			<div class="small muted">{t('from {h} rest', { h: r.rb })} · {t('then {h} rest', { h: r.ra })}</div>
			<div class="opts">
				{#each allUnits as u (u.t + u.id)}
					<button class:on={w.units.length === 1 && w.units[0].t === u.t && w.units[0].id === u.id} onclick={() => assign(w, u)}>
						{#if u.t === 'team'}<Icon name="users" size={14} />{/if} {unitName(doc, u)}
					</button>
				{/each}
			</div>
			{#if isOverride(w)}<button onclick={() => assign(w, null)}>{t('Back to plan')}</button>{/if}
		</div>
	{/if}
</div>

<style>
	.cal { position: fixed; inset: 0; z-index: 200; background: var(--bg, var(--panel)); display: flex; flex-direction: column; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
	header { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
	header b { display: flex; align-items: center; gap: 6px; }
	.nav { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
	.ttl { margin-left: 8px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.small { font-size: 12px; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; }
	.legend { display: flex; flex-wrap: wrap; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
	.legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
	.grid { flex: 1; min-height: 0; overflow: auto; }
	.hdr { display: grid; position: sticky; top: 0; z-index: 3; background: var(--panel); border-bottom: 1px solid var(--line); }
	.hdr span { text-align: center; padding: 6px 2px; font-size: 13px; font-weight: 600; }
	.hdr .today { color: var(--accent); }
	.body { display: grid; position: relative; }
	.hours { position: relative; }
	.hours span { position: absolute; right: 6px; transform: translateY(-50%); font-size: 11px; color: var(--muted); }
	.hours span:first-child { transform: none; }
	.col { position: relative; border-left: 1px solid var(--line); }
	.hl { position: absolute; left: 0; right: 0; border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
	.blk { position: absolute; margin-left: 2px; padding: 2px 5px; min-height: 0; border-radius: 5px; border: 1px solid var(--c); border-left: 4px solid var(--c); background: color-mix(in srgb, var(--c) 28%, var(--panel)); color: var(--text); display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: 0; overflow: hidden; font-size: 12px; line-height: 1.25; text-align: left; z-index: 1; }
	.blk b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
	.blk span { font-size: 11px; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
	.blk.ovr { border-style: dashed; border-left-style: solid; }
	.off { display: block; font-size: 11px; font-weight: 400; opacity: 0.8; }
	.blk.cur { box-shadow: 0 0 0 2px var(--accent); }
	.nowline { position: absolute; left: 0; right: 0; border-top: 2px solid var(--alarm); z-index: 2; pointer-events: none; }
	.pick { position: absolute; right: 16px; bottom: 16px; width: min(360px, calc(100% - 32px)); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; z-index: 5; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); }
	.pick .title { display: flex; justify-content: space-between; align-items: center; }
	.opts { display: flex; flex-wrap: wrap; gap: 6px; }
	.opts button { gap: 4px; }
</style>
