<script lang="ts">
	interface Props {
		label: string;
		ratio: number | null;
		warn?: number;
		danger?: number;
	}
	let { label, ratio, warn = 0.2, danger = 0.1 }: Props = $props();

	const pct = $derived(ratio == null ? 0 : Math.max(0, Math.min(1, ratio)) * 100);
	const color = $derived(() => {
		if (ratio == null) return 'var(--muted)';
		if (ratio <= danger) return 'var(--red)';
		if (ratio <= warn) return 'var(--amber)';
		return 'var(--green)';
	});
</script>

<div class="tank">
	<div class="head">
		<span class="label">{label}</span>
		<span class="pct" style="color:{color()}">{ratio == null ? '—' : pct.toFixed(0) + '%'}</span>
	</div>
	<div class="track">
		<div class="fill" style="width:{pct}%; background:{color()}"></div>
	</div>
</div>

<style>
	.tank { display: flex; flex-direction: column; gap: 4px; }
	.head { display: flex; justify-content: space-between; font-size: 12px; }
	.label { color: var(--muted); }
	.pct { font-weight: 600; }
	.track { height: 6px; background: var(--card2); border-radius: 3px; overflow: hidden; }
	.fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }
</style>
