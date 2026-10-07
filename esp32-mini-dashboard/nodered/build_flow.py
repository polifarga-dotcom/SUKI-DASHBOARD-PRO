#!/usr/bin/env python3
"""Baut den Node-RED-Flow-Tab "ESP32 Mini Dashboard" aus src/*.js + web/*.html
und deployt ihn optional additiv über die Node-RED Admin API.

  python3 build_flow.py            # schreibt flow.json
  python3 build_flow.py --deploy   # schreibt flow.json + POST/PUT /flow auf dem Pi

Nur dieser eine Tab wird angelegt/ersetzt — alle anderen Tabs bleiben unberührt.
"""
import hashlib, json, sys, urllib.request
from pathlib import Path

NODE_RED = 'http://192.168.0.100:1880'
SK = 'http://192.168.0.100:3000/signalk/v1/api/vessels/self'
MFD_FN = 'https://lzvwhzzscsjeivtviyjm.supabase.co/functions/v1/mfd-anchor'
MFD_KEY = 'mfd-b00c60fed1bb860778d4c704eb12a8804884377bffafca83'  # anchor_config.mfd_api_key (SUKI)
ANCHOR_URL = f'{MFD_FN}?key={MFD_KEY}'
CFG_FILE = '/home/admin/esp-dash/config.json'
LABEL = 'ESP32 Mini Dashboard'

HERE = Path(__file__).parent
TAB = hashlib.sha1(LABEL.encode()).hexdigest()[:16]


def nid(name):
    return hashlib.sha1(f'{LABEL}/{name}'.encode()).hexdigest()[:16]


nodes = []


def add(name, type_, x, y, wires=(), **props):
    nodes.append({'id': nid(name), 'type': type_, 'z': TAB, 'name': name, 'x': x, 'y': y,
                  'wires': [[nid(w) for w in out] for out in wires], **props})


def fn(name, code, x, y, wires=(), outputs=1):
    add(name, 'function', x, y, wires, func=code, outputs=outputs, timeout=0,
        noerr=0, initialize='', finalize='', libs=[])


def inject(name, x, y, wire, repeat, props, once_delay=1):
    add(name, 'inject', x, y, [[wire]], props=props, repeat=str(repeat), crontab='',
        once=True, onceDelay=str(once_delay), topic='', payload='', payloadType='date')


def http_in(name, url, method, x, y, wire):
    add(name, 'http in', x, y, [[wire]], url=url, method=method, upload=False, swaggerDoc='')


def http_out(name, x, y, headers=None):
    add(name, 'http response', x, y, statusCode='', headers=headers or {})


def str_prop(p, v):
    return {'p': p, 'v': v, 'vt': 'str'}


def num_prop(p, v):
    return {'p': p, 'v': str(v), 'vt': 'num'}


# ── 1) Datenquellen ──────────────────────────────────────────────────────────
y = 60
for topic, path, every in [('id_name', '/name', 60), ('id_mmsi', '/mmsi', 60), ('id_comm', '/communication', 60)]:
    inject(f'SK {topic}', 140, y, 'SignalK GET', every,
           [str_prop('topic', topic), str_prop('url', SK + path), num_prop('requestTimeout', 3000)])
    y += 40
inject('Anker (Supabase)', 150, y, 'Supabase GET', 5,
       [str_prop('topic', 'anchor'), num_prop('requestTimeout', 6000)])

add('SignalK GET', 'http request', 360, 100, [['SK speichern']], method='GET', ret='obj',
    paytoqs='ignore', url='', tls='', persist=False, proxy='', insecureHTTPParser=False,
    authType='', senderr=False, headers=[])
add('Supabase GET', 'http request', 360, 200, [['Anker speichern']], method='GET', ret='obj',
    paytoqs='ignore', url=ANCHOR_URL, tls='', persist=False, proxy='', insecureHTTPParser=False,
    authType='', senderr=False, headers=[])

fn('SK speichern', """\
if (msg.statusCode === 200 && msg.payload != null && (typeof msg.payload === 'object' || msg.topic.indexOf('id_') === 0)) {
    flow.set('sk_' + msg.topic, { data: msg.payload, t: Date.now() });
}
return null;""", 560, 100)

fn('Anker speichern', """\
const prev = flow.get('anchor') || {};
if (msg.statusCode === 200 && msg.payload && typeof msg.payload === 'object' && msg.payload.anchor !== undefined) {
    flow.set('anchor', { data: msg.payload, t: Date.now() });
} else {
    prev.err = msg.statusCode || String(msg.payload).slice(0, 120);
    flow.set('anchor', prev);
}
return null;""", 560, 200)

