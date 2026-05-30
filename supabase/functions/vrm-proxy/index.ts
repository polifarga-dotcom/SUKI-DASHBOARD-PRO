import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401, headers: CORS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Verify caller is an authenticated user
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', '')
  );
  if (authErr || !user) return new Response('Unauthorized', { status: 401, headers: CORS });

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

  // Read credentials from DB
  const { data: cfg } = await supabase
    .from('anchor_config')
    .select('vrm_api_token, vrm_installation_id')
    .eq('id', 1)
    .single();

  const token = overrideToken ?? cfg?.vrm_api_token;
  const id    = overrideId   ?? cfg?.vrm_installation_id;

  if (!token) {
    return new Response(
      JSON.stringify({ error: 'VRM API token not configured' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  const vrmHeaders = { 'X-Authorization': `Token ${token}` };

  // ── Discover installations for this account ──────────────────────────────
  if (action === 'discover') {
    // 1. Get user ID
    const meRes = await fetch('https://vrmapi.victronenergy.com/v2/users/me', { headers: vrmHeaders });
    if (!meRes.ok) {
      const txt = await meRes.text();
      return new Response(
        JSON.stringify({ error: `VRM /users/me failed: ${meRes.status} ${txt}` }),
        { status: meRes.status, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }
    const meJson = await meRes.json();
    const userId = meJson?.user?.id;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Could not read user ID from VRM' }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Get installations list
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
  if (!id) {
    return new Response(
      JSON.stringify({ error: 'VRM installation ID not configured' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  const vrmRes = await fetch(
    `https://vrmapi.victronenergy.com/v2/installations/${id}/diagnostics?count=1000`,
    { headers: vrmHeaders }
  );
  const data = await vrmRes.json();
  return new Response(JSON.stringify(data), {
    status: vrmRes.status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
