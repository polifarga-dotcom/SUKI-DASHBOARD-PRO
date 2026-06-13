/**
 * signalk-plugin-suki-bridge
 *
 * Streams live NMEA data from a SignalK server to SUKI Dashboard Pro via
 * a Supabase Edge Function. Install from the SignalK Appstore, then configure
 * with the Ingest URL and API Key from the SUKI Dashboard Settings tab.
 *
 * Data flow:
 *   SignalK delta stream → PATH_MAP filter → 5 s batch → POST /signalk-ingest
 *
 * The plugin:
 *   - Subscribes to all mapped SignalK paths
 *   - Collects incoming values in a pending buffer
 *   - POSTs the buffer to the Supabase Edge Function every `interval_ms`
 *   - Uses the api_key for authentication (the server resolves boat_id from it)
 *
 * Standard SignalK paths are mapped to SUKI's telemetry columns.
 * Victron-specific paths (solar total) use the Victron SignalK plugin conventions.
 *
 * v1.0.20 — Enforce minimum 30 s send interval to stay within Supabase free-plan
 *   edge-function quota. The interval is clamped in code regardless of the stored
 *   config value, so existing users get the new behaviour automatically on update.
 *
 * v1.0.10 — Add Venus-priority source filter to the V/A/W discovery subscriptions.
 *   Victron MPPT solar chargers report their output voltage on the same SignalK
 *   path as the BMV (e.g. electrical.batteries.278.voltage), causing 14.15 V
 *   (absorption charging voltage) to overwrite 13.28 V (BMV true reading) in
 *   cycles where the BMV doesn't update. The fix: once a Venus battery source
 *   (BMV/SmartShunt) has been seen for SOC, reject V/A/W from non-battery sources
 *   (solar chargers, inverters, etc.) on the same battery instance paths.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

module.exports = function (app) {
  let sendTimer        = null;
  let logTimer         = null;   // offline log snapshot timer
  let pending          = {};
  let pendingStr       = {};   // string-valued fields (ws_*_mode)
  let unsubscribes     = [];
  let discoveryTimer   = null;
  let rediscoveryTimer = null;

  // ── Dynamic solar accumulators (any MPPT instance, any namespace) ──────────
  // Values are continuously updated by subscriptions added during discovery.
  // On each batch send they are summed → solar_total_w / solar_total_a / yields.
  let _solarPowerByInst      = {};  // instKey → last panel power (W)
  let _solarCurrentByInst    = {};  // instKey → last charging current (A)
  let _solarYieldTodayByInst = {};  // instKey → yield today (J)
  let _solarYieldYestByInst  = {};  // instKey → yield yesterday (J)

  // ── Dynamic tank accumulators (any instance ID) ─────────────────────────────
  // Sorted by instance ID at send time: lowest → primary column, second → grey/aft.
  let _tankFWByInst  = {};   // instanceId → fill ratio 0–1
  let _tankDSLByInst = {};   // instanceId → fill ratio 0–1
  let _tankBWByInst  = {};   // instanceId → fill ratio 0–1

  // Tracks paths already subscribed by discovery to avoid duplicates on re-scan
  let _discoveredPaths = new Set();

  // ── Battery SOC source-priority tracking (persistent across cycles) ──────────
  // On Victron/Cerbo systems the same telemetry column (e.g. batt_main_soc) can
  // be updated by multiple SignalK paths / sources within a 5-second window:
  //   • venus.com.victronenergy.battery.ttyS*  — BMV / SmartShunt (authoritative)
  //   • n2k-on-ve.can-socket.*                 — charger, BMS, or other N2K device
  //
  // The charger often reports SOC = 1.0 ("fully charged") while the actual
  // coulomb counter shows the real value.
  //
  // Two-part fix:
  // 1. Once a Victron/Venus source is seen for a column, ALL subsequent N2K values
  //    for that column are permanently discarded (not just within the current batch).
  //    This handles the common case where the BMV and charger fire on different cycles.
  // 2. If the BMV didn't fire in the current 5-second window (BMV typically updates
  //    every ~10 s), the last known Venus value is reused instead of sending the
  //    charger's spurious 1.0. Prevents the "100% flicker every other batch" pattern.
  //
  // For boats without Victron (pure N2K), _battSocVenusSeen stays false and the
  // normal first-value-wins behaviour applies.
  let _battSocVenusSeen   = {};  // col → boolean: Venus battery source seen at least once (persists)
  let _battSocVenusLast   = {};  // col → number:  last value from a Venus battery source (persists)
  let _battDiscoveredCols = {};  // instKey → column assignment ('batt_main_soc' | 'batt_eng_soc')
                                 // Sorted by numeric instance ID: lowest → main, second → engine.
                                 // Persists so re-discovery at 60 s respects prior assignments.

  // ── SignalK path → telemetry column mapping ─────────────────────────────────
  // Standard paths work across any NMEA-connected SignalK server.
  // Instance IDs (e.g. batteries.0, chargers.0) are Victron defaults; boats with
  // non-standard IDs are handled by the dynamic discovery below.
  const PATH_MAP = {
    // Navigation (standard NMEA)
    'navigation.position.latitude':                          'nav_lat',
    'navigation.position.longitude':                         'nav_lon',
    'navigation.headingTrue':                                'nav_hdg_rad',
    'navigation.headingMagnetic':                            'nav_hdg_rad',   // fallback if True unavailable
    'navigation.speedOverGround':                            'nav_sog_ms',
    'navigation.courseOverGroundTrue':                       'nav_cog_rad',
    'navigation.speedThroughWater':                          'nav_stw_ms',

    // Environment (standard)
    'environment.depth.belowKeel':                           'env_depth_m',
    'environment.depth.belowTransducer':                     'env_depth_m',   // fallback
    'environment.water.temperature':                         'temp_water',    // Water temp (Kelvin)
    'environment.outside.temperature':                       'temp_water',    // fallback if no water sensor
    'environment.wind.angleApparent':                        'env_awa_rad',
    'environment.wind.speedApparent':                        'env_aws_ms',
    'environment.wind.angleTrueWater':                       'env_twa_rad',
    'environment.wind.speedTrue':                            'env_tws_ms',
    'environment.outside.pressure':                          'env_pressure_pa',

    // Batteries — static instance IDs removed in v1.0.9.
    // On Victron/Cerbo systems the real BMV/SmartShunt appears at a non-zero
    // instance ID (e.g. 278 on SUKI), while instance 0 is an N2K charger that
    // reports SOC=1.0 (100%) at all times. Keeping static instance 0 entries
    // caused permanent SOC/V/A flicker even when the Venus priority filter was
    // active. Battery paths are now subscribed exclusively via dynamic discovery
    // (see discoverDynamicPaths below), which finds the correct instance IDs and
    // applies the Venus-source priority filter.

    // Propulsion / Engine — Multi-Motor Support (Catamaran)
    // SignalK value for `revolutions` is in Hz (rev/sec); the TRANSFORMS map below
    // converts it to RPM (×60) before storing in the `eng_rpm` column.
    // Single-motor boats use propulsion.main.* or propulsion.port.*
    // Catamaran boats (e.g., Cooinda) use propulsion.port.* and propulsion.starboard.*
    // Mapping priority: main.* > port.* for primary engine, starboard.* for secondary
    'propulsion.main.revolutions':                           'eng_rpm',
    'propulsion.port.revolutions':                           'eng_rpm',       // fallback (primary)
    'propulsion.starboard.revolutions':                      'eng_sb_rpm',    // secondary (catamaran)
    'propulsion.main.runTime':                               'eng_run_sec',
    'propulsion.port.runTime':                               'eng_run_sec',   // fallback (primary)
    'propulsion.starboard.runTime':                          'eng_sb_run_sec', // secondary (catamaran)
    'propulsion.main.temperature':                           'eng_temp_k',
    'propulsion.port.temperature':                           'eng_temp_k',    // fallback (primary)
    'propulsion.starboard.temperature':                      'eng_sb_temp_k', // secondary (catamaran)
    'propulsion.main.alternatorVoltage':                     'eng_alt_v',
    'propulsion.port.alternatorVoltage':                     'eng_alt_v',     // fallback (primary)
    'propulsion.starboard.alternatorVoltage':                'eng_sb_alt_v',  // secondary (catamaran)

    // Tanks — instance 0 fast path (Victron default). Boats using other instance
    // IDs are handled by dynamic discovery (subscribed at 5 s / 60 s after start).
    'tanks.freshWater.0.currentLevel':                       'tank_fw',
    'tanks.diesel.0.currentLevel':                           'tank_dsl',
    'tanks.blackWater.0.currentLevel':                       'tank_bwm',
    'tanks.blackWater.1.currentLevel':                       'tank_bwg',

    // Solar — instance 0 fast path. Additional MPPT instances (electrical.solar.N.*)
    // and charger instances are discovered and summed dynamically.
    'electrical.chargers.0.panelPower':                      'solar_total_w',

    // Wakespeed alternator regulators are discovered dynamically in
    // discoverDynamicPaths() to support any instance numbering and any
    // number of boats/configs. No static entries here.

    // Rudder
    'steering.rudderAngle':                                  'rudder_rad',

    // Rigging load cells (vendor-specific; only populated if rig tension sensors
    // are connected and the Cerbo's SignalK plugin provides these paths).
    'rigging.port.tension':                                  'rig_port',
    'rigging.starboard.tension':                             'rig_sb',
  };

  // ── Fallback paths — don't overwrite a primary value in the same batch ──────
  // If a primary path (e.g. propulsion.main.*) already populated the column in
  // this cycle, the fallback path is silently skipped.
  const FALLBACKS = new Set([
    'navigation.headingMagnetic',
    'environment.depth.belowTransducer',
    'propulsion.port.revolutions',
    'propulsion.port.runTime',
    'propulsion.port.temperature',
    'propulsion.port.alternatorVoltage',
  ]);

  // ── Value transforms — applied before storing in the pending buffer ──────────
  // SignalK `propulsion.*.revolutions` is in Hz (rev/sec); eng_rpm expects RPM.
  const TRANSFORMS = {
    'propulsion.main.revolutions': v => Math.round(v * 60),
    'propulsion.port.revolutions': v => Math.round(v * 60),
    'propulsion.starboard.revolutions': v => Math.round(v * 60),
  };

  // ── Dynamic path discovery ──────────────────────────────────────────────────
  // Called at 5 s and 60 s after start. Enumerates all paths that SignalK has
  // received data for and subscribes to any solar MPPT or tank paths not already
  // in the static PATH_MAP. Uses _discoveredPaths to avoid duplicate subscriptions.
  function discoverDynamicPaths() {
    let available;
    try {
      available = app.streambundle.getAvailablePaths();
    } catch (e) {
      app.debug(`Dynamic discovery: getAvailablePaths() unavailable — ${e.message}`);
      return;
    }

    let newCount = 0;

    for (const path of available) {
      if (_discoveredPaths.has(path)) continue;

      let m;

      // ── Solar MPPTs ────────────────────────────────────────────────────────
      // Matches: electrical.solar.N.panelPower / current / yieldToday / yieldYesterday
      //      or: electrical.chargers.N.panelPower / current / yieldToday / yieldYesterday
      if ((m = path.match(
        /^electrical\.(solar|chargers)\.(\w+)\.(panelPower|current|yieldToday|yieldYesterday)$/
      ))) {
        const [, ns, inst, metric] = m;
        const key = `${ns}.${inst}`;
        try {
          const unsub = app.streambundle.getSelfBus(path).onValue(({ value }) => {
            if (typeof value !== 'number' || !isFinite(value)) return;
            if (metric === 'panelPower')     _solarPowerByInst[key]      = value;
            if (metric === 'current')        _solarCurrentByInst[key]    = value;
            if (metric === 'yieldToday')     _solarYieldTodayByInst[key] = value;
            if (metric === 'yieldYesterday') _solarYieldYestByInst[key]  = value;
          });
          unsubscribes.push(unsub);
          _discoveredPaths.add(path);
          newCount++;
        } catch (e) {
          app.debug(`Discovery: could not subscribe to ${path}: ${e.message}`);
        }
        continue;
      }

      // Battery SOC paths are collected below and processed after the main loop
      // (they need to be sorted by instance ID before column assignment).
      if ((m = path.match(/^electrical\.batteries\.(\w+)\.capacity\.stateOfCharge$/))) {
        continue; // handled in the sorted pass below
      }

      // ── Tanks ──────────────────────────────────────────────────────────────
      // Matches: tanks.{freshWater|fuel|diesel|blackWater}.N.currentLevel
      if ((m = path.match(
        /^tanks\.(freshWater|fuel|diesel|blackWater)\.(\w+)\.currentLevel$/
      ))) {
        const [, type, inst] = m;
        try {
          const unsub = app.streambundle.getSelfBus(path).onValue(({ value }) => {
            if (typeof value !== 'number' || !isFinite(value)) return;
            if (type === 'freshWater')                    _tankFWByInst[inst]  = value;
            else if (type === 'fuel' || type === 'diesel') _tankDSLByInst[inst] = value;
            else if (type === 'blackWater')                _tankBWByInst[inst]  = value;
          });
          unsubscribes.push(unsub);
          _discoveredPaths.add(path);
          newCount++;
        } catch (e) {
          app.debug(`Discovery: could not subscribe to ${path}: ${e.message}`);
        }
        continue;
      }
    }

    // ── Battery SOC — sorted instance discovery ────────────────────────────
    // Collect all non-0/non-1 battery SOC paths, sort by numeric instance ID,
    // then assign: lowest instance → batt_main_soc, second → batt_eng_soc.
    // This ensures e.g. instance 278 (BMV) always becomes "main" and
    // instance 291 (starter/engine battery) becomes "engine", regardless of
    // the order getAvailablePaths() returns them.
    const newBattSocPaths = available
      .filter(p => !_discoveredPaths.has(p))
      .map(p => {
        const bm = p.match(/^electrical\.batteries\.(\w+)\.capacity\.stateOfCharge$/);
        return bm ? { path: p, inst: bm[1] } : null;
      })
      .filter(x => x && x.inst !== '0' && x.inst !== '1')
      .sort((a, b) => Number(a.inst) - Number(b.inst));

    for (const { path, inst } of newBattSocPaths) {
      // Look up existing assignment or assign the next available column
      let col = _battDiscoveredCols[inst];
      if (!col) {
        const used = new Set(Object.values(_battDiscoveredCols));
        if      (!used.has('batt_main_soc')) col = 'batt_main_soc';
        else if (!used.has('batt_eng_soc'))  col = 'batt_eng_soc';
        else { _discoveredPaths.add(path); continue; } // > 2 instances, skip
        _battDiscoveredCols[inst] = col;
        app.debug(`Battery discovery: instance ${inst} → ${col}`);
      }
      const assignedCol = col; // capture in closure
      try {
        const unsub = app.streambundle.getSelfBus(path).onValue(({ value, source }) => {
          if (typeof value !== 'number' || !isFinite(value)) return;
          const src = typeof source === 'string' ? source
            : (source?.label ?? source?.name ?? source?.$source ?? String(source ?? ''));
          const isVictronBattery = src.startsWith('venus.com.victronenergy.battery');

          if (isVictronBattery) {
            _battSocVenusSeen[assignedCol] = true;
            _battSocVenusLast[assignedCol] = value;
            pending[assignedCol] = value;
          } else if (_battSocVenusSeen[assignedCol]) {
            return;
          } else {
            if (pending[assignedCol] != null) return;
            pending[assignedCol] = value;
          }
        });
        unsubscribes.push(unsub);
        _discoveredPaths.add(path);
        newCount++;
      } catch (e) {
        app.debug(`Discovery: could not subscribe to ${path}: ${e.message}`);
      }
    }

    // ── Battery V/A/W — subscribe voltage/current/power for each discovered instance ─
    // _battDiscoveredCols was populated by the SOC sorted pass above.
    // We skip instance IDs 0 and 1 for the same reason as the SOC pass: those are
    // N2K chargers on Victron/Cerbo systems, not the authoritative battery monitor.
    // For each discovered instance (e.g. 278 → batt_main, 291 → batt_eng) we
    // subscribe to the three remaining battery metrics so V/A/W come from the
    // same physical device as SOC — no conflict, no flicker.
    for (const [inst, socCol] of Object.entries(_battDiscoveredCols)) {
      const prefix = socCol === 'batt_main_soc' ? 'batt_main' : 'batt_eng';
      const metrics = {
        voltage: `${prefix}_v`,
        current: `${prefix}_a`,
        power:   `${prefix}_w`,
      };
      const capturedSocCol = socCol; // for Venus-priority closure
      for (const [metric, targetCol] of Object.entries(metrics)) {
        const mPath = `electrical.batteries.${inst}.${metric}`;
        if (_discoveredPaths.has(mPath)) continue;
        if (!available.includes(mPath)) continue;
        try {
          const unsub = app.streambundle.getSelfBus(mPath).onValue(({ value, source }) => {
            if (typeof value !== 'number' || !isFinite(value)) return;
            // Apply the same Venus-battery source priority as SOC:
            // once a BMV/SmartShunt has been confirmed for this battery, reject
            // V/A/W values from solar chargers or other non-battery devices that
            // share the same battery instance path (they report charging voltage,
            // not the true battery terminal voltage measured by the BMV).
            if (_battSocVenusSeen[capturedSocCol]) {
              const src = typeof source === 'string' ? source
                : (source?.label ?? source?.name ?? source?.$source ?? String(source ?? ''));
              if (!src.startsWith('venus.com.victronenergy.battery')) return;
            }
            pending[targetCol] = value;
          });
          unsubscribes.push(unsub);
          _discoveredPaths.add(mPath);
          newCount++;
          app.debug(`Battery discovery: ${mPath} → ${targetCol}`);
        } catch (e) {
          app.debug(`Discovery: could not subscribe to ${mPath}: ${e.message}`);
        }
      }
    }

    // ── Wakespeed: fully dynamic alternator discovery ─────────────────────────
    // Discovers ALL electrical.alternator.* instances in ascending order and maps
    // them to ws_0/ws_1 slots. Works for any instance numbering (0+1, 1+2, 2+3…)
    // and any boat configuration. Re-runs every 60 s — skips already-subscribed paths.
    const WS_SLOTS = [
      { v: 'ws_0_alt_v', t: 'ws_0_alt_temp_k', f: 'ws_0_field_pct', m: 'ws_0_mode' },
      { v: 'ws_1_alt_v', t: 'ws_1_alt_temp_k', f: 'ws_1_field_pct', m: 'ws_1_mode' },
    ];

    // Alternator instances not yet subscribed, sorted ascending
    const newWsInsts = available
      .map(p => { const m = p.match(/^electrical\.alternator\.(\d+)\.voltage$/); return m ? Number(m[1]) : null; })
      .filter(n => n !== null && !_discoveredPaths.has(`electrical.alternator.${n}.voltage`))
      .sort((a, b) => a - b);

    // Free slots = those not yet claimed
    const freeSlots = WS_SLOTS.filter((_, idx) => !_discoveredPaths.has(`ws_slot_${idx}`));

    newWsInsts.slice(0, freeSlots.length).forEach((inst, i) => {
      const slot = freeSlots[i];
      const slotIdx = WS_SLOTS.indexOf(slot);

      // Subscribe numeric paths
      const numPaths = {
        [`electrical.alternator.${inst}.voltage`]:     slot.v,
        [`electrical.alternator.${inst}.temperature`]: slot.t,
        [`electrical.alternator.${inst}.fieldDrive`]:  slot.f,
      };
      for (const [path, col] of Object.entries(numPaths)) {
        if (!available.includes(path)) continue;
        try {
          const unsub = app.streambundle.getSelfBus(path).onValue(({ value }) => {
            if (typeof value === 'number' && isFinite(value)) pending[col] = value;
          });
          unsubscribes.push(unsub);
          _discoveredPaths.add(path);
          newCount++;
        } catch (e) {
          app.debug(`Discovery: could not subscribe to ${path}: ${e.message}`);
        }
      }

      // Subscribe chargingMode (string — separate from PATH_MAP numeric paths)
      const modePath = `electrical.alternator.${inst}.chargingMode`;
      if (available.includes(modePath) && !_discoveredPaths.has(modePath)) {
        try {
          const unsub = app.streambundle.getSelfBus(modePath).onValue(({ value }) => {
            if (typeof value === 'string' && value.length > 0) pendingStr[slot.m] = value;
          });
          unsubscribes.push(unsub);
          _discoveredPaths.add(modePath);
          newCount++;
        } catch (e) {
          app.debug(`Discovery: could not subscribe to ${modePath}: ${e.message}`);
        }
      }

      _discoveredPaths.add(`ws_slot_${slotIdx}`);  // claim slot — prevents re-assignment
      app.debug(`Wakespeed discovery: alternator instance ${inst} → slot ${slotIdx} (${slot.v})`);
    });

    if (newCount > 0) {
      app.debug(`Dynamic discovery: subscribed to ${newCount} new paths`);
    }
  }

  const plugin = {
    id:          'suki-bridge',
    name:        'SUKI Dashboard Bridge',
    description: 'Streams live NMEA data to SUKI Dashboard Pro',

    schema: {
      type: 'object',
      required: ['api_key'],
      properties: {
        api_key: {
          type:        'string',
          title:       'API Key',
          description: 'From SUKI Dashboard → Settings → SignalK Bridge → Copy',
        },
        interval_ms: {
          type:        'number',
          title:       'Send interval (ms)',
          description: 'How often to push data to the dashboard. Minimum 30000 ms (30 s) — values below 30 s are clamped automatically.',
          default:     30000,
          minimum:     30000,
        },
      },
    },

    start (config) {
      const { api_key, interval_ms: _interval_ms = 30000 } = config || {};
      // Enforce minimum 30 s — clamps legacy configs stored with 5000 ms.
      const interval_ms = Math.max(_interval_ms, 30000);
      const url = 'https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/signalk-ingest';
      // Offline log buffer endpoint — same base URL, different function
      const logUrl = url.replace('/signalk-ingest', '/ingest-log-entries');

      if (!api_key) {
        app.setPluginError('API key not configured — go to SUKI Dashboard → Settings → SignalK Bridge');
        return;
      }

      app.debug(`Starting — endpoint: ${url}, interval: ${interval_ms}ms`);

      // ── Vessel metadata (read once at startup) ───────────────────────────────
      // MMSI and callsign are static vessel properties in SignalK — not a stream.
      // We read them once and attach to the first batch so signalk-ingest can
      // auto-populate boats.mmsi / boats.callsign without manual entry.
      let _vesselMeta = null;
      {
        const mmsi     = app.getSelfPath('mmsi');
        const callsign = app.getSelfPath('communication.callsignVhf');
        if (mmsi || callsign) {
          _vesselMeta = {};
          if (mmsi     && typeof mmsi     === 'string') _vesselMeta.mmsi     = mmsi.trim();
          if (callsign && typeof callsign === 'string') _vesselMeta.callsign = callsign.trim().toUpperCase();
          app.debug(`Vessel meta: mmsi=${mmsi ?? '—'} callsign=${callsign ?? '—'}`);
        }
      };

      // ── Subscribe to static PATH_MAP paths ──────────────────────────────────
      const paths = Object.keys(PATH_MAP);
      unsubscribes = paths.map(path => {
        try {
          return app.streambundle.getSelfBus(path).onValue(({ value, source }) => {
            const col = PATH_MAP[path];
            if (!col || value == null || typeof value !== 'number' || !isFinite(value)) return;

            // Fallback paths: skip if a primary source already populated the column
            if (FALLBACKS.has(path) && pending[col] != null) return;

            // ── Battery SOC source-priority filter ──────────────────────────
            if (col === 'batt_main_soc' || col === 'batt_eng_soc') {
              // Robustly extract source label (string or {label/name/$source} object).
              const src = typeof source === 'string' ? source
                : (source?.label ?? source?.name ?? source?.$source ?? String(source ?? ''));
              // Only venus.com.victronenergy.battery.* is a real battery monitor (BMV/SmartShunt).
              // Chargers use venus.com.victronenergy.solarcharger / vebus / etc. — excluded.
              const isVictronBattery = src.startsWith('venus.com.victronenergy.battery');

              if (isVictronBattery) {
                _battSocVenusSeen[col] = true;
                _battSocVenusLast[col] = value;
                pending[col] = value;
              } else if (_battSocVenusSeen[col]) {
                return; // Venus battery source seen before → discard all N2K/other values
              } else {
                if (pending[col] != null) return; // non-Victron: first N2K value wins
                pending[col] = value;
              }
              return;
            }

            // Apply unit transform if defined (e.g. Hz → RPM for engine revolutions)
            const transformed = TRANSFORMS[path] ? TRANSFORMS[path](value) : value;
            pending[col] = transformed;
          });
        } catch (e) {
          app.debug(`Could not subscribe to ${path}: ${e.message}`);
          return () => {};
        }
      });

      // ── Extra: Victron/Venus GPS compound position object ────────────────────
      // Standard NMEA devices emit navigation.position.latitude / .longitude as
      // separate numeric sub-paths, handled above. Victron/Venus OS GPS sources
      // emit the parent path navigation.position as a compound object
      // { latitude: number, longitude: number }. This extra subscription catches
      // that object and extracts the coordinates. Sub-path values take priority;
      // the compound handler only fills nav_lat / nav_lon if they're still null.
      try {
        const posUnsub = app.streambundle.getSelfBus('navigation.position').onValue(({ value }) => {
          if (value && typeof value === 'object' &&
              value.latitude != null && value.longitude != null) {
            if (pending['nav_lat'] == null) pending['nav_lat'] = value.latitude;
            if (pending['nav_lon'] == null) pending['nav_lon'] = value.longitude;
          }
        });
        unsubscribes.push(posUnsub);
      } catch (e) {
        app.debug(`Could not subscribe to navigation.position compound: ${e.message}`);
      }

      // Wakespeed chargingMode subscriptions are handled inside discoverDynamicPaths()
      // alongside the numeric paths, so no static subscription needed here.

      // ── Dynamic path discovery ───────────────────────────────────────────────
      // Wait 5 s for SignalK data to start flowing (devices take time to connect),
      // then scan for solar MPPT and tank paths with non-standard instance IDs.
      // Re-scan at 60 s to pick up any devices that come online later.
      discoveryTimer   = setTimeout(discoverDynamicPaths,  5000);
      rediscoveryTimer = setTimeout(discoverDynamicPaths, 60000);

      // ── Batch sender ─────────────────────────────────────────────────────────
      sendTimer = setInterval(async () => {
        // Copy pending (numeric + string) and reset for next cycle
        const payload = { ...pending, ...pendingStr };
        pending    = {};
        pendingStr = {};
        // _battSocVenusSeen / _battSocVenusLast are NOT reset here — they persist
        // across cycles so that once a Venus source is seen, N2K is always suppressed.

        // If the BMV didn't fire in this cycle (it typically updates every ~10 s,
        // but we send every 5 s), fill the SOC columns from the last known good
        // Venus value rather than letting the charger's 1.0 slip through.
        for (const col of ['batt_main_soc', 'batt_eng_soc']) {
          if (payload[col] == null && _battSocVenusLast[col] != null) {
            payload[col] = _battSocVenusLast[col];
          }
        }

        // ── Merge dynamic solar values (sum across all discovered MPPT instances) ─
        // Static PATH_MAP may already have set solar_total_w (chargers.0 fast path);
        // dynamic values only fill in when the static path produced nothing.
        if (Object.keys(_solarPowerByInst).length > 0) {
          const dynW = Object.values(_solarPowerByInst).reduce((s, v) => s + v, 0);
          if (payload.solar_total_w == null) payload.solar_total_w = dynW;
        }
        if (Object.keys(_solarCurrentByInst).length > 0) {
          const dynA = Object.values(_solarCurrentByInst).reduce((s, v) => s + v, 0);
          if (payload.solar_total_a == null) payload.solar_total_a = dynA;
        }
        if (Object.keys(_solarYieldTodayByInst).length > 0) {
          const dynYT = Object.values(_solarYieldTodayByInst).reduce((s, v) => s + v, 0);
          if (payload.solar_yield_today_j == null) payload.solar_yield_today_j = dynYT;
        }
        if (Object.keys(_solarYieldYestByInst).length > 0) {
          const dynYY = Object.values(_solarYieldYestByInst).reduce((s, v) => s + v, 0);
          if (payload.solar_yield_yesterday_j == null) payload.solar_yield_yesterday_j = dynYY;
        }

        // ── Merge dynamic tank values (sorted by instance ID, lowest = primary) ──
        const sortEntries = obj =>
          Object.entries(obj).sort(([a], [b]) => Number(a) - Number(b));

        const fwSorted = sortEntries(_tankFWByInst);
        if (fwSorted.length > 0 && payload.tank_fw  == null) payload.tank_fw  = fwSorted[0][1];

        const dslSorted = sortEntries(_tankDSLByInst);
        if (dslSorted.length > 0 && payload.tank_dsl == null) payload.tank_dsl = dslSorted[0][1];

        const bwSorted = sortEntries(_tankBWByInst);
        if (bwSorted.length > 0 && payload.tank_bwm == null) payload.tank_bwm = bwSorted[0][1];
        if (bwSorted.length > 1 && payload.tank_bwg == null) payload.tank_bwg = bwSorted[1][1];

        // ── Nothing to send ────────────────────────────────────────────────────
        if (Object.keys(payload).length === 0) return;

        try {
          // Attach vessel metadata (mmsi/callsign) to the first batch only
          const body = { api_key, data: payload };
          if (_vesselMeta) { body.vessel_meta = _vesselMeta; _vesselMeta = null; }

          const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            app.debug(`Ingest error ${res.status}: ${text}`);
            if (res.status === 401) {
              app.setPluginError('Invalid API key — check SUKI Dashboard → Settings → SignalK Bridge');
            }
            // Mark as offline for log buffering
            _online = false;
          } else {
            app.debug(`Sent ${Object.keys(payload).length} fields`);
            // Was offline → flush buffer now that we're back online
            if (!_online) {
              _online = true;
              flushLogBuffer().catch(e => app.debug(`Buffer flush error: ${e.message}`));
            }
          }
        } catch (e) {
          // Only true network errors (no route, connection refused, timeout) trigger
          // offline mode. Server errors (4xx/5xx) are handled above.
          const msg = e.message ?? '';
          const isNetworkError = (
            e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' ||
            e.code === 'ETIMEDOUT'    || e.code === 'ECONNRESET' ||
            msg.includes('fetch failed') || msg.includes('network') ||
            e.name === 'TypeError'    || e.name === 'AbortError'
          );
          if (isNetworkError) {
            _online = false;
            app.debug(`Offline (network error): ${msg}`);
          } else {
            app.debug(`Push error: ${msg}`);
          }
        }
      }, interval_ms);

      // ── Offline log snapshot timer (every 120 s) ──────────────────────────
      // Captures current telemetry as a log entry snapshot. When offline,
      // snapshots are written to a persistent JSONL file in the SignalK plugin
      // data directory (app.getDataDirPath()) — survives reboots on all platforms.
      const LOG_INTERVAL_MS   = 120_000;
      const MAX_BUFFER_ENTRIES = 1440; // 48 hours at 120s intervals

      // app.getDataDirPath() is the SignalK-standard persistent plugin directory.
      // Victron Cerbo: /data/home/root/.signalk/plugin-config-data/suki-bridge/
      // Raspberry Pi: ~/.signalk/plugin-config-data/suki-bridge/
      // All platforms: survives reboots, unlike /tmp/
      const DATA_DIR        = app.getDataDirPath();
      const LOG_BUFFER_FILE = path.join(DATA_DIR, 'log-buffer.jsonl');

      // Ensure the data directory exists (SignalK usually creates it, but be safe)
      try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

      let _online         = true;   // tracks connectivity state
      let _flushInProgress = false; // prevent concurrent flush calls
      let _lastLogPos     = null;   // [lat, lon] of last logged position

      // Calculate distance in nm between two [lat,lon] pairs
      function _distNm (a, b) {
        if (!a || !b) return null;
        const R = 3440.065;
        const dLat = (b[0] - a[0]) * Math.PI / 180;
        const dLon = (b[1] - a[1]) * Math.PI / 180;
        const s = Math.sin(dLat/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
      }

      // True wind calculation from AWS/AWA/SOG/COG-HDG (same as browser logbook)
      function _calcTrueWind (aws, awa, sog, hdg, cog) {
        if (aws == null || awa == null || sog == null) return { tws: null, twa: null };
        const leeway = (cog != null && hdg != null) ? cog - hdg : 0;
        const boatX = sog * Math.cos(leeway);
        const boatY = sog * Math.sin(leeway);
        const twX = aws * Math.cos(awa) - boatX;
        const twY = aws * Math.sin(awa) - boatY;
        return { tws: Math.sqrt(twX*twX + twY*twY), twa: Math.atan2(twY, twX) };
      }

      function buildLogSnapshot () {
        const lat   = pending.nav_lat   ?? null;
        const lon   = pending.nav_lon   ?? null;
        const sog   = pending.nav_sog_ms != null ? pending.nav_sog_ms * 1.94384 : null;
        const hdg   = pending.nav_hdg_rad ?? null;
        const cog   = pending.nav_cog_rad ?? null;
        const aws   = pending.env_aws_ms  ?? null;
        const awa   = pending.env_awa_rad ?? null;
        const tws_s = pending.env_tws_ms  ?? null;
        const twa_s = pending.env_twa_rad ?? null;
        const { tws: twsCalc, twa: twaCalc } = _calcTrueWind(aws, awa, pending.nav_sog_ms, hdg, cog);

        const pos = (lat != null && lon != null) ? [lat, lon] : null;
        const distNm = _distNm(_lastLogPos, pos);
        if (pos) _lastLogPos = pos;

        return {
          logged_at:  new Date().toISOString(),
          lat, lon,
          sog_kn: sog != null ? +sog.toFixed(2) : null,
          cog_deg: cog != null ? +(cog * 180 / Math.PI).toFixed(1) : null,
          tws_kn: tws_s != null ? +(tws_s * 1.94384).toFixed(1) : (twsCalc != null ? +(twsCalc * 1.94384).toFixed(1) : null),
          twd_deg: (hdg != null && twa_s != null) ? +((((hdg + twa_s) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1)
                 : (hdg != null && twaCalc != null) ? +((((hdg + twaCalc) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1) : null,
          aws_kn: aws != null ? +(aws * 1.94384).toFixed(1) : null,
          awa_deg: awa != null ? +(awa * 180 / Math.PI).toFixed(1) : null,
          baro_hpa: pending.env_pressure_pa != null ? +(pending.env_pressure_pa / 100).toFixed(1) : null,
          depth_m:  pending.env_depth_m != null ? +pending.env_depth_m.toFixed(1) : null,
          batt_soc: pending.batt_main_soc ?? null,
          engine_on:  (pending.eng_rpm ?? 0) > 0,
          engine_rpm: pending.eng_rpm ?? null,
          engine_temp_c: pending.eng_temp_k != null ? +(pending.eng_temp_k - 273.15).toFixed(1) : null,
          engine_hours: pending.eng_run_sec != null ? +(pending.eng_run_sec / 3600).toFixed(2) : null,
          engine_sb_on:  (pending.eng_sb_rpm ?? 0) > 0,
          engine_sb_rpm: pending.eng_sb_rpm ?? null,
          engine_sb_temp_c: pending.eng_sb_temp_k != null ? +(pending.eng_sb_temp_k - 273.15).toFixed(1) : null,
          engine_sb_hours: pending.eng_sb_run_sec != null ? +(pending.eng_sb_run_sec / 3600).toFixed(2) : null,
          distance_nm: distNm != null ? +distNm.toFixed(3) : null,
        };
      }

      async function flushLogBuffer () {
        if (_flushInProgress) return;  // prevent concurrent calls
        if (!fs.existsSync(LOG_BUFFER_FILE)) return;
        _flushInProgress = true;
        const lines = fs.readFileSync(LOG_BUFFER_FILE, 'utf8').split('\n').filter(Boolean);
        if (!lines.length) return;
        app.debug(`Flushing ${lines.length} buffered log snapshots`);
        try {
          const entries = lines.map(l => JSON.parse(l));
          const res = await fetch(logUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key, entries }),
          });
          if (res.ok) {
            const result = await res.json().catch(() => ({}));
            app.debug(`Buffer flush: inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors}`);
            fs.writeFileSync(LOG_BUFFER_FILE, ''); // clear buffer
          } else {
            app.debug(`Buffer flush failed: ${res.status}`);
          }
        } catch (e) {
          app.debug(`Buffer flush network error: ${e.message}`);
        } finally {
          _flushInProgress = false;
        }
      }

      logTimer = setInterval(() => {
        const snap = buildLogSnapshot();
        if (_online) {
          // Online: try to flush existing buffer first, then send directly
          flushLogBuffer().catch(() => {});
          // (The ingest-log-entries call handles the snapshot retroactively
          //  when the browser auto-log may have missed entries)
        } else {
          // Offline: append snapshot to local JSONL buffer
          try {
            const existing = fs.existsSync(LOG_BUFFER_FILE)
              ? fs.readFileSync(LOG_BUFFER_FILE, 'utf8').split('\n').filter(Boolean)
              : [];
            // Trim to max entries (ring buffer — drop oldest)
            const trimmed = existing.slice(-MAX_BUFFER_ENTRIES + 1);
            trimmed.push(JSON.stringify(snap));
            fs.writeFileSync(LOG_BUFFER_FILE, trimmed.join('\n') + '\n');
            app.debug(`Buffered log snapshot (${trimmed.length} total)`);
          } catch (e) {
            app.debug(`Buffer write error: ${e.message}`);
          }
        }
      }, LOG_INTERVAL_MS);

      // Flush any buffer left over from a previous offline period.
      // Wait 10s for SignalK to fully connect before attempting.
      setTimeout(() => {
        flushLogBuffer().catch(e => app.debug(`Startup flush: ${e.message}`));
      }, 10_000);

      app.setPluginStatus(`Connected — sending every ${interval_ms / 1000}s`);
    },

    stop () {
      if (sendTimer)        { clearInterval(sendTimer);       sendTimer        = null; }
      if (logTimer)         { clearInterval(logTimer);        logTimer         = null; }
      if (discoveryTimer)   { clearTimeout(discoveryTimer);   discoveryTimer   = null; }
      if (rediscoveryTimer) { clearTimeout(rediscoveryTimer); rediscoveryTimer = null; }

      unsubscribes.forEach(u => { try { u(); } catch (_) {} });
      unsubscribes = [];
      pending      = {};
      pendingStr   = {};

      // Clear dynamic accumulators so they don't bleed into the next start() call
      _solarPowerByInst      = {};
      _solarCurrentByInst    = {};
      _solarYieldTodayByInst = {};
      _solarYieldYestByInst  = {};
      _tankFWByInst          = {};
      _tankDSLByInst         = {};
      _tankBWByInst          = {};
      _discoveredPaths       = new Set();
      _battSocVenusSeen      = {};
      _battSocVenusLast      = {};
      _battDiscoveredCols    = {};

      app.setPluginStatus('Stopped');
    },
  };

  return plugin;
};