# ── 1a) SignalK-Stream per WebSocket (ersetzt das REST-Polling) ─────────────
# Eine Verbindung, nur die benötigten Pfade, nur bei Änderung und max. 1 Wert/s je Pfad
# (policy "instant" + minPeriod — "ideal" drosselt bei SignalK NICHT, das ergab ~90 Deltas/s).
# Die Deltas werden in dieselbe Baumstruktur geschrieben wie früher die REST-Antworten
# (flow.sk_batt, sk_wind, sk_nav, …) — die Auswertung bleibt dadurch unverändert.
SK_WS = nid('SignalK WS client')
ws_cfg = {'id': SK_WS, 'type': 'websocket-client', 'path': 'ws://192.168.0.100:3000/signalk/v1/stream?subscribe=none',
          'tls': '', 'wholemsg': 'false', 'hb': '0', 'subprotocol': '', 'headers': []}
add('SignalK Stream', 'websocket in', 150, 40, [['SK Delta']], server='', client=SK_WS)
fn('SK Delta', """\
let m;
try { m = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload; } catch (e) { return null; }
if (!m || !Array.isArray(m.updates)) return null;           // Hello-Nachricht o. ä.
// AIS: andere Schiffe (Kontext vessels.urn:mrn:imo:mmsi:…) — eigenes Schiff (eigene MMSI) ignorieren
const own = String(flow.get('sk_id_mmsi') ? flow.get('sk_id_mmsi').data : '211897610');
if (m.context && m.context !== 'vessels.self' && m.context.indexOf(own) < 0) {
    const ais = flow.get('ais') || {};
    const id = m.context;
    const tg = ais[id] || { ctx: id };
    const now = Date.now();
    for (const u of m.updates) for (const v of (u.values || [])) {
        const p = v.path, val = v.value;
        // echte Meldezeit verwenden (beim Abo kommen auch alte gespeicherte Positionen)
        const tu = Date.parse(u.timestamp);
        if (p === 'navigation.position' && val) { tg.lat = val.latitude; tg.lon = val.longitude; tg.tPos = isNaN(tu) ? now : Math.min(tu, now); }
        else if (p === 'navigation.courseOverGroundTrue') tg.cog = val;
        else if (p === 'navigation.speedOverGround') tg.sog = val;
        else if (p === 'navigation.headingTrue') tg.hdg = val;
        else if (p === 'navigation.state') tg.state = val;
        else if (p === 'navigation.destination.commonName') tg.dest = val;
        else if (p === 'design.length') tg.len = val && typeof val === 'object' ? val.overall : val;
        else if (p === 'design.beam') tg.beam = val;
        else if (p === 'design.aisShipType') tg.type = val && typeof val === 'object' ? val.name : val;
        else if (p === 'communication.callsignVhf') tg.cs = val;
        else if (p === '' && val && typeof val === 'object') {      // statische Daten kommen als Wurzel-Objekt
            if (val.name) tg.name = val.name;
            if (val.mmsi) tg.mmsi = val.mmsi;
        } else if (p === 'name') tg.name = val;
        else if (p === 'mmsi') tg.mmsi = val;
    }
    if (!tg.mmsi) { const mm = id.match(/mmsi:(\\d+)/); if (mm) tg.mmsi = mm[1]; }
    if (tg.mmsi && String(tg.mmsi) === own) return null;
    tg.t = now;
    ais[id] = tg;
    flow.set('ais', ais);
    return null;
}
const MAP = [['electrical.batteries.', 'batt'], ['environment.wind.', 'wind'], ['navigation.', 'nav'], ['tanks.', 'tanks'],
    ['environment.depth.', 'depth'], ['propulsion.', 'prop'], ['rigging.', 'rig'], ['environment.water.', 'water']];
const now = Date.now();
flow.set('sk_ws_last', now);
for (const u of m.updates) {
    if (!Array.isArray(u.values)) continue;
    const ts = u.timestamp || new Date(now).toISOString();
    for (const v of u.values) {
        if (!v || typeof v.path !== 'string' || !v.path) continue;
        if (v.path === 'environment.outside.pressure') {
            flow.set('sk_baro', { data: { value: v.value, timestamp: ts }, t: now });
            continue;
        }
        const hit = MAP.find((p) => v.path.indexOf(p[0]) === 0);
        if (!hit) continue;
        const key = 'sk_' + hit[1];
        const obj = flow.get(key) || { data: {} };
        if (!obj.data || typeof obj.data !== 'object') obj.data = {};
        const parts = v.path.slice(hit[0].length).split('.');
        let node_ = obj.data;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!node_[parts[i]] || typeof node_[parts[i]] !== 'object') node_[parts[i]] = {};
            node_ = node_[parts[i]];
        }
        node_[parts[parts.length - 1]] = { value: v.value, timestamp: ts, $source: u.$source };
        obj.t = now;
        flow.set(key, obj);
    }
}
return null;""", 360, 40)
inject('SK Abo prüfen 10 s', 150, 0, 'SK Abo', 10, [], once_delay=3)
fn('SK Abo', """\
// (Neu-)Abonnieren, wenn seit 10 s kein Delta kam — z. B. nach Start oder Verbindungsabbruch.
// Erst alles abbestellen, damit keine doppelten Abos entstehen.
const last = flow.get('sk_ws_last') || 0;
const VER = 5;   // bei Änderung der Abo-Liste hochzählen → wird sofort neu abonniert
if (Date.now() - last < 10000 && flow.get('sk_ws_ver') === VER) return null;
flow.set('sk_ws_ver', VER);
const PATHS = ['electrical.batteries.*', 'environment.wind.*', 'navigation.position', 'navigation.headingTrue',
    'navigation.headingMagnetic', 'navigation.speedOverGround', 'navigation.speedThroughWater', 'tanks.*',
    'environment.outside.pressure', 'propulsion.*', 'environment.depth.*', 'rigging.*', 'environment.water.temperature',
    'navigation.courseOverGroundTrue'];
const AIS = ['navigation.position', 'navigation.courseOverGroundTrue', 'navigation.speedOverGround', 'navigation.headingTrue',
    'navigation.state', 'navigation.destination.commonName', 'design.length', 'design.beam', 'design.aisShipType',
    'communication.callsignVhf', 'name', 'mmsi', ''];
node.status({ fill: 'yellow', text: 'abonniere ' + new Date().toLocaleTimeString() });
return [[
    { payload: JSON.stringify({ context: '*', unsubscribe: [{ path: '*' }] }) },
    { payload: JSON.stringify({ context: 'vessels.self', subscribe: PATHS.map((p) => ({ path: p, policy: 'instant', minPeriod: p.indexOf('environment.wind') === 0 ? 1000 : 2000 })) }) },   // nur bei Änderung; Wind max. 1/s, Rest max. alle 2 s
    // AIS: alle anderen Schiffe, je Pfad max. alle 5 s (SignalK schickt beim Abo sofort alle bekannten Werte)
    { payload: JSON.stringify({ context: 'vessels.*', subscribe: AIS.map((p) => ({ path: p, policy: 'instant', minPeriod: 5000 })) }) },
]];""", 360, 0, [['SignalK Abo senden']])
add('SignalK Abo senden', 'websocket out', 580, 0, server='', client=SK_WS)

