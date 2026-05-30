-- SUKI Dashboard PRO — Multi-boat schema
-- Migration 006

-- ── boats ─────────────────────────────────────────────────────────────────────
create table public.boats (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz default now(),
  created_by  uuid references auth.users(id) on delete set null
);

alter table public.boats enable row level security;

-- ── boat_members ──────────────────────────────────────────────────────────────
-- Replaces the global user_roles table for per-boat access control.
create table public.boat_members (
  boat_id    uuid not null references public.boats(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'viewer' check (role in ('admin','viewer')),
  invited_by uuid references auth.users(id),
  joined_at  timestamptz default now(),
  primary key (boat_id, user_id)
);

alter table public.boat_members enable row level security;

-- ── Add boat_id FK to anchor_config ──────────────────────────────────────────
alter table public.anchor_config
  add column if not exists boat_id uuid references public.boats(id);

-- ── Add boat_id FK to telemetry (SUKI-specific, stays nullable) ──────────────
alter table public.telemetry
  add column if not exists boat_id uuid references public.boats(id);

-- ── Seed: create SUKI boat and link existing rows ────────────────────────────
do $$
declare
  suki_id uuid;
begin
  insert into public.boats (name) values ('SUKI') returning id into suki_id;

  update public.anchor_config set boat_id = suki_id where id = 1;
  update public.telemetry       set boat_id = suki_id where id = 1;

  -- Migrate all existing user_roles entries as boat_members for SUKI
  insert into public.boat_members (boat_id, user_id, role)
    select suki_id, user_id, role
    from   public.user_roles
    on conflict do nothing;
end $$;
