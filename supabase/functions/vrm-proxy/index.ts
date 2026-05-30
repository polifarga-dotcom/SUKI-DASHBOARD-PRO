import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function errResp(msg: string, status = 500) {
  console.error('[vrm-proxy]', msg);
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  console.log('[vrm-proxy] incoming', req.method);

  // Always handle CORS preflight first
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errResp('Unauthorized', 401);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Verify caller is an authenticated user
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (authErr || !user) {
      console.log('[vrm-proxy] auth failed', authErr?.message);
      return errResp('Unauthorized', 401);
    }
    console.log('[vrm-proxy] authenticated user', user.id);

    // Parse request body
    let action = 'diagnostics';
    let overrideToken: string | undefined;
    let overrideId: number | undefined;
    try {
      const body = await req.json();
      if (body.action) action = body.action;
      if (body.token) overrideToken = body.token;
      if (body.installation_id) overrideId = Number(body.installation_id);
    } catch { /* no body — use defaults */ }

    console.log('[vrm-proxy] action', action);

    // Read credentials from DB
    const { data: cfg, error: cfgErr } = await supabase
      .from('anchor_config')
      .select('vrm_api_token, vrm_installation_id')
      .eq('id', 1)
      .single();

    if (cfgErr) console.log('[vrm-proxy] cfg error', cfgErr.message);

    const token = overrideToken ?? cfg?.vrm_api_token;
    const id    = overrideId   ?? cfg?.vrm_installation_id;

    if (!token) return errResp('VRM API token not configured', 400);

    const vrmHeaders = { 'X-Authorization': `Token ${token}` };

    // ── Discover installations ───────────────────────────────────────────────
    if (action === 'discover') {
      const meRes = await fetch('https://vrmapi.victronenergy.com/v2/users/me', { headers: vrmHeaders });
      if (!meRes.ok) {
        return errResp(`VRM /users/me failed: ${meRes.status}`, meRes.status);
      }
      const meJson = await meRes.json();
      const userId = meJson?.user?.id;
      if (!userId) return errResp('Could not read VRM user ID', 502);

      const instRes = await fetch(
        `https://vrmapi.victronenergy.com/v2/users/${userId}/installations`,
        { headers: vrmHeaders }
      );
      const instJson = await instRes.json();
      return new Response(JSON.stringify(instJson), {
        status: instRes.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── Diagnostics (default) ────────────────────────────────────────────────
    if (!id) return errResp('VRM installation ID not configured', 400);

    console.log('[vrm-proxy] fetching diagnostics for installation', id);
    const vrmRes = await fetch(
      `https://vrmapi.victronenergy.com/v2/installations/${id}/diagnostics?count=1000`,
      { headers: vrmHeaders }
    );
    const data = await vrmRes.json();
    console.log('[vrm-proxy] VRM status', vrmRes.status, 'records', data?.records?.length ?? 'n/a');

    return new Response(JSON.stringify(data), {
      status: vrmRes.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return errResp(`Unhandled error: ${msg}`, 500);
  }
});