# ── 1b) Victron: lokaler MQTT-Broker des Cerbo (gleiche Werte wie VRM) ────────
CERBO_BROKER = nid('Cerbo MQTT broker')
configs = [{'id': CERBO_BROKER, 'type': 'mqtt-broker', 'name': 'Cerbo GX (ESP-Dash)', 'broker': '192.168.0.116',
            'port': '1883', 'clientid': '', 'autoConnect': True, 'usetls': False, 'protocolVersion': '4',
            'keepalive': '60', 'cleansession': True, 'autoUnsubscribe': True,
            'birthTopic': '', 'birthQos': '0', 'birthPayload': '', 'birthMsg': {},
            'closeTopic': '', 'closeQos': '0', 'closePayload': '', 'closeMsg': {},
            'willTopic': '', 'willQos': '0', 'willPayload': '', 'willMsg': {}, 'userProps': '', 'sessionExpiry': ''}]
for i, t in enumerate(['N/+/system/0/#', 'N/+/solarcharger/+/History/Daily/0/Yield', 'N/+/vebus/+/Ac/ActiveIn/L1/V']):
    add(f'Cerbo {i}', 'mqtt in', 150, 880 + i * 40, [['Victron speichern']], topic=t, qos='0',
        datatype='json', broker=CERBO_BROKER, nl=False, rap=True, rh=0, inputs=0)
fn('Victron speichern', """\
// N/<portal>/system/0/Dc/Battery/Soc → vic['system/0/Dc/Battery/Soc'] = value
const parts = msg.topic.split('/');
const vic = flow.get('vic') || {};
vic[parts.slice(2).join('/')] = msg.payload && typeof msg.payload === 'object' ? msg.payload.value : null;
vic._t = Date.now();
flow.set('vic', vic);
if (!flow.get('vic_portal')) { flow.set('vic_portal', parts[1]); return { topic: 'R/' + parts[1] + '/keepalive', payload: '' }; }
return null;""", 400, 920, [['Cerbo keepalive']])
inject('Keepalive 30 s', 140, 1000, 'Keepalive bauen', 30, [], once_delay=2)
fn('Keepalive bauen', """\
// Venus OS publiziert N/-Topics nur, solange regelmäßig ein Keepalive kommt
const p = flow.get('vic_portal');
return p ? { topic: 'R/' + p + '/keepalive', payload: '' } : null;""", 400, 1000, [['Cerbo keepalive']])
add('Cerbo keepalive', 'mqtt out', 640, 960, topic='', qos='0', retain='false', respTopic='',
    contentType='', userProps='', correl='', expiry='', broker=CERBO_BROKER)

