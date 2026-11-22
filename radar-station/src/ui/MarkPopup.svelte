<script lang="ts">
	// Infofenster zu einem Marker auf der Karte: Name, Symbol, löschen (Änderungen sofort gespeichert)
	import { tools, removeMarker } from '../radar/tools.svelte';
	import { markIcon } from '../radar/markIcons';
	import { fmtLat, fmtLon } from '../lib/geo';
	import { t } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';
	import MarkIconPick from './MarkIconPick.svelte';

	let { id, sx, sy, onclose }: { id: number; sx: number; sy: number; onclose: () => void } = $props();
	const m = $derived(tools.markers.find((x) => x.id === id));

	function rename(v: string) {
		v = v.trim().slice(0, 40);
		if (m && v) m.label = v;
	}
	function remove() {
		if (m && confirm(t('Delete marker “{n}”?', { n: m.label }))) {
			removeMarker(m.id);
			onclose();
		}
	}
</script>

{#if m}
	<div
		class="mkpop"
		style="left:min({sx + 12}px, calc(100% - 262px)); top:min({sy + 12}px, calc(100% - 250px))"
		onpointerdown={(e) => e.stopPropagation()}
		onwheel={(e) => e.stopPropagation()}
		role="dialog" tabindex="-1"
		aria-label={t('Marker')}
	>
		<div class="head">
			<Icon name={markIcon(m).icon} size={16} />
			<input type="text" value={m.label} maxlength="40" onchange={(e) => rename(e.currentTarget.value)} onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} aria-label={t('Waypoint name')} />
			<button class="mini" onclick={onclose} aria-label={t('Close')}><Icon name="x" size={14} /></button>
		</div>
		<div class="muted small num">{fmtLat(m.pos.lat)} {fmtLon(m.pos.lon)}</div>
		{#if m.kind !== 'mob'}<MarkIconPick value={m.icon} onpick={(i) => (m.icon = i)} />{/if}
		<div class="btns"><button class="mini" onclick={remove}><Icon name="trash" size={14} /> {t('Delete')}</button></div>
	</div>
{/if}

<style>
	.mkpop {
		position: absolute;
		z-index: 23;
		width: 250px;
		padding: 8px 10px 10px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--panel) 96%, transparent);
		border: 1px solid var(--line);
		border-left: 4px solid #ff8a3d;
		box-shadow: 0 8px 24px #0009;
		color: var(--text);
		font-size: 13px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.head { display: flex; align-items: center; gap: 6px; }
	.head input { flex: 1; min-width: 0; font: inherit; font-weight: 700; }
	.mini { min-height: 28px; padding: 2px 8px; font-size: 12px; }
	.btns { display: flex; gap: 6px; }
	.small { font-size: 11px; }
	.muted { color: var(--muted); }
</style>
