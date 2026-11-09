<script lang="ts">
	import { settings } from '../lib/settings.svelte';
	import { radar, setControl, isTransmitting, type ControlDef, type ControlValue } from '../data/mayara.svelte';
	import { fmtRange, fmtDist, R2D, D2R, dec, numStr } from '../lib/geo';
	import { t } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let { radarId }: { radarId: string } = $props();
	const R = $derived(radar.byId[radarId]);
	const defs = $derived(R?.caps?.controls ?? {});
	let unlocked = $state(false);
	let drag: Record<string, number> = $state({});

	const ORDER = ['mode', 'gain', 'sea', 'seaState', 'rain', 'doppler', 'dopplerSpeedThreshold', 'interferenceRejection', 'localInterferenceRejection', 'noiseRejection', 'sideLobeSuppression', 'targetBoost', 'targetExpansion', 'targetSeparation', 'scanSpeed', 'spokeProcessing'];
	const SKIP = new Set(['power', 'range', 'guardZone1', 'guardZone2']);

	function group(cat: string) {
		const ks = Object.entries(defs)
			.filter(([k, d]) => d.category === cat && !SKIP.has(k))
			.map(([k]) => k);
		return ks.sort((a, b) => {
			const ia = ORDER.indexOf(a);
			const ib = ORDER.indexOf(b);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || defs[a].id - defs[b].id;
		});
	}

	const cv = (k: string): ControlValue => R?.controls?.[k] ?? {};
	const isAngle = (d: ControlDef) => d.units === 'rad';
	const shown = (d: ControlDef, v: number) => (isAngle(d) ? `${dec(v * R2D, 1)}°` : d.units === 'm' ? `${dec(v, 1)} m` : d.units === 'm/s' ? `${dec(v, 1)} m/s` : numStr(Math.round(v * 10) / 10));
	const readOnly = (k: string, d: ControlDef) => d.isReadOnly || cv(k).allowed === false || (d.category === 'installation' && !unlocked);

	function enumOptions(d: ControlDef): [string, string][] {
		const desc = d.descriptions ?? {};
		const vals = d.validValues?.length ? d.validValues.map(String) : Object.keys(desc);
		return vals.sort((a, b) => Number(a) - Number(b)).map((v) => [v, desc[v] ?? v]);
	}

	function commitNumber(k: string, d: ControlDef, raw: number) {
		const c = cv(k);
		delete drag[k];
		if (c.auto && d.hasAutoAdjustable) setControl(radarId, k, { auto: true, autoValue: raw });
		else setControl(radarId, k, { value: isAngle(d) ? raw * D2R : raw, auto: d.hasAuto ? false : undefined });
	}

	const power = $derived(Number(cv('power').value ?? 0));
	async function transmit(on: boolean) {
		await setControl(radarId, 'power', { value: on ? 2 : 1 });
	}

	const modeName = $derived(defs.mode?.descriptions?.[String(cv('mode').value)] ?? '');
	const ranges = $derived((R?.caps?.supportedRanges ?? []).filter((r) => r <= (R?.caps?.maxRange ?? Infinity)));

	function syncZone(n: 1 | 2) {
		const g = settings.guard[n - 1];
		setControl(radarId, `guardZone${n}`, { value: g.start, endValue: g.end, startDistance: g.inner, endDistance: g.outer, enabled: g.enabled });
	}
</script>

