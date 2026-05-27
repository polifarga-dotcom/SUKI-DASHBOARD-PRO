-- SUKI Dashboard PRO — RLS Policies
-- Migration 002

-- ── telemetry: auth users read, service role writes ──────────────────────────
create policy "auth users read telemetry"
  on public.telemetry for select
  to authenticated using (true);

-- ── telemetry_history: auth users read ───────────────────────────────────────
create policy "auth users read history"
  on public.telemetry_history for select
  to authenticated using (true);

-- ── relay_commands: auth users insert + select ───────────────────────────────
create policy "auth users insert relay commands"
  on public.relay_commands for insert
  to authenticated with check (true);

create policy "auth users read relay commands"
  on public.relay_commands for select
  to authenticated using (true);

-- ── anchor_config: auth users read + update ──────────────────────────────────
create policy "auth users read anchor config"
  on public.anchor_config for select
  to authenticated using (true);

create policy "auth users update anchor config"
  on public.anchor_config for update
  to authenticated using (true);

-- ── user_roles: users read own row; admins read all ──────────────────────────
create policy "users read own role"
  on public.user_roles for select
  to authenticated
  using (auth.uid() = user_id);

create policy "admins read all roles"
  on public.user_roles for select
  to authenticated
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and role = 'admin'
    )
  );

create policy "users update own role"
  on public.user_roles for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
