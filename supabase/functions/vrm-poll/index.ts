/**
 * vrm-poll — Supabase Edge Function
 *
 * Called every minute via pg_cron + pg_net.
 * For each boat in anchor_config that has VRM credentials, fetches the
 * VRM diagnostics API and upserts Cerbo-exclusive telemetry columns:
 *   • Per-MPPT panel power (solar_p277 … solar_p292)
 *   • Solar totals & yield (solar_total_w, solar_total_a, solar_yield_today_j, solar_yield_yesterday_j)
 *   • Inverter (inv_ac_v, inv_ac_hz, inv_ac_w, inv_dc_w, inv_mode)
 *   • Temperatures (temp_salon … temp_water)
 *   • Humidity (hum_salon … hum_amabb)
 *
 * These columns were previously written by server.py on the Cerbo GX.
 * Standard NMEA / SignalK data (GPS, batteries, depth, wind, engine …) continues
 * to flow via the signalk-plugin-suki-bridge.
 *
 * Instance numbers (277–292, 276, 20–29) are SUKI-specific Victron device IDs.
 * Other boats will simply leave those columns null — no error.
 *
 * No bearer auth — called only by pg_cron (Supabase-internal infrastructure).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── VRM diagnostics record type ───────────────────────────────────────────────
type DiagRecord = {
  instance: number;
  code: string;
  dbusPath: string;
  rawValue: number | null;
  description?: string;
};

// ── Per-MPPT panel power: code PPV, instances → columns ──────────────────────
const MPPT_INSTANCES: Record<number, string> = {
  277: 'solar_p277',
  279: 'solar_p279',
  289: 'solar_p289',
  290: 'solar_p290',
  292: 'solar_p292',
};

// ── Temperature sensors: code Te, instances → columns ────────────────────────
const TEMP_INSTANCES: Record<number, string> = {
  20: 'temp_salon',
  21: 'temp_fridge',
  22: 'temp_tech',
  23: 'temp_amasb',
  29: 'temp_amabb',
};

// ── Humidity sensors: code Hu, same instance numbers ─────────────────────────
const HUM_INSTANCES: Record<number, string> = {
  20: 'hum_salon',
  21: 'hum_fridge',
  22: 'hum_tech',
  23: 'hum_amasb',
  29: 'hum_amabb',
};

// ── Inverter instance ─────────────────────────────────────────────────────────
const INVERTER_INSTANCE = 276;

// ── Map one boat's VRM diagnostics to telemetry columns ──────────────────────
function mapDiagToTelemetry(
  records: DiagRecord[],
  boatId: string
): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const payload: Record<string, any> = { boat_id: boatId };

  let solarTotalW = 0;
  let solarTotalA = 0;
  let yieldTodayWh = 0;
  let yieldYesterdayWh = 0;
  let hasSolar = false;

  for (const r of records) {
    const v = r.rawValue;
    if (v == null) continue;

    // ── Solar MPPTs ───────────────────────────────────────────────────────────
    if (r.code === 'PPV') {
      const col = MPPT_INSTANCES[r.instance];
      if (col) payload[col] = v;
      solarTotalW += v;
      hasSolar = true;
    }
    if (r.code === 'IL' && MPPT_INSTANCES[r.instance] != null) {
      // IL = charger current (A) per MPPT — sum for total
      solarTotalA += v;
    }
    if (r.code === 'H20' && MPPT_INSTANCES[r.instance] != null) {
      // H20 = yield today in kWh (Victron uses 0.01 kWh resolution → multiply ×10 for Wh)
      // Note: rawValue for H20 is in kWh from the diagnostics API
      yieldTodayWh += v * 1000; // kWh → Wh
      hasSolar = true;
    }
    if (r.code === 'H22' && MPPT_INSTANCES[r.instance] != null) {
      // H22 = yield yesterday in kWh
      yieldYesterdayWh += v * 1000; // kWh → Wh
    }

    // ── Temperatures ─────────────────────────────────────────────────────────
    if (r.code === 'Te') {
      const col = TEMP_INSTANCES[r.instance];
      if (col) payload[col] = v;
      // Water temp sensor may appear under a different instance — match by dbusPath
      if (!col && r.dbusPath?.includes('/Temperature') && r.dbusPath?.includes('water')) {
        payload['temp_water'] = v;
      }
    }

    // ── Humidity ─────────────────────────────────────────────────────────────
    if (r.code === 'Hu') {
      const col = HUM_INSTANCES[r.instance];
      if (col) payload[col] = v;
    }

    // ── Inverter ─────────────────────────────────────────────────────────────
    if (r.instance === INVERTER_INSTANCE) {
      if (r.dbusPath === '/Ac/Out/V')    payload['inv_ac_v']  = v;
      if (r.dbusPath === '/Ac/Out/F')    payload['inv_ac_hz'] = v;
      if (r.dbusPath === '/Ac/Out/P')    payload['inv_ac_w']  = v;
      if (r.dbusPath === '/Dc/0/Power')  payload['inv_dc_w']  = v;
      if (r.dbusPath === '/Mode')        payload['inv_mode']  = v;
      // Alternative paths used by some firmware versions:
      if (r.code === 'AC_INPUT_V')       payload['inv_ac_v']  ??= v;
      if (r.code === 'AC_OUTPUT_P')      payload['inv_ac_w']  ??= v;
    }

    // ── GPS position (used as fallback when SignalK is offline) ──────────────
    if (r.dbusPath === '/Position/Latitude')  payload['vrm_gps_lat'] = v;
    if (r.dbusPath === '/Position/Longitude') payload['vrm_gps_lon'] = v;
  }

  // Stamp the VRM GPS timestamp only when we got a valid fix
  if (payload['vrm_gps_lat'] != null && payload['vrm_gps_lon'] != null) {
    payload['vrm_gps_at'] = new Date().toISOString();
  }

  if (hasSolar) {
    payload['solar_total_w']          = solarTotalW || null;
    payload['solar_total_a']          = solarTotalA || null;
    payload['solar_yield_today_j']    = yieldTodayWh ? Math.round(yieldTodayWh * 3600) : null;
    payload['solar_yield_yesterday_j']= yieldYesterdayWh ? Math.round(yieldYesterdayWh * 3600) : null;
  }

  return payload;
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Load all boats that have VRM credentials configured
  const { data: configs, error: cfgErr } = await supabase
    .from('anchor_config')
    .select('boat_id, vrm_api_token, vrm_installation_id')
    .not('vrm_api_token', 'is', null)
    .not('vrm_installation_id', 'is', null)
    .not('boat_id', 'is', null);

  if (cfgErr) {
    console.error('[vrm-poll] config load error', cfgErr.message);
    return json({ error: cfgErr.message }, 500);
  }

  const results: { boat_id: string; status: string; columns?: number }[] = [];
  console.log(`[vrm-poll] polling VRM for ${configs?.length ?? 0} boats`);

  for (const cfg of configs ?? []) {
    const boatId: string = cfg.boat_id;
    const token: string  = cfg.vrm_api_token;
    const installId: number = cfg.vrm_installation_id;

    try {
      const url = `https://vrmapi.victronenergy.com/v2/installations/${installId}/diagnostics?count=1000`;
      const res = await fetch(url, {
        headers: { 'X-Authorization': `Token ${token}` },
      });

      if (!res.ok) {
        console.error(`[vrm-poll] ${boatId}: VRM HTTP ${res.status}`);
        results.push({ boat_id: boatId, status: `vrm_error_${res.status}` });
        continue;
      }

      const data = await res.json();
      const records: DiagRecord[] = data?.records ?? [];
      console.log(`[vrm-poll] ${boatId}: got ${records.length} records`);

      if (records.length === 0) {
        results.push({ boat_id: boatId, status: 'no_records' });
        continue;
      }

      const payload = mapDiagToTelemetry(records, boatId);
      const columnCount = Object.keys(payload).length - 1; // subtract boat_id

      const { error: upsertErr } = await supabase
        .from('telemetry')
        .upsert(payload, { onConflict: 'boat_id' });

      if (upsertErr) {
        console.error(`[vrm-poll] ${boatId}: upsert error`, upsertErr.message);
        results.push({ boat_id: boatId, status: 'upsert_error' });
        continue;
      }

      console.log(`[vrm-poll] ${boatId}: upserted ${columnCount} columns`);
      results.push({ boat_id: boatId, status: 'ok', columns: columnCount });

    } catch (e) {
      console.error(`[vrm-poll] ${boatId}: unexpected error`, e);
      results.push({ boat_id: boatId, status: 'error' });
    }
  }

  return json({ polled: results.length, results });
});
