<script lang="ts">
	// Wachplaner: Crew, Teams, Wachmodell. Nur hier wird der Plan geändert; alle anderen Anzeigen lesen nur.
	import { PRESETS, COLORS, MAX_CREW, schedule, watchNow, unitName, hhmm, type Unit, type Mode } from '../../pi/chart-proxy/watch.mjs';
	import { wp, commit, presetOf, newId, showTz } from '../watch/watch.svelte';
	import { t, isDe } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let { now }: { now: number } = $props();
	const doc = $derived(wp.doc);
	const info = $derived(doc ? watchNow(doc, now) : null);
	const atL = $derived(info?.at != null ? hhmm(info.at, showTz()) : '');
	const upcoming = $derived(doc ? schedule(doc, now, now + 36 * 36e5).slice(0, 8) : []);
	const preset = $derived(doc ? presetOf(doc.model.preset) : null);
	const unitType = $derived<'team' | 'person'>(doc?.model.mode === 'rolling' ? 'person' : (doc?.model.units[0]?.t ?? (doc?.teams.length ? 'team' : 'person')));
	const pool = $derived(doc ? (unitType === 'team' ? doc.teams.map((x) => ({ t: 'team' as const, id: x.id })) : doc.crew.map((c) => ({ t: 'person' as const, id: c.id }))) : []);
	const unused = $derived(pool.filter((u) => !doc!.model.units.some((x) => x.t === u.t && x.id === u.id)));

	const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
	const fromTime = (s: string) => {
		const [h, m] = s.split(':').map(Number);
		return h * 60 + (m || 0);
	};
	const day = (ms: number) => new Date(ms).toLocaleDateString(isDe() ? 'de-DE' : 'en-GB', { timeZone: showTz(), weekday: 'short' });
	const label = (us: Unit[]) => us.map((u) => unitName(doc!, u)).join(' + ');

	function addCrew() {
		if (!doc || doc.crew.length >= MAX_CREW) return;
		const used = new Set(doc.crew.map((c) => c.color));
		doc.crew.push({ id: newId(), name: `${t('Crew')} ${doc.crew.length + 1}`, color: COLORS.find((c) => !used.has(c)) ?? COLORS[0], role: 'crew' });
		commit();
	}
	function removeCrew(id: string) {
		if (!doc) return;
		doc.crew = doc.crew.filter((c) => c.id !== id);
		for (const tm of doc.teams) tm.members = tm.members.filter((m) => m !== id);
		doc.model.units = doc.model.units.filter((u) => !(u.t === 'person' && u.id === id));
		commit();
	}
	function addTeam() {
		if (!doc || doc.teams.length >= MAX_CREW) return;
		doc.teams.push({ id: newId(), name: `Team ${String.fromCharCode(65 + doc.teams.length)}`, color: COLORS[(doc.teams.length * 3) % COLORS.length], members: [] });
		commit();
	}
	function removeTeam(id: string) {
		if (!doc) return;
		doc.teams = doc.teams.filter((x) => x.id !== id);
		doc.model.units = doc.model.units.filter((u) => !(u.t === 'team' && u.id === id));
		commit();
	}
	function toggleMember(teamId: string, crewId: string) {
		const tm = doc!.teams.find((x) => x.id === teamId)!;
		// eine Person gehört zu höchstens einem Team
		if (tm.members.includes(crewId)) tm.members = tm.members.filter((m) => m !== crewId);
		else {
			for (const o of doc!.teams) o.members = o.members.filter((m) => m !== crewId);
			tm.members.push(crewId);
		}
		commit();
	}
	/** Personenzahl, mit der ein Modell aufgeht (Einheit = Person oder Team, max. 8 Personen) */
	const fits = (p: { mode: Mode; units: number }) => (p.mode === 'rolling' ? '3–8' : p.units ? Array.from({ length: Math.floor(MAX_CREW / p.units) }, (_, i) => (i + 1) * p.units).join(' / ') : '');
	// Laufender Plan ist gesperrt; Bearbeiten nur nach Rückfrage
	let unlocked = $state(false);
	const locked = $derived(!!doc && doc.active !== false && !unlocked);
	function startPlan() {
		const today = new Date().toISOString().slice(0, 10); // Plan läuft in UTC
		if (doc!.model.start < today) doc!.model.start = today;
		doc!.active = true;
		unlocked = false;
		commit();
	}
	function stopPlan() {
		if (!confirm(t('Stop the watch plan? The displays no longer show watches.'))) return;
		doc!.active = false;
		commit();
	}
	function unlock() {
		if (confirm(t('The watch plan is running. Changes take effect immediately on the current and upcoming watches. Edit anyway?'))) unlocked = true;
	}
	function cycleColor(o: { color: string }) {
		o.color = COLORS[(COLORS.indexOf(o.color) + 1) % COLORS.length];
		commit();
	}
	function choosePreset(id: string) {
		const p = presetOf(id);
		const m = doc!.model;
		m.preset = id;
		if (id === 'custom') return commit();
		m.mode = p.mode;
		m.starts = [...p.starts];
		m.dayOff = !!p.dayOff;
		if (p.mode === 'rolling') {
			m.shift = p.shift;
			m.on = p.on;
			m.units = doc!.crew.map((c) => ({ t: 'person', id: c.id }));
		} else if (p.units) {
			const src = doc!.teams.length >= p.units ? doc!.teams.map((x) => ({ t: 'team' as const, id: x.id })) : doc!.crew.map((c) => ({ t: 'person' as const, id: c.id }));
			m.units = src.slice(0, p.units);
		}
		commit();
	}
	/** jede Änderung am Zeitmodell macht daraus ein eigenes Modell */
	const custom = () => {
		doc!.model.preset = 'custom';
		commit();
	};
	function setUnitType(tp: 'team' | 'person') {
		doc!.model.units = (tp === 'team' ? doc!.teams.map((x) => ({ t: 'team' as const, id: x.id })) : doc!.crew.map((c) => ({ t: 'person' as const, id: c.id }))).slice(0, Math.max(2, presetOf(doc!.model.preset).units || 8));
		commit();
	}
	function moveUnit(i: number, d: number) {
		const u = doc!.model.units;
		const j = i + d;
		if (j < 0 || j >= u.length) return;
		[u[i], u[j]] = [u[j], u[i]];
		commit();
	}
	function setMode(mode: Mode) {
		const m = doc!.model;
		m.mode = mode;
		if (mode === 'rolling') {
			m.shift ??= 60;
			m.on ??= 2;
			m.starts = [m.starts[0] ?? 0];
			m.units = doc!.crew.map((c) => ({ t: 'person', id: c.id }));
			m.dayOff = false;
		}
		custom();
	}
	function setStart(i: number, v: string) {
		const s = doc!.model.starts;
		s[i] = fromTime(v);
		doc!.model.starts = [...new Set(s)].sort((a, b) => a - b);
		custom();
	}
	function addStart() {
		const s = doc!.model.starts;
		const last = s[s.length - 1] ?? 0;
		const nxt = Math.min(1439, last + 120);
		if (!s.includes(nxt)) s.push(nxt);
		custom();
	}