# ── 1c) Wetter: Open-Meteo (Vorhersage, Sonne) + met.no (Mond), alle 30 min ───
inject('Wetter 30 min', 140, 1080, 'Wetter URL', 1800, [], once_delay=15)
fn('Wetter URL', """\
// Position: live aus SignalK, sonst letzte bekannte aus Supabase
const nav = flow.get('sk_nav');
let lat = null, lon = null;
if (nav && nav.data && nav.data.position && nav.data.position.value) {
    lat = nav.data.position.value.latitude; lon = nav.data.position.value.longitude;
} else {
    const a = flow.get('anchor');
    const p = a && a.data && a.data.position;
    if (p) { lat = p.lat; lon = p.lon; }
}
if (typeof lat !== 'number' || typeof lon !== 'number') { node.status({ fill: 'yellow', text: 'keine Position' }); return null; }
msg.lat = lat; msg.lon = lon;
msg.url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) +
    '&current=temperature_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,' +
    'wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset' +
    '&hourly=temperature_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,precipitation' +
    '&wind_speed_unit=kn&timezone=auto&forecast_days=4';
msg.requestTimeout = 15000;
return msg;""", 360, 1080, [['Open-Meteo GET']])
add('Open-Meteo GET', 'http request', 560, 1080, [['Wetter speichern']], method='GET', ret='obj',
    paytoqs='ignore', url='', tls='', persist=False, proxy='', insecureHTTPParser=False,
    authType='', senderr=False, headers=[])
fn('Wetter speichern', """\
if (msg.statusCode !== 200 || !msg.payload || !msg.payload.daily) {
    node.status({ fill: 'red', text: 'Fehler ' + msg.statusCode });
    return null;
}
flow.set('wx', { data: msg.payload, t: Date.now(), lat: msg.lat, lon: msg.lon });
// Zeitzone der aktuellen Position übernehmen (IANA, z. B. Europe/Rome) — bei Wechsel in config.json sichern
const tzNew = msg.payload.timezone;
let tzOk = false;
try { new Date().toLocaleString('en-GB', { timeZone: tzNew }); tzOk = typeof tzNew === 'string'; } catch (e) {}
if (tzOk && tzNew !== flow.get('tz_auto')) {
    flow.set('tz_auto', tzNew);
    const cfg = flow.get('cfg') || {};
    if (cfg.tzAuto !== tzNew || cfg.tz !== undefined) {
        cfg.tzAuto = tzNew;
        delete cfg.tz;   // alte manuelle Einstellung (abgeschafft)
        flow.set('cfg', cfg);
        node.send([null, { payload: JSON.stringify(cfg, null, 2) }]);
    }
}
node.status({ fill: 'green', text: 'ok ' + new Date().toLocaleTimeString() });
// Mond pro Tag bei met.no (Auf-/Untergang + Phase), Offset = Zeitzone der Position
const off = msg.payload.utc_offset_seconds || 0;
const sign = off < 0 ? '-' : '+', a = Math.abs(off);
const offset = sign + String(Math.floor(a / 3600)).padStart(2, '0') + ':' + String(Math.floor((a % 3600) / 60)).padStart(2, '0');
for (const date of msg.payload.daily.time) {
    node.send({
        date: date,
        url: 'https://api.met.no/weatherapi/sunrise/3.0/moon?lat=' + msg.lat.toFixed(3) + '&lon=' + msg.lon.toFixed(3) +
            '&date=' + date + '&offset=' + encodeURIComponent(offset),
        headers: { 'User-Agent': 'SUKI-MiniDash/1.0 (sailing yacht dashboard)' },
        requestTimeout: 15000,
    }, false);
}
return null;""", 760, 1080, [['met.no GET'], ['Config schreiben']], outputs=2)
add('met.no GET', 'http request', 960, 1080, [['Mond speichern']], method='GET', ret='obj',
    paytoqs='ignore', url='', tls='', persist=False, proxy='', insecureHTTPParser=False,
    authType='', senderr=False, headers=[])
fn('Mond speichern', """\
const p = msg.payload && msg.payload.properties;
if (msg.statusCode !== 200 || !p) return null;
const moon = flow.get('moon') || {};
moon[msg.date] = { rise: p.moonrise && p.moonrise.time, set: p.moonset && p.moonset.time, phase: p.moonphase };
// nur die letzten 8 Tage behalten
Object.keys(moon).sort().slice(0, -8).forEach((k) => delete moon[k]);
flow.set('moon', moon);
return null;""", 1160, 1080)

# ── 1d) Motor: letzte Motorstunden/Temperatur auf dem Pi sichern (Motor aus → keine SignalK-Daten) ──
ENG_FILE = '/home/admin/esp-dash/engine.json'
inject('Motor laden (Start)', 160, 1160, 'Motor lesen', '', [], once_delay=0.5)
add('Motor lesen', 'file in', 380, 1160, [['Motor übernehmen']], filename=ENG_FILE,
    filenameType='str', format='utf8', chunk=False, sendError=False, encoding='none', allProps=False)
