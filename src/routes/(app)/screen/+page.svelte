<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	// ── connection state ──────────────────────────────────────────────────────
	let isHttps   = $state(false);
	let connecting = $state(false);
	let connected  = $state(false);
	let error      = $state('');

	// ── config (persisted in localStorage) ───────────────────────────────────
	// cerboHost:cerboPort = where websockify (ws_proxy.py) listens on the Cerbo
	// ipadHost:ipadPort   = iPad VNC server — forwarded via URL path to the proxy
	let cerboHost = $state('192.168.2.116');
	let cerboPort = $state('6080');
	let ipadHost  = $state('');
	let ipadPort  = $state('5900');
	let vncPass   = $state('');

	const LS = {
		cerbo: 'suki_vnc_cerbo', cport: 'suki_vnc_cport',
		ipad:  'suki_vnc_ipad',  iport: 'suki_vnc_iport',
		pass:  'suki_vnc_pass',
	};

	// ── noVNC ─────────────────────────────────────────────────────────────────
	let canvasWrap = $state<HTMLDivElement | undefined>(undefined);
	let rfb: any = null;

	onMount(() => {
		isHttps   = window.location.protocol === 'https:';
		cerboHost = localStorage.getItem(LS.cerbo) ?? '192.168.2.116';
		cerboPort = localStorage.getItem(LS.cport) ?? '6080';
		ipadHost  = localStorage.getItem(LS.ipad)  ?? '';
		ipadPort  = localStorage.getItem(LS.iport) ?? '5900';
		vncPass   = localStorage.getItem(LS.pass)  ?? '';
	});

	onDestroy(() => { rfb?.disconnect(); rfb = null; });

	async function connect() {
		if (connecting || connected) return;
		connecting = true;
		error = '';

		localStorage.setItem(LS.cerbo, cerboHost);
		localStorage.setItem(LS.cport, cerboPort);
		localStorage.setItem(LS.ipad,  ipadHost);
		localStorage.setItem(LS.iport, ipadPort);
		localStorage.setItem(LS.pass,  vncPass);

		try {
			// Dynamic import keeps noVNC client-side only
			// Package exports '@novnc/novnc' → core/rfb.js directly
			const { default: RFB } = await import('@novnc/novnc');

			// URL path carries the iPad target: ws://cerbo:6080/[iPad-IP]/[VNC-Port]
			// ws_proxy.py on the Cerbo reads and forwards to that host:port
			const wsUrl = ipadHost
				? `ws://${cerboHost}:${cerboPort}/${ipadHost}/${ipadPort}`
				: `ws://${cerboHost}:${cerboPort}`;

			rfb = new RFB(canvasWrap, wsUrl, {
				credentials: vncPass ? { password: vncPass } : undefined,
			});
			rfb.scaleViewport = true;
			rfb.resizeSession = false;
			rfb.qualityLevel  = 6;

			rfb.addEventListener('connect', () => {
				connected  = true;
				connecting = false;
			});
			rfb.addEventListener('disconnect', (e: CustomEvent<{ clean: boolean }>) => {
				connected  = false;
				connecting = false;
				if (!e.detail?.clean) error = 'Verbindung unerwartet getrennt.';
				rfb = null;
			});
			rfb.addEventListener('securityfailure', () => {
				connected  = false;
				connecting = false;
				error = 'Authentifizierung fehlgeschlagen — Passwort prüfen.';
				rfb = null;
			});
		} catch (err: unknown) {
			connecting = false;
			error = String(err);
		}
	}

	function disconnect() {
		rfb?.disconnect();
		rfb = null;
		connected  = false;
		connecting = false;
		error = '';
	}

	function toggleFullscreen() {
		if (document.fullscreenElement) document.exitFullscreen();
		else canvasWrap?.requestFullscreen?.();
	}

</script>

<svelte:head><title>Screen · SUKI PRO</title></svelte:head>

