<script lang="ts">
	// Auswahl des Wegpunkt-Symbols (Popup auf der Karte und Seitentab)
	import { MARK_ICONS } from '../radar/markIcons';
	import { t } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let { value, onpick }: { value: string | undefined; onpick: (id: string) => void } = $props();
</script>

<div class="grid" role="radiogroup" aria-label={t('Symbol')}>
	{#each MARK_ICONS as i (i.id)}
		<button class="ic" class:on={(value ?? 'wp') === i.id} role="radio" aria-checked={(value ?? 'wp') === i.id} title={t(i.label)} aria-label={t(i.label)} onclick={() => onpick(i.id)}>
			<Icon name={i.icon} size={18} />
		</button>
	{/each}
</div>

<style>
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 4px; }
	.ic { min-height: 34px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
	.ic.on { background: var(--accent); color: #000; border-color: var(--accent); }
</style>
