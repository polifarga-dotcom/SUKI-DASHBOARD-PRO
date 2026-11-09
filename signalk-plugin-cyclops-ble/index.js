/**
 * signalk-plugin-cyclops-ble
 *
 * Reads Cyclops Marine rig load sensors (smartlink / smartlink², OEM hardware:
 * Mantracourt B24 "Smart Load") directly from their Bluetooth LE advertisements.
 * No Cyclops gateway, no WiFi, no pairing — the Signal K host just listens.
 *
 * Data flow:
 *   BlueZ (D-Bus, LE discovery) → ManufacturerData 0x04C3 → B24 decode
 *   → rigging.<name>.tension (N) + sensors.cyclops.<name>.{rssi,status,age}
 *
 * B24 advert (manufacturer data after company ID 0x04C3, 11 bytes):
 *   [0]     format ID (1)
 *   [1..2]  data tag (= last two MAC bytes)
 *   [3..10] XOR-encoded: status, units, float32 BE (4), data tag (check)
 * Encoding array = SEED XOR view PIN (ASCII, repeated), see Mantracourt B24
 * Technical Manual "Decoding Data with View PIN". Cyclops sensors use "0000".
 * A decode is accepted only when the trailing tag equals the clear-text tag.
 *
 * Needs D-Bus access to org.bluez for the Signal K user, see README.
 *
 * NMEA 2000 backup (optional): sends PGN 65293 "Diverse Yacht Services: Load
 * Cell" byte-identical to the Cyclops gateway (kg, 10 kg steps, 1 Hz) for every
 * sensor with an n2kInstance — but only while no other device (the gateway)
 * has sent 65293 for that instance within the last 5 s.
 *
 * v1.2.1 — Switches to a USB adapter that registers after start (boot race).
 * v1.2.0 — NMEA 2000 backup output for B&G Triton / MFDs.
 * v1.1.0 — Public release: auto-discovery of all B24 sensors in range
 *   (named b24_<tag> until mapped), no hard-coded MACs, README.
 * v1.0.1 — Stale limit default 120 s; any Bluetooth packet from a sensor
 *   (incl. scan responses without load data) counts as sign of life;
 *   sensors.cyclops.<name>.age (s since last load value) published every 10 s.
 */

'use strict';
const dbus = require('dbus-next');

const COMPANY_ID = 0x04c3;   // Mantracourt Electronics Ltd
const SEED       = [0x5c, 0x6f, 0x2f, 0x41, 0x21, 0x7a, 0x26, 0x45, 0x5c, 0x6f];
const G          = 9.80665;
// B24 unit codes → factor to Newton (0x3a verified against a Cyclops gateway: tonnes)
const UNIT_TO_N  = { 0x3a: 1000 * G, 0x2d: G, 0x30: G / 1000 };
const LOAD_PGN   = 65293;   // Diverse Yacht Services: Load Cell, as sent by the Cyclops gateway
const GATEWAY_HOLD_MS = 5000;
const SIGNALK_MFR = [999, 'Signal K'];   // manufacturer of Signal K's own N2K device(s)

