/**
 * cancel-anchor-alarm — immediately silences all anchor notifications for a boat.
 *
 * Called from the Anchor UI "Silence All" button when the user wants to stop
 * all Pushover/Telegram alerts regardless of DB state. Resets alarm state and
 * cancels any active Pushover emergency by tag.
 *
 * POST { boat_id: string }  — requires valid user JWT (RLS enforced via auth check)
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Auth: verify caller is a member of the boat
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body: { boat_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { boat_id } = body;
  if (typeof boat_id !== 'string') return json({ error: 'boat_id required' }, 400);

  // Verify caller is a member of this boat
  const { data: membership } = await userClient
    .from('boat_members')
    .select('role')
    .eq('boat_id', boat_id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Load anchor config to get Pushover credentials
  const { data: cfg } = await admin
    .from('anchor_config')
    .select('pushover_app_token')
    .eq('boat_id', boat_id)
    .maybeSingle();

  // Cancel Pushover emergency by boat-specific tag
  const pushoverTag = `anchor_${boat_id.substring(0, 8)}`;
  if (cfg?.pushover_app_token) {
    try {
      await fetch('https://api.pushover.net/1/cancel/bysearch.json', {
        method: 'POST',
        body: new URLSearchParams({ token: cfg.pushover_app_token, tag: pushoverTag }),
      });
    } catch (e) {
      console.error('[cancel-anchor-alarm] Pushover cancel error:', e);
    }
  }

  // Reset alarm state — active=false stops anchor-check from re-triggering
  await admin.from('anchor_config').update({
    active: false,
    alarming: false,
    alarm_started_at: null,
    alarm_notify_count: 0,
    alarm_next_notify_at: null,
    alarm_telegram_muted: false,
  }).eq('boat_id', boat_id);

  console.log(`[cancel-anchor-alarm] silenced alarm for boat ${boat_id}`);
  return json({ ok: true });
});
