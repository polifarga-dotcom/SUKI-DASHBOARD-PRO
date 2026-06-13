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

/** Fetch the single latest InReach position (last 2 h) — minimal KML parse, fast. */
async function fetchLatestInReach(
  id: string, pw: string
): Promise<{ lat: number; lon: number; at: string } | null> {
  const d2  = new Date();
  const d1  = new Date(d2.getTime() - 2 * 3_600_000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth()+1).padStart(2,'0')}-` +
    `${String(d.getUTCDate()).padStart(2,'0')}T` +
    `${String(d.getUTCHours()).padStart(2,'0')}%3A` +
    `${String(d.getUTCMinutes()).padStart(2,'0')}%3A00Z`;

  let url = `https://share.garmin.com/Feed/Share/${encodeURIComponent(id)}?d1=${fmt(d1)}&d2=${fmt(d2)}`;
  if (pw) url += `&Password=${encodeURIComponent(pw)}`;

  const res = await fetch(url, { headers: { 'User-Agent': 'SUKI-Dashboard/1.0' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const kml  = await res.text();
  // Parse only the first Placemark (newest after Garmin sort)
  const latM = /<Data name="Latitude">\s*<value>([^<]+)<\/value>/i.exec(kml);
  const lonM = /<Data name="Longitude">\s*<value>([^<]+)<\/value>/i.exec(kml);
  const tsM  = /<TimeStamp>\s*<when>([^<]+)<\/when>/i.exec(kml);
  if (!latM || !lonM || !tsM) return null;

  const lat = parseFloat(latM[1]);
  const lon = parseFloat(lonM[1]);
  return isNaN(lat) || isNaN(lon) ? null : { lat, lon, at: tsM[1].trim() };
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
    .select('id, name, tracking_slug, tracking_enabled, engine_count, tracking_password_hash, boat_icon')
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
  const [telRes, trackRes, tripRes, cfgRes] = await Promise.all([

    // Live telemetry snapshot (everything except credentials)
    // vrm_gps_* and inreach_gps_* are GPS fallback columns written by vrm-poll and this function
    supabase.from('telemetry').select(
      'nav_lat, nav_lon, nav_hdg_rad, nav_cog_rad, nav_sog_ms, nav_stw_ms,' +
      'env_aws_ms, env_awa_rad, env_tws_ms, env_twa_rad, env_pressure_pa, env_depth_m,' +
      'batt_main_soc, batt_main_v, batt_main_a,' +
      'eng_rpm, eng_run_sec, eng_temp_k,' +
      'eng_sb_rpm, eng_sb_run_sec, eng_sb_temp_k,' +
      'solar_total_w, solar_yield_today_j,' +
      'tank_fw, tank_dsl,' +
      'ws_0_alt_v, ws_0_mode, ws_1_alt_v, ws_1_mode,' +
      'vrm_gps_lat, vrm_gps_lon, vrm_gps_at,' +
      'inreach_gps_lat, inreach_gps_lon, inreach_gps_at,' +
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

    // InReach credentials for GPS fallback caching (service role — never exposed to client)
    supabase.from('anchor_config')
      .select('inreach_mapshare_id, inreach_mapshare_password')
      .eq('boat_id', boatId)
      .maybeSingle(),
  ]);

  // deno-lint-ignore no-explicit-any
  const telemetry = (telRes.data ?? null) as Record<string, any> | null;
  const track     = trackRes.data ?? [];
  const trip      = tripRes.data ?? null;
  const irCfg     = cfgRes.data ?? null;

  // ── InReach GPS cache refresh ─────────────────────────────────────────────
  // Refresh cached InReach position when stale (>10 min) and credentials exist.
  // Result is stored in telemetry so future tracker calls within 10 min skip the fetch.
  if (irCfg?.inreach_mapshare_id && telemetry) {
    const irAt    = telemetry.inreach_gps_at ? new Date(telemetry.inreach_gps_at).getTime() : 0;
    const staleMs = Date.now() - irAt;
    if (staleMs > 10 * 60_000) {
      try {
        const irPos = await fetchLatestInReach(irCfg.inreach_mapshare_id, irCfg.inreach_mapshare_password ?? '');
        if (irPos) {
          telemetry.inreach_gps_lat = irPos.lat;
          telemetry.inreach_gps_lon = irPos.lon;
          telemetry.inreach_gps_at  = irPos.at;
          // Fire-and-forget cache write — don't await so it doesn't add latency
          supabase.from('telemetry').upsert({
            boat_id:          boatId,
            inreach_gps_lat:  irPos.lat,
            inreach_gps_lon:  irPos.lon,
            inreach_gps_at:   irPos.at,
          }, { onConflict: 'boat_id' }).then(() => {});
        }
      } catch { /* non-critical — GPS fallback, not vital data */ }
    }
  }

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

  // ── GPS sources — resolved server-side for convenience ───────────────────
  // Client uses this to display which source is active and its freshness.
  // Credentials are never included.
  const now    = Date.now();
  const freshMs = (at: string | null, maxMs: number) =>
    at != null && (now - new Date(at).getTime()) < maxMs;

  const gpsSources = {
    signalk: (telemetry?.nav_lat != null && telemetry?.nav_lon != null &&
              freshMs(telemetry.updated_at, 5 * 60_000))
      ? { lat: telemetry.nav_lat as number, lon: telemetry.nav_lon as number, at: telemetry.updated_at as string }
      : null,
    vrm: (telemetry?.vrm_gps_lat != null && telemetry?.vrm_gps_lon != null &&
          freshMs(telemetry.vrm_gps_at, 30 * 60_000))
      ? { lat: telemetry.vrm_gps_lat as number, lon: telemetry.vrm_gps_lon as number, at: telemetry.vrm_gps_at as string }
      : null,
    inreach: (telemetry?.inreach_gps_lat != null && telemetry?.inreach_gps_lon != null &&
              freshMs(telemetry.inreach_gps_at, 2 * 60 * 60_000))
      ? { lat: telemetry.inreach_gps_lat as number, lon: telemetry.inreach_gps_lon as number, at: telemetry.inreach_gps_at as string }
      : null,
  };

  return json({
    boat: {
      name:         boat.name,
      slug:         boat.tracking_slug,
      engine_count: boat.engine_count,
      boat_icon:    boat.boat_icon ?? 'monohull',
    },
    telemetry,
    derived: { tws_kn, twd_deg },
    gps_sources: gpsSources,
    track,
    trip,
    generated_at: new Date().toISOString(),
  });
});
