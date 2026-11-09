<script lang="ts">
	import { settings, resetSettings } from '../lib/settings.svelte';
	import { radar, reconnectMayara } from '../data/mayara.svelte';
	import { startSim, stopSim } from '../sim/simulator';
	import { tools, removeMarker } from '../radar/tools.svelte';
	import { fmtLat, fmtLon, dec } from '../lib/geo';
	import { t } from '../lib/i18n.svelte';
	import { providers, putKey, testProvider } from '../chart/layers.svelte';
	import Icon from './Icon.svelte';

	// Kielspur: Anzeige-Länge in Stufen, Speicherung auf dem Pi (Tage, Größe, Löschen)
	const TRACK_STEPS = [0, 1, 2, 3, 6, 12, 24, 48, 72, 168, 336, 720, 2160, 8760];
	const trackIdx = $derived(Math.max(0, TRACK_STEPS.findIndex((h) => h >= settings.trackHours)));
	const trackLabel = (h: number) => (!h ? t('off') : h < 48 ? `${h} h` : t('{n} days', { n: h / 24 }));
	let trk: { days: number; bytes: number; files: number; first: string | null } | null = $state(null);
	const trackApi = async (init?: RequestInit) => {
		const r = await fetch('/tiles/api/track/info', { cache: 'no-store', ...init }).catch(() => null);
		if (r?.ok) trk = await r.json();
	};
	trackApi();
	const setTrackDays = (days: number) =>
		trackApi({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) });
	async function clearTrack() {
		if (!confirm(t('Delete the whole recorded track?'))) return;
		await fetch('/tiles/api/track', { method: 'DELETE' }).catch(() => {});
		tools.track = [];
		trackApi();
	}

	function setServer(base: string) {
		if (settings.radarBase === base) return;
		settings.radarBase = base;
		reconnectMayara();
	}
	// Kartenanbieter-Schlüssel (zentral auf dem Pi)
	const keyed = $derived(providers.list.filter((p) => p.needsKey));
	let keyInput: Record<string, string> = $state({});
	let keyMsg: Record<string, string> = $state({});
	async function saveKey(id: string) {
		keyMsg[id] = '…';
		const ok = await putKey(id, keyInput[id] ?? '');
		keyInput[id] = '';
		if (!ok) return (keyMsg[id] = t('Saving failed'));
		const r = await testProvider(id);
		keyMsg[id] = r.ok ? t('Key works') : t('Test failed: {e}', { e: r.error ?? '' });
	}
	async function removeKey(id: string) {
		await putKey(id, '');
		keyMsg[id] = t('Key removed');
	}

	// Herunterfahren der Pis (OpenCPN-Pi .112, SignalK-/Radar-Pi .100 = dieser Server)
	let power: { opencpn: boolean; keyReady: boolean } | null = $state(null);
	let powerMsg = $state('');
	/** SignalK-Pi = dieser Server: erreichbar, solange die Abfrage antwortet */
	let skOnline: boolean | null = $state(null);
	const powerApi = async () => {
		const r = await fetch('/tiles/api/power', { cache: 'no-store' }).catch(() => null);
		skOnline = !!r?.ok;
		power = r?.ok ? await r.json() : null; // ohne SignalK-Pi ist der OpenCPN-Status unbekannt
	};
	$effect(() => {
		powerApi();
		const iv = setInterval(powerApi, 5000);
		return () => clearInterval(iv);
	});
	const led = (on: boolean | null | undefined) => (on == null ? 'unknown' : on ? 'up' : 'down');
	const ledTitle = (on: boolean | null | undefined) => t(on == null ? 'unknown' : on ? 'online' : 'offline');
	const POWER_ASK = {
		opencpn: 'Shut down the OpenCPN Pi now?',
		signalk: 'Shut down the SignalK Pi now? Radar, AIS, Node-RED, ESP displays and this app stop working until it is switched on again.',
		both: 'Shut down both Pis now? Radar, AIS, Node-RED, ESP displays, OpenCPN and this app stop working until they are switched on again.'
	} as const;
	async function powerOff(target: keyof typeof POWER_ASK) {
		if (!confirm(t(POWER_ASK[target]))) return;
		powerMsg = '…';
		const r = await fetch(`/tiles/api/power/${target}`, { method: 'POST' }).catch(() => null);
		const d = r ? await r.json().catch(() => ({})) : {};
		powerMsg = r?.ok ? t('Shutting down. Wait about 30 s before switching off the power.') : t('Failed: {e}', { e: d.error ?? t('no connection') });
		setTimeout(powerApi, 5000);
	}

	function toggleSim(on: boolean) {
		settings.sim = on;
		on ? startSim() : stopSim();
	}
