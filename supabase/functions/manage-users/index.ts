/**
 * manage-users — Supabase Edge Function
 *
 * Manages crew for a specific boat.
 * The caller must be an admin of the given boat_id.
 * Falls back to user_roles admin check for SUKI legacy compatibility.
 *
 * boat_id is passed via:
 *   - GET/DELETE: x-boat-id header
 *   - POST/PATCH: body.boat_id field
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-boat-id',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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

/**
 * Verifies the caller is an admin of the given boat.
 * Also accepts legacy user_roles admins (for SUKI backward compat).
 * Returns caller's user_id on success, null otherwise.
 */
async function callerIsAdmin(authHeader: string, boatId: string | null): Promise<string | null> {
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return null;

  if (boatId) {
    const { data: member } = await admin
      .from('boat_members')
      .select('role')
      .eq('boat_id', boatId)
      .eq('user_id', user.id)
      .single();
    if (member?.role === 'admin') return user.id;
  }

  // Legacy fallback: user_roles admin (SUKI)
  const { data: roleRow } = await admin
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .single();
  return roleRow?.role === 'admin' ? user.id : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const boatIdHeader = req.headers.get('x-boat-id') ?? null;

  // For POST/PATCH/DELETE we parse body first to get boat_id
  let body: Record<string, unknown> = {};
  if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
    try { body = await req.json(); } catch { /* empty body */ }
  }
  const boatId: string | null = (body.boat_id as string | undefined) ?? boatIdHeader;

  const callerId = await callerIsAdmin(req.headers.get('Authorization') ?? '', boatId);
  if (!callerId) return json({ error: 'Unauthorized' }, 403);

  try {
    // ── GET: list members of a boat ───────────────────────────────────────────
    if (req.method === 'GET') {
      if (!boatId) return json({ error: 'boat_id required (x-boat-id header)' }, 400);

      const { data: members } = await admin
        .from('boat_members')
        .select('user_id, role')
        .eq('boat_id', boatId);

      if (!members?.length) return json([]);

      const { data: authData } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const authMap = Object.fromEntries(
        (authData?.users ?? []).map((u: { id: string; email?: string; last_sign_in_at?: string; created_at: string }) => [u.id, u])
      );

      const { data: roles } = await admin
        .from('user_roles')
        .select('user_id, force_password_change');
      const rolesMap = Object.fromEntries(
        (roles ?? []).map((r: { user_id: string; force_password_change: boolean }) => [r.user_id, r])
      );

      const users = members.map((m: { user_id: string; role: string }) => {
        const u = authMap[m.user_id];
        return {
          id:                   m.user_id,
          email:                u?.email ?? '',
          last_sign_in_at:      u?.last_sign_in_at ?? null,
          created_at:           u?.created_at ?? '',
          role:                 m.role,
          force_password_change: rolesMap[m.user_id]?.force_password_change ?? false,
        };
      });

      return json(users);
    }

    // ── POST: invite user and add to boat ─────────────────────────────────────
    if (req.method === 'POST') {
      const { email, role, redirectTo } = body as { email?: string; role?: string; redirectTo?: string };
      if (!email) return json({ error: 'Email required' }, 400);
      if (!boatId) return json({ error: 'boat_id required' }, 400);

      let userId: string;
      let emailSent = false;

      const { data, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: redirectTo ?? undefined,
      });

      if (inviteErr) {
        const msg = inviteErr.message ?? '';
        if (msg.includes('rate limit') || msg.includes('429')) {
          return json({
            error: 'Email rate limit reached. Configure custom SMTP in Supabase or wait 1 hour.',
          }, 429);
        }
        if (msg.includes('already been registered') || msg.includes('already registered')) {
          // User exists — look them up by email and add to boat directly (no email sent)
          const { data: existing } = await admin.auth.admin.listUsers({ perPage: 1000 });
          const existingUser = existing?.users.find(
            (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
          );
          if (!existingUser) return json({ error: 'User exists but could not be located.' }, 400);
          userId = existingUser.id;
          emailSent = false;
        } else {
          return json({ error: msg }, 400);
        }
      } else {
        userId = data.user.id;
        emailSent = true;
        // Also write to user_roles for force_password_change flow (SUKI legacy)
        await admin.from('user_roles').upsert({
          user_id: userId,
          role:    role ?? 'viewer',
          force_password_change: true,
        }, { onConflict: 'user_id' });
      }

      // Add / update boat_members entry
      const { error: memberErr } = await admin.from('boat_members').upsert({
        boat_id:    boatId,
        user_id:    userId,
        role:       role ?? 'viewer',
        invited_by: callerId,
      }, { onConflict: 'boat_id,user_id' });

      if (memberErr) return json({ error: memberErr.message }, 400);

      return json({ ok: true, userId, emailSent });
    }

    // ── PATCH: update role in boat_members ────────────────────────────────────
    if (req.method === 'PATCH') {
      const { userId, role, force_password_change } = body as {
        userId?: string; role?: string; force_password_change?: boolean;
      };
      if (!userId) return json({ error: 'userId required' }, 400);

      if (role !== undefined && boatId) {
        await admin.from('boat_members')
          .update({ role })
          .eq('boat_id', boatId)
          .eq('user_id', userId);
      }

      // Legacy: force_password_change via user_roles
      if (force_password_change !== undefined) {
        await admin.from('user_roles').upsert(
          { user_id: userId, force_password_change },
          { onConflict: 'user_id' }
        );
      }

      return json({ ok: true });
    }

    // ── DELETE: remove user from boat ─────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { userId } = body as { userId?: string };
      if (!userId) return json({ error: 'userId required' }, 400);
      if (userId === callerId) return json({ error: 'Cannot remove yourself' }, 400);
      if (!boatId) return json({ error: 'boat_id required' }, 400);

      await admin.from('boat_members')
        .delete()
        .eq('boat_id', boatId)
        .eq('user_id', userId);

      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
