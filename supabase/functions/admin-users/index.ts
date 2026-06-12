/**
 * admin-users — Supabase Edge Function
 *
 * Requires the caller to have is_superadmin = true in user_roles.
 *
 * GET  /admin-users          → list all users with roles + boat memberships
 * POST /admin-users          → actions: set_superadmin | reset_password | remove_from_boat
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

async function callerIsSuperAdmin(authHeader: string): Promise<string | null> {
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return null;
  const { data: role } = await admin
    .from('user_roles')
    .select('is_superadmin')
    .eq('user_id', user.id)
    .single();
  if (!role?.is_superadmin) return null;
  return user.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const authHeader = req.headers.get('authorization') ?? '';
  const callerId = await callerIsSuperAdmin(authHeader);
  if (!callerId) return json({ error: 'Forbidden' }, 403);

  // ── GET: list all users ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data: { users: authUsers }, error: authErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (authErr) return json({ error: authErr.message }, 500);

    const { data: roles } = await admin.from('user_roles').select('user_id, role, is_superadmin, force_password_change');
    const roleMap = Object.fromEntries((roles ?? []).map((r: { user_id: string; role: string; is_superadmin: boolean; force_password_change: boolean }) => [r.user_id, r]));

    const { data: members } = await admin
      .from('boat_members')
      .select('user_id, role, boat_id, boats(id, name)');

    const membersByUser: Record<string, { boat_id: string; boat_name: string; role: string }[]> = {};
    for (const m of (members ?? []) as Array<{ user_id: string; role: string; boat_id: string; boats: { id: string; name: string } | null }>) {
      if (!membersByUser[m.user_id]) membersByUser[m.user_id] = [];
      membersByUser[m.user_id].push({
        boat_id: m.boat_id,
        boat_name: m.boats?.name ?? m.boat_id,
        role: m.role,
      });
    }

    const result = authUsers.map(u => ({
      id: u.id,
      email: u.email ?? '',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      role: roleMap[u.id]?.role ?? null,
      is_superadmin: roleMap[u.id]?.is_superadmin ?? false,
      force_password_change: roleMap[u.id]?.force_password_change ?? false,
      boats: membersByUser[u.id] ?? [],
    }));

    result.sort((a, b) => {
      if (a.is_superadmin !== b.is_superadmin) return a.is_superadmin ? -1 : 1;
      const ta = a.last_sign_in_at ? new Date(a.last_sign_in_at).getTime() : 0;
      const tb = b.last_sign_in_at ? new Date(b.last_sign_in_at).getTime() : 0;
      return tb - ta;
    });

    // ── Boat connection status ─────────────────────────────────────────────
    // Collect all boat_ids across memberships
    const allBoatIds = [...new Set((members ?? []).map((m: any) => m.boat_id))];

    const [{ data: configs }, { data: telRows }] = await Promise.all([
      admin.from('anchor_config').select(
        'boat_id, plugin_api_key, vrm_api_token, vrm_installation_id, telegram_token, telegram_chat_ids, pushover_app_token, pushover_user_keys'
      ).in('boat_id', allBoatIds),
      admin.from('telemetry').select('boat_id, updated_at').in('boat_id', allBoatIds),
    ]);

    const cfgMap: Record<string, any> = Object.fromEntries((configs ?? []).map((c: any) => [c.boat_id, c]));
    const telMap: Record<string, string> = Object.fromEntries((telRows ?? []).map((t: any) => [t.boat_id, t.updated_at]));

    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const boatStatus: Record<string, { signalk: boolean; vrm: boolean; telegram: boolean; pushover: boolean; telemetry_at: string | null }> = {};
    for (const bid of allBoatIds) {
      const c = cfgMap[bid] ?? {};
      const telAt = telMap[bid] ?? null;
      boatStatus[bid] = {
        signalk:  !!(c.plugin_api_key) && !!(telAt) && new Date(telAt).getTime() > fiveMinAgo,
        vrm:      !!(c.vrm_api_token) && !!(c.vrm_installation_id),
        telegram: !!(c.telegram_token) && !!(c.telegram_chat_ids),
        pushover: !!(c.pushover_app_token) && !!(c.pushover_user_keys),
        telemetry_at: telAt,
      };
    }

    return json({ users: result, boatStatus });
  }

  // ── POST: actions ────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = await req.json();
    const { action, user_id, value, boat_id, token } = body;

    // ── Bot token read/write ───────────────────────────────────────────────
    if (action === 'get_bot_token') {
      const { data } = await admin.from('system_config').select('value').eq('key', 'telegram_bot_token').single();
      return json({ token: data?.value ?? '' });
    }

    if (action === 'set_bot_token') {
      if (!token) return json({ error: 'token required' }, 400);
      // Verify token via Telegram getMe
      let username: string | null = null;
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const tg = await res.json();
        if (tg.ok) username = tg.result.username ?? null;
        else return json({ error: `Telegram: ${tg.description}` }, 400);
      } catch {
        return json({ error: 'Could not reach Telegram API' }, 502);
      }
      await admin.from('system_config').upsert({ key: 'telegram_bot_token', value: token }, { onConflict: 'key' });
      return json({ ok: true, username });
    }

    if (!user_id) return json({ error: 'user_id required' }, 400);

    if (action === 'set_superadmin') {
      if (user_id === callerId) return json({ error: 'Cannot change your own superadmin status' }, 400);
      const { error } = await admin
        .from('user_roles')
        .update({ is_superadmin: !!value })
        .eq('user_id', user_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'reset_password') {
      const { error } = await admin
        .from('user_roles')
        .update({ force_password_change: true })
        .eq('user_id', user_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'remove_from_boat') {
      if (!boat_id) return json({ error: 'boat_id required' }, 400);
      const { error } = await admin
        .from('boat_members')
        .delete()
        .eq('user_id', user_id)
        .eq('boat_id', boat_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  }

  return json({ error: 'Method not allowed' }, 405);
});