fn('Motor übernehmen', """\
try { const v = JSON.parse(msg.payload); if (!flow.get('eng_last')) flow.set('eng_last', v); } catch (e) {}
return null;""", 600, 1160)
inject('Motor sichern 5 min', 160, 1200, 'Motor geändert?', 300, [], once_delay=60)
fn('Motor geändert?', """\
const v = flow.get('eng_last');
if (!v || !v.t || v.t === context.get('savedT')) return null;
context.set('savedT', v.t);
return { payload: JSON.stringify(v) };""", 380, 1200, [['Motor schreiben']])
add('Motor schreiben', 'file', 600, 1200, filename=ENG_FILE, filenameType='str',
    appendNewline=False, createDir=True, overwriteFile='true', encoding='utf8')

# ── 2) Auswertung ────────────────────────────────────────────────────────────
inject('Tick 1 s', 130, 280, 'Auswertung', 1, [], once_delay=3)
fn('Auswertung', (HERE / 'src' / 'evaluate.js').read_text(), 340, 280)

# ── 3) Konfiguration (persistiert als Datei auf dem Pi) ──────────────────────
inject('Config laden (Start)', 160, 340, 'Config lesen', '', [], once_delay=0.5)
add('Config lesen', 'file in', 380, 340, [['Config übernehmen']], filename=CFG_FILE,
    filenameType='str', format='utf8', chunk=False, sendError=False, encoding='none', allProps=False)
fn('Config übernehmen', """\
try { flow.set('cfg', JSON.parse(msg.payload)); node.status({ fill: 'green', text: 'geladen' }); }
catch (e) { node.status({ fill: 'yellow', text: 'Defaults' }); }
return null;""", 600, 340)

CONFIG_FN = """\
// GET → { config, batteries } | POST → validieren, speichern, Datei schreiben
const DEF = { windAlarmOn: true, windAlarmKn: 25, windHystKn: 2, windSource: 'auto', windAvgSec: 10, windWinMin: 2,
    battAlarmOn: true, battLowSoc: 30, battHystSoc: 3, battLowVolt: 0, battInstance: 'auto',
    waterAlarmOn: true, waterLowPct: 15, waterHystPct: 3, waterInstance: 'auto',
    baroAlarmOn: true, baroLowHpa: 995, baroHystHpa: 1, baroWinMin: 2,
    aisMode: 'cruising', aisCruiseNm: 0.5, aisOffshoreNm: 2, aisTcpaMin: 20, aisRangeNm: 2,
    homeLeft: 'supply', sailStyle: 'tacho', sailCloseFrom: 30, sailCloseTo: 50, sosPob: 2, sosDesc: 'sailing trimaran, 14 metres',
    bwSwap: false, bwWarnPct: 75, bwHighPct: 90, fuelWarnPct: 20, fuelLowPct: 10,
    rigAlarmOn: true, rigWarnT: 3.2, rigAlarmT: 4.2, rigHystT: 0.1, rigScaleT: 5,
    engTempAlarmOn: true, engTempWarnC: 90, engTempAlarmC: 95, engTempHystC: 2,
    engMaxRpm: 3000, engRedRpm: 2500, engGreenFrom: 1800, engGreenTo: 2200, fuelInstance: 'auto', fuelUseSensor: true, fuelCurve: '800:0.8,1000:1.2,1500:2.2,2000:3.8,2500:6.2,3000:9.5',
    anchorAlarmOn: true, anchorLocalFallback: true, ackMinutes: 5, staleSec: 30, testUntil: 0, night: false,
    soundOn: true, soundNight: 'short' };
const RANGE = { windWinMin: [1, 360], windAlarmKn: [5, 80], windHystKn: [0, 10], windAvgSec: [2, 120], battLowSoc: [5, 95],
    battHystSoc: [0, 20], battLowVolt: [0, 60], waterLowPct: [0, 95], waterHystPct: [0, 20], baroLowHpa: [900, 1050], baroHystHpa: [0, 10], baroWinMin: [1, 360], sosPob: [1, 30], aisCruiseNm: [0.1, 5], aisOffshoreNm: [0.2, 10], aisTcpaMin: [1, 120], aisRangeNm: [0.25, 24], sailCloseFrom: [0, 90], sailCloseTo: [0, 120], bwWarnPct: [10, 100], bwHighPct: [10, 100], fuelWarnPct: [0, 90], fuelLowPct: [0, 90], rigWarnT: [0.5, 20], rigAlarmT: [0.5, 25], rigHystT: [0, 2], rigScaleT: [1, 30], engTempWarnC: [40, 130], engTempAlarmC: [40, 130], engTempHystC: [0, 10], engMaxRpm: [1000, 6000], engRedRpm: [500, 6000], engGreenFrom: [0, 6000], engGreenTo: [0, 6000], ackMinutes: [1, 120], staleSec: [5, 300] };
const BOOL = ['night', 'soundOn', 'baroAlarmOn', 'rigAlarmOn', 'bwSwap', 'engTempAlarmOn', 'fuelUseSensor', 'windAlarmOn', 'battAlarmOn', 'waterAlarmOn', 'anchorAlarmOn', 'anchorLocalFallback'];
const cfg = Object.assign({}, DEF, flow.get('cfg') || {});

if (msg.req.method === 'POST') {
    const b = msg.payload || {};
    for (const k of Object.keys(RANGE)) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]);
        if (!isFinite(v) || v < RANGE[k][0] || v > RANGE[k][1]) {
            msg.statusCode = 400; msg.payload = { error: k + ' out of range ' + RANGE[k].join('-') }; return [msg, null];
        }
        cfg[k] = v;
    }
    for (const k of BOOL) if (b[k] !== undefined) cfg[k] = !!b[k];
    if (['auto', 'true', 'apparent'].indexOf(b.windSource) >= 0) cfg.windSource = b.windSource;
    if (['full', 'short', 'off'].indexOf(b.soundNight) >= 0) cfg.soundNight = b.soundNight;
    if (['tacho', 'classic'].indexOf(b.sailStyle) >= 0) cfg.sailStyle = b.sailStyle;
    if (['supply', 'split'].indexOf(b.homeLeft) >= 0) cfg.homeLeft = b.homeLeft;
    if (['anchor', 'cruising', 'offshore'].indexOf(b.aisMode) >= 0) cfg.aisMode = b.aisMode;
    if (typeof b.battInstance === 'string' && /^[\\w-]{1,20}$/.test(b.battInstance)) cfg.battInstance = b.battInstance;
    if (typeof b.sosDesc === 'string') cfg.sosDesc = b.sosDesc.replace(/[^\\w ,.\\-\\/]/g, '').slice(0, 40);
    if (typeof b.fuelInstance === 'string' && /^[\\w.-]{1,30}$/.test(b.fuelInstance)) cfg.fuelInstance = b.fuelInstance;
    if (typeof b.fuelCurve === 'string') {
        const ok = b.fuelCurve.split(',').every((p) => /^\\s*\\d+\\s*:\\s*\\d+(\\.\\d+)?\\s*$/.test(p));
        if (!ok) { msg.statusCode = 400; msg.payload = { error: 'Fuel curve: format rpm:l/h, e.g. 1000:1.2,2000:3.8' }; return [msg, null]; }
        cfg.fuelCurve = b.fuelCurve.replace(/\\s/g, '');
    }
    if (typeof b.waterInstance === 'string' && /^[\\w-]{1,20}$/.test(b.waterInstance)) cfg.waterInstance = b.waterInstance;
    // Zeitzone ist nicht manuell einstellbar — sie kommt automatisch aus der GPS-Position (tzAuto)
    delete cfg.tz;
    if (b.testSeconds !== undefined) cfg.testUntil = Date.now() + Math.min(300, Math.max(0, Number(b.testSeconds) || 0)) * 1000;
    flow.set('cfg', cfg);
    const file = { payload: JSON.stringify(cfg, null, 2) };
    msg.payload = { ok: true, config: cfg };
    return [msg, file];
}
msg.payload = { config: cfg, batteries: flow.get('batt_list') || [], tanks: flow.get('tank_list') || [], fuelTanks: flow.get('fuel_list') || [] };
return [msg, null];"""

