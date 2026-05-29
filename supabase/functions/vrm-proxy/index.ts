import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

serve(async (req) => {
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

  // Optional overrides from request body (for settings test-before-save)
  let overrideToken: string | undefined;
  let overrideId: number | undefined;
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (body.token) overrideToken = body.token;
      if (body.installation_id) overrideId = Number(body.installation_id);
    } catch { /* no body */ }
  }

  // Read credentials from DB
  const { data: cfg } = await supabase
    .from('anchor_config')
    .select('vrm_api_token, vrm_installation_id')
    .eq('id', 1)
    .single();

  const token = overrideToken ?? cfg?.vrm_api_token;
  const id    = overrideId    ?? cfg?.vrm_installation_id;

  if (!token || !id) {
    return new Response(
      JSON.stringify({ error: 'VRM credentials not configured' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  // Proxy to VRM API
  const vrmRes = await fetch(
    `https://vrmapi.victronenergy.com/v2/installations/${id}/diagnostics?count=1000`,
    { headers: { 'X-Authorization': `Token ${token}` } }
  );

  const data = await vrmRes.json();
  return new Response(JSON.stringify(data), {
    status: vrmRes.status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
