<script lang="ts">
	// Zeitregler für die Wetter-Ebenen: erscheint, sobald ein Modell aktiv ist. Achse = Vereinigung der
	// Modellzeiträume; zeigt die Werte der aktiven Modelle an der Schiffsposition.
	import { wx, fields, wxModel, wxId, activeWx, wxRange, setWxTime, wxAbout, wxRunText, wxErrorText } from '../chart/weather.svelte';
	import { sample, timeIndex, UNIT } from '../chart/wxField';
	import { own } from '../data/signalk.svelte';
	import { dec } from '../lib/geo';
	import { t, isDe } from '../lib/i18n.svelte';

	const HOUR = 3600e3;
	const MODES = [['static', 'Static'], ['animated', 'Animated'], ['both', 'Both']] as const;
	const active = $derived.by(() => {
		wx.version;
		return activeWx();
	});
	const range = $derived.by(() => {
		wx.version;
		active;
		return wxRange();
	});
	const loading = $derived(active.some((l) => wx.status[wxId(l.id)]?.loading));
	const fmt = (ms: number) =>
		new Date(ms).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
	const rel = $derived.by(() => {
		const h = Math.round((wx.time - Date.now()) / HOUR);
		return h === 0 ? t('now') : (h > 0 ? '+' : '') + h + ' h';
	});
	const values = $derived.by(() => {
		wx.version;
		wx.time;
		const p = own.pos;
		return active.map((l) => {
			const m = wxModel(l.id)!;
			const f = fields.get(m.id);
			const s = f && p ? sample(f, timeIndex(f, wx.time), p.lat, p.lon) : null;
			let v = '—';
			if (s) {
				v = `${dec(s.s, m.kind === 'wind' ? 0 : 1)} ${UNIT[m.kind]} ${Math.round(s.dir)}°`;
				if (m.kind === 'wave' && s.p != null) v += ` ${Math.round(s.p)} s`;
				if (m.kind === 'wind' && s.p != null) v += ` G ${Math.round(s.p)}`;
			} else if (f && timeIndex(f, wx.time) < 0) v = t('no data at this time');
			const err = wxErrorText(l.id);
			if (err && !f) v = wxErrorText(l.id, true);
			return { l, kind: m.kind, name: m.name, v, about: err ? err + '\n\n' + wxAbout(m) : wxAbout(m), run: err && f ? wxErrorText(l.id, true) : wxRunText(l.id) };
		});
	});
	// Abspielen: 1 h je Schritt bei kurzen Vorhersagen, sonst 3 h; am Ende wieder von vorn
	let playing = $state(false);
	$effect(() => {
		if (!playing) return;
		const iv = setInterval(() => {
			const rg = wxRange();
			if (!rg) return;
			const h = rg[1] - rg[0] > 3 * 24 * HOUR ? 3 : 1;
			setWxTime(wx.time + h * HOUR > rg[1] ? rg[0] : wx.time + h * HOUR);
		}, 700);
		return () => clearInterval(iv);
	});
	$effect(() => {
		if (!active.length) playing = false;
	});
	const step = (h: number) => {
		if (!range) return;
		setWxTime(Math.min(range[1], Math.max(range[0], wx.time + h * HOUR)));
	};
</script>

{#if active.length}
	<div class="bar" onpointerdown={(e) => e.stopPropagation()} onwheel={(e) => e.stopPropagation()} role="group" aria-label={t('Forecast time')}>
		<div class="top">
			<button class="mini play" class:on={playing} onclick={() => (playing = !playing)} aria-label={t(playing ? 'Pause' : 'Play')} title={t(playing ? 'Pause' : 'Play')}>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">{#if playing}<rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />{:else}<path d="M7 5l12 7-12 7z" />{/if}</svg>
			</button>
			<button class="mini" onclick={() => step(-3)} aria-label="-3 h">−3h</button>
			<button class="mini" onclick={() => step(-1)} aria-label="-1 h">−1h</button>
			<b class="num when">{fmt(wx.time)} <span class="rel">{rel}</span></b>
			<button class="mini" onclick={() => step(1)} aria-label="+1 h">+1h</button>
			<button class="mini" onclick={() => step(3)} aria-label="+3 h">+3h</button>
			<button class="mini" class:on={wx.live} onclick={() => { playing = false; setWxTime(Date.now()); }}>{t('Now')}</button>
		</div>
		{#if range}
			<input type="range" min={range[0]} max={range[1]} step={HOUR} value={wx.time} oninput={(e) => setWxTime(Number((e.target as HTMLInputElement).value))} aria-label={t('Forecast time')} />
			<div class="axis small num"><span>{fmt(range[0])}</span><span>{fmt(range[1])}</span></div>
		{:else}
			<div class="small muted">{loading ? t('Loading weather models… (the Pi fetches one model about every 25 s)') : t('No weather data yet.')}</div>
		{/if}
		{#each values as v (v.l.id)}
			<div class="mrow small">
				<span class="num val" title={v.about}><i>{v.name}</i> {v.v}{#if v.run}<em>{v.run}</em>{/if}</span>
				<div class="seg" role="group" aria-label={t('Display')}>
					{#each MODES as [mode, label]}
						<button class="mini" class:on={(v.l.mode ?? 'static') === mode} onclick={() => (v.l.mode = mode)}>{t(label)}</button>
					{/each}
				</div>
				{#if v.kind === 'wind'}<button class="mini" class:on={v.l.isobars} onclick={() => (v.l.isobars = !v.l.isobars)} title={t('Isobars (air pressure, 2 hPa)')}>{t('Isobars')}</button>{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.bar {
		position: absolute;
		left: 50%;
		bottom: 16px;
		transform: translateX(-50%);
		width: min(620px, calc(100% - 24px));
		z-index: 12;
		background: color-mix(in srgb, var(--panel) 88%, transparent);
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 6px 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.top { display: flex; align-items: center; gap: 6px; }
	.when { flex: 1; text-align: center; font-size: 13px; }
	.rel { color: var(--accent); font-weight: 600; margin-left: 4px; }
	.mini { min-height: 26px; padding: 2px 8px; font-size: 12px; }
	.play { min-width: 34px; }
	input[type='range'] { width: 100%; accent-color: var(--accent); }
	.axis { display: flex; justify-content: space-between; color: var(--muted); }
	.small { font-size: 11px; }
	.muted { color: var(--muted); }
	.mrow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.val { flex: 1; min-width: 160px; }
	.val i { font-style: normal; color: var(--muted); margin-right: 3px; }
	.val em { display: block; font-style: normal; color: var(--muted); font-size: 10px; }
	.seg { display: flex; }
	.seg .mini { border-radius: 0; margin-left: -1px; }
	.seg .mini:first-child { border-radius: 6px 0 0 6px; }
	.seg .mini:last-child { border-radius: 0 6px 6px 0; }
	.mini.on { background: var(--accent); color: #000; }
</style>