http_in('GET config', '/esp-dash/api/config', 'get', 150, 400, 'Config API')
http_in('POST config', '/esp-dash/api/config', 'post', 150, 440, 'Config API')
fn('Config API', CONFIG_FN, 380, 420, [['config antwort'], ['Config schreiben']], outputs=2)
http_out('config antwort', 600, 400, {'Cache-Control': 'no-store'})
add('Config schreiben', 'file', 610, 440, filename=CFG_FILE, filenameType='str',
    appendNewline=False, createDir=True, overwriteFile='true', encoding='utf8')

# ── 4) State + Quittieren (für ESP32 und Simulator) ──────────────────────────
http_in('GET state', '/esp-dash/api/state', 'get', 150, 520, 'State')
fn('State', """\
msg.payload = flow.get('state') || { v: 1, status: 'warn', blink: false, msg: 'Starting ...',
    batt: { st: 'na' }, energy: { ok: false }, weather: { ok: false }, engine: {}, tanks: [], sos: {}, ais: { targets: [] }, sail: { rig: {} }, water: { st: 'na' }, baro: { st: 'na', hist: [] }, wind: { st: 'na', hist: [] }, anchor: { st: 'na' } };
return msg;""", 360, 520, [['state antwort']])
http_out('state antwort', 560, 520, {'Cache-Control': 'no-store'})

http_in('POST ack', '/esp-dash/api/ack', 'post', 150, 580, 'Quittieren')
fn('Quittieren', """\
const cfg = flow.get('cfg') || {};
const st = flow.get('state') || {};
flow.set('ack', { until: Date.now() + (cfg.ackMinutes || 5) * 60000, keys: st.alarmKeys || [] });
node.status({ fill: 'blue', text: 'quittiert ' + new Date().toLocaleTimeString() });
msg.payload = { ok: true };
return msg;""", 360, 580, [['ack antwort']])
http_out('ack antwort', 560, 580)

