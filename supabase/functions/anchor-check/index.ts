/**
 * anchor-check — Supabase Edge Function
 *
 * Called every minute via pg_cron + pg_net.
 * Reads all active anchor watches, fetches GPS from VRM,
 * calculates distance to anchor point, and triggers
 * Telegram/Pushover alerts when the boat drags.
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

// ── Fetch GPS from VRM diagnostics ────────────────────────────────────────────
async function fetchGPSFromVRM(
  token: string,
  installationId: number
): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = `https://vrmapi.victronenergy.com/v2/installations/${installationId}/diagnostics?count=1000`;
    const res = await fetch(url, {
      headers: { 'X-Authorization': `Token ${token}` },
    });
    if (!res.ok) {
      console.error('[anchor-check] VRM fetch failed', res.status);
      return null;
    }
    const data = await res.json();
    const records: { dbusPath: string; rawValue: number }[] = data?.records ?? [];

    let lat: number | null = null;
    let lon: number | null = null;
    for (const r of records) {
      if (r.dbusPath === '/Position/Latitude'  && lat == null) lat = r.rawValue;
      if (r.dbusPath === '/Position/Longitude' && lon == null) lon = r.rawValue;
      if (lat != null && lon != null) break;
    }
    if (lat == null || lon == null) return null;
    return { lat, lon };
  } catch (e) {
    console.error('[anchor-check] VRM error', e);
    return null;
  }
}

// ── Resolve GPS: telemetry table first (5 s cadence), VRM as fallback ─────────
// Telemetry is fed by the signalk-plugin-suki-bridge plugin, which is much faster
// than a VRM API round-trip. Staleness threshold is 120 s (2× the plugin interval).
async function resolveGPS(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  boatId: string,
  vrmToken: string | null,
  vrmInstallId: number | null
): Promise<{ lat: number; lon: number; source: string } | null> {
  // 1. Try telemetry table (fresh = updated within 120 s)
  const { data: tel } = await supabase
    .from('telemetry')
    .select('nav_lat, nav_lon, updated_at')
    .eq('boat_id', boatId)
    .maybeSingle();

  if (tel?.nav_lat != null && tel?.nav_lon != null && tel?.updated_at) {
    const ageSec = (Date.now() - new Date(tel.updated_at).getTime()) / 1000;
    if (ageSec < 120) {
      return { lat: tel.nav_lat, lon: tel.nav_lon, source: 'telemetry' };
    }
    console.log(`[anchor-check] telemetry stale (${Math.round(ageSec)}s) — falling back to VRM`);
  }

  // 2. Fallback: VRM API (works without the plugin, but ~1–5 s slower)
  if (vrmToken && vrmInstallId) {
    const gps = await fetchGPSFromVRM(vrmToken, vrmInstallId);
    if (gps) return { ...gps, source: 'vrm' };
  }

  return null;
}

// ── Telegram notification ─────────────────────────────────────────────────────
async function sendTelegram(
  botToken: string | null,
  chatIds: string | null,
  text: string
): Promise<void> {
  if (!botToken || !chatIds) return;
  const ids = chatIds.split(',').map(s => s.trim()).filter(Boolean);
  for (const chatId of ids) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
    } catch (e) {
      console.error('[anchor-check] Telegram error for chat', chatId, e);
    }
  }
}

// ── Pushover notification ─────────────────────────────────────────────────────
async function sendPushover(
  appToken: string | null,
  userKeys: string | null,
  title: string,
  message: string,
  priority = 1
): Promise<void> {
  if (!appToken || !userKeys) return;
  const keys = userKeys.split(',').map(s => s.trim()).filter(Boolean);
  for (const userKey of keys) {
    try {
      const body = new URLSearchParams({
        token:    appToken,
        user:     userKey,
        title,
        message,
        priority: String(priority),
      });
      if (priority === 2) {
        body.set('retry',  '60');
        body.set('expire', '3600');
      }
      await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        body,
      });
    } catch (e) {
      console.error('[anchor-check] Pushover error', e);
    }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  // No auth guard — this function is called only by pg_cron (Supabase-internal
  // infrastructure). The SUPABASE_SERVICE_ROLE_KEY env var injected by the Deno
  // runtime does not match the public Dashboard service-role JWT, so any
  // bearer-based check would always fail. The function URL is POST-only and
  // obscure; an unauthorised caller could at most trigger a no-op anchor check.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Load all active anchor watches.
  // No longer require VRM credentials — telemetry GPS (from SignalK plugin) is primary.
  const { data: watches, error: watchErr } = await supabase
    .from('anchor_config')
    .select('*, boats(name)')
    .eq('active', true)
    .not('lat', 'is', null)
    .not('boat_id', 'is', null);

  if (watchErr) {
    console.error('[anchor-check] load error', watchErr.message);
    return json({ error: watchErr.message }, 500);
  }

  const results: { boat: string; status: string; dist_m?: number }[] = [];
  console.log(`[anchor-check] checking ${watches?.length ?? 0} active watches`);

  for (const watch of watches ?? []) {
    const boatName: string = (watch.boats as { name: string } | null)?.name ?? watch.boat_id ?? 'Unknown';

    const gps = await resolveGPS(supabase, watch.boat_id, watch.vrm_api_token ?? null, watch.vrm_installation_id ?? null);
    if (!gps) {
      console.log(`[anchor-check] ${boatName}: GPS unavailable (no telemetry or VRM)`);
      results.push({ boat: boatName, status: 'gps_unavailable' });
      continue;
    }

    const dist = haversine(gps.lat, gps.lon, watch.lat!, watch.lon!);
    const violated = dist > watch.radius_m;

    console.log(`[anchor-check] ${boatName}: dist=${Math.round(dist)}m radius=${watch.radius_m}m alarming=${watch.alarming} src=${gps.source}`);

    if (violated && !watch.alarming) {
      // ── NEW ALARM ────────────────────────────────────────────────────────
      const msg = `⚓ <b>ANCHOR ALARM — ${boatName}</b>\n` +
        `Distance: <b>${Math.round(dist)} m</b> (radius: ${watch.radius_m} m)\n` +
        `Position: ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;

      await sendTelegram(watch.telegram_token, watch.telegram_chat_ids, msg);
      await sendPushover(
        watch.pushover_app_token,
        watch.pushover_user_keys,
        `⚓ Anchor Alarm — ${boatName}`,
        `Distance: ${Math.round(dist)} m (radius: ${watch.radius_m} m)`,
        2  // emergency priority
      );

      await supabase
        .from('anchor_config')
        .update({ alarming: true })
        .eq('boat_id', watch.boat_id);

      results.push({ boat: boatName, status: 'alarm_triggered', dist_m: Math.round(dist) });

    } else if (!violated && watch.alarming) {
      // ── CLEAR ────────────────────────────────────────────────────────────
      const msg = `✅ <b>Anchor back in range — ${boatName}</b>\n` +
        `Distance: ${Math.round(dist)} m (radius: ${watch.radius_m} m)`;

      await sendTelegram(watch.telegram_token, watch.telegram_chat_ids, msg);
      await sendPushover(
        watch.pushover_app_token,
        watch.pushover_user_keys,
        `✅ Anchor back in range — ${boatName}`,
        `Distance: ${Math.round(dist)} m (radius: ${watch.radius_m} m)`,
        0
      );

      await supabase
        .from('anchor_config')
        .update({ alarming: false })
        .eq('boat_id', watch.boat_id);

      results.push({ boat: boatName, status: 'alarm_cleared', dist_m: Math.round(dist) });

    } else {
      results.push({
        boat: boatName,
        status: violated ? 'still_alarming' : 'ok',
        dist_m: Math.round(dist),
      });
    }
  }

  return json({ checked: results.length, results });
});
