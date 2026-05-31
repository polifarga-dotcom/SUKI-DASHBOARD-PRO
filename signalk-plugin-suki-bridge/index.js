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
 */

'use strict';

module.exports = function (app) {
  let sendTimer = null;
  let pending   = {};
  let unsubscribes = [];

  // ── SignalK path → telemetry column mapping ─────────────────────────────────
  // Standard paths work across any NMEA-connected SignalK server.
  // Victron-specific paths may need adjustment based on the VRM installation.
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
    // Adjust these if your VRM uses different instance numbers.
    'electrical.batteries.0.capacity.stateOfCharge':         'batt_main_soc',
    'electrical.batteries.0.voltage':                        'batt_main_v',
    'electrical.batteries.0.current':                        'batt_main_a',
    'electrical.batteries.0.power':                          'batt_main_w',
    'electrical.batteries.1.capacity.stateOfCharge':         'batt_eng_soc',
    'electrical.batteries.1.voltage':                        'batt_eng_v',
    'electrical.batteries.1.current':                        'batt_eng_a',

    // Propulsion / Engine (standard + Victron)
    'propulsion.main.revolutions':                           'eng_rpm',
    'propulsion.main.runTime':                               'eng_run_sec',
    'propulsion.main.temperature':                           'eng_temp_k',
    'propulsion.main.alternatorVoltage':                     'eng_alt_v',

    // Tanks (standard SignalK fill ratio 0.0–1.0)
    'tanks.freshWater.0.currentLevel':                       'tank_fw',
    'tanks.diesel.0.currentLevel':                           'tank_dsl',
    'tanks.blackWater.0.currentLevel':                       'tank_bwm',
    'tanks.blackWater.1.currentLevel':                       'tank_bwg',

    // Solar — Victron SignalK plugin exposes individual MPPTs as chargers.
    // We track total panel power; individual MPPT columns are VRM-specific.
    'electrical.chargers.0.panelPower':                      'solar_total_w',

    // Rudder
    'steering.rudderAngle':                                  'rudder_rad',
  };

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

      // ── Subscribe to mapped paths ─────────────────────────────────────────
      const paths = Object.keys(PATH_MAP);
      unsubscribes = paths.map(path => {
        try {
          return app.streambundle.getSelfBus(path).onValue(({ value }) => {
            const col = PATH_MAP[path];
            if (col && value != null && typeof value === 'number' && isFinite(value)) {
              // Special case: heading.Magnetic is a lower-priority fallback.
              // Only write it if the True heading hasn't been seen.
              if (path === 'navigation.headingMagnetic' && pending['nav_hdg_rad'] != null) return;
              // Same for depth fallback
              if (path === 'environment.depth.belowTransducer' && pending['env_depth_m'] != null) return;
              pending[col] = value;
            }
          });
        } catch (e) {
          app.debug(`Could not subscribe to ${path}: ${e.message}`);
          return () => {};
        }
      });

      // ── Batch sender ─────────────────────────────────────────────────────
      sendTimer = setInterval(async () => {
        if (Object.keys(pending).length === 0) return;

        const payload = { ...pending };
        pending = {};

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
      if (sendTimer) {
        clearInterval(sendTimer);
        sendTimer = null;
      }
      unsubscribes.forEach(u => { try { u(); } catch (_) {} });
      unsubscribes = [];
      pending = {};
      app.setPluginStatus('Stopped');
    },
  };

  return plugin;
};
