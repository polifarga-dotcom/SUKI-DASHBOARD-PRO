-- SUKI Dashboard PRO — Multi-boat RLS policies
-- Migration 007

-- ── boats: members can see their own boats ────────────────────────────────────
create policy "members see their boats"
  on public.boats for select
  to authenticated
  using (
    exists (
      select 1 from public.boat_members
      where boat_id = boats.id and user_id = auth.uid()
    )
  );

create policy "members create boats"
  on public.boats for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "admins update boat"
  on public.boats for update
  to authenticated
  using (
    exists (
      select 1 from public.boat_members
      where boat_id = boats.id and user_id = auth.uid() and role = 'admin'
    )
  );

-- ── boat_members ──────────────────────────────────────────────────────────────
-- Anyone can see their own membership row
create policy "see own membership"
  on public.boat_members for select
  to authenticated
  using (user_id = auth.uid());

-- Admins can see all members of their boat
create policy "admins see all members"
  on public.boat_members for select
  to authenticated
  using (
    exists (
      select 1 from public.boat_members bm
      where bm.boat_id = boat_members.boat_id
        and bm.user_id = auth.uid()
        and bm.role = 'admin'
    )
  );

-- Admins can insert / update / delete members of their boat
create policy "admins manage members"
  on public.boat_members for all
  to authenticated
  using (
    exists (
      select 1 from public.boat_members bm
      where bm.boat_id = boat_members.boat_id
        and bm.user_id = auth.uid()
        and bm.role = 'admin'
    )
  );

-- ── anchor_config: replace open policies with per-boat access ─────────────────
drop policy if exists "auth users read anchor config"   on public.anchor_config;
drop policy if exists "auth users update anchor config" on public.anchor_config;

create policy "members read boat config"
  on public.anchor_config for select
  to authenticated
  using (
    exists (
      select 1 from public.boat_members
      where boat_id = anchor_config.boat_id and user_id = auth.uid()
    )
  );

create policy "admins update boat config"
  on public.anchor_config for update
  to authenticated
  using (
    exists (
      select 1 from public.boat_members
      where boat_id = anchor_config.boat_id
        and user_id = auth.uid()
        and role = 'admin'
    )
  );

-- Insert needed for onboarding (creating a new boat's config row)
create policy "admins insert boat config"
  on public.anchor_config for insert
  to authenticated
  with check (
    exists (
      select 1 from public.boat_members
      where boat_id = anchor_config.boat_id
        and user_id = auth.uid()
        and role = 'admin'
    )
  );
