/**
 * ingest-log-entries — bulk log entry insertion for offline recovery
 *
 * Called by the SignalK plugin when internet returns after an offline period.
 * Accepts an array of log snapshots captured locally, matches each to the
 * active trip at that timestamp, deduplicates against existing entries,
 * and inserts the missing ones to fill the logbook gap.
 *
 * POST { api_key: string, entries: LogSnapshot[] }
 *   → { inserted: number, skipped: number, errors: number }
 *
 * A snapshot is skipped (not inserted) if a log_entry already exists for
 * the same boat/trip within ±90 seconds of the snapshot's timestamp — this
 * avoids duplicates when the browser was open and logging in parallel.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

type LogSnapshot = {
  logged_at:  string;        // ISO timestamp
  lat:        number | null;
  lon:        number | null;
  sog_kn:     number | null;
  cog_deg:    number | null;
  hdg_deg:    number | null;
  tws_kn:     number | null; // calculated or direct
  twd_deg:    number | null;
  aws_kn:     number | null;
  awa_deg:    number | null; // signed -180..+180
  baro_hpa:   number | null;
  depth_m:    number | null;
  batt_soc:   number | null; // 0-1 fraction from SignalK
  engine_on:  boolean;
  engine_rpm: number | null;
  engine_temp_c: number | null;
  engine_hours:  number | null;
  engine_sb_on:  boolean;
  engine_sb_rpm: number | null;
  engine_sb_temp_c: number | null;
  engine_sb_hours:  number | null;
  distance_nm: number | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { api_key?: unknown; entries?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { api_key, entries } = body;
  if (typeof api_key !== 'string' || !api_key) return json({ error: 'Unauthorized' }, 401);
  if (!Array.isArray(entries) || entries.length === 0) return json({ inserted: 0, skipped: 0, errors: 0 });

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);

  // Resolve boat_id from api_key
  const { data: cfg } = await supabase
    .from('anchor_config')
    .select('boat_id')
    .eq('plugin_api_key', api_key)
    .maybeSingle();
  if (!cfg?.boat_id) return json({ error: 'Unauthorized' }, 401);

  const boatId = cfg.boat_id;
  let inserted = 0, skipped = 0, errors = 0;

  for (const snap of entries as LogSnapshot[]) {
    const loggedAt = snap.logged_at;
    if (!loggedAt) { errors++; continue; }

    try {
      // 1. Find the trip active at this timestamp (retroactive matching)
      const { data: trips } = await supabase
        .from('log_trips')
        .select('id')
        .eq('boat_id', boatId)
        .lte('started_at', loggedAt)
        .or(`ended_at.is.null,ended_at.gte.${loggedAt}`)
        .order('started_at', { ascending: false })
        .limit(1);

      let tripId = trips?.[0]?.id ?? null;

      // Fallback for outage gaps: the entry timestamp falls BETWEEN two trips
      // (the first trip was falsely auto-stopped during an internet outage).
      // Assign to the most recently ended trip within 4 hours before this entry.
      if (!tripId) {
        const fourHoursAgo = new Date(new Date(loggedAt).getTime() - 4 * 60 * 60_000).toISOString();
        const { data: recentTrips } = await supabase
          .from('log_trips')
          .select('id')
          .eq('boat_id', boatId)
          .not('ended_at', 'is', null)
          .gte('ended_at', fourHoursAgo)
          .lte('ended_at', loggedAt)
          .order('ended_at', { ascending: false })
          .limit(1);
        tripId = recentTrips?.[0]?.id ?? null;
      }

      if (!tripId) { skipped++; continue; }

      // 2. Deduplicate: skip if entry already exists within ±90s
      const windowStart = new Date(new Date(loggedAt).getTime() - 90_000).toISOString();
      const windowEnd   = new Date(new Date(loggedAt).getTime() + 90_000).toISOString();
      const { count } = await supabase
        .from('log_entries')
        .select('id', { count: 'exact', head: true })
        .eq('trip_id', tripId)
        .gte('logged_at', windowStart)
        .lte('logged_at', windowEnd);

      if ((count ?? 0) > 0) { skipped++; continue; }

      // 3. Insert the buffered entry
      const { error } = await supabase.from('log_entries').insert({
        trip_id:    tripId,
        boat_id:    boatId,
        logged_at:  loggedAt,
        source:     'auto',
        lat:        snap.lat,
        lon:        snap.lon,
        sog_kn:     snap.sog_kn,
        cog_deg:    snap.cog_deg,
        distance_nm: snap.distance_nm,
        engine_on:   snap.engine_on,
        engine_rpm:  snap.engine_rpm,
        engine_hours: snap.engine_hours,
        engine_temp_c: snap.engine_temp_c,
        engine_sb_on:   snap.engine_sb_on,
        engine_sb_rpm:  snap.engine_sb_rpm,
        engine_sb_hours: snap.engine_sb_hours,
        engine_sb_temp_c: snap.engine_sb_temp_c,
        wind_speed_kn: snap.tws_kn,
        wind_dir_deg:  snap.twd_deg,
        apparent_wind_speed_kn:  snap.aws_kn,
        apparent_wind_angle_deg: snap.awa_deg,
        baro_hpa:  snap.baro_hpa,
        depth_m:   snap.depth_m,
        // batt_soc stored as 0-100 in log_entries; plugin provides 0-1 fraction
        batt_soc: snap.batt_soc != null ? Math.round(snap.batt_soc * 100) : null,
        notes: '[offline recovery]',
      });

      if (error) { console.error('[ingest-log-entries] insert error:', error.message); errors++; }
      else inserted++;

    } catch (e) {
      console.error('[ingest-log-entries] entry error:', e);
      errors++;
    }
  }

  console.log(`[ingest-log-entries] boat=${boatId} inserted=${inserted} skipped=${skipped} errors=${errors}`);
  return json({ inserted, skipped, errors });
});
