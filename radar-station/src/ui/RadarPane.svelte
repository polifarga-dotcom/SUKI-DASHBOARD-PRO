<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { RadarRenderer, type View } from '../radar/renderer';
	import { drawOverlay } from '../radar/overlay';
	import { fromScreen, toScreen } from '../radar/view';
	import { ChartLayer } from '../chart/chartLayer';
	import { chartCfg, providers, activeAttributions, provider } from '../chart/layers.svelte';
	import { imagery, updateImageryMeta, type ImageryMeta } from '../chart/imageryMeta.svelte';
	import { settings } from '../lib/settings.svelte';
	import { own, ownFresh } from '../data/signalk.svelte';
	import { radar, radarRange, isLive, setControl, spokeUrl, acquireTarget, ctlValue } from '../data/mayara.svelte';
	import { targets, ui, visibleTargets } from '../collision/targets.svelte';
	import { alarms } from '../alarms/alarms.svelte';
	import { tools, addMarker, markSquall, removeSquall } from '../radar/tools.svelte';
	import { squallPos } from '../collision/squall';
	import { bearingOf, fmtDeg, fmtDist, fmtLat, fmtLon, fmtRange, fmtSpeed, fmtTime, fromLocal, toLocal, isNauticalRange, norm2pi, numStr, ringStep, NM, type LatLon } from '../lib/geo';
	import { unlockAudio } from '../alarms/audio';
	import type { SpokeBatch } from '../radar/spokeDecoder';
	import { t as tr } from '../lib/i18n.svelte';
	import Icon from './Icon.svelte';
	import { countryOf, shipTypeText, navStateText } from '../lib/ais';

	let { radarId, pane = 0, label = '' }: { radarId: string; pane?: number; label?: string } = $props();

	let host: HTMLDivElement;
	let glCanvas: HTMLCanvasElement;
	let ovCanvas: HTMLCanvasElement;
	let renderer: RadarRenderer | null = null;
	let chart: ChartLayer | null = null;
	let worker: Worker | null = null;
	let w = $state(800);
	let h = $state(600);
	let glError = $state('');
	let localRange = $state(1.5 * NM);
	/** freies Verschieben: geografischer Punkt in der Bildschirmmitte (null = am Schiff) */
	let panAnchor: LatLon | null = $state(null);
	let dragStart: { view: View; pos: LatLon } | null = null;
	let lastBBox = 0;
	let courseRef: number | null = $state(null);
	let lastView: View | null = null;
	let stabilized = $state(true);
	let lastReactive = 0;

	const R = $derived(radar.byId[radarId]);
	const caps = $derived(R?.caps ?? null);
	const tx = $derived(R ? (R.lastSpoke, isLive(radarId)) : false);
	const power = $derived(Number(ctlValue(radarId, 'power') ?? 0));
	const rangeAllowed = $derived(!!R && R.controls?.range?.allowed !== false);
	/** Zoom = Radar-Range (wie am Plotter); sonst nur Kartenmaßstab */
	const radarZoom = $derived(!!R && rangeAllowed && tx && !settings.chartZoomFree);
	const range = $derived(radarZoom ? radarRange(radarId) || localRange : localRange);
	// nur beim Wechsel Radar-Zoom → Kartenzoom die letzte Radar-Range übernehmen (kein Sprung)
	let prevRadarZoom = true;
	$effect(() => {
		const rz = radarZoom;
		if (prevRadarZoom && !rz) {
			const r = untrack(() => radarRange(radarId));
			if (r) localRange = r;
		}
		prevRadarZoom = rz;
	});

	const LOCAL_STEPS = [29, 57, 115, 231, 463, 926, 1389, 1852, 2778, 3704, 5556, 7408, 11112, 14816, 22224, 29632, 44448, 66672, 88896, 118528, 177792];
	const steps = $derived.by(() => {
		if (!radarZoom) return LOCAL_STEPS;
		const all = caps?.supportedRanges ?? [57, 115, 231, 463, 926, 1389, 1852, 2778, 3704, 5556, 7408, 11112, 14816, 22224, 29632, 44448, 66672];
		const naut = all.filter(isNauticalRange);
		return isNauticalRange(range) || !caps ? naut : all.filter((r) => !isNauticalRange(r));
	});

	function stepRange(dir: 1 | -1) {
		const idx = steps.findIndex((r) => r >= range - 1);
		const cur = idx < 0 ? steps.length - 1 : idx;
		const next = steps[Math.max(0, Math.min(steps.length - 1, cur + dir))];
		if (!next || next === range) return;
		if (radarZoom) setControl(radarId, 'range', { value: next });
		else localRange = next;
	}

	const heading = () => (own.hdg != null && Date.now() - own.hdgT < 10000 ? own.hdg : null);

	function computeView(): View {
		const hd = heading();
		let up = 0;
		if (settings.orientation === 'head') up = hd ?? 0;
		else if (settings.orientation === 'course') up = courseRef ?? hd ?? own.cog ?? 0;
		const base = (Math.min(w, h) / 2) * 0.93;
		let cx = w / 2;
		let cy = h / 2;
		let rad = base;
		if (settings.motion === 'lookahead') {
			// Eigenschiff nach achtern versetzt, in Fahrtrichtung mehr Sicht
			const dir = (hd ?? own.cog ?? 0) - up;
			cx -= Math.sin(dir) * base * 0.5;
			cy += Math.cos(dir) * base * 0.5;
			rad = base * 1.25;
		} else if (settings.motion === 'custom') {
			cx += settings.offset[0] * base;
			cy += settings.offset[1] * base;
			rad = base * 1.15;
		}
		const ppm = rad / range;
		if (panAnchor && own.pos) {
			// Bildschirmmitte = verschobener Punkt; Eigenschiff relativ dazu
			const [ax, ay] = toLocal(own.pos, panAnchor);
			const c = Math.cos(up);
			const s = Math.sin(up);
			cx = w / 2 - (ax * c - ay * s) * ppm;
			cy = h / 2 + (ay * c + ax * s) * ppm;
		}
		return { width: w, height: h, dpr: window.devicePixelRatio || 1, cx, cy, ppm, up, heading: hd ?? 0, gamma: settings.echoGamma, opacity: settings.radarOpacity };
	}

	function onWorker(e: MessageEvent) {
		const m = e.data;
		const r = radar.byId[radarId];
		if (m.type === 'spokes') {
			renderer?.addSpokes(m.batch as SpokeBatch, heading(), caps?.legend ?? null);
			const now = Date.now();
			if (r && now - lastReactive > 1000) {
				lastReactive = now;
				r.lastSpoke = now;
				stabilized = renderer?.isStabilized ?? true;
			}
		} else if (m.type === 'rev' && r) {
			r.guardCounts = m.counts;
			if (m.period > 0) r.revPeriod = m.period;
			renderer?.setTrails(settings.trails, m.period);
		} else if (m.type === 'rate' && r) {
			if (r.spokeRate !== m.msgs) r.spokeRate = m.msgs;
		} else if (m.type === 'status' && r) r.spokeConnected = m.connected;
	}

	// Worker je Radar-ID / Server
	$effect(() => {
		const id = radarId;
		const base = settings.radarBase;
		if (!id || !radar.byId[id]) return;
		worker?.terminate();
		renderer?.clear();
		worker = new Worker(new URL('../radar/spokeWorker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = onWorker;
		worker.postMessage({ cmd: 'connect', url: spokeUrl(id), radarId: id, base });
		return () => {
			worker?.terminate();
			worker = null;
		};
	});

	// Hintergrund: Radarbild-Verbindung schließen (spart ~1 MB/s und Akku), bei Rückkehr neu verbinden
	$effect(() => {
		const onVis = () => {
			if (!worker) return;
			if (document.hidden) worker.postMessage({ cmd: 'close' });
			else if (radar.byId[radarId]) worker.postMessage({ cmd: 'connect', url: spokeUrl(radarId), radarId });
		};
		document.addEventListener('visibilitychange', onVis);
		return () => document.removeEventListener('visibilitychange', onVis);
	});

	// App kommt aus dem Hintergrund zurück → Radarbild-Verbindung erneuern
	$effect(() => {
		if (tools.resume) untrack(() => radar.byId[radarId] && worker?.postMessage({ cmd: 'connect', url: spokeUrl(radarId), radarId }));
	});

	// Guard Zones / Legende an den Worker
	$effect(() => {
		const zones = settings.guard.map((g) => ({ enabled: g.enabled && pane === 0, start: g.start, end: g.end, inner: g.inner, outer: g.outer }));
		const c = caps;
		worker?.postMessage({
			cmd: 'config',
			zones,
			spokesPerRev: c?.spokesPerRevolution,
			strong: c?.legend?.strongReturn,
			maxNormal: (c?.legend?.pixelColors ?? 16) - 1
		});
		if (c) renderer?.setSpokesPerRev(c.spokesPerRevolution);
	});

	$effect(() => {
		renderer?.setPalette(caps?.legend ?? null, settings.palette, settings.theme);
	});
	$effect(() => {
		renderer?.setTrails(settings.trails, R?.revPeriod ?? 2500);
	});
	$effect(() => {
		if (settings.chart && host && !chart) chart = new ChartLayer(host);
		else if (!settings.chart && chart) {
			chart.destroy();
			chart = null;
		}
	});
	// Ebenen-Konfiguration → Kartenunterlage
	$effect(() => {
		JSON.stringify(chartCfg);
		providers.list;
		chart?.sync();
	});
	const attribution = $derived.by(() => {
		JSON.stringify(chartCfg);
		providers.list;
		return settings.chart ? activeAttributions().join(' · ') : '';
	});
	$effect(() => {
		if (settings.orientation === 'course') courseRef = heading() ?? own.cog ?? 0;
		else courseRef = null;
	});

	onMount(() => {
		try {
			renderer = new RadarRenderer(glCanvas);
			renderer.setPalette(caps?.legend ?? null, settings.palette, settings.theme);
		} catch (e) {
			glError = String(e);
		}
		const ro = new ResizeObserver(() => {
			w = host.clientWidth;
			h = host.clientHeight;
		});
		ro.observe(host);
		const ctx = ovCanvas.getContext('2d')!;
		let raf = 0;
		let lastDraw = 0;
		const frame = (ts: number) => {
			raf = requestAnimationFrame(frame);
			if (document.hidden) return;
			// Akku: 60 fps nur beim Bedienen, 30 fps bei sendendem Radar, sonst 10 fps (Blinken bleibt sichtbar).
			// Ohne Begrenzung zeichnet ein iPad Pro (ProMotion) bis zu 120×/s, auch wenn sich nichts ändert.
			const fps = ptrs.size || ts - lastInput < 800 ? 60 : untrack(() => tx) ? 30 : 10;
			if (ts - lastDraw < 1000 / fps - 2) return;
			lastDraw = ts;
			const v = computeView();
			lastView = v;
			renderer?.render(v);
			const W = Math.round(v.width * v.dpr);
			const H = Math.round(v.height * v.dpr);
			if (ovCanvas.width !== W || ovCanvas.height !== H) {
				ovCanvas.width = W;
				ovCanvas.height = H;
			}
			drawOverlay(ctx, {
				view: v,
				range,
				s: settings,
				own,
				heading: heading(),
				targets: visibleTargets(),
				selected: ui.selected,
				ebl: tools.ebl,
				markers: tools.markers,
				squalls: tools.squalls,
				cursor: pane === 0 || tools.cursor ? tools.cursor : null,
				guardHit: alarms.guardHit,
				alarmKeys: new Map(alarms.active.filter((a) => a.targetKey).map((a) => [a.targetKey!, !a.acked])),
				track: settings.trackHours > 0 ? tools.track : [],
				measure: pane === 0 ? tools.measure : null,
				alignFirst: pane === 0 ? (tools.align?.first ?? null) : null,
				now: Date.now(),
				label
			});
			// sichtbarer Ausschnitt für den Revier-Download (1×/s)
			if (pane === 0 && own.pos && Date.now() - lastBBox > 1000) {
				lastBBox = Date.now();
				const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([sx, sy]) => fromLocal(own.pos!, ...fromScreen(v, sx, sy)));
				tools.viewBBox = [Math.min(...pts.map((p) => p.lon)), Math.min(...pts.map((p) => p.lat)), Math.max(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lat))];
				// Bildschirmmitte + Kartenzoom für Aufnahmedatum/Auflösung der Satellitenbilder
				const center = fromLocal(own.pos!, ...fromScreen(v, w / 2, h / 2));
				const z = Math.round(Math.log2(156543.03392 * Math.cos((center.lat * Math.PI) / 180) * v.ppm));
				updateImageryMeta(center, z);
			}
			chart?.update(v, ownFresh() || settings.sim ? own.pos : null, settings.chartOpacity, settings.theme === 'night' ? 'brightness(.35) sepia(1) hue-rotate(-40deg) saturate(3)' : settings.theme === 'dusk' ? 'brightness(.55) contrast(1.1)' : '');
		};
		raf = requestAnimationFrame(frame);
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
			renderer?.destroy();
			chart?.destroy();
			chart = null;
		};
	});

	// ── Eingaben ──
	let lastInput = 0; // performance.now() der letzten Bedienung (für die Bildrate)
	const markInput = () => (lastInput = performance.now());
	const ptrs = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
	let pinch0 = 0;
	let longTimer: ReturnType<typeof setTimeout> | undefined;
	let dragOffset: [number, number] | null = null;

	function local(e: PointerEvent | MouseEvent) {
		const r = host.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top] as [number, number];
	}

	function pick(sx: number, sy: number) {
		if (!lastView) return null;
		let best: string | null = null;
		let bd = 26;
		for (const t of visibleTargets()) {
			const [px, py] = toScreen(lastView, t.x, t.y);
			const d = Math.hypot(px - sx, py - sy);
			if (d < bd) {
				bd = d;
				best = t.key;
			}
		}
		return best;
	}

	function onDown(e: PointerEvent) {
		markInput();
		unlockAudio();
		host.setPointerCapture(e.pointerId);
		hover = null;
		const [x, y] = local(e);
		ptrs.set(e.pointerId, { x, y, x0: x, y0: y, t0: Date.now() });
		tools.menu = null;
		if (ptrs.size === 2) {
			const [a, b] = [...ptrs.values()];
			pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
			clearTimeout(longTimer);
		} else if (ptrs.size === 1) {
			if (settings.motion === 'custom' && !panAnchor) dragOffset = [...settings.offset] as [number, number];
			else if (lastView && own.pos) dragStart = { view: lastView, pos: { ...own.pos } };
			clearTimeout(longTimer);
			if (e.pointerType !== 'mouse')
				longTimer = setTimeout(() => {
					openMenu(x, y);
					ptrs.clear();
				}, 550);
		}
	}

	// Maus-Hover über einem Ziel → Info-Tooltip
	let hover: { key: string; x: number; y: number } | null = $state(null);

	function onMove(e: PointerEvent) {
		markInput();
		if (e.pointerType === 'mouse' && ptrs.size === 0) {
			const [x, y] = local(e);
			const k = pick(x, y);
			hover = k ? { key: k, x, y } : null;
			return;
		}
		const p = ptrs.get(e.pointerId);
		if (!p) return;
		const [x, y] = local(e);
		p.x = x;
		p.y = y;
		if (Math.hypot(x - p.x0, y - p.y0) > 10) clearTimeout(longTimer);
		if (ptrs.size === 2 && pinch0 > 0) {
			const [a, b] = [...ptrs.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (d / pinch0 > 1.35) {
				stepRange(-1);
				pinch0 = d;
			} else if (d / pinch0 < 0.74) {
				stepRange(1);
				pinch0 = d;
			}
		} else if (ptrs.size === 1 && dragStart && Math.hypot(x - p.x0, y - p.y0) > 10) {
			const [lx, ly] = fromScreen(dragStart.view, w / 2 - (x - p.x0), h / 2 - (y - p.y0));
			panAnchor = fromLocal(dragStart.pos, lx, ly);
			hover = null;
		} else if (ptrs.size === 1 && dragOffset && Math.hypot(x - p.x0, y - p.y0) > 10) {
			const base = (Math.min(w, h) / 2) * 0.93;
			settings.offset = [
				Math.max(-0.9, Math.min(0.9, dragOffset[0] + (x - p.x0) / base)),
				Math.max(-0.9, Math.min(0.9, dragOffset[1] + (y - p.y0) / base))
			];
		}
	}

	function onUp(e: PointerEvent) {
		const p = ptrs.get(e.pointerId);
		clearTimeout(longTimer);
		ptrs.delete(e.pointerId);
		if (ptrs.size < 2) pinch0 = 0;
		dragOffset = null;
		dragStart = null;
		if (!p || ptrs.size > 0) return;
		const moved = Math.hypot(p.x - p.x0, p.y - p.y0);
		if (moved > 10 || Date.now() - p.t0 > 600 || e.button === 2) return;
		tap(p.x, p.y);
	}

	function tap(sx: number, sy: number) {
		if (!lastView) return;
		const [x, y] = fromScreen(lastView, sx, sy);
		const mode = tools.tapMode;
		if (mode === 'acquire') {
			acquireAt(x, y);
			tools.tapMode = 'select';
			return;
		}
		if (mode === 'ebl') {
			setEbl(x, y);
			tools.tapMode = 'select';
			return;
		}
		if (mode === 'align') {
			const geo = own.pos ? fromLocal(own.pos, x, y) : null;
			const a = tools.align;
			if (!a || !geo) {
				tools.tapMode = 'select';
				return;
			}
			if (!a.first) {
				a.first = geo;
				return;
			}
			// erster Tap = Merkmal im Satellitenbild, zweiter = wahre Lage → Versatz = wahr − gesehen
			const [dx, dy] = toLocal(a.first, geo);
			const l = chartCfg.layers.find((q) => q.id === a.layer);
			if (l) {
				l.dx = Math.round(l.dx + dx);
				l.dy = Math.round(l.dy + dy);
			}
			tools.align = null;
			tools.tapMode = 'select';
			return;
		}
		if (mode === 'measure') {
			if (!own.pos) return;
			const geo = fromLocal(own.pos, x, y);
			if (!tools.measure || tools.measure.b) tools.measure = { a: geo, b: null };
			else tools.measure.b = geo;
			return;
		}
		if (mode === 'mark') {
			if (own.pos) addMarker(fromLocal(own.pos, x, y));
			tools.tapMode = 'select';
			return;
		}
		const k = pick(sx, sy);
		if (k) {
			ui.selected = k;
			settings.sidePanel = true;
			settings.sideTab = 'targets';
		} else {
			ui.selected = null;
			tools.cursor = own.pos ? fromLocal(own.pos, x, y) : null;
		}
	}

	function setEbl(x: number, y: number) {
		const e = tools.ebl[tools.activeEbl];
		const brg = bearingOf(x, y);
		e.brg = e.relative ? norm2pi(brg - (heading() ?? 0)) : brg;
		e.vrm = Math.hypot(x, y);
		e.on = true;
	}

	function acquireAt(x: number, y: number) {
		if (!own.pos || !R) return;
		const p = fromLocal(own.pos, x, y);
		acquireTarget(radarId, p.lat, p.lon);
	}

	function openMenu(sx: number, sy: number) {
		if (!lastView) return;
		const [x, y] = fromScreen(lastView, sx, sy);
		tools.cursor = own.pos ? fromLocal(own.pos, x, y) : null;
		tools.menu = { sx, sy, x, y, pane };
	}

	function onContext(e: MouseEvent) {
		e.preventDefault();
		const [x, y] = local(e);
		openMenu(x, y);
	}

	let wheelAcc = 0;
	function onWheel(e: WheelEvent) {
		e.preventDefault();
		markInput();
		wheelAcc += e.deltaY;
		if (Math.abs(wheelAcc) > 60) {
			stepRange(wheelAcc > 0 ? 1 : -1);
			wheelAcc = 0;
		}
	}

	async function transmit(on: boolean) {
		if (!R) return;
		await setControl(radarId, 'power', { value: on ? 2 : 1 });
	}

	const cursorInfo = $derived.by(() => {
		ui.version;
		const c = tools.cursor;
		if (!c || !own.pos) return null;
		const [x, y] = toLocal(own.pos, c);
		return { brg: bearingOf(x, y), dist: Math.hypot(x, y), pos: c };
	});

	const ringTxt = $derived(fmtDist(ringStep(range).step));
	const modeName = $derived(caps?.controls?.mode?.descriptions?.[String(ctlValue(radarId, 'mode'))] ?? '');
	const ctlShort = (n: string) => {
		const c = R?.controls?.[n];
		if (!c) return '—';
		return c.auto ? 'A' + (c.autoValue ? (c.autoValue > 0 ? '+' : '') + c.autoValue : '') : String(c.value ?? '—');
	};
	const orientLabel = { head: 'H-UP', north: 'N-UP', course: 'C-UP' } as const;
	const motionLabel = { center: 'CENTER', lookahead: 'LOOK AHEAD', custom: 'OFFSET' } as const; // über tr() angezeigt
	const cycleOrient = () => (settings.orientation = settings.orientation === 'head' ? 'north' : settings.orientation === 'north' ? 'course' : 'head');
	const cycleMotion = () => (settings.motion = settings.motion === 'center' ? 'lookahead' : settings.motion === 'lookahead' ? 'custom' : 'center');
	const tip = $derived.by(() => {
		ui.version;
		if (!hover) return null;
		const t = targets.byKey.get(hover.key);
		if (!t) return null;
		const e = t.enc;
		const future = !!e && e.tcpa > 0 && isFinite(e.tcpa);
		const v = t.vessel;
		return {
			t,
			left: hover.x + 280 > w ? hover.x - 276 : hover.x + 18,
			top: Math.min(hover.y + 14, h - 250),
			name: t.label,
			sub: t.kind === 'ais' ? `MMSI ${v?.mmsi ?? '—'}` : `${tr('Radar target')} · ${tr(t.arpa?.acquisition === 'manual' ? 'manual' : 'auto')}`,
			rows: [
				[tr('Range'), fmtDist(t.range)],
				['SOG', fmtSpeed(t.sog)],
				['COG', t.cog != null && (t.sog ?? 0) >= 0.1 ? `${fmtDeg(t.cog)}T` : '—'],
				['CPA', future ? fmtDist(e!.cpa) : e && isFinite(e.tcpa) ? tr('opening') : '—'],
				['TCPA', future ? fmtTime(e!.tcpa) : '—'],
				[tr('Type'), t.kind === 'ais' ? shipTypeText(v?.shipType, v?.shipTypeName, tr) : 'ARPA'],
				[tr('Country'), t.kind === 'ais' ? countryOf(v?.mmsi, tr) : '—'],
				[tr('Status'), t.kind === 'ais' ? navStateText(v?.navState, tr) : tr(t.arpa?.status ?? '—')]
			] as [string, string][]
		};
	});
	const hint = $derived.by(() => {
		switch (tools.tapMode) {
			case 'acquire':
				return tr('Tap on the screen to acquire a target');
			case 'ebl':
				return tr('Tap on the screen to set EBL/VRM {n}', { n: tools.activeEbl + 1 });
			case 'align':
				return tools.align?.first
					? tr('Now tap where this feature really is (chart, buoy, own boat)')
					: tr('Tap a distinctive feature in the satellite image (pier end, reef edge)');
			case 'measure':
				return !tools.measure || tools.measure.b ? tr('Tap the start point') : tr('Tap the end point');
			default:
				return tr('Tap on the screen to place a marker');
		}
	});
	// Satellitenbilder: Aufnahmedatum, Alter, Auflösung (unten im Bild)
	const fmtDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString(settings.lang === 'de' ? 'de-DE' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
	function age(d: string) {
		const days = Math.round((Date.now() - Date.parse(d + 'T12:00:00Z')) / 86400e3);
		if (days < 1) return tr('today');
		if (days < 60) return tr('{n} days old', { n: days });
		const months = Math.round(days / 30.4);
		return months < 24 ? tr('{n} months old', { n: months }) : tr('{n} years old', { n: Math.round(days / 365) });
	}
	function metaText(m: ImageryMeta) {
		const name = provider(m.id)?.name.replace(/\s*\(.*\)\s*$/, '') ?? m.id;
		const parts: string[] = [];
		if (m.kind === 'year' && m.year) parts.push(tr('mosaic {y}', { y: m.year }));
		else if (m.date) parts.push(`${fmtDate(m.date)}${m.time ? ' ' + m.time + ' UTC' : ''} (${age(m.date)})`);
		else parts.push(tr('date unknown'));
		parts.push(m.res != null ? `${numStr(+m.res.toFixed(m.res < 1 ? 2 : 0))} m` : tr(m.resolution ?? ''));
		if (m.acc != null) parts.push(`±${Math.round(m.acc)} m`);
		if (m.cloud != null) parts.push(tr('{n} % clouds', { n: Math.round(m.cloud) }));
		return `${name}: ${parts.filter(Boolean).join(' · ')}`;
	}
	const imageryLine = $derived(settings.chart ? imagery.list.map(metaText).join('\n') : '');

	const noHeading = $derived.by(() => {
		ui.version;
		return heading() == null;
	});
</script>

<div
	class="pane"
	bind:this={host}
	onpointerdown={onDown}
	onpointermove={onMove}
	onpointerup={onUp}
	onpointercancel={onUp}
	onpointerleave={() => (hover = null)}
	oncontextmenu={onContext}
	onwheel={onWheel}
	onscroll={(e) => {
		const el = e.currentTarget as HTMLElement;
		el.scrollLeft = 0;
		el.scrollTop = 0;
	}}
	role="application"
	aria-label="{tr('Radar display')} {label}"
>
	<canvas class="gl" bind:this={glCanvas}></canvas>
	<canvas class="ov" bind:this={ovCanvas}></canvas>

	<!-- A/B-Wahl (HALO Dual Range) neben Transmit/Standby; nur Einzelansicht -->
	{#snippet radarPick()}
		{#if !label && radar.list.length > 1}
			<div class="seg pick" role="group" aria-label={tr('Radar range')}>
				{#each radar.list as id}
					<button class:on={settings.radarId === id} onclick={() => (settings.radarId = id)}>{radar.byId[id]?.name.replace(/^.*\s/, '') || id}</button>
				{/each}
			</div>
		{/if}
	{/snippet}

	<div class="hud tl" onpointerdown={(e) => e.stopPropagation()} role="toolbar" tabindex="-1">
		<div class="range num">{fmtRange(range)}</div>
		<div class="muted num small">{tr('Rings')} {ringTxt}</div>
		<div class="row">
			<button onclick={cycleOrient} title={tr('Orientation (O)')}>{orientLabel[settings.orientation]}</button>
			<button onclick={cycleMotion} title={tr('Own ship position (P)')}>{tr(motionLabel[settings.motion])}</button>
		</div>
		{#if noHeading && settings.orientation !== 'head'}<div class="warn small">{tr('No heading – image head-up')}</div>{/if}
		{#if !stabilized && tx}<div class="warn small">{tr('Not stabilised')}</div>{/if}
	</div>

	<div class="hud tr" onpointerdown={(e) => e.stopPropagation()} role="toolbar" tabindex="-1">
		<div class="txrow">
			<span class="dot" class:tx class:stby={!tx && R} class:off={!R}></span>
			<b>{R ? (tx ? 'TX' : tr(power === 3 ? 'WARMING UP' : power === 4 ? 'FAULT' : power === 0 ? 'OFF' : 'STANDBY')) : tr('NO RADAR')}</b>
			{#if label}<span class="muted">{label}</span>{/if}
		</div>
		{#if R && (tx || power === 2 || power === 3)}
			<div class="pickrow">
				{@render radarPick()}
				<button class="stbybtn" onclick={() => transmit(false)} disabled={R.replay} title={tr('Stop transmitting')}><Icon name="power" size={16} /> {tr('Standby')}</button>
			</div>
		{/if}
		{#if R}
			<div class="muted small num">{tr(modeName)} · G {ctlShort('gain')} · S {ctlShort('sea')} · R {ctlShort('rain')}</div>
			{#if Number(ctlValue(radarId, 'doppler')) > 0}<div class="small dopp">VelocityTrack {tr(caps?.controls?.doppler?.descriptions?.[String(ctlValue(radarId, 'doppler'))] ?? '')}</div>{/if}
		{/if}
	</div>

	<div class="hud bl" onpointerdown={(e) => e.stopPropagation()} role="status">
		{#if cursorInfo}
			<div class="num">
				<span class="muted">{tr('CUR')}</span>
				{fmtDeg(cursorInfo.brg)}T · {fmtDist(cursorInfo.dist)}
				<button class="mini" onclick={() => (tools.cursor = null)} aria-label={tr('Clear cursor')}><Icon name="x" size={14} /></button>
			</div>
			{#if cursorInfo.pos}<div class="num muted small">{fmtLat(cursorInfo.pos.lat)} {fmtLon(cursorInfo.pos.lon)}</div>{/if}
		{/if}
		{#each tools.ebl as e, i}
			{#if e.on}
				<div class="num ebl">
					<span>EBL{i + 1}</span>
					{fmtDeg(e.brg, 1)}{e.relative ? 'R' : 'T'}
					{#if e.vrm}· VRM{i + 1} {fmtDist(e.vrm)}{/if}
					<button class="mini" onclick={() => (e.on = false)} aria-label={tr('Clear EBL/VRM {n}', { n: i + 1 })}><Icon name="x" size={14} /></button>
				</div>
			{/if}
		{/each}
	</div>

	<div class="hud br" onpointerdown={(e) => e.stopPropagation()} role="toolbar" tabindex="-1">
		<div class="col">
			{#if panAnchor}<button class="big home" data-act="center-ship" onclick={() => (panAnchor = null)} title={tr('Back to own ship (C)')} aria-label={tr('Back to own ship (C)')}><Icon name="home" size={22} /></button>{/if}
			<button class="big" data-act="range-in" onclick={() => stepRange(-1)} aria-label={tr('Range in')} title={tr('Range in (−)')}><Icon name="plus" size={22} /></button>
			<button class="big" data-act="range-out" onclick={() => stepRange(1)} aria-label={tr('Range out')} title={tr('Range out (+)')}><Icon name="minus" size={22} /></button>
		</div>
		{#if pane === 0}
			<div class="col">
				<button class:on={tools.tapMode === 'acquire'} onclick={() => (tools.tapMode = tools.tapMode === 'acquire' ? 'select' : 'acquire')} data-act="acquire" title={tr('Acquire ARPA target (A)')} disabled={!R}><Icon name="target" /></button>
				<button class:on={tools.tapMode === 'ebl'} onclick={() => (tools.tapMode = tools.tapMode === 'ebl' ? 'select' : 'ebl')} title={tr('Place EBL/VRM (E)')}><Icon name="ruler" /></button>
				<button class:on={tools.tapMode === 'mark'} onclick={() => (tools.tapMode = tools.tapMode === 'mark' ? 'select' : 'mark')} title={tr('Place marker')}><Icon name="flag" /></button>
				<button class:on={tools.tapMode === 'measure'} onclick={() => { tools.tapMode = tools.tapMode === 'measure' ? 'select' : 'measure'; if (tools.tapMode === 'select') tools.measure = null; }} title={tr('Measure distance')}><Icon name="measure" /></button>
			</div>
		{/if}
	</div>

	{#if tools.tapMode !== 'select' && pane === 0}
		<div class="modehint">
			{hint}
			<button class="mini" onclick={() => { tools.tapMode = 'select'; tools.align = null; tools.measure = null; }}>{tools.tapMode === 'measure' ? tr('Done') : tr('Cancel')}</button>
		</div>
	{/if}

	{#if R && !tx && power !== 3}
		<div class="standby" class:compact={settings.chart} onpointerdown={(e) => e.stopPropagation()} role="dialog" tabindex="-1">
			<div class="big-txt">{tr(power === 4 ? 'RADAR FAULT' : power === 0 ? 'RADAR OFF' : 'STANDBY')}</div>
			<div class="muted">{R.name}</div>
			<div class="pickrow">
				{@render radarPick()}
				{#if power === 1}<button class="on txbtn" onclick={() => transmit(true)}><Icon name="power" /> {tr('Transmit')}</button>{/if}
			</div>
		</div>
	{:else if power === 3}
		<div class="standby"><div class="big-txt">{tr('WARMING UP')}</div></div>
	{/if}
	{#if !R}
		<div class="standby passive"><div class="muted">{radar.error ? tr(radar.error) : tr('Waiting for radar…')}</div></div>
	{/if}

	{#if glError}<div class="standby"><div class="warn">{glError}</div></div>{/if}

	{#if imageryLine && pane === 0}<div class="imgmeta">{imageryLine}</div>{/if}
	{#if attribution}<div class="attrib">{attribution}</div>{/if}

	{#if tip}
		<div class="tip {tip.t.lost ? 'lost' : tip.t.danger}" style="left:{tip.left}px; top:{tip.top}px" role="tooltip">
			<div class="tname">{tip.name}</div>
			<div class="tsub">{tip.sub}</div>
			<dl class="num">
				{#each tip.rows as [k, val]}<dt>{k}</dt><dd>{val}</dd>{/each}
			</dl>
		</div>
	{/if}

	{#if tools.menu && tools.menu.pane === pane}
		{@const m = tools.menu}
		<!-- Squall in der Nähe des Taps (0,5 sm) → „entfernen“ anbieten -->
		{@const sq = own.pos ? tools.squalls.find((q) => { const [x, y] = toLocal(own.pos!, squallPos(q, Date.now())); return Math.hypot(x - m.x, y - m.y) < 0.5 * NM; }) : undefined}
		<div class="menu" style="left:{Math.min(m.sx, w - 210)}px; top:{Math.min(m.sy, h - 300)}px" onpointerdown={(e) => e.stopPropagation()} role="menu" tabindex="-1">
			<button onclick={() => { acquireAt(m.x, m.y); tools.menu = null; }} disabled={!R}><Icon name="target" /> {tr('Acquire target')}</button>
			<button onclick={() => { setEbl(m.x, m.y); tools.menu = null; }}><Icon name="ruler" /> {tr('EBL/VRM {n} here', { n: tools.activeEbl + 1 })}</button>
			<button onclick={() => { if (own.pos) addMarker(fromLocal(own.pos, m.x, m.y)); tools.menu = null; }}><Icon name="flag" /> {tr('Place marker')}</button>
			<button onclick={() => { if (own.pos) markSquall(fromLocal(own.pos, m.x, m.y)); tools.menu = null; }} disabled={!own.pos} title={tr('Mark the centre of a rain cell; mark it again after a few minutes to get its track.')}><Icon name="cloud" /> {tr('Mark squall')}</button>
			{#if sq}<button onclick={() => { removeSquall(sq.id); tools.menu = null; }}><Icon name="trash" /> {tr('Remove squall')}</button>{/if}
			<button onclick={() => { const k = pick(m.sx, m.sy); if (k) { ui.selected = k; settings.sidePanel = true; settings.sideTab = 'targets'; } tools.menu = null; }}><Icon name="list" /> {tr('Target info')}</button>
			<button onclick={() => (tools.menu = null)}><Icon name="x" /> {tr('Close')}</button>
		</div>
	{/if}
</div>

<style>
	.pane {
		position: relative;
		overflow: hidden;
		/* clip statt hidden: die (für die Drehung übergroße) Kartenunterlage darf den Bereich nie scrollen,
		   auch nicht per Fokus */
		overflow: clip;
		background: var(--radar-bg);
		width: 100%;
		height: 100%;
		touch-action: none;
		cursor: crosshair;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	.hud {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		text-shadow: 0 1px 2px #000a;
		pointer-events: auto;
	}
	.hud button {
		background: color-mix(in srgb, var(--btn) 82%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
	.tl { top: 0; left: 0; }
	.tr { top: 0; right: 0; align-items: flex-end; text-align: right; }
	.bl { bottom: 0; left: 0; }
	.br { bottom: 0; right: 0; flex-direction: row; align-items: flex-end; gap: 8px; }
	.col { display: flex; flex-direction: column; gap: 6px; }
	.row { display: flex; gap: 6px; margin-top: 4px; }
	.range { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; color: var(--hud-strong); }
	.small { font-size: 12px; }
	.warn { color: var(--warn); font-weight: 600; }
	.dopp { color: var(--dopp); }
	button.big { width: 52px; height: 52px; border-radius: 12px; }
	button.mini { min-height: 24px; padding: 2px 6px; font-size: 12px; }
	.txrow { display: flex; gap: 8px; align-items: center; font-size: 15px; }
	.stbybtn { min-height: 34px; padding: 4px 12px; font-weight: 600; }
	.pickrow { display: flex; gap: 8px; align-items: center; }
	.pick button { min-height: 34px; padding: 4px 12px; font-weight: 700; }
	.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
	.dot.tx { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
	.dot.stby { background: var(--warn); }
	.dot.off { background: var(--alarm); }
	.ebl span { color: var(--ebl); font-weight: 700; margin-right: 4px; }
	.standby {
		position: absolute;
		left: 50%;
		bottom: 24px;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 12px 22px;
		border-radius: 14px;
		background: color-mix(in srgb, var(--panel) 75%, transparent);
		border: 1px solid var(--line);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
	.standby.passive { padding: 8px 14px; }
	.standby.compact { bottom: 44px; flex-direction: row; gap: 12px; padding: 6px 8px 6px 14px; }
	.standby.compact .big-txt { font-size: 14px; letter-spacing: 1.5px; }
	.standby.compact .muted { display: none; }
	.standby.compact .txbtn { font-size: 14px; padding: 4px 12px; min-height: 30px; }
	.big-txt { font-size: 22px; font-weight: 800; letter-spacing: 3px; }
	.txbtn { font-size: 16px; padding: 10px 22px; }
	.modehint {
		position: absolute;
		top: 76px;
		left: 50%;
		transform: translateX(-50%);
		white-space: nowrap;
		font-size: 13px;
		background: var(--accent);
		color: var(--on-accent);
		padding: 6px 12px;
		border-radius: 20px;
		font-weight: 600;
		display: flex;
		gap: 10px;
		align-items: center;
	}
	.imgmeta {
		position: absolute;
		left: 12px;
		top: 128px;
		max-width: min(55%, 480px);
		font-size: 11px;
		font-weight: 600;
		line-height: 1.25;
		color: var(--text);
		background: color-mix(in srgb, var(--panel) 72%, transparent);
		border-radius: 6px;
		padding: 3px 8px;
		text-align: left;
		pointer-events: none;
		white-space: pre-line;
	}
	.attrib {
		position: absolute;
		left: 50%;
		bottom: 2px;
		transform: translateX(-50%);
		max-width: 70%;
		font-size: 9.5px;
		line-height: 1.2;
		color: var(--muted);
		text-align: center;
		pointer-events: none;
		text-shadow: 0 1px 2px #000c;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tip {
		position: absolute;
		z-index: 25;
		pointer-events: none;
		width: 258px;
		padding: 9px 12px 10px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--panel) 94%, transparent);
		border: 1px solid var(--line);
		border-left: 4px solid var(--ok);
		box-shadow: 0 8px 24px #0009;
		color: var(--text);
		font-size: 13px;
	}
	.tip.caution { border-left-color: var(--warn); }
	.tip.dangerous { border-left-color: var(--alarm); }
	.tip.lost { border-left-color: var(--muted); }
	.tname { font-size: 15px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tsub { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }
	.tip dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; }
	.tip dt { color: var(--muted); }
	.tip dd { margin: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tip.dangerous dd { color: var(--text); }
	.menu {
		position: absolute;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px;
		min-width: 200px;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 12px;
		box-shadow: 0 10px 30px #0008;
	}
	.menu button { justify-content: flex-start; border: 0; background: transparent; }
	.menu button:hover { background: var(--btn-hi); }
	:global(.chart-wrap) { z-index: 0; }
	:global(.chart-wrap .leaflet-container), :global(.chart-wrap.leaflet-container) { background: var(--chart-bg); }
</style>