# ── 4b) Anker einholen (systemweit über Supabase, nur Stoppen — Setzen geht hier nicht) ──
http_in('POST anchor-up', '/esp-dash/api/anchor-up', 'post', 150, 620, 'Anker-up Request')
fn('Anker-up Request', f"""\
// silence_alarm = Anker inaktiv + Alarm aus + Eskalation zurück + Pushover widerrufen
// (wie der Zeus-MFD-Client). dryRun: nur Auth/Erreichbarkeit prüfen, ändert nichts.
const dry = !!(msg.payload && msg.payload.dryRun);
msg.dryRun = dry;
msg.url = '{MFD_FN}';
msg.method = 'POST';
msg.headers = {{ 'content-type': 'application/json' }};
msg.requestTimeout = 8000;
msg.payload = {{ api_key: '{MFD_KEY}', action: dry ? 'dry_run_noop' : 'silence_alarm' }};
node.status({{ fill: 'yellow', text: dry ? 'dry run' : 'sende anchor up' }});
return msg;""", 380, 620, [['Supabase POST']])
add('Supabase POST', 'http request', 590, 620, [['Anker-up Antwort']], method='POST', ret='obj',
    paytoqs='ignore', url='', tls='', persist=False, proxy='', insecureHTTPParser=False,
    authType='', senderr=False, headers=[])
fn('Anker-up Antwort', """\
const code = msg.statusCode;
delete msg.headers;  // Antwort-Header der Edge Function nicht weiterreichen
if (msg.dryRun) {
    // Unbekannte Aktion → 400 heißt: Key gültig, Funktion erreichbar
    const ok = code === 400 && msg.payload && /Unknown action/.test(msg.payload.error || '');
    msg.statusCode = ok ? 200 : 502;
    msg.payload = { ok: ok, dryRun: true, upstream: code };
} else if (code === 200 && msg.payload && msg.payload.ok) {
    // Cache sofort aktualisieren, damit Display/Simulator nicht auf den nächsten 5-s-Poll warten
    const prev = flow.get('anchor') || {};
    const data = Object.assign({}, prev.data || {}, { anchor: msg.payload.anchor });
    flow.set('anchor', { data: data, t: Date.now() });
    context.set('localDragSince', 0);
    node.status({ fill: 'green', text: 'anchor up ' + new Date().toLocaleTimeString() });
    msg.payload = { ok: true };
} else {
    node.status({ fill: 'red', text: 'Fehler ' + code });
    msg.statusCode = 502;
    msg.payload = { ok: false, error: (msg.payload && msg.payload.error) || ('upstream ' + code) };
}
return msg;""", 800, 620, [['anchor-up antwort']])
http_out('anchor-up antwort', 1000, 620)

