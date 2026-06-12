/**
 * telegram-webhook — receives updates from Telegram for @SukiProBot
 *
 * No JWT required — Telegram calls this endpoint directly.
 *
 * Commands:
 *   /start <boat_code>  → subscribe chat to anchor alerts for that boat
 *   /stop               → unsubscribe this chat from all boats
 *   /mute               → mute Telegram alerts for boat (Pushover still fires)
 *   /unmute             → re-enable Telegram alerts
 *   /status             → show current subscription status
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function getBotToken(): Promise<string | null> {
  const { data } = await admin.from('system_config').select('value').eq('key', 'telegram_bot_token').single();
  return data?.value ?? null;
}

async function sendReply(botToken: string, chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('ok', { status: 200 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const msg = update?.message;
  if (!msg) return new Response('ok', { status: 200 });

  const chatId = msg.chat?.id;
  const text: string = msg.text ?? '';
  const firstName: string = msg.from?.first_name ?? '';

  if (!chatId) return new Response('ok', { status: 200 });

  const botToken = await getBotToken();
  if (!botToken) return new Response('ok', { status: 200 });

  const chatIdStr = String(chatId);

  // ── /start <boat_code> ──────────────────────────────────────────────────
  if (text.startsWith('/start')) {
    const parts = text.trim().split(/\s+/);
    const boatCode = parts[1] ?? '';

    if (!boatCode) {
      await sendReply(botToken, chatId,
        '⚓ <b>SUKI PRO</b>\n\nHello! To receive anchor alerts, open the SUKI app → Settings → Telegram and tap <b>Add subscriber</b>.');
      return new Response('ok', { status: 200 });
    }

    // Look up boat by plugin_api_key
    const { data: cfg } = await admin
      .from('anchor_config')
      .select('boat_id, boats(name)')
      .eq('plugin_api_key', boatCode)
      .maybeSingle();

    if (!cfg) {
      await sendReply(botToken, chatId,
        '❌ Invalid activation code. Please check the link in your SUKI app.');
      return new Response('ok', { status: 200 });
    }

    const boatName = (cfg.boats as any)?.name ?? 'your boat';

    // Upsert subscriber
    await admin.from('telegram_subscribers').upsert({
      boat_id: cfg.boat_id,
      chat_id: chatIdStr,
      label: firstName || null,
    }, { onConflict: 'boat_id,chat_id' });

    await sendReply(botToken, chatId,
      `✅ <b>Subscribed!</b>\n\nYou'll now receive anchor alarm notifications for <b>${boatName}</b>.\n\n` +
      `Send /stop to unsubscribe or /mute to silence Telegram alerts temporarily.`);
    return new Response('ok', { status: 200 });
  }

  // ── /stop ───────────────────────────────────────────────────────────────
  if (text.startsWith('/stop')) {
    const { count } = await admin
      .from('telegram_subscribers')
      .delete({ count: 'exact' })
      .eq('chat_id', chatIdStr);

    if (count && count > 0) {
      await sendReply(botToken, chatId, '🔕 You have been unsubscribed from all SUKI anchor alerts.');
    } else {
      await sendReply(botToken, chatId, 'You are not currently subscribed to any SUKI alerts.');
    }
    return new Response('ok', { status: 200 });
  }

  // ── /mute ───────────────────────────────────────────────────────────────
  if (text.startsWith('/mute')) {
    const { data: sub } = await admin
      .from('telegram_subscribers')
      .select('boat_id, boats(name)')
      .eq('chat_id', chatIdStr)
      .maybeSingle();

    if (!sub) {
      await sendReply(botToken, chatId, 'You are not subscribed to any SUKI alerts.');
      return new Response('ok', { status: 200 });
    }

    await admin.from('anchor_config').update({ alarm_telegram_muted: true }).eq('boat_id', sub.boat_id);
    const boatName = (sub.boats as any)?.name ?? 'your boat';
    await sendReply(botToken, chatId,
      `🔇 Telegram alerts muted for <b>${boatName}</b>. Pushover notifications remain active.\n\nSend /unmute to re-enable.`);
    return new Response('ok', { status: 200 });
  }

  // ── /unmute ─────────────────────────────────────────────────────────────
  if (text.startsWith('/unmute')) {
    const { data: sub } = await admin
      .from('telegram_subscribers')
      .select('boat_id, boats(name)')
      .eq('chat_id', chatIdStr)
      .maybeSingle();

    if (!sub) {
      await sendReply(botToken, chatId, 'You are not subscribed to any SUKI alerts.');
      return new Response('ok', { status: 200 });
    }

    await admin.from('anchor_config').update({ alarm_telegram_muted: false }).eq('boat_id', sub.boat_id);
    const boatName = (sub.boats as any)?.name ?? 'your boat';
    await sendReply(botToken, chatId, `🔔 Telegram alerts re-enabled for <b>${boatName}</b>.`);
    return new Response('ok', { status: 200 });
  }

  // ── /status ─────────────────────────────────────────────────────────────
  if (text.startsWith('/status')) {
    const { data: subs } = await admin
      .from('telegram_subscribers')
      .select('boat_id, boats(name), anchor_config(alarm_telegram_muted)')
      .eq('chat_id', chatIdStr);

    if (!subs || subs.length === 0) {
      await sendReply(botToken, chatId, 'You are not subscribed to any SUKI alerts.');
      return new Response('ok', { status: 200 });
    }

    const lines = subs.map((s: any) => {
      const muted = s.anchor_config?.alarm_telegram_muted;
      return `⚓ <b>${s.boats?.name ?? s.boat_id}</b> — ${muted ? '🔇 muted' : '🔔 active'}`;
    });
    await sendReply(botToken, chatId, `Your SUKI subscriptions:\n\n${lines.join('\n')}`);
    return new Response('ok', { status: 200 });
  }

  // ── Unknown command ──────────────────────────────────────────────────────
  await sendReply(botToken, chatId,
    '⚓ <b>SUKI PRO Bot</b>\n\nAvailable commands:\n' +
    '/stop — unsubscribe from alerts\n' +
    '/mute — silence Telegram alerts\n' +
    '/unmute — re-enable alerts\n' +
    '/status — show your subscriptions');

  return new Response('ok', { status: 200 });
});
