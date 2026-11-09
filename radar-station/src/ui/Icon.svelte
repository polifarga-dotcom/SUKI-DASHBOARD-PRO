<script lang="ts">
	import { ICONS } from './icons';
	let { name, size = 18 }: { name: string; size?: number } = $props();
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d={ICONS[name] ?? ''} />
</svg>
