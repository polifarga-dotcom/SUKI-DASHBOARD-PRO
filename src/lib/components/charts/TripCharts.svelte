<script lang="ts">
	// ── Types ─────────────────────────────────────────────────────────────────
	export type ChartPoint = {
		t:          number;         // ms epoch
		sog:        number | null;  // knots
		tws:        number | null;  // knots
		twd:        number | null;  // degrees 0–360
		aws:        number | null;  // knots
		awa:        number | null;  // degrees –180..+180 (neg=port, pos=stbd)
		baro:       number | null;  // hPa
		depth:      number | null;  // meters (positive = below surface)
		batt_soc:   number | null;  // percent 0–100
		air_temp:   number | null;  // °C
		water_temp: number | null;  // °C
		eng_rpm:    number | null;  // RPM port/primary
		eng_sb_rpm: number | null;  // RPM starboard (catamaran)
		wave_h:       number | null;  // meters
		wave_period_s: number | null; // seconds
		eng_on:       boolean;
	};

	interface Props { points: ChartPoint[]; }
	let { points }: Props = $props();

	// ── SVG coordinate space ─────────────────────────────────────────────────
	const W  = 600;   // viewBox width (unitless — CSS scales it)
	const H  = 52;    // track height
	const PL = 2, PR = 2, PT = 4, PB = 4;
	const IW = W - PL - PR;   // inner width
	const IH = H - PT - PB;   // inner height

	// ── Time domain ──────────────────────────────────────────────────────────
	const tMin   = $derived(points[0]?.t ?? 0);
	const tMax   = $derived(points.at(-1)?.t ?? 1);
	const tRange = $derived(Math.max(tMax - tMin, 1));

	// ── Slider (0–1000 integer for precision) ────────────────────────────────
	let sliderVal = $state(0);
	const cursorPct  = $derived(sliderVal / 1000);
	const cursorTime = $derived(tMin + cursorPct * tRange);
	const cursorX    = $derived(PL + cursorPct * IW);

	// Nearest data point to cursor
	const cursorIdx = $derived((() => {
		let best = 0, bestDist = Infinity;
		for (let i = 0; i < points.length; i++) {
			const d = Math.abs(points[i].t - cursorTime);
			if (d < bestDist) { bestDist = d; best = i; }
		}
		return best;
	})());
	const cur = $derived(points[cursorIdx]);

	// ── Coordinate helpers ───────────────────────────────────────────────────
	function tx(t: number): number { return PL + ((t - tMin) / tRange) * IW; }
	function vy(v: number, min: number, range: number): number {
		return PT + (1 - (v - min) / range) * IH;
	}

	type ChartMeta = { vals: (number | null)[]; min: number; max: number; range: number };
	function meta(getter: (p: ChartPoint) => number | null): ChartMeta | null {
		const vals = points.map(getter);
		const valid = vals.filter(v => v != null) as number[];
		if (valid.length < 2) return null;
		const min = Math.min(...valid), max = Math.max(...valid);
		return { vals, min, max, range: max - min || 1 };
	}

	// ── Catmull-Rom → Cubic Bezier smoothing ────────────────────────────────
	// Converts a sequence of (x,y) points into a smooth cubic-bezier SVG path.
	// Handles null gaps (restarts path segment at each gap).
	// tension=1 = standard Catmull-Rom, lower = tighter curves
	const TENSION = 1.0;

	function smoothPath(m: ChartMeta): string {
		// Collect valid (x,y) segments, broken at nulls
		const segments: [number, number][][] = [];
		let seg: [number, number][] = [];
		for (let i = 0; i < points.length; i++) {
			const v = m.vals[i];
			if (v == null) { if (seg.length) { segments.push(seg); seg = []; } continue; }
			seg.push([tx(points[i].t), vy(v, m.min, m.range)]);
		}
		if (seg.length) segments.push(seg);

		return segments.map(pts => {
			if (pts.length < 2) return `M${pts[0][0]} ${pts[0][1]}`;
			if (pts.length === 2) return `M${pts[0][0]} ${pts[0][1]} L${pts[1][0]} ${pts[1][1]}`;

			let d = `M${pts[0][0]} ${pts[0][1]}`;
			for (let i = 0; i < pts.length - 1; i++) {
				const p0 = pts[Math.max(i - 1, 0)];
				const p1 = pts[i];
				const p2 = pts[i + 1];
				const p3 = pts[Math.min(i + 2, pts.length - 1)];
				// Catmull-Rom control points
				const cp1x = p1[0] + (p2[0] - p0[0]) / 6 * TENSION;
				const cp1y = p1[1] + (p2[1] - p0[1]) / 6 * TENSION;
				const cp2x = p2[0] - (p3[0] - p1[0]) / 6 * TENSION;
				const cp2y = p2[1] - (p3[1] - p1[1]) / 6 * TENSION;
				d += ` C${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
			}
			return d;
		}).join(' ');
	}

	// Keep raw linePath for TWD scatter and AWA diverging (no smoothing needed)
	function linePath(m: ChartMeta): string {
		let d = '';
		for (let i = 0; i < points.length; i++) {
			const v = m.vals[i]; if (v == null) continue;
			const x = tx(points[i].t), y = vy(v, m.min, m.range);
			d += d ? ` L${x} ${y}` : `M${x} ${y}`;
		}
		return d;
	}

	function areaPath(m: ChartMeta): string {
		const line = smoothPath(m);
		if (!line) return '';
		// Find first/last valid for baseline closure
		let fx = tx(points.find((p, i) => m.vals[i] != null)!.t);
		let lx = tx([...points].reverse().find((p, i) => m.vals[points.length - 1 - i] != null)!.t);
		const base = PT + IH;
		return `${line} L${lx} ${base} L${fx} ${base} Z`;
	}

	// Engine-on background segments (orange shading)
	const engineBg = $derived((() => {
		let rects = '';
		let start: number | null = null;
		for (let i = 0; i < points.length; i++) {
			const on = points[i].eng_on;
			if (on && start == null) start = tx(points[i].t);
			else if (!on && start != null) {
				const w = tx(points[i].t) - start;
				rects += `<rect x="${start}" y="${PT}" width="${Math.max(w,1)}" height="${IH}" fill="rgba(251,146,60,0.14)"/>`;
				start = null;
			}
		}
		if (start != null) {
			const w = tx(points.at(-1)!.t) - start;
			rects += `<rect x="${start}" y="${PT}" width="${Math.max(w,1)}" height="${IH}" fill="rgba(251,146,60,0.14)"/>`;
		}
		return rects;
	})());

	// ── Per-track derived data ───────────────────────────────────────────────
	const sogM   = $derived(meta(p => p.sog));
	const twsM   = $derived(meta(p => p.tws));
	const awsM   = $derived(meta(p => p.aws));
	const baroM  = $derived(meta(p => p.baro));
	const depthM = $derived(meta(p => p.depth));
	const socM   = $derived(meta(p => p.batt_soc));
	const airM   = $derived(meta(p => p.air_temp));
	const waterM = $derived(meta(p => p.water_temp));
	const waveM  = $derived(meta(p => p.wave_h));
	const rpmM   = $derived(meta(p => (p.eng_rpm ?? 0) > 0 ? p.eng_rpm : (p.eng_sb_rpm ?? 0) > 0 ? p.eng_sb_rpm : null));
	const awaM   = $derived(meta(p => p.awa));

	// TWD: scatter dots (avoids 0°/360° wrap artefacts)
	const twdDots = $derived((() => {
		if (!points.some(p => p.twd != null)) return '';
		let d = '';
		for (const p of points) {
			if (p.twd == null) continue;
			const x = tx(p.t);
			const y = PT + (1 - p.twd / 360) * IH;
			d += `<circle cx="${x}" cy="${y}" r="1.4" fill="rgba(167,243,208,0.8)"/>`;
		}
		return d;
	})());

	// AWA: diverging chart from centre (port below, stbd above)
	const awaPath = $derived((() => {
		if (!awaM) return { stbd: '', port: '' };
		const cx = PT + IH / 2;
		const scale = IH / 2 / 180;
		let stbd = '', port = '';
		for (let i = 0; i < points.length; i++) {
			const v = points[i].awa; if (v == null) continue;
			const x = tx(points[i].t);
			const y = cx - Math.abs(v) * scale;
			const seg = `${i === 0 || points[i-1].awa == null ? 'M' : 'L'}${x} ${y}`;
			if (v >= 0) stbd += seg; else port += seg;
		}
		return { stbd, port };
	})());

	// Temperature: shared meta covering both air and water
	const tempM = $derived((() => {
		const allVals = points.flatMap(p => [p.air_temp, p.water_temp]).filter(v => v != null) as number[];
		if (allVals.length < 2) return null;
		const min = Math.min(...allVals), max = Math.max(...allVals);
		return { min, max, range: max - min || 1 };
	})());

	function tempLine(getter: (p: ChartPoint) => number | null): string {
		if (!tempM) return '';
		let d = '';
		for (const p of points) {
			const v = getter(p); if (v == null) continue;
			const x = tx(p.t), y = vy(v, tempM.min, tempM.range);
			d += d ? ` L${x} ${y}` : `M${x} ${y}`;
		}
		return d;
	}

	// Cursor Y positions per track
	const curY = $derived(((m: ChartMeta | null, v: number | null) =>
		m && v != null ? vy(v, m.min, m.range) : null));

	// Time tick labels on the slider axis
	const timeTicks = $derived((() => {
		if (points.length < 2) return [];
		const ticks: { pct: number; label: string }[] = [];
		const n = 5;
		for (let i = 0; i <= n; i++) {
			const t = tMin + (i / n) * tRange;
			const d = new Date(t);
			ticks.push({
				pct: (i / n) * 100,
				label: d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
			});
		}
		return ticks;
	})());

	// Readout values at cursor
	function fmtV(v: number | null, dec: number, unit: string): string {
		return v != null ? `${v.toFixed(dec)} ${unit}` : '—';
	}
	function fmtAWA(deg: number | null): string {
		if (deg == null) return '—';
		return `${Math.abs(deg).toFixed(0)}° ${deg < 0 ? 'P' : 'S'}`;
	}
	function fmtTWD(deg: number | null): string {
		if (deg == null) return '—';
		const cards = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
		return `${deg.toFixed(0)}° ${cards[Math.round(((deg%360)+360)%360/22.5)%16]}`;
	}

	// Cursor time label
	const cursorLabel = $derived(
		cur ? new Date(cur.t).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
	);

	// Check which tracks have data
	const hasSog   = $derived(!!sogM);
	const hasTws   = $derived(!!twsM);
	const hasAws   = $derived(!!awsM);
	const hasTwd   = $derived(points.some(p => p.twd != null));
	const hasAwa   = $derived(!!awaM);
	const hasBaro  = $derived(!!baroM);
	const hasDepth = $derived(!!depthM);
	const hasSoc   = $derived(!!socM);
	const hasTemp  = $derived(!!tempM);
	const hasWave  = $derived(!!waveM);
	const hasRpm   = $derived(!!rpmM);

	// SOC color gradient
	function socColor(v: number | null): string {
		if (v == null) return '#6b7280';
		if (v > 50) return '#22c55e';
		if (v > 20) return '#f59e0b';
		return '#ef4444';
	}

	// ── Pointer handling (mouse + touch) ────────────────────────────────────
	// Uses Pointer Events API with setPointerCapture so drag continues even
	// if the pointer leaves the SVG. touch-action:none on the SVG prevents
	// the page from scrolling while the user drags the cursor.
	let dragging = $state(false);

	function moveCursor(e: PointerEvent) {
		const rect = (e.currentTarget as Element).getBoundingClientRect();
		const pct = (e.clientX - rect.left) / rect.width;
		sliderVal = Math.round(Math.max(0, Math.min(1, pct)) * 1000);
	}

	function onPointerDown(e: PointerEvent) {
		dragging = true;
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		moveCursor(e);
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		moveCursor(e);
	}

	function onPointerUp() { dragging = false; }
</script>

{#if points.length >= 2}
<div class="trip-charts">

	<!-- ── CHART TRACKS ─────────────────────────────────────────────────── -->

	{#snippet track(label: string, color: string, valueStr: string, svgContent: string)}
	<div class="track">
		<span class="track-lbl">{label}</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			{@html svgContent}
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
		</svg>
		<span class="track-val" style="color:{color}">{valueStr}</span>
	</div>
	{/snippet}

	{#if hasSog && sogM}
	{@const area = areaPath(sogM)}
	{@const line = smoothPath(sogM)}
	{@const cy   = curY(sogM, cur?.sog ?? null)}
	<div class="track">
		<span class="track-lbl">SOG</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			{@html engineBg}
			<path d={area} fill="rgba(34,211,238,0.15)"/>
			<path d={line} stroke="#22d3ee" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill="#22d3ee"/>{/if}
		</svg>
		<span class="track-val" style="color:#22d3ee">{fmtV(cur?.sog ?? null, 1, 'kn')}</span>
	</div>
	{/if}

	{#if hasTws && twsM}
	{@const area = areaPath(twsM)}
	{@const line = smoothPath(twsM)}
	{@const lineAws = awsM ? smoothPath(awsM) : ''}
	{@const cy   = curY(twsM, cur?.tws ?? null)}
	<div class="track">
		<span class="track-lbl">Wind</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<path d={area} fill="rgba(34,197,94,0.15)"/>
			<path d={line} stroke="#22c55e" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			{#if lineAws}<path d={lineAws} stroke="#fb923c" stroke-width="1" stroke-dasharray="3 2" fill="none" stroke-linejoin="round"/>{/if}
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill="#22c55e"/>{/if}
		</svg>
		<span class="track-val" style="color:#22c55e">
			<span style="color:#22c55e">TWS {fmtV(cur?.tws ?? null, 1, 'kn')}</span>{#if cur?.aws != null}<br/><span style="color:#fb923c;font-weight:500">AWS {cur.aws.toFixed(1)} kn</span>{/if}
		</span>
	</div>
	{:else if hasAws && awsM}
	{@const area = areaPath(awsM)}
	{@const line = smoothPath(awsM)}
	{@const cy   = curY(awsM, cur?.aws ?? null)}
	<div class="track">
		<span class="track-lbl">AWS</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<path d={area} fill="rgba(251,146,60,0.15)"/>
			<path d={line} stroke="#fb923c" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill="#fb923c"/>{/if}
		</svg>
		<span class="track-val" style="color:#fb923c">{fmtV(cur?.aws ?? null, 1, 'kn')}</span>
	</div>
	{/if}

	{#if hasTwd}
	<div class="track">
		<span class="track-lbl">TWD</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<!-- N/S labels -->
			<text x={PL} y={PT+6} font-size="7" fill="rgba(255,255,255,0.3)" font-family="monospace">N</text>
			<text x={PL} y={PT+IH} font-size="7" fill="rgba(255,255,255,0.3)" font-family="monospace">S</text>
			{@html twdDots}
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
		</svg>
		<span class="track-val" style="color:rgba(167,243,208,0.9)">{fmtTWD(cur?.twd ?? null)}</span>
	</div>
	{/if}

	{#if hasAwa}
	{@const cx_center = PT + IH / 2}
	<div class="track">
		<span class="track-lbl">AWA</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<!-- Centre line (0° = close hauled boundary) -->
			<line x1={PL} y1={cx_center} x2={W-PR} y2={cx_center} stroke="rgba(255,255,255,0.12)" stroke-width="0.5"/>
			<text x={PL} y={cx_center - 2} font-size="6" fill="rgba(255,255,255,0.25)" font-family="monospace">S</text>
			<text x={PL} y={cx_center + 8} font-size="6" fill="rgba(255,255,255,0.25)" font-family="monospace">P</text>
			<!-- Starboard (positive) in green -->
			{#if awaPath.stbd}<path d={awaPath.stbd} stroke="#22c55e" stroke-width="1.2" fill="none" stroke-linejoin="round"/>{/if}
			<!-- Port (negative) in red -->
			{#if awaPath.port}<path d={awaPath.port} stroke="#ef4444" stroke-width="1.2" fill="none" stroke-linejoin="round"/>{/if}
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
		</svg>
		<span class="track-val" style="color:{cur?.awa != null ? (cur.awa >= 0 ? '#22c55e' : '#ef4444') : 'var(--muted)'}">
			{fmtAWA(cur?.awa ?? null)}
		</span>
	</div>
	{/if}

	{#if hasBaro && baroM}
	{@const line = smoothPath(baroM)}
	{@const cy   = curY(baroM, cur?.baro ?? null)}
	<!-- Baro trend annotation -->
	{@const baroTrend = (() => {
		if (points.length < 4) return '';
		const recent = points.slice(-Math.min(12, Math.floor(points.length/4)));
		const first = recent.find(p => p.baro != null)?.baro;
		const last  = [...recent].reverse().find(p => p.baro != null)?.baro;
		if (first == null || last == null) return '';
		const diff = last - first;
		return diff > 0.3 ? '↑' : diff < -0.3 ? '↓' : '→';
	})()}
	<div class="track">
		<span class="track-lbl">Baro {baroTrend}</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<path d={line} stroke="#a78bfa" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill="#a78bfa"/>{/if}
		</svg>
		<span class="track-val" style="color:#a78bfa">{fmtV(cur?.baro ?? null, 0, 'hPa')}</span>
	</div>
	{/if}

	{#if hasDepth && depthM}
	{@const area = areaPath(depthM)}
	{@const line = smoothPath(depthM)}
	{@const cy   = curY(depthM, cur?.depth ?? null)}
	<div class="track">
		<span class="track-lbl">Depth</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<path d={area} fill="rgba(14,165,233,0.15)"/>
			<path d={line} stroke="#0ea5e9" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill="#0ea5e9"/>{/if}
		</svg>
		<span class="track-val" style="color:#0ea5e9">{fmtV(cur?.depth ?? null, 1, 'm')}</span>
	</div>
	{/if}

	{#if hasSoc && socM}
	{@const line = smoothPath(socM)}
	{@const curSoc = cur?.batt_soc ?? null}
	{@const cy    = curY(socM, curSoc)}
	<div class="track">
		<span class="track-lbl">Batt</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<path d={line} stroke={socColor(curSoc)} stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill={socColor(curSoc)}/>{/if}
		</svg>
		<span class="track-val" style="color:{socColor(curSoc)}">{fmtV(curSoc, 0, '%')}</span>
	</div>
	{/if}

	{#if hasTemp && tempM}
	{@const airLine   = tempLine(p => p.air_temp)}
	{@const waterLine = tempLine(p => p.water_temp)}
	{@const cy_air   = cur?.air_temp   != null ? vy(cur.air_temp,   tempM.min, tempM.range) : null}
	{@const cy_water = cur?.water_temp != null ? vy(cur.water_temp, tempM.min, tempM.range) : null}
	<div class="track">
		<span class="track-lbl">Temp</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			{#if airLine}  <path d={airLine}   stroke="#fb923c" stroke-width="1.5" fill="none" stroke-linejoin="round"/>{/if}
			{#if waterLine}<path d={waterLine} stroke="#38bdf8" stroke-width="1.5" fill="none" stroke-dasharray="3 2" stroke-linejoin="round"/>{/if}
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy_air   != null}<circle cx={cursorX} cy={cy_air}   r="3" fill="#fb923c"/>{/if}
			{#if cy_water != null}<circle cx={cursorX} cy={cy_water} r="3" fill="#38bdf8"/>{/if}
		</svg>
		<span class="track-val">
			{#if cur?.air_temp != null}<span style="color:#fb923c">{cur.air_temp.toFixed(0)}°</span>{/if}
			{#if cur?.air_temp != null && cur?.water_temp != null}&nbsp;·&nbsp;{/if}
			{#if cur?.water_temp != null}<span style="color:#38bdf8">{cur.water_temp.toFixed(0)}°C</span>{/if}
			{#if cur?.air_temp == null && cur?.water_temp == null}—{/if}
		</span>
	</div>
	{/if}

	{#if hasWave && waveM}
	{@const area = areaPath(waveM)}
	{@const line = smoothPath(waveM)}
	{@const cy   = curY(waveM, cur?.wave_h ?? null)}
	<div class="track">
		<span class="track-lbl">Wave</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			<path d={area} fill="rgba(99,102,241,0.15)"/>
			<path d={line} stroke="#6366f1" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill="#6366f1"/>{/if}
		</svg>
		<span class="track-val" style="color:#6366f1">{fmtV(cur?.wave_h ?? null, 1, 'm')}{cur?.wave_period_s != null ? ` · ${cur.wave_period_s.toFixed(0)}s` : ''}</span>
	</div>
	{/if}

	{#if hasRpm && rpmM}
	{@const line = smoothPath(rpmM)}
	{@const cy   = curY(rpmM, cur?.eng_rpm ?? cur?.eng_sb_rpm ?? null)}
	<div class="track">
		<span class="track-lbl">RPM</span>
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="track-svg"
			role="img"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}>
			{@html engineBg}
			<path d={line} stroke="#fb923c" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
			<line class="cursor-line" x1={cursorX} y1={PT} x2={cursorX} y2={PT+IH}/>
			{#if cy != null}<circle cx={cursorX} cy={cy} r="3" fill="#fb923c"/>{/if}
		</svg>
		<span class="track-val" style="color:#fb923c">
			{#if cur?.eng_rpm != null && cur.eng_rpm > 0}P {cur.eng_rpm.toFixed(0)}{/if}
			{#if cur?.eng_sb_rpm != null && cur.eng_sb_rpm > 0} S {cur.eng_sb_rpm.toFixed(0)}{/if}
			{#if (cur?.eng_rpm ?? 0) === 0 && (cur?.eng_sb_rpm ?? 0) === 0}OFF{/if}
		</span>
	</div>
	{/if}

	<!-- ── TIME SLIDER ───────────────────────────────────────────────────── -->
	<div class="slider-area">
		<div class="time-axis">
			{#each timeTicks as tick}
				<span class="time-tick" style="left:{tick.pct}%">{tick.label}</span>
			{/each}
		</div>
		<input type="range" class="time-slider" min="0" max="1000" step="1"
			bind:value={sliderVal} aria-label="Timeline position"/>
		<div class="cursor-time">{cursorLabel}</div>
	</div>

</div>
{/if}

<style>
	.trip-charts {
		margin-top: 8px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		user-select: none;
	}

	.track {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 52px;
	}
	/* Fixed widths (not min-width) so slider aligns exactly with SVG area */
	.track-lbl {
		font-size: 9px;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		width: 36px;            /* fixed — prevents "Baro ↑" from pushing SVG */
		text-align: right;
		flex-shrink: 0;
		overflow: hidden;
		white-space: nowrap;
	}
	.track-svg {
		flex: 1;
		height: 100%;
		cursor: crosshair;
		border-radius: 3px;
		background: rgba(255,255,255,0.03);
		touch-action: none;    /* prevent page scroll during drag */
	}
	.track-val {
		font-size: 10px;
		font-weight: 600;
		width: 72px;            /* fixed — prevents layout shift */
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
		white-space: normal;    /* allow wrap for long wind values */
		line-height: 1.3;
		overflow: hidden;
	}

	/* Cursor line (rendered via SVG attribute, styled via CSS) */
	:global(.cursor-line) {
		stroke: rgba(255,255,255,0.55);
		stroke-width: 1;
		stroke-dasharray: none;
		pointer-events: none;
	}

	/* ── Slider area ── */
	/* padding-left = label width (36px) + gap (6px) = 42px  */
	/* padding-right = value width (72px) + gap (6px) = 78px */
	.slider-area {
		margin-top: 6px;
		padding-left: 42px;
		padding-right: 78px;
		position: relative;
	}
	.time-axis {
		position: relative;
		height: 14px;
		margin-bottom: 2px;
	}
	.time-tick {
		position: absolute;
		transform: translateX(-50%);
		font-size: 9px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.time-slider {
		width: 100%;
		height: 3px;
		-webkit-appearance: none;
		appearance: none;
		background: rgba(255,255,255,0.12);
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}
	.time-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 14px; height: 14px;
		background: #00c8ff;
		border-radius: 50%;
		cursor: pointer;
		box-shadow: 0 0 4px rgba(0,200,255,0.5);
	}
	.time-slider::-moz-range-thumb {
		width: 14px; height: 14px;
		background: #00c8ff;
		border-radius: 50%;
		border: none;
		cursor: pointer;
	}
	.cursor-time {
		margin-top: 4px;
		text-align: center;
		font-size: 10px;
		font-weight: 600;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
	}

	/* ── Animations ──────────────────────────────────────────────────────── */

	/* Chart reveal: each track SVG slides in from left, staggered by track order */
	@keyframes chart-reveal {
		from { clip-path: inset(0 100% 0 0 round 3px); opacity: 0.4; }
		to   { clip-path: inset(0 0%   0 0 round 3px); opacity: 1; }
	}

	/* Area fill fades in slightly after the line */
	@keyframes area-fade {
		from { opacity: 0; }
		to   { opacity: 1; }
	}

	/* Cursor dot subtle bounce when it jumps to a new position */
	@keyframes dot-pop {
		0%   { transform: scale(0.5); opacity: 0.6; }
		60%  { transform: scale(1.4); opacity: 1; }
		100% { transform: scale(1);   opacity: 1; }
	}

	/* Apply reveal to all track SVGs with staggered delay */
	.track-svg {
		animation: chart-reveal 0.7s cubic-bezier(0.22, 1, 0.36, 1) both;
	}

	/* Stagger each track by 45ms */
	.track:nth-child(1)  .track-svg { animation-delay:   0ms; }
	.track:nth-child(2)  .track-svg { animation-delay:  45ms; }
	.track:nth-child(3)  .track-svg { animation-delay:  90ms; }
	.track:nth-child(4)  .track-svg { animation-delay: 135ms; }
	.track:nth-child(5)  .track-svg { animation-delay: 180ms; }
	.track:nth-child(6)  .track-svg { animation-delay: 225ms; }
	.track:nth-child(7)  .track-svg { animation-delay: 270ms; }
	.track:nth-child(8)  .track-svg { animation-delay: 315ms; }
	.track:nth-child(9)  .track-svg { animation-delay: 360ms; }
	.track:nth-child(10) .track-svg { animation-delay: 405ms; }
	.track:nth-child(n+11) .track-svg { animation-delay: 450ms; }

	/* Area paths fade in 150ms after the clip-path starts */
	:global(.track-svg path[fill]) {
		animation: area-fade 0.5s ease-out 0.3s both;
	}

	/* Cursor dots pop when appearing */
	:global(.track-svg circle:not([r="1.4"])) {
		animation: dot-pop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}

	/* Smooth cursor line movement */
	:global(.cursor-line) {
		transition: x1 0.05s ease, x2 0.05s ease;
	}
</style>
