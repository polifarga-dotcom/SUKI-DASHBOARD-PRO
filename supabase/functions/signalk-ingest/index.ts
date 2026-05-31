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
  'nav_lat', 'nav_lon', 'nav_hdg_rad', 'nav_sog_ms', 'nav_stw_ms',
  // Environment
  'env_depth_m', 'env_aws_ms', 'env_awa_rad', 'env_tws_ms', 'env_twa_rad', 'env_pressure_pa',
  // Battery
  'batt_main_soc', 'batt_main_v', 'batt_main_a', 'batt_main_w',
  'batt_eng_soc', 'batt_eng_v', 'batt_eng_a',
  // Engine
  'eng_rpm', 'eng_run_sec', 'eng_temp_k', 'eng_alt_v',
  // Tanks
  'tank_fw', 'tank_dsl', 'tank_bwm', 'tank_bwg',
  // Solar (generic total — individual MPPT columns are VRM-specific)
  'solar_total_w',
  // Rudder
  'rudder_rad',
]);

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  let body: { api_key?: unknown; data?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { api_key, data } = body;

  if (typeof api_key !== 'string' || !api_key) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json({ error: 'Missing or invalid data' }, 400);
  }

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);

  // ── Resolve boat_id from api_key ──────────────────────────────────────────
  // The plugin never sends boat_id directly — we derive it server-side from the
  // key to prevent cross-boat data injection.
  const { data: cfg } = await supabase
    .from('anchor_config')
    .select('boat_id')
    .eq('plugin_api_key', api_key)
    .maybeSingle();

  if (!cfg?.boat_id) {
    console.warn('[signalk-ingest] invalid or missing api_key');
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── Sanitize payload: only known numeric columns ──────────────────────────
  const safe: Record<string, number> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (ALLOWED_COLUMNS.has(k) && typeof v === 'number' && isFinite(v)) {
      safe[k] = v;
    }
  }

  // Nothing to write is valid (plugin may have just sent an empty batch)
  if (Object.keys(safe).length === 0) {
    return json({ ok: true, fields: 0 });
  }

  // ── Upsert telemetry row ──────────────────────────────────────────────────
  // onConflict:'boat_id' requires the unique index added in migration 009.
  // If no row exists for this boat yet, a new row is inserted (id from sequence).
  const { error } = await supabase
    .from('telemetry')
    .upsert(
      { boat_id: cfg.boat_id, ...safe, updated_at: new Date().toISOString() },
      { onConflict: 'boat_id' }
    );

  if (error) {
    console.error('[signalk-ingest] upsert error:', error.message);
    return json({ error: error.message }, 500);
  }

  console.log(`[signalk-ingest] boat=${cfg.boat_id} fields=${Object.keys(safe).length}`);
  return json({ ok: true, fields: Object.keys(safe).length });
});
