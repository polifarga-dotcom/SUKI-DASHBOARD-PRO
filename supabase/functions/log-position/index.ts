/**
 * log-position — Supabase Edge Function  (v9)
 *
 * Called every 2 minutes via pg_cron + pg_net.
 * For every active trip that has VRM credentials configured:
 *   1. Fetch current GPS + telemetry from telemetry table (SignalK plugin)
 *   2. Skip if the browser inserted an entry within the last 110 s (it was active)
 *   3. Insert a full log_entry (GPS + wind/pressure/depth/battery/engine)
 *   4. Increment trip totals (distance, max SOG)
 *   5. Auto-stop detection for is_auto=true trips (15 min < 1.5 kn)
 *
 * Server-side auto-trip detection (bulletproof, 3 layers):
 *   Fix 1 — Pre-trip logging: log orphan 'pre-trip' entries while confirming movement.
 *            On trip creation, backdate started_at + link all pre-trip entries retroactively.
 *   Fix 2 — Outage tolerance: don't reset confirmation on a single bad tick.
 *            auto_miss_ticks counts consecutive bad ticks; reset only after ≥ 2.
 *   Fix 3 — Position-delta fallback: when SOG is null (VRM path), compare current
 *            position to auto_last_lat/lon. Movement > 150 m in 2 min → underway.
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

// ── Haversine distance (metres) ───────────────────────────────────────────────
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── GPS + telemetry from VRM diagnostics ─────────────────────────────────────
type GPSData = {
  lat: number;
  lon: number;
  speed_kn: number | null;
  course_deg: number | null;
  source?: string;
  // Telemetry enrichment (null on VRM path)
  tws_kn: number | null;
  aws_kn: number | null;
  awa_deg: number | null;
  baro_hpa: number | null;
  depth_m: number | null;
  batt_soc: number | null;
  water_temp_c: number | null;
  engine_rpm: number | null;
};

async function fetchGPSFromVRM(
  token: string,
  installationId: number
): Promise<GPSData | null> {
  try {
    const url = `https://vrmapi.victronenergy.com/v2/installations/${installationId}/diagnostics?count=1000`;
    const res = await fetch(url, {
      headers: { 'X-Authorization': `Token ${token}` },
    });
    if (!res.ok) {
      console.error('[log-position] VRM fetch failed', res.status);
      return null;
    }
    const data = await res.json();
    const records: { dbusPath: string; rawValue: number }[] = data?.records ?? [];

    let lat: number | null = null;
    let lon: number | null = null;
    let speedMs: number | null = null;
    let course: number | null = null;

    for (const r of records) {
      if (r.dbusPath === '/Position/Latitude'  && lat     == null) lat     = r.rawValue;
      if (r.dbusPath === '/Position/Longitude' && lon     == null) lon     = r.rawValue;
      if (r.dbusPath === '/Position/Speed'     && speedMs == null) speedMs = r.rawValue;
      if (r.dbusPath === '/Position/Course'    && course  == null) course  = r.rawValue;
      if (lat != null && lon != null && speedMs != null && course != null) break;
    }

    if (lat == null || lon == null) return null;

    return {
      lat,
      lon,
      speed_kn:   speedMs != null ? +(speedMs * 1.94384).toFixed(2) : null,
      course_deg: course  != null ? +course.toFixed(1)              : null,
      source:     'vrm',
      tws_kn: null, aws_kn: null, awa_deg: null,
      baro_hpa: null, depth_m: null, batt_soc: null,
      water_temp_c: null, engine_rpm: null,
    };
  } catch (e) {
    console.error('[log-position] VRM error', e);
    return null;
  }
}

// ── Resolve GPS: telemetry table first (5 s cadence), VRM as fallback ─────────
async function resolveGPS(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  boatId: string,
  vrmToken: string | null,
  vrmInstallId: number | null
): Promise<GPSData | null> {
  const { data: tel } = await supabase
    .from('telemetry')
    .select('nav_lat, nav_lon, nav_sog_ms, nav_cog_rad, updated_at, env_tws_ms, env_aws_ms, env_awa_rad, env_pressure_pa, env_depth_m, batt_main_soc, temp_water, eng_rpm')
    .eq('boat_id', boatId)
    .maybeSingle();

  if (tel?.nav_lat != null && tel?.nav_lon != null && tel?.updated_at) {
    const ageSec = (Date.now() - new Date(tel.updated_at).getTime()) / 1000;
    if (ageSec < 120) {
      return {
        lat:          tel.nav_lat,
        lon:          tel.nav_lon,
        speed_kn:     tel.nav_sog_ms  != null ? +(tel.nav_sog_ms  * 1.94384).toFixed(2) : null,
        course_deg:   tel.nav_cog_rad != null ? +(tel.nav_cog_rad * 180 / Math.PI).toFixed(1) : null,
        source:       'telemetry',
        tws_kn:       tel.env_tws_ms      != null ? +(tel.env_tws_ms      * 1.94384).toFixed(1) : null,
        aws_kn:       tel.env_aws_ms      != null ? +(tel.env_aws_ms      * 1.94384).toFixed(1) : null,
        awa_deg:      tel.env_awa_rad     != null ? +(tel.env_awa_rad     * 180 / Math.PI).toFixed(1) : null,
        baro_hpa:     tel.env_pressure_pa != null ? +(tel.env_pressure_pa / 100).toFixed(1) : null,
        depth_m:      tel.env_depth_m     != null ? +tel.env_depth_m.toFixed(1) : null,
        batt_soc:     tel.batt_main_soc   != null ? +(tel.batt_main_soc * 100).toFixed(1) : null,
        water_temp_c: tel.temp_water      != null ? +(tel.temp_water - 273.15).toFixed(1) : null,
        engine_rpm:   tel.eng_rpm         != null ? Math.round(tel.eng_rpm) : null,
      };
    }
    console.log(`[log-position] telemetry stale (${Math.round(ageSec)}s) — falling back to VRM`);
  }

  if (vrmToken && vrmInstallId) {
    return await fetchGPSFromVRM(vrmToken, vrmInstallId);
  }

  return null;
}

// ── Nominatim reverse geocode ─────────────────────────────────────────────────
async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=en`,
      { headers: { 'User-Agent': 'SUKI-Dashboard-Pro/1.0 sailing@suki.boat', 'Accept-Language': 'en' } }
    );
    if (!r.ok) throw new Error('nominatim error');
    const j = await r.json();
    const a = j.address ?? {};
    return a.bay ?? a.sea ?? a.body_of_water ?? a.island ?? a.archipelago ??
           a.village ?? a.town ?? a.city_district ?? a.city ??
           a.county ?? j.name ??
           `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
  } catch {
    return `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
  }
}

// ── Type helpers ──────────────────────────────────────────────────────────────
type Trip = {
  id:               string;
  boat_id:          string;
  name:             string | null;
  from_port:        string | null;
  is_auto:          boolean;
  auto_slow_since:  string | null;
  total_nm:         number | null;
  sail_nm:          number | null;
  motor_nm:         number | null;
  max_sog_kn:       number | null;
  engine_hours:     number | null;
};

// ── Build enriched insert payload from GPSData ────────────────────────────────
function telemetryFields(gps: GPSData) {
  return {
    wind_speed_kn:           gps.tws_kn,
    apparent_wind_speed_kn:  gps.aws_kn,
    apparent_wind_angle_deg: gps.awa_deg,
    baro_hpa:                gps.baro_hpa,
    depth_m:                 gps.depth_m,
    batt_soc:                gps.batt_soc,
    water_temp_c:            gps.water_temp_c,
    engine_rpm:              gps.engine_rpm,
  };
}

// ── Auto-stop: compute final stats + close the trip ──────────────────────────
async function serverAutoStop(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  trip: Trip,
  gps: GPSData
): Promise<void> {
  const boatId = trip.boat_id;
  const place  = await reverseGeocode(gps.lat, gps.lon);

  await supabase.from('log_entries').insert({
    trip_id:   trip.id,
    boat_id:   boatId,
    logged_at: new Date().toISOString(),
    lat:       gps.lat,
    lon:       gps.lon,
    sog_kn:    gps.speed_kn,
    cog_deg:   gps.course_deg,
    engine_on: gps.engine_rpm != null ? gps.engine_rpm > 200 : false,
    source:    'auto',
    notes:     `Arrival at ${place} (auto-stop: < 1.5 kn for 15 min)`,
    ...telemetryFields(gps),
  });

  const { data: rows } = await supabase
    .from('log_entries')
    .select('distance_nm, engine_on, sog_kn, engine_hours, logged_at')
    .eq('trip_id', trip.id)
    .eq('boat_id', boatId)
    .order('logged_at', { ascending: true });

  let totalNm = 0, sailNm = 0, motorNm = 0;
  let sumSog = 0, sogCount = 0, maxSog = 0;
  let motorTimeSec = 0;
  const withEng: number[] = [];

  for (let i = 0; i < (rows ?? []).length; i++) {
    const row = rows[i];
    const d = row.distance_nm ?? 0;
    totalNm += d;
    if (row.engine_on) motorNm += d; else sailNm += d;
    if (row.sog_kn != null) { sumSog += row.sog_kn; sogCount++; if (row.sog_kn > maxSog) maxSog = row.sog_kn; }
    if (row.engine_hours != null) withEng.push(row.engine_hours);
    if (i > 0 && row.engine_on) {
      const intv = Math.min(
        (new Date(row.logged_at).getTime() - new Date(rows[i - 1].logged_at).getTime()) / 1000,
        7200
      );
      motorTimeSec += intv;
    }
  }

  const avgSog   = sogCount > 0 ? +(sumSog / sogCount).toFixed(2) : null;
  // Prefer VRM absolute counter delta; fall back to time-based calc
  const engHours = withEng.length >= 2
    ? +Math.max(0, withEng[withEng.length - 1] - withEng[0]).toFixed(2)
    : motorTimeSec > 0 ? +(motorTimeSec / 3600).toFixed(2) : null;
  const tripName = trip.from_port && place
    ? `${trip.from_port} → ${place}`
    : (trip.name ?? 'Auto trip');

  await supabase.from('log_trips').update({
    ended_at:        new Date().toISOString(),
    to_port:         place,
    name:            tripName,
    total_nm:        +totalNm.toFixed(3),
    sail_nm:         +sailNm.toFixed(3),
    motor_nm:        +motorNm.toFixed(3),
    avg_sog_kn:      avgSog,
    max_sog_kn:      maxSog > 0 ? +maxSog.toFixed(2) : null,
    engine_hours:    engHours,
    is_auto:         false,
    auto_slow_since: null,
  }).eq('id', trip.id).eq('boat_id', boatId);

  console.log(`[log-position] Auto-stopped trip ${trip.id} for boat ${boatId} at "${place}"`);
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

  // ── Server-side auto-trip detection ─────────────────────────────────────────
  //
  // Three-layer bulletproof detection:
  //   Fix 1 — Pre-trip logging + backdating
  //   Fix 2 — Outage tolerance (miss counter, reset only after ≥ 2 consecutive bad ticks)
  //   Fix 3 — Position-delta fallback when SOG is null
  {
    const SOG_START_KN      = 1.5;
    const CONFIRM_MS        = 60_000;  // 1 min confirmed movement → start trip
    const MOVE_THRESHOLD_M  = 150;     // ~2.4 kn equivalent over 2-min interval
    const MAX_MISS_TICKS    = 2;       // tolerate this many consecutive bad ticks

    const { data: autoCfgs } = await supabase
      .from('anchor_config')
      .select('boat_id, auto_trip_enabled, auto_fast_since, auto_miss_ticks, auto_last_lat, auto_last_lon, active, vrm_api_token, vrm_installation_id')
      .eq('auto_trip_enabled', true)
      .not('boat_id', 'is', null);

    for (const ac of autoCfgs ?? []) {
      const boatId = ac.boat_id as string;

      // Anchor watch active → don't auto-start
      if (ac.active) {
        if (ac.auto_fast_since) {
          await supabase.from('anchor_config')
            .update({ auto_fast_since: null, auto_miss_ticks: 0 })
            .eq('boat_id', boatId);
        }
        continue;
      }

      // Already has an active trip
      const { data: existingTrip } = await supabase
        .from('log_trips').select('id').eq('boat_id', boatId).is('ended_at', null).maybeSingle();
      if (existingTrip) continue;

      // Resolve GPS
      const gps = await resolveGPS(supabase, boatId, ac.vrm_api_token ?? null, ac.vrm_installation_id ?? null);

      if (!gps) {
        // GPS unavailable — treat as bad tick (Fix 2)
        const newMiss = (ac.auto_miss_ticks ?? 0) + 1;
        if (newMiss >= MAX_MISS_TICKS && ac.auto_fast_since) {
          await supabase.from('log_entries')
            .delete().eq('boat_id', boatId).is('trip_id', null).eq('source', 'pre-trip');
          await supabase.from('anchor_config')
            .update({ auto_fast_since: null, auto_miss_ticks: 0 }).eq('boat_id', boatId);
          console.log(`[log-position] auto-trip: boat ${boatId} GPS gone (${newMiss} ticks) — reset`);
        } else {
          await supabase.from('anchor_config')
            .update({ auto_miss_ticks: newMiss }).eq('boat_id', boatId);
        }
        continue;
      }

      // Fix 3: position-delta fallback when SOG is null
      let underway = (gps.speed_kn ?? 0) >= SOG_START_KN;
      if (!underway && gps.speed_kn == null && ac.auto_last_lat != null && ac.auto_last_lon != null) {
        const dist = haversine(ac.auto_last_lat, ac.auto_last_lon, gps.lat, gps.lon);
        if (dist >= MOVE_THRESHOLD_M) {
          underway = true;
          console.log(`[log-position] auto-trip: boat ${boatId} pos-delta ${Math.round(dist)} m → underway (no SOG)`);
        }
      }

      // Always persist latest known position for next tick's delta check
      const posUpdate = { auto_last_lat: gps.lat, auto_last_lon: gps.lon };

      if (underway) {
        // Fix 2: good tick → reset miss counter
        const nowIso = new Date().toISOString();

        // Fix 1: log a pre-trip orphan entry on every underway tick before trip starts
        await supabase.from('log_entries').insert({
          boat_id:   boatId,
          trip_id:   null,
          logged_at: nowIso,
          lat:       gps.lat,
          lon:       gps.lon,
          sog_kn:    gps.speed_kn,
          cog_deg:   gps.course_deg,
          engine_on: gps.engine_rpm != null ? gps.engine_rpm > 200 : false,
          source:    'pre-trip',
          ...telemetryFields(gps),
        });

        if (!ac.auto_fast_since) {
          // First underway tick — start confirmation timer
          await supabase.from('anchor_config')
            .update({ ...posUpdate, auto_fast_since: nowIso, auto_miss_ticks: 0 })
            .eq('boat_id', boatId);
          console.log(`[log-position] auto-trip: boat ${boatId} ${gps.speed_kn ?? 'delta'} kn — confirming...`);
        } else {
          const fastMs = Date.now() - new Date(ac.auto_fast_since).getTime();
          await supabase.from('anchor_config')
            .update({ ...posUpdate, auto_miss_ticks: 0 })
            .eq('boat_id', boatId);
          console.log(`[log-position] auto-trip: boat ${boatId} ${gps.speed_kn ?? 'delta'} kn for ${Math.round(fastMs / 1000)} s`);

          if (fastMs >= CONFIRM_MS) {
            // ── Confirmed underway: create trip, backdate, link pre-trip entries ──

            // Fix 1: load all orphan pre-trip entries (last 3 h only, avoid stale)
            const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
            const { data: preTripRows } = await supabase
              .from('log_entries')
              .select('id, logged_at, lat, lon')
              .eq('boat_id', boatId)
              .is('trip_id', null)
              .eq('source', 'pre-trip')
              .gte('logged_at', cutoff)
              .order('logged_at', { ascending: true });

            const earliest = preTripRows?.[0];
            const departureAt = earliest?.logged_at ?? nowIso;
            const depLat = earliest?.lat ?? gps.lat;
            const depLon = earliest?.lon ?? gps.lon;
            const place  = await reverseGeocode(depLat, depLon);

            const { data: newTrip } = await supabase
              .from('log_trips')
              .insert({
                boat_id:    boatId,
                name:       place ?? 'Auto trip',
                from_port:  place,
                started_at: departureAt,   // ← backdated to first pre-trip entry
                is_auto:    true,
              })
              .select('id')
              .single();

            if (newTrip) {
              // Link pre-trip entries to new trip + fill in distance_nm
              if (preTripRows?.length) {
                for (let i = 0; i < preTripRows.length; i++) {
                  const e   = preTripRows[i];
                  const prv = i > 0 ? preTripRows[i - 1] : null;
                  const distNm = prv
                    ? +(haversine(prv.lat, prv.lon, e.lat, e.lon) / 1852).toFixed(3)
                    : 0;
                  await supabase.from('log_entries')
                    .update({ trip_id: newTrip.id, distance_nm: distNm > 0 ? distNm : null })
                    .eq('id', e.id);
                }
              }
              // Add current position as first confirmed entry
              await supabase.from('log_entries').insert({
                trip_id:   newTrip.id,
                boat_id:   boatId,
                logged_at: nowIso,
                lat:       gps.lat,
                lon:       gps.lon,
                sog_kn:    gps.speed_kn,
                cog_deg:   gps.course_deg,
                engine_on: gps.engine_rpm != null ? gps.engine_rpm > 200 : false,
                source:    'auto',
                notes:     `Departure from ${place ?? 'unknown'} (server auto-start)`,
                ...telemetryFields(gps),
              });
              console.log(`[log-position] auto-trip: started trip ${newTrip.id} for boat ${boatId} from "${place}" (backdated ${preTripRows?.length ?? 0} entries)`);
            }

            // Clear confirmation state
            await supabase.from('anchor_config')
              .update({ auto_fast_since: null, auto_miss_ticks: 0, ...posUpdate })
              .eq('boat_id', boatId);
          }
        }
      } else {
        // Fix 2: bad tick — increment miss counter, only reset after threshold
        const newMiss = (ac.auto_miss_ticks ?? 0) + 1;
        if (newMiss >= MAX_MISS_TICKS) {
          if (ac.auto_fast_since) {
            // Clean up stale pre-trip entries
            await supabase.from('log_entries')
              .delete().eq('boat_id', boatId).is('trip_id', null).eq('source', 'pre-trip');
            console.log(`[log-position] auto-trip: boat ${boatId} stopped (${newMiss} bad ticks) — reset`);
          }
          await supabase.from('anchor_config')
            .update({ auto_fast_since: null, auto_miss_ticks: 0, ...posUpdate })
            .eq('boat_id', boatId);
        } else {
          await supabase.from('anchor_config')
            .update({ auto_miss_ticks: newMiss, ...posUpdate })
            .eq('boat_id', boatId);
          console.log(`[log-position] auto-trip: boat ${boatId} slow/null — miss tick ${newMiss}/${MAX_MISS_TICKS}`);
        }
      }
    }
  }

  // ── Load all active trips ────────────────────────────────────────────────────
  const { data: trips, error: tripsErr } = await supabase
    .from('log_trips')
    .select('id, boat_id, name, from_port, is_auto, auto_slow_since, total_nm, sail_nm, motor_nm, max_sog_kn, engine_hours')
    .is('ended_at', null);

  if (tripsErr) {
    console.error('[log-position] load trips error', tripsErr.message);
    return json({ error: tripsErr.message }, 500);
  }

  const results: { trip: string; boat: string; status: string }[] = [];
  console.log(`[log-position] processing ${trips?.length ?? 0} active trips`);

  for (const trip of (trips ?? []) as Trip[]) {
    const boatId = trip.boat_id;

    const { data: cfg } = await supabase
      .from('anchor_config')
      .select('vrm_api_token, vrm_installation_id')
      .eq('boat_id', boatId)
      .maybeSingle();

    // ── Duplicate guard: skip if browser was active within 110 s ─────────────
    const { data: lastEntry } = await supabase
      .from('log_entries')
      .select('logged_at, lat, lon')
      .eq('trip_id', trip.id)
      .eq('boat_id', boatId)
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const recentMs = lastEntry
      ? Date.now() - new Date(lastEntry.logged_at).getTime()
      : Infinity;

    if (recentMs < 110_000) {
      console.log(`[log-position] trip ${trip.id}: browser active (${Math.round(recentMs / 1000)} s ago) — skip`);
      results.push({ trip: trip.id, boat: boatId, status: 'browser_active' });
      continue;
    }

    // ── Resolve GPS ───────────────────────────────────────────────────────────
    const gps = await resolveGPS(
      supabase, boatId,
      cfg?.vrm_api_token ?? null,
      cfg?.vrm_installation_id ?? null
    );
    if (!gps) {
      console.log(`[log-position] trip ${trip.id}: GPS unavailable`);
      results.push({ trip: trip.id, boat: boatId, status: 'gps_unavailable' });
      continue;
    }

    console.log(`[log-position] trip ${trip.id}: ${gps.lat.toFixed(5)},${gps.lon.toFixed(5)} ${gps.speed_kn ?? '?'} kn [${gps.source ?? '?'}]`);

    // ── Distance since last entry ─────────────────────────────────────────────
    const distNm = (lastEntry?.lat != null && lastEntry?.lon != null)
      ? +(haversine(lastEntry.lat, lastEntry.lon, gps.lat, gps.lon) / 1852).toFixed(3)
      : 0;

    // ── Insert entry ──────────────────────────────────────────────────────────
    await supabase.from('log_entries').insert({
      trip_id:     trip.id,
      boat_id:     boatId,
      logged_at:   new Date().toISOString(),
      lat:         gps.lat,
      lon:         gps.lon,
      sog_kn:      gps.speed_kn,
      cog_deg:     gps.course_deg,
      distance_nm: distNm > 0 ? distNm : null,
      engine_on:   gps.engine_rpm != null ? gps.engine_rpm > 200 : false,
      source:      'auto',
      ...telemetryFields(gps),
    });

    // ── Increment trip totals ─────────────────────────────────────────────────
    if (distNm > 0) {
      const engineOn = gps.engine_rpm != null ? gps.engine_rpm > 200 : false;
      const patch: Record<string, unknown> = {
        total_nm: +((trip.total_nm ?? 0) + distNm).toFixed(3),
      };
      if (engineOn)  patch.motor_nm = +((trip.motor_nm ?? 0) + distNm).toFixed(3);
      else           patch.sail_nm  = +((trip.sail_nm  ?? 0) + distNm).toFixed(3);
      const newMax = gps.speed_kn ?? 0;
      if (newMax > (trip.max_sog_kn ?? 0)) patch.max_sog_kn = +newMax.toFixed(2);
      await supabase.from('log_trips').update(patch).eq('id', trip.id).eq('boat_id', boatId);
    }

    // ── Auto-stop check ───────────────────────────────────────────────────────
    {
      const underway = (gps.speed_kn ?? 0) >= 1.5;
      if (!underway) {
        if (!trip.auto_slow_since) {
          await supabase.from('log_trips')
            .update({ auto_slow_since: new Date().toISOString() })
            .eq('id', trip.id).eq('boat_id', boatId);
          console.log(`[log-position] trip ${trip.id}: slow — 15-min countdown started`);
        } else {
          const slowMs = Date.now() - new Date(trip.auto_slow_since).getTime();
          console.log(`[log-position] trip ${trip.id}: slow ${Math.round(slowMs / 60_000)} min`);
          if (slowMs > 15 * 60_000) {
            await serverAutoStop(supabase, trip, gps);
            results.push({ trip: trip.id, boat: boatId, status: 'auto_stopped' });
            continue;
          }
        }
      } else if (trip.auto_slow_since) {
        await supabase.from('log_trips')
          .update({ auto_slow_since: null })
          .eq('id', trip.id).eq('boat_id', boatId);
      }
    }

    results.push({ trip: trip.id, boat: boatId, status: 'logged' });
  }

  return json({ processed: results.length, results });
});
