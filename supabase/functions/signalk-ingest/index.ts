/**
 * signalk-ingest — Supabase Edge Function
 *
 * Server-to-server endpoint for the signalk-plugin-suki-bridge SignalK plugin.
 * Accepts batched NMEA telemetry data, validates the api_key, resolves the
 * boat_id, and upserts the telemetry row for that boat.
 *
 * POST { api_key: string, data: { nav_lat: number, ... } }
 *   → { ok: true, fields: N }
 *
 * No user JWT required — the plugin runs server-side and authenticates via
 * the plugin_api_key stored in anchor_config.
 *
 * GPS fallback: if the plugin payload is missing nav_lat/nav_lon (e.g. Victron
 * Venus OS GPS not yet handled by plugin version) and the boat has VRM
 * credentials configured, GPS is fetched directly from the VRM diagnostics API.
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

// Whitelist of telemetry columns the plugin is allowed to write.
// Prevents injection of arbitrary columns (e.g. shelly states, server health flags).
const ALLOWED_COLUMNS = new Set([
  // Navigation
  'nav_lat', 'nav_lon', 'nav_hdg_rad', 'nav_cog_rad', 'nav_sog_ms', 'nav_stw_ms',
  // Environment
  'env_depth_m', 'env_aws_ms', 'env_awa_rad', 'env_tws_ms', 'env_twa_rad', 'env_pressure_pa',
  // Battery
  'batt_main_soc', 'batt_main_v', 'batt_main_a', 'batt_main_w',
  'batt_eng_soc', 'batt_eng_v', 'batt_eng_a',
  // Engine — port / primary
  'eng_rpm', 'eng_run_sec', 'eng_temp_k', 'eng_alt_v',
  // Engine — starboard / secondary (catamaran twin-engine)
  'eng_sb_rpm', 'eng_sb_run_sec', 'eng_sb_temp_k', 'eng_sb_alt_v',
  // Tanks
  'tank_fw', 'tank_dsl', 'tank_bwm', 'tank_bwg',
  // Solar (generic total — individual MPPT columns are VRM-specific)
  'solar_total_w',
  // Rudder
  'rudder_rad',
  // Wakespeed alternator regulators (up to 2 units, electrical.alternator.{0,1}.*)
  'ws_0_alt_v', 'ws_0_alt_temp_k', 'ws_0_field_pct',
  'ws_1_alt_v', 'ws_1_alt_temp_k', 'ws_1_field_pct',
]);

// Whitelist for string-valued telemetry columns (chargingMode from Wakespeed)
const ALLOWED_STRING_COLUMNS = new Set([
  'ws_0_mode', 'ws_1_mode',
]);

// ── VRM GPS fallback ──────────────────────────────────────────────────────────
// Same endpoint as log-position uses. Called only when nav_lat/nav_lon are
// absent from the plugin payload and VRM credentials are configured.
async function fetchVRMGPS(
  token: string,
  installationId: number
): Promise<{ nav_lat: number; nav_lon: number; nav_sog_ms?: number } | null> {
  try {
    const url = `https://vrmapi.victronenergy.com/v2/installations/${installationId}/diagnostics?count=1000`;
    const res = await fetch(url, {
      headers: { 'X-Authorization': `Token ${token}` },
    });
    if (!res.ok) {
      console.warn(`[signalk-ingest] VRM diagnostics ${res.status} for install ${installationId}`);
      return null;
    }
    const data = await res.json();
    const records: { dbusPath: string; rawValue: number }[] = data?.records ?? [];

    let lat: number | null = null;
    let lon: number | null = null;
    let speedMs: number | null = null;

    for (const r of records) {
      if (r.dbusPath === '/Position/Latitude'  && lat     == null) lat     = r.rawValue;
      if (r.dbusPath === '/Position/Longitude' && lon     == null) lon     = r.rawValue;
      if (r.dbusPath === '/Position/Speed'     && speedMs == null) speedMs = r.rawValue;
      if (lat != null && lon != null && speedMs != null) break;
    }

    if (lat == null || lon == null) return null;

    const result: { nav_lat: number; nav_lon: number; nav_sog_ms?: number } = {
      nav_lat: lat,
      nav_lon: lon,
    };
    if (speedMs != null && isFinite(speedMs)) result.nav_sog_ms = speedMs;
    return result;
  } catch (e) {
    console.error('[signalk-ingest] VRM GPS error:', e);
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  let body: { api_key?: unknown; data?: unknown; vessel_meta?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { api_key, data, vessel_meta } = body;

  if (typeof api_key !== 'string' || !api_key) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json({ error: 'Missing or invalid data' }, 400);
  }

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);

  // ── Resolve boat_id + VRM credentials from api_key ───────────────────────────
  // The plugin never sends boat_id directly — we derive it server-side from the
  // key to prevent cross-boat data injection. VRM creds fetched here so we can
  // use them as GPS fallback without a second DB round-trip.
  const { data: cfg } = await supabase
    .from('anchor_config')
    .select('boat_id, vrm_api_token, vrm_installation_id')
    .eq('plugin_api_key', api_key)
    .maybeSingle();

  if (!cfg?.boat_id) {
    console.warn('[signalk-ingest] invalid or missing api_key');
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── Sanitize payload: numeric columns ────────────────────────────────────
  const safe: Record<string, number> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (ALLOWED_COLUMNS.has(k) && typeof v === 'number' && isFinite(v)) {
      safe[k] = v;
    }
  }

  // ── Sanitize payload: string columns (Wakespeed chargingMode) ─────────────
  const safeStr: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (ALLOWED_STRING_COLUMNS.has(k) && typeof v === 'string' && v.length > 0 && v.length < 64) {
      safeStr[k] = v;
    }
  }

  // ── VRM GPS fallback ──────────────────────────────────────────────────────
  // If the plugin didn't supply a position (e.g. Venus OS GPS emits a compound
  // object that older plugin versions can't parse) and VRM creds are available,
  // fetch coordinates directly from the VRM diagnostics API.
  // Plugin-supplied values always take priority; VRM only fills missing fields.
  if ((safe['nav_lat'] == null || safe['nav_lon'] == null) &&
      cfg.vrm_api_token && cfg.vrm_installation_id) {
    const vrm = await fetchVRMGPS(cfg.vrm_api_token, cfg.vrm_installation_id);
    if (vrm) {
      if (safe['nav_lat']    == null) safe['nav_lat']    = vrm.nav_lat;
      if (safe['nav_lon']    == null) safe['nav_lon']    = vrm.nav_lon;
      if (safe['nav_sog_ms'] == null && vrm.nav_sog_ms != null) safe['nav_sog_ms'] = vrm.nav_sog_ms;
      console.log(`[signalk-ingest] VRM GPS fallback: ${vrm.nav_lat.toFixed(5)},${vrm.nav_lon.toFixed(5)}`);
    }
  }

  // ── Auto-populate vessel metadata (mmsi / callsign) from SignalK ─────────
  // Plugin reads these once at startup from vessels.self and sends them in
  // the first batch. Only write non-empty values; never overwrite with empty.
  if (vessel_meta && typeof vessel_meta === 'object' && !Array.isArray(vessel_meta)) {
    const meta = vessel_meta as Record<string, unknown>;
    const boatUpdate: Record<string, string> = {};
    if (typeof meta.mmsi     === 'string' && meta.mmsi.trim())     boatUpdate.mmsi     = meta.mmsi.trim();
    if (typeof meta.callsign === 'string' && meta.callsign.trim()) boatUpdate.callsign = meta.callsign.trim().toUpperCase();
    if (Object.keys(boatUpdate).length > 0) {
      await supabase.from('boats').update(boatUpdate).eq('id', cfg.boat_id);
      console.log(`[signalk-ingest] vessel meta: ${JSON.stringify(boatUpdate)}`);
    }
  }

  // Nothing to write is valid (plugin may have just sent an empty batch)
  if (Object.keys(safe).length === 0 && Object.keys(safeStr).length === 0) {
    return json({ ok: true, fields: 0 });
  }

  // ── Upsert telemetry row ──────────────────────────────────────────────────
  // onConflict:'boat_id' requires the unique index added in migration 009.
  // If no row exists for this boat yet, a new row is inserted (id from sequence).
  const { error } = await supabase
    .from('telemetry')
    .upsert(
      { boat_id: cfg.boat_id, ...safe, ...safeStr, updated_at: new Date().toISOString() },
      { onConflict: 'boat_id' }
    );

  if (error) {
    console.error('[signalk-ingest] upsert error:', error.message);
    return json({ error: error.message }, 500);
  }

  console.log(`[signalk-ingest] boat=${cfg.boat_id} fields=${Object.keys(safe).length}`);
  return json({ ok: true, fields: Object.keys(safe).length });
});