</script>

<div class="wrap scroll">
	{#if !doc}
		<section><div class="muted small">{wp.err ? t('Watch plan not reachable on the Pi: {e}', { e: wp.err }) : t('loading…')}</div></section>
	{:else}
		<section>
			<div class="title">
				<b>{t('On watch')}</b>
				<div class="btns">
					<button class="mini" onclick={() => (wp.calendar = true)}><Icon name="calendar" size={14} /> {t('Calendar')}</button>
					{#if doc.active === false}<button class="mini go" onclick={startPlan} disabled={!doc.model.units.length}>{t('Start')}</button>
					{:else}<button class="mini" onclick={stopPlan}>{t('Stop')}</button>{/if}
				</div>
			</div>
			{#if info?.on}
				<div class="now">
					<div><span class="muted small">{t('Now')}</span> <b>{info.now?.label || '—'}</b>{#if info.now && info.now.names.join(' + ') !== info.now.label}<span class="muted small"> ({info.now.names.join(', ')})</span>{/if}</div>
					{#if info.off}<div><span class="muted small">{t('Day off today')}</span> <b>{info.off}</b></div>{/if}
					<div class:soon={info.soon}><span class="muted small">{t('Change {t}', { t: atL })}</span> <b>{info.next?.label ?? '—'}</b> <span class="muted small num">{t('in {m} min', { m: info.inMin ?? 0 })}</span></div>
				</div>
				<div class="list small num">
					{#each upcoming as w (w.start)}
						<div><span class="muted">{day(w.start)} {hhmm(w.start, showTz())}–{hhmm(w.end, showTz())}</span> {doc.model.mode === 'rolling' ? w.members.map((m) => doc.crew.find((c) => c.id === m)?.name).join(', ') : label(w.units)}</div>
					{/each}
				</div>
			{:else if doc.active === false && doc.model.units.length}
				<div class="muted small">{t('Watch plan stopped. Press Start when the watches begin; until then the displays show no watches.')}</div>
			{:else}
				<div class="muted small">{t('No watch plan yet: add crew, optionally teams, then choose a watch system below.')}</div>
			{/if}
			{#if wp.err}<div class="err small">{t(wp.err)}</div>{/if}
			{#if locked}
				<div class="row small"><span class="muted grow">{t('The plan is running and locked against changes.')}</span><button class="mini" onclick={unlock}>{t('Edit plan')}</button></div>
			{:else if doc.active !== false}
				<div class="row small"><span class="warn grow">{t('Editing the running plan.')}</span><button class="mini" onclick={() => (unlocked = false)}>{t('Lock')}</button></div>
			{/if}
		</section>

		<fieldset class="edit" disabled={locked}>

		<section>
			<div class="title"><b>{t('Crew ({n} of {max})', { n: doc.crew.length, max: MAX_CREW })}</b><button class="mini" onclick={addCrew} disabled={doc.crew.length >= MAX_CREW}><Icon name="plus" size={14} /> {t('Person')}</button></div>
			{#each doc.crew as c (c.id)}
				<div class="row">
					<button class="dot" style="background:{c.color}" onclick={() => cycleColor(c)} title={t('Change colour')} aria-label={t('Change colour')}></button>
					<input type="text" bind:value={c.name} maxlength="30" oninput={commit} aria-label={t('Name')} />
					<select bind:value={c.role} onchange={commit} aria-label={t('Role')}>
						<option value="skipper">{t('Skipper')}</option>
						<option value="leader">{t('Watch leader')}</option>
						<option value="crew">{t('Crew')}</option>
					</select>
					<button class="mini" onclick={() => removeCrew(c.id)} aria-label={t('Remove')}><Icon name="trash" size={14} /></button>
				</div>
			{/each}
		</section>

		<section>
			<div class="title"><b>{t('Teams')}</b><button class="mini" onclick={addTeam} disabled={doc.teams.length >= MAX_CREW || !doc.crew.length}><Icon name="plus" size={14} /> {t('Team')}</button></div>
			<div class="muted small">{t('Optional. Without teams each person is a watch of their own.')}</div>
			{#each doc.teams as tm (tm.id)}
				<div class="team">
					<div class="row">
						<button class="dot" style="background:{tm.color}" onclick={() => cycleColor(tm)} title={t('Change colour')} aria-label={t('Change colour')}></button>
						<input type="text" bind:value={tm.name} maxlength="30" oninput={commit} aria-label={t('Name')} />
						<button class="mini" onclick={() => removeTeam(tm.id)} aria-label={t('Remove')}><Icon name="trash" size={14} /></button>
					</div>
					<div class="chips">
						{#each doc.crew as c (c.id)}
							<button class="chip" class:on={tm.members.includes(c.id)} onclick={() => toggleMember(tm.id, c.id)}>{c.name}</button>
						{/each}
					</div>
				</div>
			{/each}
		</section>

		<section>
			<b>{t('Watch system')}</b>
			<select value={doc.model.preset} onchange={(e) => choosePreset(e.currentTarget.value)} aria-label={t('Watch system')}>
				{#each PRESETS as p}<option value={p.id}>{t(p.name)}{#if fits(p)}{' · '}{t('{n} people', { n: fits(p) })}{/if}</option>{/each}
			</select>
			{#if preset}<div class="info small">{t(preset.info)}{#if preset.units}<span class="muted"> {t('Needs {n} watches.', { n: preset.units })}</span>{/if}</div>{/if}

			{#if doc.model.mode !== 'rolling'}
				<div class="seg">
					<button class:on={unitType === 'team'} disabled={!doc.teams.length} onclick={() => setUnitType('team')}>{t('Teams')}</button>
					<button class:on={unitType === 'person'} onclick={() => setUnitType('person')}>{t('Individuals')}</button>
				</div>
			{/if}
			<div class="small muted">{t('Watch order')}</div>
			{#each doc.model.units as u, i (u.t + u.id)}
				<div class="row">
					<span class="num muted">{i + 1}.</span>
					<span class="grow">{unitName(doc, u)}</span>
					<button class="mini" onclick={() => moveUnit(i, -1)} aria-label={t('Move up')}>▲</button>
					<button class="mini" onclick={() => moveUnit(i, 1)} aria-label={t('Move down')}>▼</button>
					<button class="mini" onclick={() => { doc.model.units.splice(i, 1); commit(); }} aria-label={t('Remove')}><Icon name="x" size={14} /></button>
				</div>
			{/each}
			{#if unused.length}
				<select value="" onchange={(e) => { const u = unused.find((x) => x.id === e.currentTarget.value); if (u) { doc.model.units.push(u); commit(); } e.currentTarget.value = ''; }} aria-label={t('Add to watch order')}>
					<option value="">{t('+ add to watch order')}</option>
					{#each unused as u}<option value={u.id}>{unitName(doc, u)}</option>{/each}
				</select>
			{/if}
			{#if preset && preset.units && doc.model.units.length !== preset.units && doc.model.preset !== 'custom'}<div class="warn small">{t('This system is meant for {n} watches, the order has {m}.', { n: preset.units, m: doc.model.units.length })}</div>{/if}

			<div class="small muted">{t('Rhythm')}</div>
			<div class="seg">
				<button class:on={doc.model.mode === 'rotate'} onclick={() => setMode('rotate')}>{t('Rotating')}</button>
				<button class:on={doc.model.mode === 'fixed'} onclick={() => setMode('fixed')}>{t('Fixed')}</button>
				<button class:on={doc.model.mode === 'rolling'} onclick={() => setMode('rolling')}>{t('Rolling')}</button>
			</div>
			<div class="muted small">
				{#if doc.model.mode === 'rotate'}{t('Watches continue across midnight; with an odd number per day the night watches move on daily.')}
				{:else if doc.model.mode === 'fixed'}{t('Every day the same: watch 1 → first in the order, watch 2 → second, …')}
				{:else}{t('One person changes at each interval; each stands several intervals.')}{/if}
			</div>
			{#if doc.model.mode !== 'rolling'}
				<label class="ctl"><span>{t('Rotating day off (one watch free each day)')}</span><input type="checkbox" checked={!!doc.model.dayOff} onchange={(e) => { doc.model.dayOff = e.currentTarget.checked; custom(); }} /></label>
			{/if}

			{#if doc.model.mode === 'rolling'}
				<label class="ctl"><span>{t('First change (UTC)')}</span><input type="time" value={toTime(doc.model.starts[0] ?? 0)} onchange={(e) => setStart(0, e.currentTarget.value)} /></label>
				<label class="ctl"><span>{t('Change every')}</span>
					<select value={doc.model.shift} onchange={(e) => { doc.model.shift = Number(e.currentTarget.value); custom(); }}>
						{#each [30, 60, 90, 120, 180, 240] as s}<option value={s}>{s < 60 ? `${s} min` : `${s / 60} h`}</option>{/each}
					</select>
				</label>
				<label class="ctl"><span>{t('People on watch at once')}</span>
					<select value={doc.model.on} onchange={(e) => { doc.model.on = Number(e.currentTarget.value); custom(); }}>
						{#each [1, 2, 3, 4] as n}<option value={n}>{n}</option>{/each}
					</select>
				</label>
			{:else}
				<div class="small muted">{t('Watch start times in UTC (a watch ends when the next one starts)')}</div>
				<div class="starts">
					{#each doc.model.starts as s, i (i + '-' + s)}
						<span class="st">
							<input type="time" value={toTime(s)} onchange={(e) => setStart(i, e.currentTarget.value)} />
							{#if doc.model.starts.length > 1}<button class="mini" onclick={() => { doc.model.starts.splice(i, 1); custom(); }} aria-label={t('Remove')}><Icon name="x" size={12} /></button>{/if}
						</span>
					{/each}
					<button class="mini" onclick={addStart} disabled={doc.model.starts.length >= 48} aria-label={t('Add watch')}><Icon name="plus" size={14} /></button>
				</div>
			{/if}
			<label class="ctl"><span>{t('Rotation starts on')}</span><input type="date" bind:value={doc.model.start} onchange={commit} /></label>
		</section>

		<section>
			<b>{t('Time')}</b>
			<div class="small">{t('The plan runs in UTC, so a passage across time zones shifts nothing. Times are shown in local time ({z}).', { z: showTz() })}</div>
			{#if doc.tz !== 'UTC'}<div class="btns"><button class="mini" onclick={() => { doc.tz = 'UTC'; doc.overrides = []; commit(); }}>{t('Switch plan to UTC (was {z})', { z: doc.tz })}</button></div>{/if}
			<div class="muted small">{t('Only this app changes the plan; MFD, Mini Dash and Cabin Watch only show it.')}</div>
		</section>
		</fieldset>
	{/if}
</div>

<style>
	.wrap { height: 100%; }
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.title { display: flex; justify-content: space-between; align-items: center; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; }
	.small { font-size: 12px; }
	.row { display: flex; gap: 6px; align-items: center; }
	.row input[type='text'] { flex: 1; min-width: 0; }
	.grow { flex: 1; }
	.dot { width: 22px; min-width: 22px; height: 22px; min-height: 22px; padding: 0; border-radius: 50%; border: 2px solid var(--line); }
	.team { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; }
	.chips { display: flex; flex-wrap: wrap; gap: 4px; }
	.chip { min-height: 26px; padding: 2px 8px; font-size: 12px; border-radius: 13px; }
	.now { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
	.soon { color: var(--warn); }
	.soon b { color: var(--warn); }
	.list { display: flex; flex-direction: column; gap: 2px; }
	.info { line-height: 1.4; }
	.starts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
	.st { display: inline-flex; gap: 2px; align-items: center; }
	.ctl { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
	.btns { display: flex; flex-wrap: wrap; gap: 6px; }
	.err { color: var(--alarm); }
	.warn { color: var(--warn); }
	.edit { border: 0; padding: 0; margin: 0; min-width: 0; }
	.edit:disabled { opacity: 0.5; }
	.go { border-color: var(--ok); color: var(--ok); }
	input[type='text'], input[type='time'], input[type='date'] { font: inherit; color: var(--text); background: var(--btn); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; min-height: 32px; }
</style>
