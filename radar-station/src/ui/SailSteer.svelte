<script lang="ts">
	// Kleines SailSteer im klassischen B&G-Layout (wie ESP-Mini-Dashboard „classic“): Bug oben, AWA-Zeiger,
	// TWA-Dreieck am Rand, Am-Wind-Sektoren, AWA + SOG in der Mitte, STW/TWA/TWS/TWD in den Ecken.
	import { normPi, D2R } from '../lib/geo';
	import type { Wind } from '../lib/instruments';
	import { t } from '../lib/i18n.svelte';

	let { w, twaTxt, twsTxt, twdTxt, stwTxt, sogTxt, calc }: {
		w: Wind;
		twaTxt: string;
		twsTxt: string;
		twdTxt: string;
		stwTxt: string;
		sogTxt: string;
		calc: boolean;
	} = $props();

	const C = 150;
	const R = 128;
	const pt = (deg: number, r: number) => [C + r * Math.sin(deg * D2R), C - r * Math.cos(deg * D2R)] as const;
	function arc(a0: number, a1: number, r: number) {
		const [x0, y0] = pt(a0, r);
		const [x1, y1] = pt(a1, r);
		return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 ${a1 > a0 ? 1 : 0} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
	}
	const ticks = Array.from({ length: 36 }, (_, i) => i * 10);
	const labels = [30, 60, 90, 120, -30, -60, -90, -120];

	const awaDeg = $derived(w.awa == null ? null : normPi(w.awa) / D2R);
	const twaDeg = $derived(w.twa == null ? null : normPi(w.twa) / D2R);
	const needle = $derived.by(() => {
		if (awaDeg == null) return '';
		const tip = pt(awaDeg, R - 10);
		const l = pt(awaDeg - 90, 7);
		const r = pt(awaDeg + 90, 7);
		return `${l[0]},${l[1]} ${tip[0]},${tip[1]} ${r[0]},${r[1]}`;
	});
	const twaTri = $derived.by(() => {
		if (twaDeg == null) return '';
		const a = pt(twaDeg, R - 20);
		const b = pt(twaDeg - 5, R - 2);
		const c = pt(twaDeg + 5, R - 2);
		return `${a[0]},${a[1]} ${b[0]},${b[1]} ${c[0]},${c[1]}`;
	});
	const awaLabel = $derived(awaDeg == null ? '—' : `${Math.round(Math.abs(awaDeg))}° ${awaDeg < 0 ? t('P') : t('S')}`);
</script>

