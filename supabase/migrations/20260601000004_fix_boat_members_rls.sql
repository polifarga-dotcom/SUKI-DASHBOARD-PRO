-- Fix infinite recursion in boat_members RLS policies
-- Root cause: policies on boat_members queried boat_members to check admin status,
-- causing PostgreSQL to re-enter the same policies infinitely.
-- Solution: SECURITY DEFINER helper function bypasses RLS when checking admin status.

-- ── 1. Helper function (runs as table owner, bypasses RLS) ────────────────────
CREATE OR REPLACE FUNCTION public.is_boat_admin(p_boat_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.boat_members
    WHERE boat_id = p_boat_id
      AND user_id = auth.uid()
      AND role = 'admin'
  );
$$;

-- ── 2. Drop all broken boat_members policies ──────────────────────────────────
DROP POLICY IF EXISTS "see own membership"    ON public.boat_members;
DROP POLICY IF EXISTS "admins see all members" ON public.boat_members;
DROP POLICY IF EXISTS "admins manage members"  ON public.boat_members;

-- ── 3. Recreate without recursion ─────────────────────────────────────────────

-- SELECT: own row (fast path) OR admin of that boat
CREATE POLICY "members see own row" ON public.boat_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "admins see all boat members" ON public.boat_members
  FOR SELECT TO authenticated
  USING (public.is_boat_admin(boat_id));

-- INSERT:
--   Case A – onboarding: inserting yourself as admin for a boat you just created
--   Case B – admin inviting someone: you are already admin of this boat
CREATE POLICY "boat_members_insert" ON public.boat_members
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      user_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.boats
        WHERE id = boat_id AND created_by = auth.uid()
      )
    )
    OR public.is_boat_admin(boat_id)
  );

-- UPDATE: only admins can change memberships
CREATE POLICY "admins update members" ON public.boat_members
  FOR UPDATE TO authenticated
  USING (public.is_boat_admin(boat_id))
  WITH CHECK (public.is_boat_admin(boat_id));

-- DELETE: only admins can remove members
CREATE POLICY "admins delete members" ON public.boat_members
  FOR DELETE TO authenticated
  USING (public.is_boat_admin(boat_id));

-- ── 4. Also fix boats.admins_update_boat (same recursion pattern) ─────────────
DROP POLICY IF EXISTS "admins update boat" ON public.boats;

CREATE POLICY "admins update boat" ON public.boats
  FOR UPDATE TO authenticated
  USING (public.is_boat_admin(id))
  WITH CHECK (public.is_boat_admin(id));