# ── 4c) Anker-Aktionen vom Display/Simulator (systemweit über Supabase mfd-anchor) ──
# Setzen/Ändern berechnet Node-RED aus der Live-Position (SignalK) — das Display schickt nur die Absicht.
http_in('POST anchor', '/esp-dash/api/anchor', 'post', 150, 720, 'Anker-Aktion bauen')
fn('Anker-Aktion bauen', f"""\
const b = msg.payload || {{}};
const st = flow.get('state') || {{}};
const m = (st.anchor && st.anchor.map) || {{}};
const toR = Math.PI / 180;
function dest(lat, lon, brg, d) {{
    const R = 6371000, a = brg * toR, dr = d / R, la1 = lat * toR, lo1 = lon * toR;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(a));
    const lo2 = lo1 + Math.atan2(Math.sin(a) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2));
    return [la2 / toR, ((lo2 / toR) + 540) % 360 - 180];
}}
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
let body = null, err = null;
switch (b.action) {{
    case 'drop_now':        // wie "Drop Anchor Now" der Pro App: Bug-Position, Radius = 6 × Tiefe
        if (m.blat == null) {{ err = 'no GPS position'; break; }}
        body = {{ action: 'drop_anchor_now', lat: m.blat, lon: m.blon, hdg_deg: m.hdg != null ? m.hdg : 0, depth_m: m.depth }};
        break;
    case 'set': {{          // wie "Set Anchor": Anker = Boot + Peilung × Kette
        if (m.blat == null) {{ err = 'no GPS position'; break; }}
        const brg = num(b.bearing_deg) != null ? b.bearing_deg : (m.hdg != null ? m.hdg : 0);
        const chain = num(b.chain_length_m) != null ? b.chain_length_m : 0;
        const p = dest(m.blat, m.blon, brg, chain);
        body = {{ action: 'set_anchor', lat: p[0], lon: p[1], radius_m: num(b.radius_m) != null ? b.radius_m : 50,
            chain_length_m: chain, bearing_deg: brg, anchor_depth_at_set: m.depth }};
        break;
    }}
    case 'restore':         // letzten Anker wieder scharf schalten (Position bleibt)
        if (m.lat == null) {{ err = 'no previous anchor'; break; }}
        body = {{ action: 'set_anchor', lat: m.lat, lon: m.lon, radius_m: st.anchor.rad || 50,
            chain_length_m: m.chain || 0, bearing_deg: m.brg || 0, anchor_depth_at_set: m.dset }};
        break;
    case 'move': {{         // Kette/Peilung bei aktivem Anker → Anker neu projizieren (wie Pro App)
        if (m.blat == null) {{ err = 'no GPS position'; break; }}
        if (m.alarming) {{ err = 'not while alarming'; break; }}
        const brg = num(b.bearing_deg) != null ? b.bearing_deg : (m.brg || 0);
        const chain = num(b.chain_length_m) != null ? b.chain_length_m : (m.chain || 0);
        const p = dest(m.blat, m.blon, brg, chain);
        body = {{ action: 'set_anchor', lat: p[0], lon: p[1], radius_m: st.anchor.rad || 50,
            chain_length_m: chain, bearing_deg: brg, anchor_depth_at_set: m.dset }};
        break;
    }}
    case 'radius':
        if (num(b.radius_m) == null) {{ err = 'radius_m required'; break; }}
        body = {{ action: 'update_settings', radius_m: b.radius_m }};
        break;
    case 'up':   body = {{ action: 'silence_alarm' }}; break;
    case 'mute': body = {{ action: 'mute_alarm' }}; break;
    case 'dry':  body = {{ action: 'dry_run_noop' }}; msg.dryRun = true; break;
    default: err = 'unknown action';
}}
if (err) {{ msg.statusCode = 400; msg.payload = {{ ok: false, error: err }}; return [null, msg]; }}
body.api_key = '{MFD_KEY}';
msg.url = '{MFD_FN}';
msg.method = 'POST';
msg.headers = {{ 'content-type': 'application/json' }};
msg.requestTimeout = 8000;
msg.payload = body;
node.status({{ fill: 'yellow', text: b.action }});
return [msg, null];""", 380, 720, [['Supabase POST 2'], ['anchor antwort']], outputs=2)
add('Supabase POST 2', 'http request', 590, 700, [['Anker-up Antwort']], method='POST', ret='obj',
    paytoqs='ignore', url='', tls='', persist=False, proxy='', insecureHTTPParser=False,
    authType='', senderr=False, headers=[])
http_out('anchor antwort', 600, 760)

# ── 5) Web-Seiten: Simulator + Einstellungen ─────────────────────────────────
for i, (name, url, file) in enumerate([('Simulator', '/esp-dash', 'index.html'),
                                       ('Einstellungen', '/esp-dash/settings', 'settings.html')]):
    yy = 660 + i * 40
    http_in(f'GET {name}', url, 'get', 150, yy, f'{name} HTML')
    add(f'{name} HTML', 'template', 360, yy, [[f'{name} antwort']], field='payload',
        fieldType='msg', format='html', syntax='plain', template=(HERE / 'web' / file).read_text(),
        output='str')
    http_out(f'{name} antwort', 560, yy, {'Content-Type': 'text/html; charset=utf-8'})

flow = {'id': TAB, 'label': LABEL, 'disabled': False,
        'info': 'Backend für das Waveshare ESP32-S3 7" Mini-Dashboard. Quelle: '
                'SUKI DASHBOARD PRO/esp32-mini-dashboard/nodered (build_flow.py). '
                'Nicht im Editor ändern — wird beim nächsten Deploy überschrieben.',
        'nodes': nodes, 'configs': configs + [ws_cfg]}
(HERE / 'flow.json').write_text(json.dumps(flow, indent=2, ensure_ascii=False))
print(f'flow.json geschrieben ({len(nodes)} Nodes, Tab {TAB})')

if '--deploy' in sys.argv:
    hdr = {'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'flows'}
    # Node-RED vergibt beim Anlegen eine eigene Tab-ID → Tab über das Label finden
    cur = json.loads(urllib.request.urlopen(urllib.request.Request(
        f'{NODE_RED}/flows', headers={'Node-RED-API-Version': 'v2'}), timeout=10).read())
    tab = next((n['id'] for n in cur['flows'] if n['type'] == 'tab' and n.get('label') == LABEL), None)
    exists = tab is not None
    if exists:
        flow['id'] = tab
        for n in nodes:
            n['z'] = tab
    req = urllib.request.Request(f'{NODE_RED}/flow' + (f'/{tab}' if exists else ''),
                                 data=json.dumps(flow).encode(), headers=hdr,
                                 method='PUT' if exists else 'POST')
    print(('Aktualisiert' if exists else 'Angelegt'), urllib.request.urlopen(req, timeout=20).read().decode())