<div class="wrap scroll">
	{#if !R}
		<p class="muted pad">{radar.error ? t(radar.error) : t('No radar found.')}</p>
	{:else}
		<section>
			<div class="title">
				<b>{R.name}</b>
				<span class="muted small">{R.model} · {R.ip}{R.replay ? ' · ' + t('read-only') : ''}</span>
			</div>
			{#if radar.list.length > 1}
				<div class="seg sel">
					{#each radar.list as id}
						<button class:on={settings.radarId === id} onclick={() => (settings.radarId = id)}>{radar.byId[id]?.name.replace(/^.*\s/, '') || id}</button>
					{/each}
				</div>
			{/if}
			<div class="powerrow">
				<button class:on={power === 2} onclick={() => transmit(true)} disabled={power === 2 || R.replay}><Icon name="power" /> {t('Transmit')}</button>
				<button class:on={power === 1} onclick={() => transmit(false)} disabled={power === 1 || R.replay}>{t('Standby')}</button>
			</div>
			<label class="ctl">
				<span>{t('Radar range')}</span>
				<select value={Number(cv('range').value ?? 0)} onchange={(e) => setControl(radarId, 'range', { value: Number((e.target as HTMLSelectElement).value) })} disabled={R.replay}>
					{#each ranges as r}<option value={r}>{fmtRange(r)}</option>{/each}
				</select>
			</label>
			{#if radar.lastError}<div class="err small">{radar.lastError}</div>{/if}
			<div class="muted small num">
				{t('Spokes')} {isTransmitting(radarId) ? `${R.spokeRate} msg/s` : '—'}{R.revPeriod ? ` · ${(60000 / R.revPeriod).toFixed(0)} rpm` : ''}
			</div>
		</section>

		{#each [['base', 'Picture'], ['advanced', 'Advanced'], ['targets', 'Targets'], ['trails', 'Trails'], ['installation', 'Installation'], ['info', 'Info']] as [cat, title]}
			{@const keys = group(cat)}
			{#if keys.length || cat === 'targets'}
				<section>
					<div class="title">
						<b>{t(title)}</b>
						{#if cat === 'installation'}
							<button class="mini" onclick={() => (unlocked = !unlocked)}><Icon name={unlocked ? 'unlock' : 'lock'} size={14} /> {unlocked ? t('Lock') : t('Unlock')}</button>
						{/if}
					</div>
					{#if cat === 'targets'}
						<div class="muted small">{t('Radar guard zones drive automatic ARPA acquisition. Copy the app guard zones (Alarms tab):')}</div>
						<div class="zones">
							{#each [1, 2] as n}
								{@const z = cv(`guardZone${n}`)}
								<div class="zone">
									<span>{t('Zone {n}', { n })}: {z.enabled ? `${fmtDist(z.startDistance)}–${fmtDist(z.endDistance)}` : t('off')}</span>
									<button class="mini" onclick={() => syncZone(n as 1 | 2)} disabled={R.replay}>{t('Use app zone {n}', { n })}</button>
								</div>
							{/each}
						</div>
					{/if}
					{#each keys as k}
						{@const d = defs[k]}
						{@const c = cv(k)}
						{@const ro = readOnly(k, d)}
						<div class="ctl" class:ro>
							<span class="lbl" title={d.description ? t(d.description) : ''}>{t(d.name)}</span>
							{#if c.allowed === false && !d.isReadOnly}
								<span class="locked">{t('Locked by mode {m} – switch Mode to Custom to change', { m: t(modeName) })}</span>
							{/if}
							{#if d.dataType === 'number'}
								{@const useAuto = !!c.auto && !!d.hasAutoAdjustable}
								{@const min = useAuto ? (d.autoAdjustMinValue ?? -50) : isAngle(d) ? (d.minValue ?? 0) * R2D : (d.minValue ?? 0)}
								{@const max = useAuto ? (d.autoAdjustMaxValue ?? 50) : isAngle(d) ? (d.maxValue ?? 100) * R2D : (d.maxValue ?? 100)}
								{@const cur = drag[k] ?? (useAuto ? (c.autoValue ?? 0) : isAngle(d) ? Number(c.value ?? 0) * R2D : Number(c.value ?? 0))}
								<div class="numrow">
									{#if d.hasAuto}
										<button class="mini" class:on={!!c.auto} disabled={ro} onclick={() => setControl(radarId, k, { auto: !c.auto, value: c.value })}>AUTO</button>
									{/if}
									<input
										type="range"
										{min}
										{max}
										step={isAngle(d) ? 0.1 : (d.stepValue ?? 1)}
										value={cur}
										disabled={ro || (!!c.auto && !d.hasAutoAdjustable)}
										oninput={(e) => (drag[k] = Number((e.target as HTMLInputElement).value))}
										onchange={(e) => commitNumber(k, d, Number((e.target as HTMLInputElement).value))}
									/>
									<span class="val num">{c.auto && !d.hasAutoAdjustable ? 'A' : useAuto ? `A${cur > 0 ? '+' : ''}${Math.round(cur)}` : isAngle(d) ? `${dec(cur, 1)}°` : shown(d, cur)}</span>
								</div>
							{:else if d.dataType === 'enum'}
								{@const opts = enumOptions(d)}
								{#if opts.length <= 4}
									<div class="seg">
										{#each opts as [v, txt]}
											<button class:on={String(c.value) === v} disabled={ro} onclick={() => setControl(radarId, k, { value: Number(v) })}>{t(txt)}</button>
										{/each}
									</div>
								{:else}
									<select value={String(c.value)} disabled={ro} onchange={(e) => setControl(radarId, k, { value: Number((e.target as HTMLSelectElement).value) })}>
										{#each opts as [v, txt]}<option value={v}>{t(txt)}</option>{/each}
									</select>
								{/if}
							{:else if d.dataType === 'button'}
								<button disabled={ro} onclick={() => setControl(radarId, k, { value: 1 })}>{t(d.name)}</button>
							{:else if d.dataType === 'sector'}
								<span class="num small">{c.enabled ? `${(Number(c.value) * R2D).toFixed(0)}° → ${(Number(c.endValue) * R2D).toFixed(0)}°` : t('off')}</span>
							{:else}
								<span class="num small">{d.units === 's' && typeof c.value === 'number' ? `${Math.round(c.value / 3600)} h` : (c.value ?? '—')}</span>
							{/if}
						</div>
					{/each}
				</section>
			{/if}
		{/each}
	{/if}
</div>

<style>
	.wrap { height: 100%; }
	.pad { padding: 14px; }
	section { padding: 10px 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
	.title { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
	.small { font-size: 12px; }
	.err { color: var(--alarm); }
	.sel { align-self: flex-start; }
	.powerrow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.ctl { display: flex; flex-direction: column; gap: 4px; }
	.ctl.ro { opacity: 0.6; }
	.lbl { font-size: 12px; color: var(--muted); }
	.locked { font-size: 11.5px; color: var(--warn); }
	.numrow { display: flex; align-items: center; gap: 8px; }
	.val { min-width: 54px; text-align: right; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; }
	.seg { flex-wrap: wrap; }
	.zones { display: flex; flex-direction: column; gap: 6px; }
	.zone { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
</style>
