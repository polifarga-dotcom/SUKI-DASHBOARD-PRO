<script lang="ts">
	interface Props {
		label: string;
		value: string | number | null;
		unit?: string;
		color?: string;
		large?: boolean;
	}
	let { label, value, unit = '', color = '', large = false }: Props = $props();

	const display = $derived(value == null ? '—' : String(value));
</script>

<div class="cell" class:large>
	<div class="label">{label}</div>
	<div class="value" style={color ? `color:${color}` : ''}>
		{display}<span class="unit">{unit}</span>
	</div>
</div>

<style>
	.cell { display: flex; flex-direction: column; gap: 2px; }
	.label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
	.value { font-size: 18px; font-weight: 600; }
	.cell.large .value { font-size: 28px; }
	.unit { font-size: 11px; font-weight: 400; color: var(--muted); margin-left: 2px; }
</style>