module.exports = function (app) {
  const plugin = {
    id: 'cyclops-ble',
    name: 'Cyclops BLE Rig Load',
    description: 'Cyclops / Mantracourt B24 load sensors via Bluetooth LE (no gateway)',
  };

  let bus          = null;
  let om           = null;    // BlueZ ObjectManager interface
  let adapterPath  = null;
  let watchdog     = null;
  let devProxies   = {};      // object path → props interface (signal listener attached)
  let lastSeen     = {};      // name → { t, value, rssi }  (last decoded load value)
  let lastAlive    = {};      // name → ms of last Bluetooth packet of any kind
  let macOfName    = {};      // name → MAC (configured and auto-discovered)
  let sensorsByMac = {};      // configured MAC → name
  let encArray     = [];
  let options      = {};
  let n2kInstOf    = {};      // name → N2K load cell instance
  let gatewaySeen  = {};      // instance → ms of last 65293 from a Cyclops gateway
  let ownSrcs      = new Set();   // N2K addresses of Signal K itself (our own sends)
  let n2kTimer     = null;
  let n2kSending   = false;

  plugin.schema = {
    type: 'object',
    properties: {
      adapter: {
        type: 'string',
        title: 'Bluetooth adapter (e.g. hci1). Empty = prefer USB adapter, else hci0',
        default: '',
      },
      autoDiscover: {
        type: 'boolean',
        title: 'Publish unmapped B24 sensors as rigging.b24_<tag>.tension',
        default: true,
      },
      pin: { type: 'string', title: 'B24 view PIN (Cyclops: 0000)', default: '0000' },
      staleSec: { type: 'number', title: 'Mark sensor stale after (s)', default: 120 },
      n2kBackup: {
        type: 'boolean',
        title: 'NMEA 2000 backup: send PGN 65293 like the Cyclops gateway while no gateway is on the bus',
        default: false,
      },
      sensors: {
        type: 'array',
        title: 'Sensors (MAC → name). The plugin status shows MACs of discovered sensors.',
        default: [],
        items: {
          type: 'object',
          properties: {
            mac:  { type: 'string', title: 'MAC address, e.g. 84:C6:92:EC:ED:0F' },
            name: { type: 'string', title: 'Name, e.g. port → rigging.port.tension' },
            n2kInstance: { type: 'number', title: 'NMEA 2000 load cell instance (Cyclops gateway: e.g. 30 port, 31 starboard)' },
          },
        },
      },
    },
  };

  plugin.start = function (opts) {
    options = Object.assign({ adapter: '', autoDiscover: true, pin: '0000', staleSec: 120, n2kBackup: false, sensors: [] }, opts);
    const pin = Buffer.from(options.pin || '0000', 'ascii');
    encArray = SEED.map((s, i) => s ^ pin[i % pin.length]);
    sensorsByMac = {};
    macOfName = {};
    for (const s of options.sensors || []) {
      if (!s.mac || !s.name) continue;
      const mac = s.mac.trim().toUpperCase();
      const name = cleanName(s.name);
      sensorsByMac[mac] = name;
      macOfName[name] = mac;
      if (Number.isInteger(s.n2kInstance)) n2kInstOf[name] = s.n2kInstance;
    }
    publishMeta(Object.keys(macOfName));
    app.setPluginStatus('Starting Bluetooth scan…');
    init().catch(err => app.setPluginError(`Bluetooth init failed: ${err.message}`));
    watchdog = setInterval(tick, 10000);
    if (options.n2kBackup && Object.keys(n2kInstOf).length) {
      app.on('N2KAnalyzerOut', onN2K);
      n2kTimer = setInterval(sendN2K, 1000);
    }
  };

  plugin.stop = function () {
    clearInterval(watchdog);
    watchdog = null;
    clearInterval(n2kTimer);
    n2kTimer = null;
    app.removeListener('N2KAnalyzerOut', onN2K);
    n2kInstOf = {};
    gatewaySeen = {};
    ownSrcs = new Set();
    n2kSending = false;
    for (const props of Object.values(devProxies)) props.removeAllListeners('PropertiesChanged');
    if (bus) {
      const b = bus;
      if (adapterPath) {
        b.getProxyObject('org.bluez', adapterPath)
          .then(o => o.getInterface('org.bluez.Adapter1').StopDiscovery())
          .catch(() => {});
      }
      setTimeout(() => { try { b.disconnect(); } catch (e) {} }, 500);
    }
    bus = null;
    om = null;
    adapterPath = null;
    devProxies = {};
    lastSeen = {};
    lastAlive = {};
  };

  function cleanName(s) {
    return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  // ── BlueZ setup ────────────────────────────────────────────────────────────
  async function init() {
    bus = dbus.systemBus();
    const root = await bus.getProxyObject('org.bluez', '/');
    om = root.getInterface('org.freedesktop.DBus.ObjectManager');
    const objects = await om.GetManagedObjects();

    const path = pickAdapter(objects);
    if (!path) throw new Error('no Bluetooth adapter found');
    await useAdapter(path);

    om.on('InterfacesAdded', (path, ifaces) => {
      if (ifaces['org.bluez.Device1']) watchDevice(path, ifaces['org.bluez.Device1']);
    });
    om.on('InterfacesRemoved', (path) => {
      if (devProxies[path]) devProxies[path].removeAllListeners('PropertiesChanged');
      delete devProxies[path];
    });

    scanObjects(objects);
    app.setPluginStatus(`Scanning on ${adapterPath.split('/').pop()}`);
  }

  // Switch scanning to `path`; also used later when a USB adapter shows up after
  // Signal K started (at boot the USB dongle can register with BlueZ too late).
  async function useAdapter(path) {
    if (adapterPath && adapterPath !== path) {
      const old = adapterPath;
      bus.getProxyObject('org.bluez', old)
        .then(o => o.getInterface('org.bluez.Adapter1').StopDiscovery())
        .catch(() => {});
      for (const props of Object.values(devProxies)) props.removeAllListeners('PropertiesChanged');
      devProxies = {};
      app.debug(`switching Bluetooth adapter ${old} → ${path}`);
    }
    adapterPath = path;
    const adapterObj = await bus.getProxyObject('org.bluez', adapterPath);
    const adapter = adapterObj.getInterface('org.bluez.Adapter1');
    const adapterProps = adapterObj.getInterface('org.freedesktop.DBus.Properties');
    await adapterProps.Set('org.bluez.Adapter1', 'Powered', new dbus.Variant('b', true));
    await adapter.SetDiscoveryFilter({
      Transport: new dbus.Variant('s', 'le'),
      DuplicateData: new dbus.Variant('b', true),
    });
    await startDiscovery();
  }

  function pickAdapter(objects) {
    const adapters = Object.entries(objects)
      .filter(([, ifaces]) => ifaces['org.bluez.Adapter1'])
      .map(([path, ifaces]) => ({ path, modalias: (ifaces['org.bluez.Adapter1'].Modalias || {}).value || '' }));
    if (options.adapter) {
      const a = adapters.find(x => x.path.endsWith('/' + options.adapter));
      return a ? a.path : null;
    }
    const usb = adapters.find(x => x.modalias.startsWith('usb:'));
    return (usb || adapters[0] || {}).path || null;
  }

  async function startDiscovery() {
    const obj = await bus.getProxyObject('org.bluez', adapterPath);
    const props = obj.getInterface('org.freedesktop.DBus.Properties');
    const discovering = await props.Get('org.bluez.Adapter1', 'Discovering');
    if (!discovering.value) await obj.getInterface('org.bluez.Adapter1').StartDiscovery();
  }

  function scanObjects(objects) {
    for (const [path, ifaces] of Object.entries(objects)) {
      if (ifaces['org.bluez.Device1']) watchDevice(path, ifaces['org.bluez.Device1']);
    }
  }

  function isCandidate(mac, devProps) {
    if (sensorsByMac[mac]) return true;
    const mfg = (devProps.ManufacturerData || {}).value;
    return !!(mfg && mfg[COMPANY_ID]);
  }

  // Only configured MACs and devices advertising Mantracourt data get a listener,
  // so phones etc. with rotating addresses don't pile up D-Bus subscriptions.
  async function watchDevice(path, devProps) {
    if (!adapterPath || !path.startsWith(adapterPath + '/') || devProxies[path]) return;
    const mac = ((devProps.Address || {}).value || '').toUpperCase();
    if (!isCandidate(mac, devProps)) return;
    try {
      const obj = await bus.getProxyObject('org.bluez', path);
      const props = obj.getInterface('org.freedesktop.DBus.Properties');
      if (devProxies[path]) return;
      devProxies[path] = props;
      let rssi = (devProps.RSSI || {}).value;
      props.on('PropertiesChanged', (iface, changed) => {
        if (iface !== 'org.bluez.Device1') return;
        const name = nameFor(mac);
        if (name && (changed.RSSI || changed.ManufacturerData)) lastAlive[name] = Date.now();
        if (changed.RSSI) rssi = changed.RSSI.value;
        if (changed.ManufacturerData) handleAdvert(mac, changed.ManufacturerData.value, rssi);
      });
      if (devProps.ManufacturerData) handleAdvert(mac, devProps.ManufacturerData.value, rssi);
    } catch (err) {
      app.debug(`watchDevice ${path}: ${err.message}`);
    }
  }

  // Configured name, or the auto-discovered one once a valid B24 advert was seen
  function nameFor(mac) {
    if (sensorsByMac[mac]) return sensorsByMac[mac];
    const auto = 'b24_' + mac.replace(/:/g, '').slice(-4).toLowerCase();
    return macOfName[auto] === mac ? auto : null;
  }

  // ── Decode + publish ───────────────────────────────────────────────────────
  function handleAdvert(mac, mfgData, rssi) {
    const v = mfgData && mfgData[COMPANY_ID];
    const buf = v && Buffer.from(v.value || v);
    if (!buf) return;
    const r = decodeB24(buf);
    if (!r) { app.debug(`${mac}: undecodable advert ${buf.toString('hex')} (wrong PIN?)`); return; }
    const factor = UNIT_TO_N[r.units];
    if (factor === undefined) { app.debug(`${mac}: unknown unit code 0x${r.units.toString(16)}`); return; }

    let name = nameFor(mac);
    if (!name) {
      if (!options.autoDiscover) return;
      name = 'b24_' + mac.replace(/:/g, '').slice(-4).toLowerCase();
      macOfName[name] = mac;
      publishMeta([name]);
      app.debug(`discovered B24 sensor ${mac} as ${name}`);
    }

    const newtons = r.value * factor;
    lastSeen[name] = { t: Date.now(), value: newtons, rssi };
    lastAlive[name] = lastSeen[name].t;
    app.handleMessage(plugin.id, {
      updates: [{
        values: [
          { path: `rigging.${name}.tension`, value: newtons },
          { path: `sensors.cyclops.${name}.rssi`, value: rssi === undefined ? null : rssi },
          { path: `sensors.cyclops.${name}.status`, value: r.status },
        ],
      }],
    });
  }

  function decodeB24(buf) {
    if (buf.length < 11 || buf[0] !== 0x01) return null;
    const dec = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) dec[i] = buf[3 + i] ^ encArray[i];
    if (dec[6] !== buf[1] || dec[7] !== buf[2]) return null;   // tag check = PIN/format ok
    return { status: dec[0], units: dec[1], value: dec.readFloatBE(2) };
  }

  function publishMeta(names) {
    if (!names.length) return;
    const meta = [];
    for (const name of names) {
      meta.push({ path: `rigging.${name}.tension`, value: { units: 'N', description: `Cyclops rig load ${name}` } });
      meta.push({ path: `sensors.cyclops.${name}.rssi`, value: { units: 'dB', description: 'Bluetooth signal strength' } });
      meta.push({ path: `sensors.cyclops.${name}.age`, value: { units: 's', description: 'Seconds since last load value' } });
    }
    app.handleMessage(plugin.id, { updates: [{ meta }] });
  }

  // ── NMEA 2000 backup output ────────────────────────────────────────────────
  let lastSrcRefresh = 0;
  // Any 65293 for our instance that does not come from Signal K itself counts as
  // the gateway (fail-safe: an unknown sender keeps us silent). Own addresses come
  // from the source tree via app.signalk (not official plugin API, but long stable).
  function refreshOwnSrcs() {
    lastSrcRefresh = Date.now();
    try {
      const srcs = new Set();
      for (const conn of Object.values(app.signalk.retrieve().sources || {})) {
        for (const [addr, info] of Object.entries(conn || {})) {
          if (info && info.n2k && SIGNALK_MFR.includes(info.n2k.manufacturerCode)) srcs.add(Number(addr));
        }
      }
      ownSrcs = srcs;
    } catch (err) {
      app.debug(`source lookup failed: ${err.message}`);
    }
  }

  function onN2K(msg) {
    if (!msg || msg.pgn !== LOAD_PGN || !msg.fields) return;
    if (Date.now() - lastSrcRefresh > 30000) refreshOwnSrcs();
    if (!ownSrcs.has(msg.src)) gatewaySeen[msg.fields.instance] = Date.now();
  }

  function sendN2K() {
    const now = Date.now();
    let sent = false;
    for (const [name, instance] of Object.entries(n2kInstOf)) {
      const s = lastSeen[name];
      if (!s || now - s.t > options.staleSec * 1000) continue;            // never repeat stale loads
      if (now - (gatewaySeen[instance] || 0) < GATEWAY_HOLD_MS) continue; // gateway is talking
      app.emit('nmea2000JsonOut', {
        pgn: LOAD_PGN, prio: 6, dst: 255,
        fields: {
          manufacturerCode: 'Diverse Yacht Services',
          industryCode: 'Marine Industry',
          instance,
          loadCell: Math.round(s.value / G / 10) * 10,   // kg in 10 kg steps, like the gateway
        },
      });
      sent = true;
    }
    n2kSending = sent;
  }

  // ── Watchdog: keep discovery alive, catch missed devices, report freshness ─
  async function tick() {
    if (!bus) return;
    try {
      if (!adapterPath) { await init(); return; }
      const objects = await om.GetManagedObjects();
      const want = pickAdapter(objects);
      if (want && want !== adapterPath) await useAdapter(want);
      else await startDiscovery();
      scanObjects(objects);
    } catch (err) {
      app.setPluginError(`Bluetooth: ${err.message}`);
      return;
    }
    const now = Date.now();
    const names = Object.keys(macOfName);
    const sec = t => (t ? Math.round((now - t) / 1000) : null);
    if (names.length) {
      app.handleMessage(plugin.id, {
        updates: [{
          values: names.map(name => ({
            path: `sensors.cyclops.${name}.age`,
            value: lastSeen[name] ? sec(lastSeen[name].t) : null,
          })),
        }],
      });
    }
    const adapterName = adapterPath.split('/').pop();
    if (!names.length) {
      app.setPluginStatus(`${adapterName} · scanning, no B24 sensor seen yet`);
      return;
    }
    const parts = names.map(name => {
      const s = lastSeen[name];
      const alive = sec(lastAlive[name]);
      const hint = sensorsByMac[macOfName[name]] ? '' : ` [${macOfName[name]}]`;
      if (!s) return `${name}${hint}: –${alive !== null ? ` (alive ${alive}s)` : ''}`;
      const age = sec(s.t);
      const t = (s.value / G / 1000).toFixed(2);
      return `${name}${hint}: ${t} t (${age}s, alive ${alive}s, ${s.rssi} dBm)${age > options.staleSec ? ' STALE' : ''}`;
    });
    // Stale = no load value within staleSec. A sensor that is alive but sends no
    // new load value is still flagged, since the shown tension may be outdated.
    const stale = names.some(n => !lastSeen[n] || now - lastSeen[n].t > options.staleSec * 1000);
    let n2k = '';
    if (n2kTimer) {
      const gw = Object.values(n2kInstOf).some(i => now - (gatewaySeen[i] || 0) < GATEWAY_HOLD_MS);
      const state = n2kSending ? 'sending' : gw ? 'gateway' : 'idle';
      n2k = ` · N2K: ${state}`;
      app.handleMessage(plugin.id, { updates: [{ values: [{ path: 'sensors.cyclops.n2kBackup', value: state }] }] });
    }
    const msg = `${adapterName} · ${parts.join(' · ')}${n2k}`;
    if (stale) app.setPluginError(msg); else app.setPluginStatus(msg);
  }

  return plugin;
};
