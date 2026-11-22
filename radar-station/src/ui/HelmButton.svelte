<script lang="ts">
	// Steuerstand-Taster (Shelly BLU Button Tough 1): Belegung erklären, auf dem Pi anlernen/entfernen (Dienst suki-button)
	import { t, isDe } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	interface St { alive: boolean; macs: string[]; learnUntil?: number; last?: { mac: string; ev: string; ok: boolean; at: number } | null; battery?: Record<string, number> }
	let st = $state<St | null>(null);
	let msg = $state('');
	let now = $state(Date.now());
	const API = '/tiles/api/button';

	async function load() {
		st = await fetch(API).then((r) => (r.ok ? r.json() : null)).catch(() => null);
		now = Date.now();
	}
	$effect(() => {
		load();
		// beim Anlernen öfter nachsehen, damit „angelernt“ sofort erscheint
		const iv = setInterval(() => (learning ? load() : (now = Date.now())), 2000);
		const slow = setInterval(load, 15e3);
		return () => (clearInterval(iv), clearInterval(slow));
	});
	const learning = $derived(!!st?.learnUntil && st.learnUntil > now);
	const left = $derived(learning ? Math.ceil((st!.learnUntil! - now) / 1000) : 0);

	async function learn() {
		msg = '';
		const r = await fetch(`${API}/learn`, { method: 'POST' }).catch(() => null);
		if (!r?.ok) return (msg = t('Pi not reachable.'));
		await load();
	}
	async function forget(mac: string) {
		if (!confirm(mac === 'all' ? t('Remove all buttons?') : t('Remove this button?'))) return;
		await fetch(`${API}/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mac }) }).catch(() => null);
		await load();
	}
	const when = (ms: number) => new Date(ms).toLocaleString(isDe() ? 'de-DE' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	const EV: Record<string, string> = { press: '1×', double: '2×', triple: '3×', long: 'long', learned: 'learned' };
</script>

<section>
	<b>{t('Helm button')}</b>
	<div class="muted small">{t('Shelly BLU Button Tough 1 at the helm. The SignalK Pi receives it directly via Bluetooth and triggers:')}</div>
	<table class="small">
		<tbody>
			<tr><td class="g">1×</td><td>{t('Acknowledge all alarms (during a watch alarm also confirms the watch)')}</td></tr>
			<tr><td class="g">2×</td><td>{t('Confirm watch')}</td></tr>
			<tr><td class="g">3×</td><td>{t('Anchor alarm on (“Drop Anchor Now”: bow position, radius 6 × depth), only below 1 kn and with no anchor set')}</td></tr>
			<tr><td class="g">{t('long')}</td><td>{t('Man overboard (hold ≥ 2 s): MOB alarm on all devices, position from GPS')}</td></tr>
		</tbody>
	</table>
	<details>
		<summary class="small">{t('Tips and feedback tones')}</summary>
		<ul class="small">
			<li>{t('Feedback from the buzzer at the Pi: 1/2/3 short beeps = done, 2 long = MOB set, 1 very long = refused or Pi problem.')}</li>
			<li>{t('Press 3× quickly; 1× followed by 2× within 2 s also counts as 3×.')}</li>
			<li>{t('MOB is removed in the radar app (tap the marker → delete); the anchor alarm is stopped in the anchor app or on the Mini Dash.')}</li>
			<li>{t('Range: the Pi must receive the button at the helm. Battery: CR2032, level shown below.')}</li>
			<li>{t('If 2×, 3× or long do not arrive: update the button firmware in the Shelly Smart Control app.')}</li>
		</ul>
	</details>

	{#if !st}
		<div class="warn small">{t('Pi not reachable.')}</div>
	{:else}
		{#if !st.alive}<div class="warn small">{t('Button service on the Pi is not running.')}</div>{/if}
		{#each st.macs as m (m)}
			<div class="row small">
				<Icon name="check" size={14} />
				<span class="mac" title={m}>{m}</span>
				{#if st.battery?.[m] != null}<span class="muted">{t('Battery {n} %', { n: st.battery[m] })}</span>{/if}
				<button class="mini" onclick={() => forget(m)} title={t('Remove this button')}><Icon name="trash" size={14} /></button>
			</div>
		{:else}
			<div class="muted small">{t('No button learned yet.')}</div>
		{/each}
		{#if st.last}<div class="muted small">{t('Last: {e} {r} ({t})', { e: t(EV[st.last.ev] ?? st.last.ev), r: st.last.ok ? '✓' : '✗', t: when(st.last.at) })}</div>{/if}
		{#if learning}
			<div class="ok small">{t('Press the button once now ({n} s) …', { n: left })}</div>
		{:else}
			<button onclick={learn} disabled={!st.alive}><Icon name="plus" size={14} /> {t('Learn button')}</button>
			<div class="muted small">{t('Starts 60 s learning mode on the Pi: the first Shelly BLU button pressed is added. Must be on board within Bluetooth range of the Pi.')}</div>
		{/if}
	{/if}
	{#if msg}<div class="warn small">{msg}</div>{/if}
</section>

<style>
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.small { font-size: 12px; }
	table { border-collapse: collapse; }
	td { padding: 2px 6px 2px 0; vertical-align: top; }
	.g { font-weight: 700; white-space: nowrap; width: 42px; }
	ul { margin: 4px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
	summary { cursor: pointer; font-weight: 600; }
	.row { display: flex; align-items: center; gap: 6px; }
	.mac { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
	.mini { min-height: 28px; padding: 2px 8px; }
	.ok { color: var(--ok); font-weight: 600; }
	.warn { color: var(--warn); }
</style>
