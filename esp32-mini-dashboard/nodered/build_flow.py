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
for topic, path, every in [('batt', '/electrical/batteries', 2), ('wind', '/environment/wind', 2),
                           ('nav', '/navigation', 2), ('tanks', '/tanks', 5), ('baro', '/environment/outside/pressure', 2), ('prop', '/propulsion', 2), ('depth', '/environment/depth', 2)]:
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
if (msg.statusCode === 200 && msg.payload && typeof msg.payload === 'object') {
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
    });
}
return null;""", 760, 1080, [['met.no GET']])
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
    engMaxRpm: 3000, engRedRpm: 2500, engGreenFrom: 1800, engGreenTo: 2200, fuelInstance: 'auto', fuelUseSensor: true, fuelCurve: '800:0.8,1000:1.2,1500:2.2,2000:3.8,2500:6.2,3000:9.5',
    anchorAlarmOn: true, anchorLocalFallback: true, ackMinutes: 5, staleSec: 30, tz: 'Europe/Rome', testUntil: 0, night: false,
    soundOn: true, soundNight: 'short' };
const RANGE = { windWinMin: [1, 360], windAlarmKn: [5, 80], windHystKn: [0, 10], windAvgSec: [2, 120], battLowSoc: [5, 95],
    battHystSoc: [0, 20], battLowVolt: [0, 60], waterLowPct: [0, 95], waterHystPct: [0, 20], baroLowHpa: [900, 1050], baroHystHpa: [0, 10], baroWinMin: [1, 360], engMaxRpm: [1000, 6000], engRedRpm: [500, 6000], engGreenFrom: [0, 6000], engGreenTo: [0, 6000], ackMinutes: [1, 120], staleSec: [5, 300] };
const BOOL = ['night', 'soundOn', 'baroAlarmOn', 'fuelUseSensor', 'windAlarmOn', 'battAlarmOn', 'waterAlarmOn', 'anchorAlarmOn', 'anchorLocalFallback'];
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
    if (typeof b.battInstance === 'string' && /^[\\w-]{1,20}$/.test(b.battInstance)) cfg.battInstance = b.battInstance;
    if (typeof b.fuelInstance === 'string' && /^[\\w.-]{1,30}$/.test(b.fuelInstance)) cfg.fuelInstance = b.fuelInstance;
    if (typeof b.fuelCurve === 'string') {
        const ok = b.fuelCurve.split(',').every((p) => /^\\s*\\d+\\s*:\\s*\\d+(\\.\\d+)?\\s*$/.test(p));
        if (!ok) { msg.statusCode = 400; msg.payload = { error: 'Fuel curve: format rpm:l/h, e.g. 1000:1.2,2000:3.8' }; return [msg, null]; }
        cfg.fuelCurve = b.fuelCurve.replace(/\\s/g, '');
    }
    if (typeof b.waterInstance === 'string' && /^[\\w-]{1,20}$/.test(b.waterInstance)) cfg.waterInstance = b.waterInstance;
    if (typeof b.tz === 'string' && b.tz) {
        try { new Date().toLocaleString('en-GB', { timeZone: b.tz }); cfg.tz = b.tz; }
        catch (e) { msg.statusCode = 400; msg.payload = { error: 'Unknown time zone' }; return [msg, null]; }
    }
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
    batt: { st: 'na' }, energy: { ok: false }, weather: { ok: false }, engine: {}, water: { st: 'na' }, baro: { st: 'na', hist: [] }, wind: { st: 'na', hist: [] }, anchor: { st: 'na' } };
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
        'nodes': nodes, 'configs': configs}
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
