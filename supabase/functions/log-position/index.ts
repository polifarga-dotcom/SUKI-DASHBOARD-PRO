/**
 * log-position — Supabase Edge Function
 *
 * Called every 2 minutes via pg_cron + pg_net.
 * For every active trip that has VRM credentials configured:
 *   1. Fetch current GPS from VRM API
 *   2. Skip if the browser inserted an entry within the last 110 s (it was active)
 *   3. Insert a lean position-only log_entry
 *   4. Increment trip totals (distance, max SOG)
 *   5. Auto-stop detection for is_auto=true trips (15 min < 1.5 kn)
 *
 * Multi-boat: every query is scoped by boat_id — no cross-boat access.
 * Authentication: Bearer SUPABASE_SERVICE_ROLE_KEY (sent by pg_cron via vault).
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

// ── GPS + speed from VRM diagnostics ─────────────────────────────────────────
type GPSData = {
  lat: number;
  lon: number;
  speed_kn: number | null;
  course_deg: number | null;
  source?: string;
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
      if (r.dbusPath === '/Position/Latitude'  && lat      == null) lat      = r.rawValue;
      if (r.dbusPath === '/Position/Longitude' && lon      == null) lon      = r.rawValue;
      if (r.dbusPath === '/Position/Speed'     && speedMs  == null) speedMs  = r.rawValue;
      if (r.dbusPath === '/Position/Course'    && course   == null) course   = r.rawValue;
      if (lat != null && lon != null && speedMs != null && course != null) break;
    }

    if (lat == null || lon == null) return null;

    return {
      lat,
      lon,
      speed_kn:   speedMs != null ? +(speedMs * 1.94384).toFixed(2) : null,
      course_deg: course  != null ? +course.toFixed(1)              : null,
      source:     'vrm',
    };
  } catch (e) {
    console.error('[log-position] VRM error', e);
    return null;
  }
}

// ── Resolve GPS: telemetry table first (5 s cadence), VRM as fallback ─────────
// Telemetry is fed by the signalk-plugin-suki-bridge plugin. Staleness threshold
// is 120 s — if the plugin is offline, fall back to VRM API.
async function resolveGPS(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  boatId: string,
  vrmToken: string | null,
  vrmInstallId: number | null
): Promise<GPSData | null> {
  // 1. Try fresh telemetry (plugin updates every ~5 s)
  const { data: tel } = await supabase
    .from('telemetry')
    .select('nav_lat, nav_lon, nav_sog_ms, updated_at')
    .eq('boat_id', boatId)
    .maybeSingle();

  if (tel?.nav_lat != null && tel?.nav_lon != null && tel?.updated_at) {
    const ageSec = (Date.now() - new Date(tel.updated_at).getTime()) / 1000;
    if (ageSec < 120) {
      return {
        lat:        tel.nav_lat,
        lon:        tel.nav_lon,
        speed_kn:   tel.nav_sog_ms != null ? +(tel.nav_sog_ms * 1.94384).toFixed(2) : null,
        course_deg: null,   // telemetry doesn't expose COG separately yet
        source:     'telemetry',
      };
    }
    console.log(`[log-position] telemetry stale (${Math.round(ageSec)}s) — falling back to VRM`);
  }

  // 2. Fallback: VRM API
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

// ── Auto-stop: compute final stats + close the trip ──────────────────────────
async function serverAutoStop(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  trip: Trip,
  gps: GPSData
): Promise<void> {
  const boatId = trip.boat_id;

  // Geocode current position
  const place = await reverseGeocode(gps.lat, gps.lon);

  // Insert final arrival entry (scoped to this boat)
  await supabase.from('log_entries').insert({
    trip_id:    trip.id,
    boat_id:    boatId,
    logged_at:  new Date().toISOString(),
    lat:        gps.lat,
    lon:        gps.lon,
    sog_kn:     gps.speed_kn,
    cog_deg:    gps.course_deg,
    engine_on:  false,
    source:     'auto',
    notes:      `Arrival at ${place} (auto-stop: < 1.5 kn for 15 min)`,
  });

  // Recalculate all stats from DB entries for this trip (this boat only)
  const { data: rows } = await supabase
    .from('log_entries')
    .select('distance_nm, engine_on, sog_kn, engine_hours, logged_at')
    .eq('trip_id', trip.id)
    .eq('boat_id', boatId)
    .order('logged_at', { ascending: true });

  let totalNm = 0, sailNm = 0, motorNm = 0;
  let sumSog = 0, sogCount = 0, maxSog = 0;
  const withEng: number[] = [];

  for (const row of rows ?? []) {
    const d = row.distance_nm ?? 0;
    totalNm += d;
    if (row.engine_on) motorNm += d; else sailNm += d;
    if (row.sog_kn != null) { sumSog += row.sog_kn; sogCount++; if (row.sog_kn > maxSog) maxSog = row.sog_kn; }
    if (row.engine_hours != null) withEng.push(row.engine_hours);
  }

  const avgSog    = sogCount > 0 ? +(sumSog / sogCount).toFixed(2) : null;
  const engHours  = withEng.length >= 2
    ? +Math.max(0, withEng[withEng.length - 1] - withEng[0]).toFixed(2)
    : null;
  const tripName  = trip.from_port && place
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
    is_auto:         false,        // trip is now closed
    auto_slow_since: null,
  }).eq('id', trip.id).eq('boat_id', boatId);

  console.log(`[log-position] Auto-stopped trip ${trip.id} for boat ${boatId} at "${place}"`);
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  // Called internally by pg_cron — no external JWT verification needed.
  // The function uses service_role for all DB access; the worst an unauthenticated
  // caller can do is trigger one position snapshot (blocked by the 110 s duplicate guard).
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    serviceKey,
  );

  // ── Server-side auto-trip: start trips when boat moves ───────────────────────
  // Mirrors the browser's checkAutoTrip() / autoStartTrip() but works when the
  // app is closed. Runs BEFORE the active-trip loop so a freshly created trip
  // isn't immediately processed in the same tick.
  //
  // State machine (per boat, stored in anchor_config):
  //   SOG ≥ 1.5 kn → set auto_fast_since (if not already set)
  //   SOG ≥ 1.5 kn + auto_fast_since ≥ 60 s ago → create trip, clear auto_fast_since
  //   SOG < 1.5 kn, anchor alarming, or no GPS → clear auto_fast_since
  {
    const SOG_START_KN = 1.5;
    const CONFIRM_MS   = 60_000; // 1 min at speed → auto-start

    const { data: autoCfgs } = await supabase
      .from('anchor_config')
      .select('boat_id, auto_trip_enabled, auto_fast_since, alarming, vrm_api_token, vrm_installation_id')
      .eq('auto_trip_enabled', true)
      .not('boat_id', 'is', null);

    for (const ac of autoCfgs ?? []) {
      const boatId = ac.boat_id as string;

      // Don't auto-start while the anchor alarm is active
      if (ac.alarming) {
        if (ac.auto_fast_since) {
          await supabase.from('anchor_config').update({ auto_fast_since: null }).eq('boat_id', boatId);
        }
        continue;
      }

      // Skip if this boat already has an active trip (the active-trip loop below will handle it)
      const { data: existingTrip } = await supabase
        .from('log_trips').select('id').eq('boat_id', boatId).is('ended_at', null).maybeSingle();
      if (existingTrip) continue;

      // Resolve GPS + SOG
      const gps = await resolveGPS(supabase, boatId, ac.vrm_api_token ?? null, ac.vrm_installation_id ?? null);
      if (!gps) {
        if (ac.auto_fast_since) {
          await supabase.from('anchor_config').update({ auto_fast_since: null }).eq('boat_id', boatId);
        }
        continue;
      }

      const underway = (gps.speed_kn ?? 0) >= SOG_START_KN;

      if (underway) {
        if (!ac.auto_fast_since) {
          // First tick above threshold — record timestamp, wait for confirmation
          await supabase.from('anchor_config')
            .update({ auto_fast_since: new Date().toISOString() })
            .eq('boat_id', boatId);
          console.log(`[log-position] auto-trip: boat ${boatId} ${gps.speed_kn} kn — confirming...`);
        } else {
          const fastMs = Date.now() - new Date(ac.auto_fast_since).getTime();
          console.log(`[log-position] auto-trip: boat ${boatId} ${gps.speed_kn} kn fast for ${Math.round(fastMs / 1000)} s`);

          if (fastMs >= CONFIRM_MS) {
            // Confirmed underway — create the trip
            const place = await reverseGeocode(gps.lat, gps.lon);
            const { data: newTrip } = await supabase
              .from('log_trips')
              .insert({
                boat_id:    boatId,
                name:       place ?? 'Auto trip',
                from_port:  place,
                started_at: new Date().toISOString(),
                is_auto:    true,
              })
              .select('id')
              .single();

            if (newTrip) {
              await supabase.from('log_entries').insert({
                trip_id:   newTrip.id,
                boat_id:   boatId,
                logged_at: new Date().toISOString(),
                lat:       gps.lat,
                lon:       gps.lon,
                sog_kn:    gps.speed_kn,
                cog_deg:   gps.course_deg,
                engine_on: false,
                source:    'auto',
                notes:     `Departure from ${place ?? 'unknown'} (server auto-start)`,
              });
              console.log(`[log-position] auto-trip: started trip ${newTrip.id} for boat ${boatId} from "${place}"`);
            }

            // Clear confirm timer regardless of insert success
            await supabase.from('anchor_config').update({ auto_fast_since: null }).eq('boat_id', boatId);
          }
        }
      } else {
        // Slow or stopped — clear confirm timer
        if (ac.auto_fast_since) {
          await supabase.from('anchor_config').update({ auto_fast_since: null }).eq('boat_id', boatId);
          console.log(`[log-position] auto-trip: boat ${boatId} stopped — reset confirm timer`);
        }
      }
    }
  }

  // Load all active trips (across all boats)
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

    // ── Get VRM credentials for this specific boat (used as GPS fallback) ───────
    const { data: cfg } = await supabase
      .from('anchor_config')
      .select('vrm_api_token, vrm_installation_id')
      .eq('boat_id', boatId)
      .maybeSingle();

    // ── Duplicate guard ───────────────────────────────────────────────────────
    // Skip if the browser was active and inserted an entry within the last 110 s
    // (logging interval is 120 s; 110 s = safe margin)
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

    // ── Resolve GPS (telemetry first, VRM fallback) ───────────────────────────
    const gps = await resolveGPS(
      supabase, boatId,
      cfg?.vrm_api_token ?? null,
      cfg?.vrm_installation_id ?? null
    );
    if (!gps) {
      console.log(`[log-position] trip ${trip.id}: GPS unavailable (no telemetry or VRM)`);
      results.push({ trip: trip.id, boat: boatId, status: 'gps_unavailable' });
      continue;
    }

    console.log(`[log-position] trip ${trip.id}: GPS ${gps.lat.toFixed(5)},${gps.lon.toFixed(5)} ${gps.speed_kn ?? '?'} kn [${gps.source ?? 'unknown'}]`);

    // ── Distance since last entry ─────────────────────────────────────────────
    const distNm = (lastEntry?.lat != null && lastEntry?.lon != null)
      ? +(haversine(lastEntry.lat, lastEntry.lon, gps.lat, gps.lon) / 1852).toFixed(3)
      : 0;

    // ── Insert position entry (scoped to this boat) ───────────────────────────
    await supabase.from('log_entries').insert({
      trip_id:     trip.id,
      boat_id:     boatId,
      logged_at:   new Date().toISOString(),
      lat:         gps.lat,
      lon:         gps.lon,
      sog_kn:      gps.speed_kn,
      cog_deg:     gps.course_deg,
      distance_nm: distNm > 0 ? distNm : null,
      engine_on:   false,   // engine state unknown server-side
      source:      'auto',
    });

    // ── Increment trip totals ─────────────────────────────────────────────────
    if (distNm > 0) {
      const patch: Record<string, unknown> = {
        total_nm: +((trip.total_nm ?? 0) + distNm).toFixed(3),
        // engine unknown → credit as sail for now; recalcFromDB corrects at trip end
        sail_nm:  +((trip.sail_nm ?? 0) + distNm).toFixed(3),
      };
      const newMax = gps.speed_kn ?? 0;
      if (newMax > (trip.max_sog_kn ?? 0)) patch.max_sog_kn = +newMax.toFixed(2);

      await supabase.from('log_trips').update(patch).eq('id', trip.id).eq('boat_id', boatId);
    }

    // ── Auto-stop check (all active trips — auto or manual) ──────────────────
    {
      const underway = (gps.speed_kn ?? 0) >= 1.5;

      if (!underway) {
        if (!trip.auto_slow_since) {
          // First time below threshold — record timestamp
          await supabase.from('log_trips')
            .update({ auto_slow_since: new Date().toISOString() })
            .eq('id', trip.id).eq('boat_id', boatId);
          console.log(`[log-position] trip ${trip.id}: slow — starting 15-min countdown`);
        } else {
          const slowMs = Date.now() - new Date(trip.auto_slow_since).getTime();
          console.log(`[log-position] trip ${trip.id}: slow for ${Math.round(slowMs / 60_000)} min`);
          if (slowMs > 15 * 60_000) {
            await serverAutoStop(supabase, trip, gps);
            results.push({ trip: trip.id, boat: boatId, status: 'auto_stopped' });
            continue;
          }
        }
      } else if (trip.auto_slow_since) {
        // Back underway — clear the countdown
        await supabase.from('log_trips')
          .update({ auto_slow_since: null })
          .eq('id', trip.id).eq('boat_id', boatId);
      }
    }

    results.push({ trip: trip.id, boat: boatId, status: 'logged' });
  }

  return json({ processed: results.length, results });
});