</script>

<div class="wrap scroll">
	<section>
		<b>{t('Language')}</b>
		<div class="seg">
			<button class:on={settings.lang === 'en'} onclick={() => (settings.lang = 'en')}>English</button>
			<button class:on={settings.lang === 'de'} onclick={() => (settings.lang = 'de')}>Deutsch</button>
		</div>
	</section>

	<section>
		<b>{t('Display')}</b>
		<div class="ctl"><span>{t('Theme')}</span>
			<div class="seg">
				<button class:on={settings.theme === 'day'} onclick={() => (settings.theme = 'day')}><Icon name="sun" size={15} /> {t('Day')}</button>
				<button class:on={settings.theme === 'dusk'} onclick={() => (settings.theme = 'dusk')}>{t('Dusk')}</button>
				<button class:on={settings.theme === 'night'} onclick={() => (settings.theme = 'night')}><Icon name="moon" size={15} /> {t('Night')}</button>
			</div>
		</div>
		<div class="ctl"><span>{t('Echo colours')}</span>
			<div class="seg">
				<button class:on={settings.palette === 'multicolor'} onclick={() => (settings.palette = 'multicolor')}>{t('Multicolour')}</button>
				<button class:on={settings.palette === 'yellow'} onclick={() => (settings.palette = 'yellow')}>{t('Yellow')}</button>
				<button class:on={settings.palette === 'green'} onclick={() => (settings.palette = 'green')}>{t('Green')}</button>
			</div>
		</div>
		<label class="ctl"><span>{t('Echo intensity')} <b class="num">{dec(settings.echoGamma, 2)}</b></span><input type="range" min="0.4" max="2.5" step="0.05" bind:value={settings.echoGamma} /></label>
		<label class="ctl"><span>{t('Echo trails')} <b class="num">{settings.trails ? `${settings.trails} s` : t('off')}</b></span><input type="range" min="0" max="180" step="10" bind:value={settings.trails} /></label>
		<label class="chk"><input type="checkbox" bind:checked={settings.rings} /> {t('Range rings')}</label>
		<label class="chk"><input type="checkbox" bind:checked={settings.compass} /> {t('Bearing scale')}</label>
		<label class="chk"><input type="checkbox" bind:checked={settings.headingLine} /> {t('Heading line')}</label>
	</section>

	<section>
		<b>{t('Chart overlay')}</b>
		<label class="chk"><input type="checkbox" bind:checked={settings.chart} /> {t('OpenStreetMap + OpenSeaMap below radar (needs internet)')}</label>
		<label class="ctl"><span>{t('Chart opacity')} <b class="num">{Math.round(settings.chartOpacity * 100)}%</b></span><input type="range" min="0.2" max="1" step="0.05" bind:value={settings.chartOpacity} /></label>
		<label class="ctl"><span>{t('Radar opacity')} <b class="num">{Math.round(settings.radarOpacity * 100)}%</b></span><input type="range" min="0.2" max="1" step="0.05" bind:value={settings.radarOpacity} /></label>
	</section>

	<section>
		<b>{t('Targets')}</b>
		<label class="chk"><input type="checkbox" bind:checked={settings.aisShow} /> {t('AIS targets')}</label>
		<label class="chk"><input type="checkbox" bind:checked={settings.arpaShow} /> {t('ARPA targets')}</label>
		<label class="chk"><input type="checkbox" bind:checked={settings.aisNames} /> {t('Names')}</label>
		<label class="chk"><input type="checkbox" bind:checked={settings.hideStaticAis} /> {t('Hide moored / anchored (unless dangerous)')}</label>
		<div class="ctl"><span>{t('Vectors')}</span>
			<div class="seg">
				<button class:on={settings.vectorMode === 'true'} onclick={() => (settings.vectorMode = 'true')}>{t('True')}</button>
				<button class:on={settings.vectorMode === 'relative'} onclick={() => (settings.vectorMode = 'relative')}>{t('Relative')}</button>
			</div>
		</div>
		<label class="ctl"><span>{t('Vector length')} <b class="num">{settings.aisVectorMin} min</b></span><input type="range" min="1" max="30" step="1" bind:value={settings.aisVectorMin} /></label>
		<label class="ctl"><span>{t('Own track')} <b class="num">{trackLabel(settings.trackHours)}</b></span><input type="range" min="0" max={TRACK_STEPS.length - 1} step="1" value={trackIdx} oninput={(e) => (settings.trackHours = TRACK_STEPS[+e.currentTarget.value])} /></label>
		{#if trk}
			<label class="ctl"><span>{t('Keep track (days)')}</span><input type="number" min="1" max="3650" step="1" value={trk.days} onchange={(e) => setTrackDays(+e.currentTarget.value)} /></label>
			<div class="ctl"><span class="muted">{t('Stored: {mb} MB, {n} days', { mb: dec(trk.bytes / 1048576, 1), n: trk.files })}{trk.first ? ` · ${t('since')} ${trk.first}` : ''}</span><button class="mini" onclick={clearTrack}>{t('Delete')}</button></div>
		{/if}
		<label class="ctl"><span>{t('Past track')} <b class="num">{settings.aisTrackMin ? `${settings.aisTrackMin} min` : t('off')}</b></span><input type="range" min="0" max="30" step="1" bind:value={settings.aisTrackMin} /></label>
	</section>

	<section>
		<b>{t('Radar')}</b>
		<div class="ctl"><span>{t('Source')}</span>
			<div class="seg">
				<button class:on={settings.radarBase === '/mayara'} onclick={() => setServer('/mayara')}>{t('HALO (live)')}</button>
				<button class:on={settings.radarBase === '/mayara-emu'} onclick={() => setServer('/mayara-emu')}>{t('Emulator')}</button>
			</div>
		</div>
		{#if radar.list.length > 1}
			<label class="chk"><input type="checkbox" bind:checked={settings.dualRange} /> {t('Dual range (two pictures side by side)')}</label>
			<div class="two">
				<label class="ctl"><span>{t('Left')}</span><select bind:value={settings.radarId}>{#each radar.list as id}<option value={id}>{radar.byId[id]?.name ?? id}</option>{/each}</select></label>
				<label class="ctl"><span>{t('Right')}</span><select bind:value={settings.radarIdB}>{#each radar.list as id}<option value={id}>{radar.byId[id]?.name ?? id}</option>{/each}</select></label>
			</div>
		{/if}
	</section>

	<section>
		<b>{t('Chart providers')}</b>
		<div class="muted small">{t('Keys are stored on the Pi and used by all devices. Free accounts are enough.')}</div>
		{#each keyed as p (p.id)}
			<div class="prov">
				<div class="pname"><b>{p.name}</b> {#if p.keySet}<span class="okk">✓ {t('key set')}</span>{/if}</div>
				<div class="muted small">{t(p.info)}</div>
				<div class="keyrow">
					<input type="password" autocomplete="off" placeholder={t(p.keyLabel ?? 'API key')} bind:value={keyInput[p.id]} />
					<button class="mini" disabled={!keyInput[p.id]} onclick={() => saveKey(p.id)}>{t('Save')}</button>
					{#if p.keySet}<button class="mini" onclick={() => removeKey(p.id)}>{t('Remove')}</button>{/if}
				</div>
				<div class="small">
					{#if p.keyUrl}<a href={p.keyUrl} target="_blank" rel="noopener">{t('Get a key')}</a>{/if}
					{#if keyMsg[p.id]}<span class="kmsg">{keyMsg[p.id]}</span>{/if}
				</div>
			</div>
		{/each}
	</section>

	<section>
		<b>{t('Markers')}</b>
		{#each tools.markers as m (m.id)}
			<div class="mk small num"><span><b>{m.label}</b> {fmtLat(m.pos.lat)} {fmtLon(m.pos.lon)}</span><button class="mini" onclick={() => removeMarker(m.id)} aria-label={t('Delete marker')}><Icon name="trash" size={14} /></button></div>
		{:else}
			<div class="muted small">{t('None. Long-press / right-click the radar to place one.')}</div>
		{/each}
	</section>

	<section>
		<b>{t('System')}</b>
		{#if power && !power.keyReady}<div class="muted small">{t('OpenCPN Pi')}: {t('shutdown key not set up')}</div>{/if}
		<button class="pwr" onclick={() => powerOff('opencpn')} disabled={!power?.opencpn || !power?.keyReady}><Icon name="power" size={14} /> {t('Shut down OpenCPN Pi')}<span class="led {led(power?.opencpn)}" title={ledTitle(power?.opencpn)} role="img" aria-label={ledTitle(power?.opencpn)}></span></button>
		<button class="pwr" onclick={() => powerOff('signalk')} disabled={!skOnline}><Icon name="power" size={14} /> {t('Shut down SignalK Pi')}<span class="led {led(skOnline)}" title={ledTitle(skOnline)} role="img" aria-label={ledTitle(skOnline)}></span></button>
		<button onclick={() => powerOff('both')} disabled={!power?.opencpn || !power?.keyReady}><Icon name="power" size={14} /> {t('Shut down both')}</button>
		{#if powerMsg}<div class="small">{powerMsg}</div>{/if}
		<div class="muted small">{t('A Pi that has been shut down only starts again after switching its power off and on.')}</div>
	</section>

	<section>
		<b>{t('Test')}</b>
		<label class="chk"><input type="checkbox" checked={settings.sim} onchange={(e) => toggleSim((e.target as HTMLInputElement).checked)} /> {t('Simulated AIS encounters (head-on, crossing, overtaking, SART)')}</label>
		<button onclick={() => confirm(t('Reset all display and alarm settings on this device?')) && resetSettings()}>{t('Reset settings')}</button>
		<div class="muted small">Build {__BUILD__}</div>
	</section>
</div>

<style>
	.wrap { height: 100%; }
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.ctl { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
	.chk { display: flex; gap: 8px; align-items: center; font-size: 13.5px; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.small { font-size: 12px; }
	.mini { min-height: 28px; padding: 2px 8px; }
	.mk { display: flex; justify-content: space-between; align-items: center; }
	.seg { align-self: flex-start; }
	.prov { border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
	.okk { color: var(--ok); font-size: 12px; margin-left: 6px; }
	.keyrow { display: flex; gap: 6px; }
	.keyrow input { flex: 1; font: inherit; color: var(--text); background: var(--btn); border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; min-height: 30px; }
	.kmsg { margin-left: 10px; }
	a { color: var(--accent); }
	.pwr { display: flex; align-items: center; gap: 6px; }
	.led { margin-left: auto; width: 10px; height: 10px; border-radius: 50%; flex: none; }
	.led.up { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
	.led.down { background: var(--alarm); }
	.led.unknown { background: var(--line); }
</style>
