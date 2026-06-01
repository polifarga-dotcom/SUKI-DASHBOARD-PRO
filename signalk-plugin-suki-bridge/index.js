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
 * v1.0.6 — Persistent Venus-source lock for battery SOC
 *   Solar MPPTs and tanks use non-zero instance IDs that vary per installation.
 *   This version adds a dynamic discovery pass (at 5 s and 60 s after start) that
 *   enumerates all available electrical.solar / electrical.chargers and tanks.*
 *   paths via app.streambundle.getAvailablePaths() and subscribes to each.
 *   Solar values across all discovered instances are summed; tank values use the
 *   lowest instance ID as the primary tank. Static PATH_MAP entries for well-known
 *   instance IDs (e.g. Victron default instance 0) are kept as fast-path fallbacks.
 */

'use strict';

module.exports = function (app) {
  let sendTimer        = null;
  let pending          = {};
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
  let _battSocVenusSeen = {};  // col → boolean: Venus/Victron source seen at least once (persists)
  let _battSocVenusLast = {};  // col → number:  last value from a Venus source (persists)

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
    'navigation.speedThroughWater':                          'nav_stw_ms',

    // Environment (standard)
    'environment.depth.belowKeel':                           'env_depth_m',
    'environment.depth.belowTransducer':                     'env_depth_m',   // fallback
    'environment.wind.angleApparent':                        'env_awa_rad',
    'environment.wind.speedApparent':                        'env_aws_ms',
    'environment.wind.angleTrueWater':                       'env_twa_rad',
    'environment.wind.speedTrue':                            'env_tws_ms',
    'environment.outside.pressure':                          'env_pressure_pa',

    // Batteries — Victron SignalK plugin uses integer instance IDs.
    // Instance 0 = house bank (main), instance 1 = engine/starter.
    'electrical.batteries.0.capacity.stateOfCharge':         'batt_main_soc',
    'electrical.batteries.0.voltage':                        'batt_main_v',
    'electrical.batteries.0.current':                        'batt_main_a',
    'electrical.batteries.0.power':                          'batt_main_w',
    'electrical.batteries.1.capacity.stateOfCharge':         'batt_eng_soc',
    'electrical.batteries.1.voltage':                        'batt_eng_v',
    'electrical.batteries.1.current':                        'batt_eng_a',

    // Propulsion / Engine
    // SignalK value for `revolutions` is in Hz (rev/sec); the TRANSFORMS map below
    // converts it to RPM (×60) before storing in the `eng_rpm` column.
    // The Victron/Cerbo SignalK plugin may expose the engine as propulsion.main.*
    // or propulsion.port.* depending on installation. Both are mapped; port paths
    // are lower-priority fallbacks (won't overwrite a main.* value received in the
    // same batch cycle).
    'propulsion.main.revolutions':                           'eng_rpm',
    'propulsion.port.revolutions':                           'eng_rpm',       // fallback
    'propulsion.main.runTime':                               'eng_run_sec',
    'propulsion.port.runTime':                               'eng_run_sec',   // fallback
    'propulsion.main.temperature':                           'eng_temp_k',
    'propulsion.port.temperature':                           'eng_temp_k',    // fallback
    'propulsion.main.alternatorVoltage':                     'eng_alt_v',
    'propulsion.port.alternatorVoltage':                     'eng_alt_v',     // fallback

    // Tanks — instance 0 fast path (Victron default). Boats using other instance
    // IDs are handled by dynamic discovery (subscribed at 5 s / 60 s after start).
    'tanks.freshWater.0.currentLevel':                       'tank_fw',
    'tanks.diesel.0.currentLevel':                           'tank_dsl',
    'tanks.blackWater.0.currentLevel':                       'tank_bwm',
    'tanks.blackWater.1.currentLevel':                       'tank_bwg',

    // Solar — instance 0 fast path. Additional MPPT instances (electrical.solar.N.*)
    // and charger instances are discovered and summed dynamically.
    'electrical.chargers.0.panelPower':                      'solar_total_w',

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

      // ── Battery SOC (discover additional instances beyond 0 and 1) ───────
      // Victron systems often use high VRM device IDs (e.g. instance 278 for
      // BMV-712) rather than instance 0. The real BMV is typically sourced from
      // venus.com.victronenergy.battery.* while instance 0 mixes in N2K charger
      // sources that report 1.0. Subscribing to the high-ID instance lets the
      // source-priority filter above prefer it over the N2K charger value.
      // Instance 1 is excluded (handled by static PATH_MAP as engine battery).
      if ((m = path.match(/^electrical\.batteries\.(\w+)\.capacity\.stateOfCharge$/))) {
        const [, inst] = m;
        if (inst === '0' || inst === '1') continue; // already in static PATH_MAP
        try {
          const unsub = app.streambundle.getSelfBus(path).onValue(({ value, source }) => {
            if (typeof value !== 'number' || !isFinite(value)) return;
            const col = 'batt_main_soc';
            const src = typeof source === 'string' ? source
              : (source?.label ?? source?.name ?? source?.$source ?? String(source ?? ''));
            const isVictron = src.includes('victronenergy');

            if (isVictron) {
              _battSocVenusSeen[col] = true;
              _battSocVenusLast[col] = value;
              pending[col] = value;
            } else if (_battSocVenusSeen[col]) {
              return; // Venus seen before → ignore N2K
            } else {
              if (pending[col] != null) return;
              pending[col] = value;
            }
          });
          unsubscribes.push(unsub);
          _discoveredPaths.add(path);
          newCount++;
        } catch (e) {
          app.debug(`Discovery: could not subscribe to ${path}: ${e.message}`);
        }
        continue;
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
        endpoint: {
          type:        'string',
          title:       'Ingest URL',
          description: 'From SUKI Dashboard → Settings → SignalK Bridge → Copy (pre-filled)',
          default:     'https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/signalk-ingest',
        },
        interval_ms: {
          type:        'number',
          title:       'Send interval (ms)',
          description: 'How often to push data to the dashboard. Default 5000 ms = 5 seconds.',
          default:     5000,
        },
      },
    },

    start (config) {
      const { api_key, endpoint, interval_ms = 5000 } = config || {};
      const url = endpoint || 'https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/signalk-ingest';

      if (!api_key) {
        app.setPluginError('API key not configured — go to SUKI Dashboard → Settings → SignalK Bridge');
        return;
      }

      app.debug(`Starting — endpoint: ${url}, interval: ${interval_ms}ms`);

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
              // Robustly extract source label whether it's a string or an object
              // (SignalK server version and transport can affect the format).
              const src = typeof source === 'string' ? source
                : (source?.label ?? source?.name ?? source?.$source ?? String(source ?? ''));
              const isVictron = src.includes('victronenergy');

              if (isVictron) {
                // Venus/BMV source → always accept, remember for future cycles
                _battSocVenusSeen[col] = true;
                _battSocVenusLast[col] = value;
                pending[col] = value;
              } else if (_battSocVenusSeen[col]) {
                // Venus source has been seen before → permanently ignore all N2K values
                return;
              } else {
                // Non-Victron boat (pure N2K): first value in cycle wins
                if (pending[col] != null) return;
                pending[col] = value;
              }
              return; // skip the generic pending[col] = transformed assignment below
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

      // ── Dynamic path discovery ───────────────────────────────────────────────
      // Wait 5 s for SignalK data to start flowing (devices take time to connect),
      // then scan for solar MPPT and tank paths with non-standard instance IDs.
      // Re-scan at 60 s to pick up any devices that come online later.
      discoveryTimer   = setTimeout(discoverDynamicPaths,  5000);
      rediscoveryTimer = setTimeout(discoverDynamicPaths, 60000);

      // ── Batch sender ─────────────────────────────────────────────────────────
      sendTimer = setInterval(async () => {
        // Copy pending (from static subscriptions) and reset for next cycle
        const payload = { ...pending };
        pending = {};
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
          const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ api_key, data: payload }),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            app.debug(`Ingest error ${res.status}: ${text}`);
            if (res.status === 401) {
              app.setPluginError('Invalid API key — check SUKI Dashboard → Settings → SignalK Bridge');
            }
          } else {
            app.debug(`Sent ${Object.keys(payload).length} fields`);
          }
        } catch (e) {
          app.debug(`Network error: ${e.message}`);
        }
      }, interval_ms);

      app.setPluginStatus(`Connected — sending every ${interval_ms / 1000}s`);
    },

    stop () {
      if (sendTimer)        { clearInterval(sendTimer);       sendTimer        = null; }
      if (discoveryTimer)   { clearTimeout(discoveryTimer);   discoveryTimer   = null; }
      if (rediscoveryTimer) { clearTimeout(rediscoveryTimer); rediscoveryTimer = null; }

      unsubscribes.forEach(u => { try { u(); } catch (_) {} });
      unsubscribes = [];
      pending      = {};

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

      app.setPluginStatus('Stopped');
    },
  };

  return plugin;
};
