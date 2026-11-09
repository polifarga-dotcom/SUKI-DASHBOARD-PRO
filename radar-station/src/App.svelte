<script lang="ts">
	import { onMount } from 'svelte';
	import { settings } from './lib/settings.svelte';
	import { connectSignalK, reconnectSignalK, signalKSilence, own, sk, pruneVessels, ownFresh } from './data/signalk.svelte';
	import { connectMayara, resumeMayara, radar } from './data/mayara.svelte';
	import { computeTargets, ui } from './collision/targets.svelte';
	import { evaluateAlarms, alarms, ackAll, ackAlarm, muteFor, watch, confirmWatch, setWatch } from './alarms/alarms.svelte';
	import { unlockAudio } from './alarms/audio';
	import { startAlarmSync } from './alarms/alarmsync.svelte';
	import { startSim } from './sim/simulator';
	import { tools, addMarker } from './radar/tools.svelte';
	import { fmtDeg, fmtSpeed, fmtLat, fmtLon, dec } from './lib/geo';
	import RadarPane from './ui/RadarPane.svelte';
	import TargetsTab from './ui/TargetsTab.svelte';
	import RadarTab from './ui/RadarTab.svelte';
	import AlarmsTab from './ui/AlarmsTab.svelte';
	import SettingsTab from './ui/SettingsTab.svelte';
	import LayersTab from './ui/LayersTab.svelte';
	import InstrumentsTab from './ui/InstrumentsTab.svelte';
	import Icon from './ui/Icon.svelte';
	import AlarmBar from './ui/AlarmBar.svelte';
	import { loadProviders } from './chart/layers.svelte';
	import { t, timeFmt } from './lib/i18n.svelte';

	let clock = $state(new Date());
	/** neuere App-Version auf dem Pi (version.txt ≠ eigene Build-Kennung) */
	let updateReady = $state(false);

	$effect(() => {
		document.documentElement.dataset.theme = settings.theme;
	});

	onMount(() => {
		connectSignalK();
		connectMayara();
		loadProviders();
		const stopSync = startAlarmSync();
		if (settings.sim) setTimeout(startSim, 1500);
		const t1 = setInterval(() => computeTargets(), 500);
		const t2 = setInterval(() => {
			evaluateAlarms();
			clock = new Date();
		}, 1000);
		// Kielspur vom Pi
		// Kielspur: einmal komplett, danach nur neue Punkte anhängen (spart Daten und Rechenzeit)
		let trackHours = 0;
		const loadTrack = async () => {
			if (settings.trackHours <= 0) return (tools.track = []);
			const full = trackHours !== settings.trackHours || !tools.track.length;
			const last = tools.track.at(-1)?.[0] ?? 0;
			try {
				const r = await fetch(full ? `/tiles/api/track?hours=${settings.trackHours}` : `/tiles/api/track?since=${last}`, { cache: 'no-store' });
				if (!r.ok) return;
				const pts: [number, number, number][] = await r.json();
				trackHours = settings.trackHours;
				// letzter Punkt der Antwort ist ggf. die aktuelle Position (nicht gespeichert) → vorher entfernen
				const cut = Date.now() - settings.trackHours * 3600e3;
				const base = full ? [] : tools.track.slice(0, -1);
				tools.track = [...base, ...pts].filter((p) => p[0] >= cut);
			} catch {
				/* offline */
			}
		};
		loadTrack();
		// Update-Erkennung: alle 5 min und beim Zurückkommen aus dem Hintergrund
		const checkVersion = async () => {
			try {
				const r = await fetch('/version.txt', { cache: 'no-store' });
				if (r.ok) updateReady = (await r.text()).trim() !== __BUILD__;
			} catch {
				/* offline */
			}
		};
		checkVersion();
		const t5 = setInterval(checkVersion, 300000);
		document.addEventListener('visibilitychange', () => !document.hidden && checkVersion());
		const t4 = setInterval(loadTrack, 15000);
		const t3 = setInterval(() => {
			pruneVessels();
			loadProviders();
		}, 60000);
		window.addEventListener('pointerdown', unlockAudio, { once: false, passive: true });
		window.addEventListener('keydown', onKey);
		// iPad/Safari: nach Hintergrund oder Display-aus sind Verbindungen oft tot → alles frisch verbinden
		let hiddenAt = 0;
		const onVis = () => {
			if (document.hidden) hiddenAt = Date.now();
			else if (Date.now() - hiddenAt > 10000 || signalKSilence() > 10) {
				// SignalK nur neu verbinden, wenn wirklich nichts mehr kommt (Neuverbindung = ~2 MB Startdaten)
				setTimeout(() => {
					if (signalKSilence() > 3) reconnectSignalK();
				}, 3000);
				resumeMayara();
				tools.resume++;
				loadProviders();
			}
		};
		document.addEventListener('visibilitychange', onVis);
		window.addEventListener('pageshow', onVis);
		window.addEventListener('online', onVis);
		return () => {
			clearInterval(t1);
			clearInterval(t2);
			clearInterval(t3);
			clearInterval(t4);
			clearInterval(t5);
			stopSync();
			window.removeEventListener('keydown', onKey);
			document.removeEventListener('visibilitychange', onVis);
			window.removeEventListener('pageshow', onVis);
			window.removeEventListener('online', onVis);
		};
	});

	function onKey(e: KeyboardEvent) {
		if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
		const k = e.key;
		if (k === ' ') {
			ackAll();
			e.preventDefault();
		} else if (k === 'm' || k === 'M') muteFor(5);
		else if (k === 'o' || k === 'O') settings.orientation = settings.orientation === 'head' ? 'north' : settings.orientation === 'north' ? 'course' : 'head';
		else if (k === 'p' || k === 'P') settings.motion = settings.motion === 'center' ? 'lookahead' : settings.motion === 'lookahead' ? 'custom' : 'center';
		else if (k === 'a' || k === 'A') tools.tapMode = tools.tapMode === 'acquire' ? 'select' : 'acquire';
		else if (k === 'c' || k === 'C') document.querySelector<HTMLButtonElement>('.pane button[data-act="center-ship"]')?.click();
		else if (k === 'e' || k === 'E') tools.tapMode = tools.tapMode === 'ebl' ? 'select' : 'ebl';
		else if (k === '1' || k === '2') {
			tools.activeEbl = Number(k) - 1;
			tools.ebl[tools.activeEbl].on = !tools.ebl[tools.activeEbl].on;
		} else if (k === 'Escape') {
			tools.tapMode = 'select';
			tools.align = null;
			tools.measure = null;
			tools.menu = null;
			tools.cursor = null;
			ui.selected = null;
		} else if (k === 'n' || k === 'N') settings.theme = settings.theme === 'night' ? 'dusk' : 'night';
		else if (k === 'Tab') {
			settings.sidePanel = !settings.sidePanel;
			e.preventDefault();
		} else if (k === '+' || k === '=' || k === '-') {
			// an das erste Radarfenster weiterreichen
			document.querySelector<HTMLButtonElement>(`.pane button[data-act="${k === '-' ? 'range-in' : 'range-out'}"]`)?.click();
		}
	}

	const unacked = $derived(alarms.active.filter((a) => !a.acked).length);
	const nav = $derived.by(() => {
		clock;
		const depthFresh = own.depth != null && Date.now() - own.depthT < 15000;
		return { pos: own.pos, hdg: own.hdg, cog: own.cog, sog: own.sog, fresh: ownFresh(), depth: depthFresh ? own.depth : null, shallow: depthFresh && settings.shallowAlarm > 0 && own.depth! < settings.shallowAlarm };
	});

	// MOB: gedrückt halten (0,8 s), damit es nicht versehentlich auslöst
	let mobTimer: ReturnType<typeof setTimeout> | undefined;
	let mobHold = $state(false);
	function mobDown() {
		mobHold = true;
		mobTimer = setTimeout(() => {
			mobHold = false;
			if (own.pos) addMarker({ ...own.pos }, 'mob');
			settings.sidePanel = true;
			settings.sideTab = 'alarms';
		}, 800);
	}
	function mobUp() {
		mobHold = false;
		clearTimeout(mobTimer);
	}
	const dual = $derived(settings.dualRange && radar.list.length > 1);
	// Split an → Seitenleiste zu (mehr Platz für zwei Radarbilder), Split aus → wieder auf; danach frei umschaltbar
	let prevDual = settings.dualRange;
	$effect(() => {
		const d = settings.dualRange;
		if (d !== prevDual) settings.sidePanel = !d;
		prevDual = d;
	});
	const tabs = [
		['instruments', 'gauge', 'Instruments'],
		['targets', 'list', 'Targets'],
		['radar', 'radar', 'Radar'],
		['layers', 'layers', 'Layers'],
		['alarms', 'bell', 'Alarms'],
		['settings', 'gear', 'Settings']
	] as const;