<svg viewBox="0 0 300 300" class="ss" role="img" aria-label="SailSteer">
	<defs>
		<radialGradient id="ssface" cx="50%" cy="45%" r="60%">
			<stop offset="0%" stop-color="var(--ss-face1)" />
			<stop offset="100%" stop-color="var(--ss-face2)" />
		</radialGradient>
	</defs>
	<circle cx={C} cy={C} r={R + 4} fill="url(#ssface)" stroke="var(--ss-bezel)" stroke-width="2" />
	<!-- Am-Wind-Sektoren 20–60° -->
	<path d={arc(-60, -20, R - 6)} stroke="var(--ss-port)" stroke-width="10" fill="none" />
	<path d={arc(20, 60, R - 6)} stroke="var(--ss-stbd)" stroke-width="10" fill="none" />
	<!-- Skala -->
	{#each ticks as d}
		{@const major = d % 30 === 0}
		{@const [x0, y0] = pt(d, R - 13)}
		{@const [x1, y1] = pt(d, major ? R - 27 : R - 19)}
		<line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--ss-tick)" stroke-width={major ? 2 : 1} />
	{/each}
	{#each labels as d}
		{@const [x, y] = pt(d, R - 39)}
		<text {x} y={y + 4} class="lbl">{Math.abs(d)}</text>
	{/each}
	<!-- Rumpf -->
	<path d="M150 104 C162 122 163 160 158 196 L142 196 C137 160 138 122 150 104 Z" fill="var(--ss-hull)" stroke="var(--ss-hullline)" stroke-width="1.5" />
	<!-- TWA-Dreieck -->
	{#if twaTri}
		{@const [tx, ty] = pt(twaDeg!, R - 32)}
		<polygon points={twaTri} fill="none" stroke="var(--ss-true)" stroke-width="2.5" />
		<text x={tx} y={ty + 4} class="tl">T</text>
	{/if}
	<!-- AWA-Zeiger -->
	{#if needle}
		<polygon points={needle} fill={awaDeg! < 0 ? 'var(--ss-port)' : 'var(--ss-stbd)'} />
	{/if}
	<circle cx={C} cy={C} r="9" fill="var(--ss-hub)" stroke="var(--ss-tick)" stroke-width="1.5" />
	<!-- Mitte: AWA + SOG -->
	<text x={C} y={C - 46} class="awa">{awaLabel}</text>
	<text x={C} y={C + 74} class="sog">{sogTxt}</text>
	<text x={C} y={C + 90} class="sogu">SOG KN</text>
	<!-- Ecken -->
	<text x="6" y="16" class="cl">STW</text>
	<text x="6" y="36" class="cv">{stwTxt}</text>
	<text x="294" y="16" class="cl r">TWA{calc ? ' ·' : ''}</text>
	<text x="294" y="36" class="cv r">{twaTxt}</text>
	<text x="6" y="272" class="cl">TWD</text>
	<text x="6" y="292" class="cv">{twdTxt}</text>
	<text x="294" y="272" class="cl r">TWS{calc ? ' ·' : ''}</text>
	<text x="294" y="292" class="cv r">{twsTxt}</text>
	{#if calc}<text x={C} y="296" class="calc">{t('true wind calculated')}</text>{/if}
</svg>

<style>
	.ss {
		width: 100%;
		max-width: 340px;
		display: block;
		margin: 0 auto;
		--ss-face1: #1b1b1b;
		--ss-face2: #050505;
		--ss-bezel: #3a3a3a;
		--ss-port: #e00000;
		--ss-stbd: #00c853;
		--ss-true: #4fc3f7;
		--ss-tick: #9aa0a6;
		--ss-hull: #1c1c1c;
		--ss-hullline: #666;
		--ss-hub: #222;
		--ss-text: #e8e8e8;
		--ss-muted: #8a9099;
	}
	:global([data-theme='night']) .ss {
		--ss-face1: #120000;
		--ss-face2: #000;
		--ss-bezel: #3a0a05;
		--ss-port: #a8321f;
		--ss-stbd: #6e1e12;
		--ss-true: #d65a32;
		--ss-tick: #7a2416;
		--ss-hull: #0a0000;
		--ss-hullline: #5a1a10;
		--ss-hub: #140302;
		--ss-text: #d0402c;
		--ss-muted: #7a2416;
	}
	text { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
	.lbl { fill: var(--ss-muted); font-size: 11px; text-anchor: middle; font-weight: 600; }
	.tl { fill: var(--ss-true); font-size: 11px; font-weight: 800; text-anchor: middle; }
	.awa { fill: var(--ss-text); font-size: 20px; font-weight: 800; text-anchor: middle; }
	.sog { fill: var(--ss-text); font-size: 40px; font-weight: 800; text-anchor: middle; }
	.sogu { fill: var(--ss-muted); font-size: 10px; font-weight: 700; text-anchor: middle; letter-spacing: 1px; }
	.cl { fill: var(--ss-muted); font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }
	.cv { fill: var(--ss-text); font-size: 18px; font-weight: 800; }
	.r { text-anchor: end; }
	.calc { fill: #f5a623; font-size: 9.5px; text-anchor: middle; font-weight: 600; }
	:global([data-theme='night']) .calc { fill: #d4572a; }
</style>
