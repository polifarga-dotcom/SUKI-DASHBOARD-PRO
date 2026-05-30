/**
 * inreach-proxy — Supabase Edge Function
 *
 * Fetches the Garmin InReach MapShare KML feed for a given feed name,
 * parses the KML and returns JSON. Acts as a CORS proxy since the
 * Garmin share endpoint doesn't set CORS headers.
 *
 * GET ?id=FEED_NAME[&password=PW][&hours=24]
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** Extract a named <Data> value from a KML Placemark string */
function getData(pm: string, name: string): string | null {
  const re = new RegExp(`<Data name="${name}">\\s*<value>([^<]*)<\\/value>`, 'i');
  const m = re.exec(pm);
  return m ? m[1].trim() : null;
}

interface InReachPoint {
  lat: number;
  lon: number;
  speed_kn: number | null;
  course_deg: number | null;
  altitude_m: number | null;
  timestamp: string;        // ISO 8601 UTC
  message: string | null;
  event_type: string | null;
  device_name: string | null;
  in_emergency: boolean;
}

function parseKML(kml: string): InReachPoint[] {
  const points: InReachPoint[] = [];
  const pmRe = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let m: RegExpExecArray | null;

  while ((m = pmRe.exec(kml)) !== null) {
    const pm = m[1];

    const latStr = getData(pm, 'Latitude');
    const lonStr = getData(pm, 'Longitude');
    const lat = parseFloat(latStr ?? '');
    const lon = parseFloat(lonStr ?? '');
    if (isNaN(lat) || isNaN(lon)) continue;

    // Timestamp from <TimeStamp><when>…</when></TimeStamp>
    const tsM = /<TimeStamp>\s*<when>([^<]+)<\/when>/i.exec(pm);
    const timestamp = tsM ? tsM[1].trim() : '';

    // Velocity in km/h → knots
    const velKmh = parseFloat(getData(pm, 'Velocity') ?? '');
    const speed_kn = isNaN(velKmh) ? null : +(velKmh * 0.539957).toFixed(1);

    const courseStr = getData(pm, 'Course');
    const course_deg = courseStr !== null ? parseFloat(courseStr) : null;

    const altStr = getData(pm, 'Elevation');
    const altitude_m = altStr !== null ? parseFloat(altStr) : null;

    const text = getData(pm, 'Text') || null;
    const event_type = getData(pm, 'Event') || null;
    const device_name = getData(pm, 'Map Display Name') || getData(pm, 'Name') || null;
    const emergency = (getData(pm, 'In Emergency') ?? '').toLowerCase() === 'true';

    points.push({
      lat, lon, speed_kn,
      course_deg: course_deg !== null && !isNaN(course_deg) ? course_deg : null,
      altitude_m: altitude_m !== null && !isNaN(altitude_m) ? altitude_m : null,
      timestamp,
      message: text && text.length > 0 ? text : null,
      event_type,
      device_name,
      in_emergency: emergency,
    });
  }

  // Return newest first
  return points.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(req.url);
  const id  = url.searchParams.get('id')?.trim();
  const pw  = url.searchParams.get('password')?.trim() ?? '';
  const hours = Math.min(parseInt(url.searchParams.get('hours') ?? '24', 10), 168); // max 7 days

  if (!id) return json({ error: 'id parameter required' }, 400);

  const d2 = new Date();
  const d1 = new Date(d2.getTime() - hours * 3_600_000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}T${String(d.getUTCHours()).padStart(2,'0')}%3A${String(d.getUTCMinutes()).padStart(2,'0')}%3A00Z`;

  let garminUrl = `https://share.garmin.com/Feed/Share/${encodeURIComponent(id)}?d1=${fmt(d1)}&d2=${fmt(d2)}`;
  if (pw) garminUrl += `&Password=${encodeURIComponent(pw)}`;

  try {
    const res = await fetch(garminUrl, {
      headers: { 'User-Agent': 'SUKI-Dashboard/1.0' },
    });

    if (!res.ok) {
      if (res.status === 404) return json({ error: 'Feed not found — check MapShare ID' }, 404);
      if (res.status === 401 || res.status === 403) return json({ error: 'Invalid password or feed is private' }, 401);
      return json({ error: `Garmin returned HTTP ${res.status}` }, 502);
    }

    const kml = await res.text();
    if (!kml.includes('<kml')) return json({ error: 'Unexpected response from Garmin' }, 502);

    const points = parseKML(kml);
    return json({ ok: true, points, count: points.length });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
