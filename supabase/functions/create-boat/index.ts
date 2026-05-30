/**
 * create-boat — Supabase Edge Function
 *
 * Creates a new boat and makes the caller its admin.
 * Uses service role to bypass RLS — auth is verified via JWT.
 *
 * POST body: { name: string }
 * Returns:   { ok: true, boatId: string }
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Verify caller's JWT
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (!user || authErr) return json({ error: 'Unauthorized' }, 403);

  let body: { name?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }

  const name = (body.name ?? '').trim();
  if (!name) return json({ error: 'Boat name is required' }, 400);

  try {
    // Create boat with service role (bypasses RLS)
    const { data: boat, error: boatErr } = await admin
      .from('boats')
      .insert({ name, created_by: user.id })
      .select('id')
      .single();

    if (boatErr || !boat) return json({ error: boatErr?.message ?? 'Failed to create boat' }, 400);

    // Add caller as admin member
    const { error: memberErr } = await admin
      .from('boat_members')
      .insert({ boat_id: boat.id, user_id: user.id, role: 'admin' });

    if (memberErr) return json({ error: memberErr.message }, 400);

    // Create default anchor_config row
    await admin.from('anchor_config').insert({
      boat_id:       boat.id,
      active:        false,
      radius_m:      50,
      chain_length_m: 30,
      bearing_deg:   0,
      alarm_delay_s: 30,
      alarming:      false,
      cloud_enabled: false,
    });

    return json({ ok: true, boatId: boat.id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
