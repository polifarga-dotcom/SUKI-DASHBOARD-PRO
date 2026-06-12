/**
 * send-test-notification
 *
 * Called by the Settings page "Send test message" buttons.
 * Reads credentials from anchor_config for the user's current boat
 * and sends a test message via Telegram or Pushover.
 *
 * POST body: { boat_id: string, channel: 'telegram' | 'pushover' }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function sendTelegramRaw(botToken: string, chatIds: string, boatName: string): Promise<string[]> {
  const ids = chatIds.split(',').map(s => s.trim()).filter(Boolean);
  const errors: string[] = [];
  for (const chatId of ids) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `⚓ <b>SUKI Dashboard Pro</b>\nTest message for <b>${boatName}</b> — Telegram notifications are working!`,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      errors.push(`Chat ${chatId}: ${res.status} ${body}`);
    }
  }
  return errors;
}

async function sendTelegram(
  supaAdmin: ReturnType<typeof createClient>,
  boatId: string,
  legacyToken: string | null,
  legacyChatIds: string | null,
  boatName: string
): Promise<string[]> {
  // Try app-wide bot + subscribers first
  const { data: tokenRow } = await supaAdmin.from('system_config').select('value').eq('key', 'telegram_bot_token').single();
  const appToken: string | null = tokenRow?.value ?? null;
  if (appToken) {
    const { data: subs } = await supaAdmin.from('telegram_subscribers').select('chat_id').eq('boat_id', boatId);
    if (subs && subs.length > 0) {
      const ids = subs.map((s: any) => s.chat_id).join(',');
      return sendTelegramRaw(appToken, ids, boatName);
    }
  }
  // Legacy fallback
  if (legacyToken && legacyChatIds) return sendTelegramRaw(legacyToken, legacyChatIds, boatName);
  return ['No Telegram subscribers found. Open @SukiProBot and send /start to subscribe.'];
}

async function sendPushover(appToken: string, userKeys: string, boatName: string): Promise<string[]> {
  const keys = userKeys.split(',').map(s => s.trim()).filter(Boolean);
  const errors: string[] = [];
  for (const userKey of keys) {
    const body = new URLSearchParams({
      token:   appToken,
      user:    userKey,
      title:   'SUKI Dashboard Pro',
      message: `Test message for ${boatName} — Pushover notifications are working!`,
      priority: '0',
    });
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body,
    });
    if (!res.ok) {
      const b = await res.text();
      errors.push(`Key ${userKey.substring(0, 6)}…: ${res.status} ${b}`);
    }
  }
  return errors;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return err('POST only', 405);

  // Auth — require valid JWT
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return err('Unauthorized', 401);

  let body: { boat_id?: string; channel?: string };
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const { boat_id, channel } = body;
  if (!boat_id) return err('boat_id required');
  if (channel !== 'telegram' && channel !== 'pushover') return err('channel must be telegram or pushover');

  // Verify user is a member of this boat
  const { data: member } = await supabase
    .from('boat_members')
    .select('role')
    .eq('boat_id', boat_id)
    .eq('user_id', user.id)
    .single();
  if (!member) return err('Forbidden', 403);

  // Read credentials from anchor_config
  const supaAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const { data: cfg, error: cfgErr } = await supaAdmin
    .from('anchor_config')
    .select('telegram_token, telegram_chat_ids, pushover_app_token, pushover_user_keys')
    .eq('boat_id', boat_id)
    .single();
  if (cfgErr || !cfg) return err('Boat config not found');

  // Get boat name for the message
  const { data: boat } = await supaAdmin.from('boats').select('name').eq('id', boat_id).single();
  const boatName = boat?.name ?? 'your boat';

  let errors: string[] = [];

  if (channel === 'telegram') {
    errors = await sendTelegram(supaAdmin, boat_id, cfg.telegram_token, cfg.telegram_chat_ids, boatName);
  } else {
    if (!cfg.pushover_app_token || !cfg.pushover_user_keys) return err('Pushover not configured');
    errors = await sendPushover(cfg.pushover_app_token, cfg.pushover_user_keys, boatName);
  }

  if (errors.length > 0) {
    return new Response(JSON.stringify({ ok: false, errors }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
