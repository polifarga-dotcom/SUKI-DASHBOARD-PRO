// Vesper Cortex → SUKI: liest die lokale Cortex-WebSocket-API (nur lesend) und liefert den AIS-Alarmstand
// als JSON an Node-RED: GET http://127.0.0.1:8095/state. Node 22, keine Abhängigkeiten.
// Protokoll: ws://HOST:8000/v3/openChannel?generateToken → "N:ChannelIdentifier{token}" →
// GET /v3/subscribeChannel/<Kanal>?token=… ; Nachrichten "<id>:<Typ><json>".
// DeviceInfo (enthält das Cortex-WLAN-Passwort) wird bewusst NICHT abonniert.
import http from 'node:http';

const HOST = process.env.CORTEX_HOST ?? '192.168.0.117';
const PORT = Number(process.env.PORT ?? 8095);
const CHANNELS = ['TargetCalculations', 'CollisionProfiles', 'CollisionProfileControl', 'MonitorModeControl', 'ActiveAlarm', 'AlarmSound'];
const TARGET_TTL = 600e3; // Ziel ohne Update → weg (Cortex sendet nur Änderungen; ruhende Ziele melden sich lange nicht)
const SILENT = 30e3; // so lange ohne Nachricht → Cortex gilt als offline
const RECONNECT = 15e3; // ruhige Lage sendet nichts: dann neu verbinden, das liefert die volle Zielliste (= Lebenszeichen)

export function parse(raw) {
	const m = /^([^:]*):([A-Za-z]+)([\s\S]*)$/.exec(String(raw));
	if (!m) return null;
	let data = null;
	try {
		data = m[3] ? JSON.parse(m[3]) : null;
	} catch {
		return null;
	}
	return { type: m[2], data };
}

export function newStore() {
	return { last: 0, targets: new Map(), profiles: [], profileId: null, monitorMode: null, activeAlarm: null, alarmSound: null };
}

/** eine Nachricht in den Stand übernehmen */
export function apply(st, type, data, now = Date.now()) {
	st.last = now;
	if (type === 'TargetCalculations') {
		for (const t of Array.isArray(data) ? data : [data]) if (t && t.mmsi != null) st.targets.set(String(t.mmsi), { ...t, t: now });
	} else if (type === 'CollisionProfiles') st.profiles = data?.collisionProfiles ?? [];
	else if (type === 'CollisionProfileControl') st.profileId = data?.profileId ?? null;
	else if (type === 'MonitorModeControl') st.monitorMode = data?.mode ?? null;
	else if (type === 'ActiveAlarm') st.activeAlarm = data;
	else if (type === 'AlarmSound') st.alarmSound = data;
}

/** Stand für Node-RED: Alarmflags je Ziel, TCPA in s ab jetzt */
export function snapshot(st, now = Date.now()) {
	const targets = [];
	for (const [k, t] of st.targets) {
		if (now - t.t > TARGET_TTL) {
			st.targets.delete(k);
			continue;
		}
		targets.push({
			m: k,
			cpaA: !!t.cpaAlarmTriggered,
			guardA: !!t.guardAlarmTriggered,
			proxA: !!t.proximityAlarmTriggered,
			lost: !!t.isLost,
			filt: !!t.isFiltered,
			pri: t.priority ?? null,
			ds: t.dangerState ?? null,
			cpa: t.hasCpa && Number.isFinite(t.cpa) ? +t.cpa.toFixed(3) : null,
			tcpa: t.hasCpa && Number.isFinite(t.tcpa) ? Math.round(t.tcpa - now / 1000) : null,
			r: Number.isFinite(t.range) ? +t.range.toFixed(3) : null,
			b: Number.isFinite(t.bearing) ? Math.round(t.bearing) : null
		});
	}
	const p = st.profiles.find((x) => x.id === st.profileId) ?? null;
	return {
		ok: st.last > 0 && now - st.last < SILENT,
		age: st.last ? Math.round((now - st.last) / 1000) : null,
		profile: p,
		profiles: st.profiles,
		monitorMode: st.monitorMode,
		activeAlarm: st.activeAlarm,
		alarmSound: st.alarmSound,
		targets
	};
}

function run() {
	const st = newStore();
	let ws = null;
	const connect = () => {
		ws = new WebSocket(`ws://${HOST}:8000/v3/openChannel?generateToken`);
		const sock = ws;
		sock.onmessage = (ev) => {
			const m = parse(ev.data);
			if (!m) return;
			if (m.type === 'ChannelIdentifier' && m.data?.token) {
				const tok = encodeURIComponent(m.data.token);
				for (const c of CHANNELS)
					fetch(`http://${HOST}:8000/v3/subscribeChannel/${c}?token=${tok}`, { signal: AbortSignal.timeout(5e3) }).catch((e) => console.log(`subscribe ${c}: ${e.message}`));
				return;
			}
			apply(st, m.type, m.data);
		};
		sock.onclose = () => {
			if (ws === sock) ws = null;
		};
		sock.onerror = () => {};
	};
	setInterval(() => {
		// stumm oder getrennt → neu verbinden
		if (ws && Date.now() - Math.max(st.last, ws.t0) < RECONNECT) return;
		try {
			ws?.close();
		} catch {}
				connect();
		ws.t0 = Date.now();
	}, 5e3);
	connect();
	ws.t0 = Date.now();

	http
		.createServer((req, res) => {
			if (req.method === 'GET' && req.url === '/state') {
				res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
				res.end(JSON.stringify(snapshot(st)));
			} else {
				res.writeHead(404);
				res.end();
			}
		})
		.listen(PORT, '127.0.0.1', () => console.log(`cortex-bridge: ${HOST} → http://127.0.0.1:${PORT}/state`));
}

if (import.meta.url === `file://${process.argv[1]}`) run();
