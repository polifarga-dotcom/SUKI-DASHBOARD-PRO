/**
 * mfd-anchor — Supabase Edge Function
 *
 * Server-to-server endpoint for the standalone "MFD Anchor" kiosk app that
 * runs on the B&G Zeus chartplotter (via a Raspberry Pi on the boat LAN).
 * That app is plain HTML/vanilla JS targeting an old QtWebEngine 5.12.9 /
 * Chrome 69 browser, so it cannot use the Supabase JS SDK or Supabase Auth
 * (both assume a modern browser). Instead it authenticates with a static
 * per-boat api key (mfd_api_key on anchor_config) via plain fetch(), the
 * same pattern signalk-ingest uses for the SignalK bridge.
 *
 * This function is a thin read/write client over anchor_config — it does
 * NOT evaluate the anchor alarm itself. Drag detection and Telegram/Pushover
 * escalation are entirely owned by the anchor-check cron function. Writing
 * anchor_config here is enough to arm/disarm the alarm system-wide, exactly
 * as the Pro app's anchor page does.
 *
 * GET  ?key=<mfd_api_key>
 *   → { boat, position, anchor }
 *
 * POST { api_key, action, ... }
 *   actions: set_anchor | drop_anchor_now | set_anchor_by_gps |
 *            update_settings | lift_anchor | clear_anchor |
 *            mute_alarm | silence_alarm
 *   → { ok: true, anchor } | { error }
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

// ── Geo helpers (mirrors src/lib/utils/geo.ts) ────────────────────────────────
const EARTH_R = 6_371_000;

function destinationPoint(lat: number, lon: number, bearingDeg: number, distM: number): [number, number] {
  const brng = (bearingDeg * Math.PI) / 180;
  const d = distM / EARTH_R;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [(lat2 * 180) / Math.PI, ((lon2 * 180) / Math.PI + 540) % 360 - 180];
}

// ── Validation helpers ─────────────────────────────────────────────────────
function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
function isValidLat(v: number | null): v is number { return v != null && v >= -90 && v <= 90; }
function isValidLon(v: number | null): v is number { return v != null && v >= -180 && v <= 180; }

// Whitelisted anchor_config fields returned to the MFD app — never the
// telegram/pushover/vrm/plugin_api_key/mfd_api_key secret columns.
function publicAnchor(cfg: Record<string, unknown>) {
  return {
    active: cfg.active,
    lat: cfg.lat,
    lon: cfg.lon,
    radius_m: cfg.radius_m,
    chain_length_m: cfg.chain_length_m,
    bearing_deg: cfg.bearing_deg,
    alarm_delay_s: cfg.alarm_delay_s,
    alarming: cfg.alarming,
    alarm_telegram_muted: cfg.alarm_telegram_muted,
    anchor_depth_at_set: cfg.anchor_depth_at_set,
  };
}

// deno-lint-ignore no-explicit-any
async function resolveBoat(supabase: any, apiKey: string) {
  const { data } = await supabase
    .from('anchor_config')
    .select('boat_id, pushover_app_token, boats(gps_to_bow_m)')
    .eq('mfd_api_key', apiKey)
    .maybeSingle();
  return data ?? null;
}

async function cancelPushoverByTag(appToken: string | null, tag: string): Promise<void> {
  if (!appToken) return;
  try {
    await fetch('https://api.pushover.net/1/cancel/bysearch.json', {
      method: 'POST',
      body: new URLSearchParams({ token: appToken, tag }),
    });
  } catch (e) {
    console.error('[mfd-anchor] Pushover cancel error:', e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── GET: current position + anchor status ───────────────────────────────
  if (req.method === 'GET') {
    const key = new URL(req.url).searchParams.get('key');
    if (!key) return json({ error: 'key required' }, 400);

    const boat = await resolveBoat(supabase, key);
    if (!boat?.boat_id) return json({ error: 'Unauthorized' }, 401);

    const [{ data: tel }, { data: cfg }] = await Promise.all([
      supabase.from('telemetry')
        .select('nav_lat, nav_lon, nav_hdg_rad, env_awa_rad, env_aws_ms, env_depth_m, updated_at')
        .eq('boat_id', boat.boat_id)
        .maybeSingle(),
      supabase.from('anchor_config')
        .select('active, lat, lon, radius_m, chain_length_m, bearing_deg, alarm_delay_s, alarming, alarm_telegram_muted, anchor_depth_at_set')
        .eq('boat_id', boat.boat_id)
        .maybeSingle(),
    ]);

    const ageS = tel?.updated_at ? Math.round((Date.now() - new Date(tel.updated_at).getTime()) / 1000) : null;
    const rad2deg = (r: number | null) => (r == null ? null : ((r * 180) / Math.PI + 360) % 360);
    const ms2kn = (ms: number | null) => (ms == null ? null : +(ms * 1.94384).toFixed(1));

    return json({
      boat: { gps_to_bow_m: boat.boats?.gps_to_bow_m ?? 0 },
      position: tel ? {
        lat: tel.nav_lat, lon: tel.nav_lon,
        hdg_deg: rad2deg(tel.nav_hdg_rad),
        awa_deg: rad2deg(tel.env_awa_rad),
        aws_kn: ms2kn(tel.env_aws_ms),
        depth_m: tel.env_depth_m,
        updated_at: tel.updated_at,
        age_s: ageS,
      } : null,
      anchor: cfg ? publicAnchor(cfg) : null,
    });
  }

  if (req.method !== 'POST') return json({ error: 'GET or POST only' }, 405);

  // ── POST: apply an action ────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const apiKey = body.api_key;
  const action = body.action;
  if (typeof apiKey !== 'string' || !apiKey) return json({ error: 'api_key required' }, 400);
  if (typeof action !== 'string') return json({ error: 'action required' }, 400);

  const boat = await resolveBoat(supabase, apiKey);
  if (!boat?.boat_id) return json({ error: 'Unauthorized' }, 401);
  const boatId = boat.boat_id as string;
  const gpsToBowM = (boat.boats?.gps_to_bow_m as number | undefined) ?? 0;

  let patch: Record<string, unknown> | null = null;

  switch (action) {
    case 'set_anchor': {
      const lat = num(body.lat), lon = num(body.lon);
      if (!isValidLat(lat) || !isValidLon(lon)) return json({ error: 'lat/lon required' }, 400);
      patch = {
        lat, lon, active: true, alarming: false,
        radius_m: clamp(num(body.radius_m) ?? 50, 10, 300),
        chain_length_m: clamp(num(body.chain_length_m) ?? 0, 0, 150),
        bearing_deg: ((num(body.bearing_deg) ?? 0) % 360 + 360) % 360,
        anchor_depth_at_set: num(body.anchor_depth_at_set),
      };
      break;
    }
    case 'drop_anchor_now': {
      const boatLat = num(body.lat), boatLon = num(body.lon);
      if (!isValidLat(boatLat) || !isValidLon(boatLon)) return json({ error: 'lat/lon required' }, 400);
      const hdgDeg = num(body.hdg_deg) ?? 0;
      const depthM = num(body.depth_m);
      const [ancLat, ancLon] = gpsToBowM > 0
        ? destinationPoint(boatLat, boatLon, hdgDeg, gpsToBowM)
        : [boatLat, boatLon];
      const autoRadius = depthM != null && depthM > 0 ? Math.round(depthM * 6) : 30;
      patch = {
        lat: ancLat, lon: ancLon, active: true, alarming: false,
        chain_length_m: 0,
        radius_m: clamp(autoRadius, 10, 300),
        bearing_deg: ((Math.round(hdgDeg) % 360) + 360) % 360,
        anchor_depth_at_set: depthM,
      };
      break;
    }
    case 'set_anchor_by_gps': {
      const lat = num(body.lat), lon = num(body.lon);
      if (!isValidLat(lat) || !isValidLon(lon)) return json({ error: 'lat/lon required' }, 400);
      patch = { lat, lon, active: true, alarming: false, anchor_depth_at_set: num(body.anchor_depth_at_set) };
      break;
    }
    case 'update_settings': {
      patch = {};
      if (body.radius_m !== undefined) patch.radius_m = clamp(num(body.radius_m) ?? 50, 10, 300);
      if (body.chain_length_m !== undefined) patch.chain_length_m = clamp(num(body.chain_length_m) ?? 0, 0, 150);
      if (body.bearing_deg !== undefined) patch.bearing_deg = ((num(body.bearing_deg) ?? 0) % 360 + 360) % 360;
      if (Object.keys(patch).length === 0) return json({ error: 'no settings provided' }, 400);
      break;
    }
    case 'lift_anchor':
    case 'clear_anchor': {
      patch = { active: false, alarming: false };
      break;
    }
    case 'mute_alarm': {
      patch = { alarm_telegram_muted: true };
      break;
    }
    case 'silence_alarm': {
      const pushoverTag = `anchor_${boatId.substring(0, 8)}`;
      await cancelPushoverByTag((boat.pushover_app_token as string | null) ?? null, pushoverTag);
      patch = {
        active: false, alarming: false,
        alarm_started_at: null, alarm_notify_count: 0,
        alarm_next_notify_at: null, alarm_telegram_muted: false,
      };
      break;
    }
    default:
      return json({ error: `Unknown action: ${action}` }, 400);
  }

  const { data: updated, error } = await supabase
    .from('anchor_config')
    .update(patch)
    .eq('boat_id', boatId)
    .select('active, lat, lon, radius_m, chain_length_m, bearing_deg, alarm_delay_s, alarming, alarm_telegram_muted, anchor_depth_at_set')
    .single();

  if (error) {
    console.error('[mfd-anchor] update error:', error.message);
    return json({ error: error.message }, 500);
  }

  console.log(`[mfd-anchor] boat=${boatId} action=${action}`);
  return json({ ok: true, anchor: publicAnchor(updated) });
});
