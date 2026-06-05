/**
 * public-boat-tracker
 *
 * Public (no-auth) endpoint that returns sanitised tracking data for a boat.
 * Only serves boats that have tracking_enabled = true.
 *
 * GET ?slug=sv-suki
 *   → { boat, telemetry, track, trip, weather }
 *
 * Intentionally excludes: credentials, alarm state, relay state, VRM tokens.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Cache-Control':                'public, max-age=20',   // 20 s browser cache
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url  = new URL(req.url);
  const slug = url.searchParams.get('slug')?.toLowerCase().trim();
  if (!slug) return json({ error: 'slug required' }, 400);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Resolve boat ──────────────────────────────────────────────────────────
  const { data: boat } = await supabase
    .from('boats')
    .select('id, name, tracking_slug, tracking_enabled, engine_count, tracking_password_hash')
    .eq('tracking_slug', slug)
    .single();

  if (!boat || !boat.tracking_enabled) {
    return json({ error: 'Tracking not found or not enabled for this boat.' }, 404);
  }

  const boatId = boat.id as string;

  // ── Password check ────────────────────────────────────────────────────────
  // If a password hash is stored, the caller must provide the correct password.
  // Password is SHA-256 hashed client-side before sending (never plaintext in transit).
  if (boat.tracking_password_hash) {
    const provided = url.searchParams.get('pw');
    if (!provided) {
      // No password supplied → tell client to show the password form
      return json({ password_required: true }, 401);
    }
    // Hash what was provided and compare
    const enc     = new TextEncoder().encode(provided);
    const hashBuf = await crypto.subtle.digest('SHA-256', enc);
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (hashHex !== boat.tracking_password_hash) {
      return json({ password_required: true, wrong_password: true }, 401);
    }
    // Correct password — no cache for password-protected pages
    CORS['Cache-Control'] = 'no-store';
  }

  // ── Fetch all data in parallel ────────────────────────────────────────────
  const [telRes, trackRes, tripRes] = await Promise.all([

    // Live telemetry snapshot (everything except credentials)
    supabase.from('telemetry').select(
      'nav_lat, nav_lon, nav_hdg_rad, nav_cog_rad, nav_sog_ms, nav_stw_ms,' +
      'env_aws_ms, env_awa_rad, env_tws_ms, env_twa_rad, env_pressure_pa, env_depth_m,' +
      'batt_main_soc, batt_main_v, batt_main_a,' +
      'eng_rpm, eng_run_sec, eng_temp_k,' +
      'eng_sb_rpm, eng_sb_run_sec, eng_sb_temp_k,' +
      'solar_total_w, solar_yield_today_j,' +
      'tank_fw, tank_dsl,' +
      'ws_0_alt_v, ws_0_mode, ws_1_alt_v, ws_1_mode,' +
      'updated_at'
    ).eq('boat_id', boatId).single(),

    // GPS track — all log_entries with positions, last 7 days, max 1000 pts
    supabase.from('log_entries').select(
      'lat, lon, logged_at, sog_kn, wind_speed_kn, wind_dir_deg, engine_on, batt_soc'
    )
      .eq('boat_id', boatId)
      .not('lat', 'is', null)
      .not('lon', 'is', null)
      .gte('logged_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
      .order('logged_at', { ascending: true })
      .limit(1000),

    // Active trip (if any)
    supabase.from('log_trips').select(
      'id, name, started_at, from_port, total_nm, sail_nm, motor_nm, avg_sog_kn, max_sog_kn'
    ).eq('boat_id', boatId).is('ended_at', null).maybeSingle(),
  ]);

  const telemetry = telRes.data ?? null;
  const track     = trackRes.data ?? [];
  const trip      = tripRes.data ?? null;

  // ── Derive true wind if not directly available ────────────────────────────
  let tws_kn: number | null = null;
  let twd_deg: number | null = null;

  if (telemetry) {
    const { env_tws_ms, env_twa_rad, env_aws_ms, env_awa_rad,
            nav_sog_ms, nav_hdg_rad, nav_cog_rad } = telemetry as Record<string, number | null>;

    if (env_tws_ms != null) {
      tws_kn = +(env_tws_ms * 1.94384).toFixed(1);
    } else if (env_aws_ms != null && env_awa_rad != null && nav_sog_ms != null) {
      const hdg    = nav_hdg_rad ?? 0;
      const cog    = nav_cog_rad ?? hdg;
      const leeway = cog - hdg;
      const bx = nav_sog_ms * Math.cos(leeway);
      const by = nav_sog_ms * Math.sin(leeway);
      const twX = env_aws_ms * Math.cos(env_awa_rad) - bx;
      const twY = env_aws_ms * Math.sin(env_awa_rad) - by;
      tws_kn = +(Math.sqrt(twX * twX + twY * twY) * 1.94384).toFixed(1);
      const twaRad = Math.atan2(twY, twX);
      if (nav_hdg_rad != null) {
        twd_deg = +((((nav_hdg_rad + twaRad) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1);
      }
    }

    if (twd_deg == null && nav_hdg_rad != null && env_twa_rad != null) {
      twd_deg = +((((nav_hdg_rad + env_twa_rad) * 180 / Math.PI) % 360 + 360) % 360).toFixed(1);
    }
  }

  return json({
    boat: {
      name:         boat.name,
      slug:         boat.tracking_slug,
      engine_count: boat.engine_count,
    },
    telemetry,
    derived: { tws_kn, twd_deg },
    track,
    trip,
    generated_at: new Date().toISOString(),
  });
});
