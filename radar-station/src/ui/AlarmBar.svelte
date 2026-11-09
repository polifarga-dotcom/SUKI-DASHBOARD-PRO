<script lang="ts">
	// Große Alarmleiste über dem Radarbild: was ist los (Klartext), was tun (KVR), deutlich quittieren.
	import { settings } from '../lib/settings.svelte';
	import { alarms, ackAlarm, ackAll, muteFor, categoryLabel, type Alarm } from '../alarms/alarms.svelte';
	import { ui } from '../collision/targets.svelte';
	import { unlockAudio } from '../alarms/audio';
	import { t, tn } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let { now }: { now: number } = $props();

	const unacked = $derived(alarms.active.filter((a) => !a.acked));
	const top = $derived<Alarm | null>(unacked[0] ?? null);
	const ackedCount = $derived(alarms.active.length - unacked.length);
	const muteLeft = $derived(Math.max(0, alarms.mutedUntil - now));

	function ack(a: Alarm) {
		unlockAudio();
		ackAlarm(a.id);
	}
	function show(a: Alarm) {
		if (a.targetKey) ui.selected = a.targetKey;
		settings.sidePanel = true;
		settings.sideTab = a.targetKey ? 'targets' : 'alarms';
	}
	function openList() {
		settings.sidePanel = true;
		settings.sideTab = 'alarms';
	}
	const ago = (ts: number) => {
		const s = Math.round((now - ts) / 1000);
		return s < 60 ? t('{n} s ago', { n: s }) : t('{n} min ago', { n: Math.floor(s / 60) });
	};
	const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
</script>