<div class="screen-root">

	{#if isHttps}
		<!-- ── HTTPS: not available remotely ──────────────────────────────── -->
		<div class="notice card">
			<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="var(--amber)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2" y="3" width="20" height="14" rx="2"/>
				<line x1="8" y1="21" x2="16" y2="21"/>
				<line x1="12" y1="17" x2="12" y2="21"/>
				<line x1="12" y1="8"  x2="12" y2="11"/>
				<circle cx="12" cy="14" r="0.8" fill="var(--amber)" stroke="none"/>
			</svg>
			<p class="notice-title">Nur im lokalen WLAN verfügbar</p>
			<p class="notice-body">
				Screen Mirror öffnet eine direkte WebSocket-Verbindung zum Cerbo
				und ist nur über HTTP (LAN) erreichbar, nicht über HTTPS.
			</p>
			<code class="notice-url">http://192.168.2.116:8888</code>
		</div>

	{:else if !connected && !connecting}
		<!-- ── Config form ────────────────────────────────────────────────── -->
		<div class="config card">
			<div class="config-title">iPad Screen Mirror</div>
			<p class="config-hint">
				Verbindet über ws_proxy.py (Port&nbsp;6080) auf dem Cerbo mit
				dem VNC-Server auf dem iPad.
			</p>

			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

			<div class="fields">
				<div class="field">
					<label for="cerbo-host">Cerbo IP</label>
					<input id="cerbo-host" type="text" bind:value={cerboHost}
						placeholder="192.168.2.116" autocomplete="off" />
				</div>
				<div class="field">
					<label for="cerbo-port">WebSocket-Port (ws_proxy)</label>
					<input id="cerbo-port" type="text" bind:value={cerboPort}
						placeholder="6080" autocomplete="off" />
				</div>
				<div class="field">
					<label for="ipad-host">iPad IP (VNC-Ziel)</label>
					<input id="ipad-host" type="text" bind:value={ipadHost}
						placeholder="192.168.2.50" autocomplete="off" />
				</div>
				<div class="field">
					<label for="ipad-port">iPad VNC-Port</label>
					<input id="ipad-port" type="text" bind:value={ipadPort}
						placeholder="5900" autocomplete="off" />
				</div>
				<div class="field">
					<label for="vnc-pass">VNC-Passwort</label>
					<input id="vnc-pass" type="password" bind:value={vncPass}
						placeholder="(optional)" autocomplete="new-password" />
				</div>
			</div>

			<button class="btn btn-primary connect-btn" onclick={connect}>
				Verbinden
			</button>
		</div>

	{:else if connecting}
		<!-- ── Connecting ─────────────────────────────────────────────────── -->
		<div class="connecting">
			<div class="spinner"></div>
			<p>Verbinde mit {cerboHost}:{cerboPort}&nbsp;→&nbsp;{ipadHost}:{ipadPort}&nbsp;…</p>
		</div>

	{:else}
		<!-- ── VNC canvas ─────────────────────────────────────────────────── -->
		<div class="vnc-toolbar">
			<span class="vnc-status">
				<span class="live-dot"></span>{ipadHost || cerboHost}
			</span>
			<div class="vnc-actions">
				<button class="tool-btn" onclick={toggleFullscreen} title="Vollbild">
					<svg viewBox="0 0 20 20" width="18" height="18" fill="none"
						stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M3 7V3h4M13 3h4v4M3 13v4h4M17 13v4h-4"/>
					</svg>
				</button>
				<button class="tool-btn disconnect-btn" onclick={disconnect} title="Trennen">
					<svg viewBox="0 0 20 20" width="18" height="18" fill="none"
						stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M13 3h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3"/>
						<polyline points="9 14 13 10 9 6"/>
						<line x1="13" y1="10" x2="3" y2="10"/>
					</svg>
				</button>
			</div>
		</div>

		<div class="vnc-wrap" bind:this={canvasWrap}></div>
	{/if}

</div>

<style>
	/* Remove layout padding so the canvas fills edge-to-edge while this page is active */
	:global(.content) {
		padding: 0 !important;
		overflow: hidden !important;
	}

	.screen-root {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	/* ── HTTPS notice ─────────────────────────────────────────── */
	.notice {
		margin: 12px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 32px 20px;
		text-align: center;
	}
	.notice-title { font-size: 15px; font-weight: 600; color: var(--amber); }
	.notice-body  { font-size: 13px; color: var(--muted); line-height: 1.6; max-width: 300px; }
	.notice-url {
		font-size: 13px;
		background: var(--card2);
		padding: 6px 14px;
		border-radius: 8px;
		color: var(--accent);
		border: 1px solid var(--border);
	}

	/* ── Config form ──────────────────────────────────────────── */
	.config {
		margin: 12px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.config-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.config-hint { font-size: 12px; color: var(--muted); line-height: 1.5; }
	.fields      { display: flex; flex-direction: column; gap: 10px; }
	.field       { display: flex; flex-direction: column; gap: 5px; }
	label        { font-size: 12px; color: var(--muted); font-weight: 500; }
	.connect-btn { margin-top: 4px; }

	/* ── Connecting ───────────────────────────────────────────── */
	.connecting {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		color: var(--muted);
		font-size: 13px;
	}
	.spinner {
		width: 32px;
		height: 32px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.75s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* ── VNC toolbar ──────────────────────────────────────────── */
	.vnc-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 10px;
		height: 38px;
		background: var(--card);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.vnc-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted);
	}
	.live-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--green);
		animation: pulse-live 2s ease-in-out infinite;
	}
	@keyframes pulse-live { 0%,100% { opacity:1; } 50% { opacity:0.35; } }

	.vnc-actions { display: flex; gap: 4px; }
	.tool-btn {
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--muted);
		transition: background 0.15s, color 0.15s;
	}
	.tool-btn:hover            { background: var(--card2); color: var(--text); }
	.disconnect-btn:hover { color: var(--red); }

	/* ── noVNC canvas wrapper ─────────────────────────────────── */
	.vnc-wrap {
		flex: 1;
		min-height: 0;
		background: #000;
		overflow: hidden;
	}
	/* noVNC injects a <canvas>; make it fill the wrapper */
	:global(.vnc-wrap canvas) {
		display: block;
		width: 100% !important;
		height: 100% !important;
	}
</style>