</script>

<div class="app">
	<header class="top">
		<div class="brand"><Icon name="radar" size={20} /> <b>SUKI</b> <span class="muted">Radar</span></div>
		<div class="nav num">
			<span><i>HDG</i> {fmtDeg(nav.hdg)}</span>
			<span><i>COG</i> {fmtDeg(nav.cog)}</span>
			<span><i>SOG</i> {fmtSpeed(nav.sog)}</span>
			<span class:shallow={nav.shallow}><i>{t('DPT')}</i> {nav.depth != null ? `${dec(nav.depth, 1)} m` : '—'}</span>
			<span class="pos" class:stale={!nav.fresh}><span>{fmtLat(nav.pos?.lat)}</span> <span>{fmtLon(nav.pos?.lon)}</span></span>
		</div>
		<div class="status">
			{#if updateReady}<button class="update" onclick={() => location.reload()} title={t('A newer version is on the Pi – tap to load it')}>{t('Update available')}</button>{/if}
			<button class="mob" class:hold={mobHold} onpointerdown={mobDown} onpointerup={mobUp} onpointerleave={mobUp} onpointercancel={mobUp} title={t('Man overboard – hold')} aria-label={t('Man overboard – hold')}>MOB</button>
			<span class="pill" class:ok={sk.connected} title={sk.connected ? t('SignalK connected') : t('SignalK disconnected')}>SK</span>
			<span class="pill" class:ok={nav.fresh} class:warn={!nav.fresh && !!nav.pos} title={nav.fresh ? t('GPS position current') : nav.pos ? t('GPS position outdated') : t('No GPS position')}>GPS</span>
			<span class="pill" class:ok={radar.connected} title={t('Radar server')}>RDR</span>
			{#if settings.sim}<span class="pill sim">SIM</span>{/if}
			<span class="num clock">{timeFmt(clock)}</span>
			<!-- Wachalarm: Auge schaltet ein; eingeschaltet = Bestätigen mit Countdown + Aus-Knopf -->
			{#if settings.watchOn}
				{@const left = Math.round((watch.last + settings.watchMin * 60e3 - clock.getTime()) / 1000)}
				<span class="watchgrp">
					<button class="watchbtn num" class:due={left <= Math.min(60, settings.watchMin * 20)} class:over={left <= 0} onclick={confirmWatch} title={t('Confirm the watch')}>
						<Icon name="eye" /> {t('Watch OK')} {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : ''}
					</button>
					<button class="watchoff" onclick={() => setWatch(false)} title={t('Switch watch alarm off')} aria-label={t('Switch watch alarm off')}><Icon name="x" /></button>
				</span>
			{:else}
				<button onclick={() => setWatch(true)} title={t('Switch watch alarm on ({m} min)', { m: settings.watchMin })} aria-label={t('Switch watch alarm on ({m} min)', { m: settings.watchMin })}><Icon name="eye" /></button>
			{/if}
			<button class:on={settings.chart} onclick={() => (settings.chart = !settings.chart)} title={t('Chart overlay')} aria-label={t('Chart overlay')}><Icon name="map" /></button>
			{#if radar.list.length > 1}<button class:on={settings.dualRange} onclick={() => (settings.dualRange = !settings.dualRange)} title={t('Dual range')} aria-label={t('Dual range')}><Icon name="split" /></button>{/if}
			<button class:on={settings.theme === 'night'} onclick={() => (settings.theme = settings.theme === 'night' ? 'dusk' : 'night')} title={t('Night mode (N)')} aria-label={t('Night mode')}><Icon name="moon" /></button>
			<button class="mutebtn" class:muted={!settings.alarmSound} onclick={() => { unlockAudio(); settings.alarmSound = !settings.alarmSound; }} title={settings.alarmSound ? t('Mute all alarm sounds') : t('Switch alarm sounds on')} aria-label={settings.alarmSound ? t('Mute all alarm sounds') : t('Switch alarm sounds on')} aria-pressed={!settings.alarmSound}>
				<Icon name={settings.alarmSound ? 'volume' : 'volumeOff'} />{#if !settings.alarmSound}<span>{t('MUTED')}</span>{/if}
			</button>
			<button class="alarmbtn" class:hot={unacked > 0} onclick={() => { settings.sidePanel = true; settings.sideTab = 'alarms'; }} aria-label={t('Alarms')}>
				<Icon name="bell" />{#if unacked}<span class="badge">{unacked}</span>{/if}
			</button>
			<button class:on={settings.sidePanel} onclick={() => (settings.sidePanel = !settings.sidePanel)} title={t('Side panel (Tab)')} aria-label={t('Side panel')}><Icon name="panel" /></button>
		</div>
	</header>

	<main class:withside={settings.sidePanel}>
		<div class="screens">
			<AlarmBar now={clock.getTime()} />
			<button class="sidetoggle" onclick={() => (settings.sidePanel = !settings.sidePanel)} title={t('Side panel (Tab)')} aria-label={t('Side panel')} aria-expanded={settings.sidePanel}>
				<Icon name={settings.sidePanel ? 'chevronRight' : 'chevronLeft'} size={18} />
			</button>
			<div class="panes" class:dual>
				{#key settings.radarBase}
					<RadarPane radarId={settings.radarId} pane={0} label={dual ? 'A' : ''} />
					{#if dual}<RadarPane radarId={settings.radarIdB} pane={1} label="B" />{/if}
				{/key}
			</div>
		</div>
		{#if settings.sidePanel}
			<aside class="side">
				<nav class="tabs">
					{#each tabs as [id, icon, txt]}
						<button class:on={settings.sideTab === id} onclick={() => (settings.sideTab = id)}><Icon name={icon} size={16} /> {t(txt)}{#if id === 'alarms' && unacked}<span class="badge sm">{unacked}</span>{/if}</button>
					{/each}
				</nav>
				<div class="tabbody">
					{#if settings.sideTab === 'instruments'}<InstrumentsTab />
					{:else if settings.sideTab === 'targets'}<TargetsTab />
					{:else if settings.sideTab === 'radar'}<RadarTab radarId={settings.radarId} />
					{:else if settings.sideTab === 'layers'}<LayersTab />
					{:else if settings.sideTab === 'alarms'}<AlarmsTab />
					{:else}<SettingsTab />{/if}
				</div>
			</aside>
		{/if}
	</main>
</div>

<style>
	.app { display: flex; flex-direction: column; height: 100%; padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left); }
	.top { display: flex; align-items: center; gap: 16px; padding: 6px 12px; background: var(--panel); border-bottom: 1px solid var(--line); min-height: 50px; }
	.brand { display: flex; align-items: center; gap: 6px; font-size: 16px; color: var(--accent); }
	.brand b { color: var(--text); letter-spacing: 1px; }
	.nav { display: flex; gap: 18px; font-size: 15px; flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; }
	.nav i { font-style: normal; color: var(--muted); font-size: 11px; margin-right: 3px; }
	.pos { color: var(--muted); }
	.shallow { color: var(--alarm); font-weight: 700; }
	.mob { background: #c81e1e; border-color: #ff6b6b; color: #fff; font-weight: 800; letter-spacing: 1px; min-width: 58px; position: relative; overflow: hidden; }
	.mob.hold { background: #ff2a2a; box-shadow: 0 0 0 3px #ff2a2a66; }
	:global([data-theme='night']) .mob { background: #5a0b04; border-color: #ff3b1f; color: #ff6a4a; }
	.pos.stale { color: var(--warn); }
	.status { display: flex; align-items: center; gap: 6px; }
	/* Statusfelder kräftig: grün = ok, orange = veraltet, rot = fehlt */
	.pill { font-size: 11px; font-weight: 800; letter-spacing: 0.3px; padding: 4px 7px; border-radius: 6px; background: var(--pill-bad); color: var(--pill-bad-fg); }
	.pill.ok, .pill.warn { color: var(--pill-fg); }
	.pill.ok { background: var(--pill-ok); }
	.pill.warn { background: var(--pill-warn); }
	.pill.sim { background: var(--sim-bg); color: var(--sim-fg); }
	.clock { margin: 0 6px; color: var(--muted); }
	.watchgrp { display: inline-flex; gap: 2px; }
	.watchbtn { gap: 6px; font-weight: 700; }
	.watchbtn.due { background: var(--pill-warn); border-color: var(--pill-warn); color: var(--pill-fg); }
	.watchbtn.over { background: var(--pill-bad); border-color: var(--pill-bad); color: var(--pill-bad-fg); animation: mutepulse 1s ease-in-out infinite; }
	.alarmbtn { position: relative; }
	.update { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 800; font-size: 12px; }
	/* Stummschalter: aktiv = auffällig orange und blinkend, damit es nicht vergessen wird */
	.mutebtn.muted { background: var(--pill-warn); border-color: var(--pill-warn); color: var(--pill-fg); font-weight: 800; animation: mutepulse 1.6s ease-in-out infinite; }
	@keyframes mutepulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--pill-warn) 45%, transparent); } }
	.alarmbtn.hot { color: var(--alarm); border-color: var(--alarm); }
	.badge { position: absolute; top: -5px; right: -5px; background: var(--alarm); color: var(--on-accent); font-size: 10px; font-weight: 700; border-radius: 9px; min-width: 17px; height: 17px; display: grid; place-items: center; padding: 0 4px; }
	.badge.sm { position: static; margin-left: 2px; }
	main { flex: 1; display: grid; grid-template-columns: 1fr; min-height: 0; }
	main.withside { grid-template-columns: 1fr minmax(340px, 400px); }
	.screens { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--radar-bg); }
	.panes { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; }
	.panes.dual { grid-template-columns: 1fr 1fr; gap: 2px; background: var(--line); }
	/* Griff am rechten Rand des Radarbereichs: Seitenleiste ein-/ausklappen */
	.sidetoggle { position: absolute; right: 0; top: 50%; transform: translateY(-50%); z-index: 35; width: 22px; min-height: 64px; padding: 0; border-radius: 8px 0 0 8px; border-right: 0; background: color-mix(in srgb, var(--panel) 85%, transparent); }
	.side { display: flex; flex-direction: column; min-height: 0; background: var(--panel); border-left: 1px solid var(--line); }
	.tabs { display: grid; grid-template-columns: repeat(6, 1fr); border-bottom: 1px solid var(--line); }
	.tabs button { border: 0; border-radius: 0; background: transparent; font-size: 10.5px; padding: 6px 2px 5px; min-height: 48px; border-bottom: 2px solid transparent; flex-direction: column; gap: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; position: relative; }
	.tabs .badge.sm { position: absolute; top: 3px; right: 6px; }
	.tabs button.on { background: transparent; color: var(--accent); border-bottom-color: var(--accent); }
	.tabbody { flex: 1; min-height: 0; }
	@media (max-width: 1100px) {
		.clock, .brand .muted { display: none; }
		/* Position bleibt sichtbar: zweizeilig und kleiner statt ausgeblendet */
		.nav { gap: 12px; font-size: 14px; }
		.nav .pos { display: flex; flex-direction: column; font-size: 11.5px; line-height: 1.15; justify-content: center; }
		main.withside { grid-template-columns: 1fr 340px; }
	}
</style>
