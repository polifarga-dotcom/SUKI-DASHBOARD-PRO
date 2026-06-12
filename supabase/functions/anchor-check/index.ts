/**
 * anchor-check — Supabase Edge Function
 *
 * Called every minute via pg_cron + pg_net.
 * Reads all active anchor watches, fetches GPS from telemetry (SignalK plugin)
 * or VRM as fallback, runs the full escalation state machine, and sends
 * Telegram/Pushover alerts with escalating repeat intervals.
 *
 * State machine (matches server.py monitor_loop behaviour):
 *   1. In range  → clear alarm if set; reset all state
 *   2. Dragging, grace period (< alarm_delay_s) → record alarm_started_at, wait
 *   3. Dragging, past grace → first alert + repeat every 15 min (≤5×), then 60 min
 *   Mute: alarm_telegram_muted=true → Pushover still fires, Telegram silent
 *
 * Multi-boat: every watch uses its own credentials from anchor_config.
 * Pushover tag is boat-specific (anchor_<first-8-chars-boat_id>) so
 * cancelling one boat's alarm never affects another.
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
// deno-lint-ignore no-explicit-any
async function resolveGPS(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  boatId: string,
  vrmToken: string | null,
  vrmInstallId: number | null
): Promise<{ lat: number; lon: number; source: string } | null> {
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

  if (vrmToken && vrmInstallId) {
    const gps = await fetchGPSFromVRM(vrmToken, vrmInstallId);
    if (gps) return { ...gps, source: 'vrm' };
  }

  return null;
}

// ── Telegram notification ─────────────────────────────────────────────────────
async function sendTelegramRaw(botToken: string, chatIds: string, text: string): Promise<void> {
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

// Cached per invocation
let _appBotToken: string | null | undefined = undefined;
async function getAppBotToken(): Promise<string | null> {
  if (_appBotToken !== undefined) return _appBotToken;
  const { data } = await admin.from('system_config').select('value').eq('key', 'telegram_bot_token').single();
  _appBotToken = data?.value ?? null;
  return _appBotToken;
}

async function sendTelegram(
  legacyToken: string | null,
  legacyChatIds: string | null,
  text: string,
  boatId: string
): Promise<void> {
  // Prefer app-wide bot subscribers
  const appToken = await getAppBotToken();
  if (appToken) {
    const { data: subs } = await admin
      .from('telegram_subscribers')
      .select('chat_id')
      .eq('boat_id', boatId);
    if (subs && subs.length > 0) {
      const ids = subs.map((s: any) => s.chat_id).join(',');
      await sendTelegramRaw(appToken, ids, text);
      return;
    }
  }
  // Legacy fallback: per-boat token
  if (legacyToken && legacyChatIds) {
    await sendTelegramRaw(legacyToken, legacyChatIds, text);
  }
}

// ── Pushover notification ─────────────────────────────────────────────────────
async function sendPushover(
  appToken: string | null,
  userKeys: string | null,
  title: string,
  message: string,
  priority = 1,
  tag?: string
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
      if (tag) body.set('tags', tag);
      await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        body,
      });
    } catch (e) {
      console.error('[anchor-check] Pushover error', e);
    }
  }
}

// ── Pushover cancel-by-tag (clears all emergency notifications for that tag) ──
async function cancelPushoverByTag(appToken: string | null, tag: string): Promise<void> {
  if (!appToken) return;
  try {
    await fetch('https://api.pushover.net/1/cancel/bysearch.json', {
      method: 'POST',
      body: new URLSearchParams({ token: appToken, tag }),
    });
  } catch (e) {
    console.error('[anchor-check] Pushover cancel error for tag', tag, e);
  }
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

  // Load all active anchor watches.
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
    const dragging = dist > watch.radius_m;

    // Boat-specific Pushover tag — ensures cancel only affects this boat's alarms.
    const pushoverTag = `anchor_${String(watch.boat_id).substring(0, 8)}`;

    const nowMs = Date.now();
    const alarmDelaySec = watch.alarm_delay_s ?? 60;

    console.log(
      `[anchor-check] ${boatName}: dist=${Math.round(dist)}m radius=${watch.radius_m}m ` +
      `dragging=${dragging} alarming=${watch.alarming} muted=${watch.alarm_telegram_muted} ` +
      `count=${watch.alarm_notify_count ?? 0} src=${gps.source}`
    );

    // ── STATE 1: Back in range ────────────────────────────────────────────────
    if (!dragging) {
      if (watch.alarming) {
        // All-clear: cancel Pushover emergency + send Telegram clear
        await cancelPushoverByTag(watch.pushover_app_token, pushoverTag);

        const msg =
          `✅ <b>Anchor back in range — ${boatName}</b>\n` +
          `Distance: ${Math.round(dist)} m (radius: ${watch.radius_m} m)`;
        await sendTelegram(watch.telegram_token, watch.telegram_chat_ids, msg, watch.boat_id);
        await sendPushover(
          watch.pushover_app_token,
          watch.pushover_user_keys,
          `✅ Anchor back in range — ${boatName}`,
          `Distance: ${Math.round(dist)} m (radius: ${watch.radius_m} m)`,
          0
        );

        await supabase.from('anchor_config').update({
          alarming: false,
          alarm_started_at: null,
          alarm_notify_count: 0,
          alarm_next_notify_at: null,
          alarm_telegram_muted: false,
        }).eq('boat_id', watch.boat_id);

        results.push({ boat: boatName, status: 'alarm_cleared', dist_m: Math.round(dist) });
      } else {
        // Was in grace period or not alarming — clear any grace period start
        if (watch.alarm_started_at) {
          await supabase.from('anchor_config')
            .update({ alarm_started_at: null })
            .eq('boat_id', watch.boat_id);
        }
        results.push({ boat: boatName, status: 'ok', dist_m: Math.round(dist) });
      }
      continue;
    }

    // ── STATE 2: Dragging — start or check grace period ───────────────────────
    let alarmStartedAt = watch.alarm_started_at
      ? new Date(watch.alarm_started_at).getTime()
      : null;

    if (alarmStartedAt == null) {
      // First time we detect drag — record start time, wait for next tick
      await supabase.from('anchor_config')
        .update({ alarm_started_at: new Date(nowMs).toISOString() })
        .eq('boat_id', watch.boat_id);
      results.push({ boat: boatName, status: 'grace_period', dist_m: Math.round(dist) });
      continue;
    }

    const elapsedSec = (nowMs - alarmStartedAt) / 1000;
    if (elapsedSec < alarmDelaySec) {
      results.push({ boat: boatName, status: 'grace_period', dist_m: Math.round(dist) });
      continue;
    }

    // ── STATE 3: Dragging, past grace period — fire or escalate ───────────────
    const notifyCount = watch.alarm_notify_count ?? 0;
    const nextNotifyAt = watch.alarm_next_notify_at
      ? new Date(watch.alarm_next_notify_at).getTime()
      : null;

    const shouldNotify =
      notifyCount === 0 ||
      (nextNotifyAt != null && nowMs >= nextNotifyAt);

    if (shouldNotify) {
      const msg =
        `⚓ <b>ANCHOR ALARM — ${boatName}</b>\n` +
        `Distance: <b>${Math.round(dist)} m</b> (radius: ${watch.radius_m} m)\n` +
        `Position: ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` +
        (notifyCount > 0 ? `\nAlert #${notifyCount + 1}` : '');

      // Telegram: skip if muted
      if (!watch.alarm_telegram_muted) {
        await sendTelegram(watch.telegram_token, watch.telegram_chat_ids, msg, watch.boat_id);
      }

      // Pushover: always fire (emergency priority with tag for cancel-on-clear)
      await sendPushover(
        watch.pushover_app_token,
        watch.pushover_user_keys,
        `⚓ Anchor Alarm — ${boatName}`,
        `Distance: ${Math.round(dist)} m (radius: ${watch.radius_m} m)` +
          (notifyCount > 0 ? ` · Alert #${notifyCount + 1}` : ''),
        2,
        pushoverTag
      );

      const newCount = notifyCount + 1;
      // Escalation schedule: first 5 alerts every 15 min, then every 60 min
      const nextIntervalMs = newCount <= 5 ? 15 * 60 * 1000 : 60 * 60 * 1000;
      const nextNotify = new Date(nowMs + nextIntervalMs).toISOString();

      await supabase.from('anchor_config').update({
        alarming: true,
        alarm_notify_count: newCount,
        alarm_next_notify_at: nextNotify,
      }).eq('boat_id', watch.boat_id);

      results.push({ boat: boatName, status: 'alarm_triggered', dist_m: Math.round(dist) });
    } else {
      // Alarm already active, not yet time for next notification
      results.push({ boat: boatName, status: 'still_alarming', dist_m: Math.round(dist) });
    }
  }

  return json({ checked: results.length, results });
});
