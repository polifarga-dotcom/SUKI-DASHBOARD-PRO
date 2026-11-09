<script lang="ts">
	import { settings, applyAlarmPreset, ALARM_PRESETS, type AlarmPreset } from '../lib/settings.svelte';
	import { alarms, ackAlarm, ackAll, muteFor, confirmWatch, setWatch } from '../alarms/alarms.svelte';
	import { playAlarm, unlockAudio } from '../alarms/audio';
	import { ui } from '../collision/targets.svelte';
	import { fmtDist, D2R, R2D, NM, dec } from '../lib/geo';
	import { t, timeFmt } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	const time = (ts: number) => timeFmt(ts, true);
	const muted = $derived(alarms.mutedUntil > Date.now());
	const deg = (r: number) => Math.round((((r * R2D) % 360) + 360) % 360);
	const EVENT = { raised: 'raised', acked: 'acked', cleared: 'cleared' } as const;
</script>

<div class="wrap scroll">
	<section>
		<div class="title">
			<b>{t('Active ({n})', { n: alarms.active.length })}</b>
			<div class="btns">
				<button class="mini" onclick={ackAll} disabled={!alarms.active.some((a) => !a.acked)}><Icon name="check" size={14} /> {t('Ack all')}</button>
				<button class="mini" class:on={muted} onclick={() => (muted ? (alarms.mutedUntil = 0) : muteFor(5))}><Icon name="volumeOff" size={14} /> {muted ? t('Unmute') : t('Mute 5 min')}</button>
			</div>
		</div>
		{#each alarms.active as a (a.id)}
			<div class="alarm {a.level}" class:acked={a.acked}>
				<button class="txt" onclick={() => { if (a.targetKey) { ui.selected = a.targetKey; settings.sideTab = 'targets'; } }}>
					<b>{a.title}</b>
					<span class="small">{a.detail}</span>
					<span class="small muted">{t('since {t}', { t: time(a.since) })}</span>
				</button>
				{#if !a.acked}<button class="mini" onclick={() => ackAlarm(a.id)}>{t('Ack')}</button>{/if}
			</div>
		{:else}
			<div class="muted small">{t('No active alarms.')}</div>
		{/each}
	</section>

	<section>
		<b>{t('Collision alarm (CPA / TCPA)')}</b>
		<div class="seg">
			{#each Object.entries(ALARM_PRESETS) as [k, p]}
				<button class:on={settings.alarmPreset === k} onclick={() => applyAlarmPreset(k as AlarmPreset)}>{t(p.label)}</button>
			{/each}
			<button class:on={settings.alarmPreset === 'custom'} onclick={() => applyAlarmPreset('custom')}>{t('Custom')}</button>
		</div>
		<label class="ctl">
			<span>{t('CPA limit')} <b class="num">{fmtDist(settings.cpaLimit)}</b></span>
			<input type="range" min="0.05" max="5" step="0.05" value={settings.cpaLimit / NM} oninput={(e) => { settings.cpaLimit = Number((e.target as HTMLInputElement).value) * NM; settings.alarmPreset = 'custom'; }} />
		</label>
		<label class="ctl">
			<span>{t('TCPA limit')} <b class="num">{Math.round(settings.tcpaLimit / 60)} min</b></span>
			<input type="range" min="1" max="60" step="1" value={settings.tcpaLimit / 60} oninput={(e) => { settings.tcpaLimit = Number((e.target as HTMLInputElement).value) * 60; settings.alarmPreset = 'custom'; }} />
		</label>
		<label class="chk"><input type="checkbox" bind:checked={settings.lostTargetAlarm} /> {t('Lost dangerous target warning')}</label>
	</section>

	<section>
		<b>{t('Watch alarm')}</b>
		<label class="chk"><input type="checkbox" checked={settings.watchOn} onchange={(e) => setWatch(e.currentTarget.checked)} /> {t('Watch alarm on')}</label>
		<label class="ctl"><span>{t('Confirm every')} <b class="num">{settings.watchMin} min</b></span><input type="range" min="1" max="60" step="1" bind:value={settings.watchMin} oninput={confirmWatch} /></label>
		<div class="muted small">{t('Switch on and off with the eye button in the header.')} {t('Press “Watch OK” in the header within this time. One minute before a warning sounds, then the alarm; after 2 more minutes at full volume. Works only while this app is open and the screen is on.')}</div>
	</section>

	<section>
		<b>{t('Shallow water')}</b>
		<label class="ctl"><span>{t('Alarm below')} <b class="num">{settings.shallowAlarm > 0 ? `${dec(settings.shallowAlarm, 1)} m` : t('off')}</b></span><input type="range" min="0" max="20" step="0.5" bind:value={settings.shallowAlarm} /></label>
		<div class="muted small">{t('Uses depth below keel if available, otherwise below transducer.')}</div>
	</section>

	<section>
		<b>{t('Guard zones')}</b>
		<div class="muted small">{t('Sectors relative to the bow. Radar echoes and AIS targets inside raise an alarm.')}</div>
		{#each settings.guard as g, i}
			<div class="zone">
				<label class="chk"><input type="checkbox" bind:checked={g.enabled} /> <b>{t('Zone {n}', { n: i + 1 })}</b></label>
				<div class="two">
					<label class="ctl"><span>{t('From')} <b class="num">{deg(g.start)}°</b></span><input type="range" min="0" max="359" value={deg(g.start)} oninput={(e) => (g.start = Number((e.target as HTMLInputElement).value) * D2R)} /></label>
					<label class="ctl"><span>{t('To')} <b class="num">{deg(g.end)}°</b>{deg(g.end) === deg(g.start) ? ' (360°)' : ''}</span><input type="range" min="0" max="359" value={deg(g.end)} oninput={(e) => (g.end = Number((e.target as HTMLInputElement).value) * D2R)} /></label>
					<label class="ctl"><span>{t('Inner')} <b class="num">{fmtDist(g.inner)}</b></span><input type="range" min="0" max="6" step="0.05" value={g.inner / NM} oninput={(e) => (g.inner = Math.min(Number((e.target as HTMLInputElement).value) * NM, g.outer - 50))} /></label>
					<label class="ctl"><span>{t('Outer')} <b class="num">{fmtDist(g.outer)}</b></span><input type="range" min="0.1" max="12" step="0.05" value={g.outer / NM} oninput={(e) => (g.outer = Math.max(Number((e.target as HTMLInputElement).value) * NM, g.inner + 50))} /></label>
				</div>
				<label class="ctl"><span>{t('Echo sensitivity')} <b class="num">{g.sensitivity}</b> <span class="muted">{t('(strong cells / sweep)')}</span></span><input type="range" min="1" max="60" value={g.sensitivity} oninput={(e) => (g.sensitivity = Number((e.target as HTMLInputElement).value))} /></label>
			</div>
		{/each}
		<label class="chk"><input type="checkbox" bind:checked={settings.aisGuard} /> {t('AIS / ARPA targets in zones alarm too (moving only)')}</label>
	</section>

	<section>
		<b>{t('Sound')}</b>
		<label class="chk"><input type="checkbox" bind:checked={settings.alarmSound} /> {t('Alarm sound')}</label>
		{#if !settings.alarmSound}<div class="warnbox small">{t('All alarm sounds are off. Alarms are only shown, not heard.')}</div>{/if}
		<div class="numrow">
			<input type="range" min="0.1" max="1" step="0.05" bind:value={settings.alarmVolume} aria-label={t('Volume')} />
			<button class="mini" onclick={() => { unlockAudio(); playAlarm(settings.alarmVolume); }}>{t('Test')}</button>
		</div>
		<div class="muted small">{t('iPad: sound works after the first touch on the screen. Keep the iPad unmuted.')}</div>
	</section>

	<section>
		<b>{t('Log')}</b>
		{#each alarms.log.slice(0, 60) as l}
			<div class="log small {l.level}"><span class="muted num">{time(l.t)}</span> <span class="ev">{t(EVENT[l.event])}</span> {l.text}</div>
		{:else}
			<div class="muted small">{t('Empty.')}</div>
		{/each}
	</section>
</div>

<style>
	.wrap { height: 100%; }
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.title { display: flex; justify-content: space-between; align-items: center; }
	.btns { display: flex; gap: 6px; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; }
	.small { font-size: 12px; }
	.alarm { display: flex; gap: 8px; align-items: center; border-left: 4px solid var(--alarm); background: color-mix(in srgb, var(--alarm) 14%, transparent); border-radius: 6px; padding: 4px 6px; }
	.alarm.warning { border-left-color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
	.alarm.acked { opacity: 0.65; }
	.alarm .txt { flex: 1; flex-direction: column; align-items: flex-start; background: transparent; border: 0; text-align: left; padding: 4px; }
	.ctl { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
	.chk { display: flex; gap: 8px; align-items: center; }
	.zone { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
	.numrow { display: flex; gap: 8px; align-items: center; }
	.warnbox { background: var(--pill-warn); color: var(--pill-fg); border-radius: 6px; padding: 6px 8px; font-weight: 700; }
	.log .ev { text-transform: uppercase; font-size: 10px; font-weight: 700; color: var(--muted); }
	.log.alarm, .log.warning { border: 0; background: none; padding: 0; display: block; }
</style>