{#if top}
	<div class="bar {top.level}" role="alertdialog" aria-live="assertive" aria-label="{categoryLabel(top.category)}: {top.title}">
		<div class="ico" aria-hidden="true">
			<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
				{#if top.level === 'alarm'}
					<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />
				{:else}
					<path d="M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 8v4M12 16h.01" />
				{/if}
			</svg>
		</div>
		<div class="body">
			<div class="cat">
				{categoryLabel(top.category)}{top.level === 'warning' ? ' · ' + t('warning') : ''}
				<span class="since">{ago(top.since)}</span>
			</div>
			<div class="title">{top.title}</div>
			<div class="detail">{top.detail}</div>
			{#if top.advice}<div class="advice">→ {top.advice}</div>{/if}
			{#if unacked.length > 1}
				<div class="morerow">
					<button class="more" onclick={openList}>{tn(unacked.length - 1, '+{n} more alarm – open list', '+{n} more alarms – open list')}</button>
					<button class="more" onclick={() => { unlockAudio(); ackAll(); }}>{t('Acknowledge all {n}', { n: unacked.length })}</button>
				</div>
			{/if}
		</div>
		<div class="actions">
			<button class="ackbtn" onclick={() => ack(top)}>
				<Icon name="check" size={24} />
				<span><b>{t('ACKNOWLEDGE')}</b><small>{t('stops the sound')}</small></span>
			</button>
			<div class="row">
				{#if top.targetKey}<button onclick={() => show(top)}><Icon name="crosshair" size={16} /> {t('Show')}</button>{/if}
				<button onclick={() => muteFor(5)} title={t('Mute all alarm sounds for 5 minutes')}><Icon name="volumeOff" size={16} /> {t('Mute 5 min')}</button>
			</div>
		</div>
	</div>
{:else if alarms.active.length}
	<button class="pill" onclick={openList}>
		<Icon name="bell" size={15} />
		{tn(ackedCount, '{n} acknowledged alarm still active – view', '{n} acknowledged alarms still active – view')}
	</button>
{/if}

{#if muteLeft > 0}
	<button class="mute" onclick={() => (alarms.mutedUntil = 0)} title={t('Unmute')}>
		<Icon name="volumeOff" size={15} /> {t('Sound muted {t} · tap to unmute', { t: mmss(muteLeft) })}
	</button>
{/if}
{#if !settings.alarmSound}
	<!-- dauerhaft sichtbar, solange alle Alarmtöne aus sind -->
	<button class="mute off" onclick={() => { unlockAudio(); settings.alarmSound = true; }} title={t('Switch alarm sounds on')}>
		<Icon name="volumeOff" size={15} /> {t('ALL ALARM SOUNDS OFF · tap to switch on')}
	</button>
{/if}

<style>
	.bar {
		position: relative;
		margin: 8px 10px 6px;
		z-index: 40;
		display: flex;
		align-items: stretch;
		gap: 14px;
		padding: 12px 12px 12px 14px;
		border-radius: 14px;
		background: var(--alarm-bg);
		color: var(--alarm-fg);
		border: 2px solid var(--alarm-border);
		box-shadow: 0 12px 34px #000b;
		animation: pulse 1s infinite;
	}
	.bar.warning {
		background: var(--warn-bg);
		color: var(--warn-fg);
		border-color: var(--warn-border);
		animation: none;
	}
	@keyframes pulse {
		50% { box-shadow: 0 0 0 7px var(--alarm-glow), 0 12px 34px #000b; }
	}
	.ico { display: grid; place-items: center; width: 56px; border-radius: 10px; background: #0000002e; flex: none; }
	.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.cat { font-size: 12px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; opacity: 0.9; display: flex; gap: 10px; }
	.since { font-weight: 500; letter-spacing: 0; text-transform: none; opacity: 0.8; }
	.title { font-size: 22px; font-weight: 800; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.detail { font-size: 15px; font-weight: 500; }
	.advice { font-size: 15px; font-weight: 700; margin-top: 2px; }
	.actions { display: flex; flex-direction: column; gap: 8px; align-items: stretch; flex: none; }
	.ackbtn {
		min-height: 64px;
		min-width: 190px;
		padding: 8px 18px;
		border-radius: 12px;
		background: var(--ack-bg);
		color: var(--ack-fg);
		border: 0;
		gap: 10px;
		font-size: 17px;
		box-shadow: 0 2px 0 #0004;
	}
	.ackbtn:hover { background: var(--ack-bg); filter: brightness(0.95); }
	.ackbtn span { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1; }
	.ackbtn small { font-size: 11.5px; font-weight: 600; opacity: 0.75; }
	.row { display: flex; gap: 6px; }
	.row button { flex: 1; white-space: nowrap; background: #ffffff22; border-color: #ffffff55; color: inherit; font-weight: 600; }
	.bar.warning .row button { background: #00000018; border-color: #0000003a; }
	:global([data-theme='night']) .bar .row button, :global([data-theme='night']) .bar .more { background: #ff3b1f1a; border-color: #ff3b1f55; }
	.morerow { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
	.more { min-height: 26px; padding: 2px 10px; font-size: 12.5px; font-weight: 700; background: #00000030; border-color: #ffffff55; color: inherit; }
	.pill {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 40;
		font-size: 13px;
		font-weight: 600;
		background: color-mix(in srgb, var(--panel) 88%, transparent);
		border-color: var(--warn);
		color: var(--text);
		border-radius: 20px;
		padding: 4px 14px;
	}
	.mute.off { bottom: auto; top: 52px; background: var(--pill-warn); border-color: var(--pill-warn); color: var(--pill-fg); font-weight: 800; letter-spacing: 0.4px; }
	.mute {
		position: absolute;
		z-index: 40;
		bottom: 14px;
		left: 50%;
		transform: translateX(-50%);
		font-size: 13px;
		font-weight: 600;
		background: color-mix(in srgb, var(--panel) 90%, transparent);
		border: 1px solid var(--warn);
		color: var(--text);
		border-radius: 20px;
		padding: 5px 14px;
		display: inline-flex;
		gap: 6px;
		align-items: center;
		min-height: 32px;
	}
	@media (max-width: 900px) {
		.ackbtn { min-width: 150px; }
		.title { font-size: 19px; }
	}
</style>
