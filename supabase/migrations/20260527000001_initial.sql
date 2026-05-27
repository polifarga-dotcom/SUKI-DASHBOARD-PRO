-- SUKI Dashboard PRO — Initial Schema
-- Migration 001: Core tables

create extension if not exists "uuid-ossp";

-- ── Telemetry: single live row (upserted by Cerbo every 3s) ─────────────────
create table public.telemetry (
  id                      integer primary key default 1,
  updated_at              timestamptz not null default now(),
  -- Battery main (LiFePO4 house bank)
  batt_main_soc           real,
  batt_main_v             real,
  batt_main_a             real,
  batt_main_w             real,
  batt_main_mode          text,
  -- Battery engine (12V starter)
  batt_eng_soc            real,
  batt_eng_v              real,
  batt_eng_a              real,
  -- Solar (5 MPPTs)
  solar_p277              real,
  solar_p279              real,
  solar_p289              real,
  solar_p290              real,
  solar_p292              real,
  solar_total_w           real,
  solar_total_a           real,
  solar_yield_today_j     real,
  solar_yield_yesterday_j real,
  -- Inverter/Charger
  inv_mode                text,
  inv_ac_v                real,
  inv_ac_hz               real,
  inv_ac_w                real,
  inv_dc_w                real,
  -- Navigation
  nav_lat                 double precision,
  nav_lon                 double precision,
  nav_hdg_rad             real,
  nav_sog_ms              real,
  nav_stw_ms              real,
  -- Environment
  env_depth_m             real,
  env_aws_ms              real,
  env_awa_rad             real,
  env_tws_ms              real,
  env_twa_rad             real,
  env_pressure_pa         real,
  -- Tanks (fill ratio 0.0–1.0)
  tank_fw                 real,
  tank_dsl                real,
  tank_bwm                real,
  tank_bwg                real,
  -- Temperatures (Kelvin)
  temp_salon              real,
  temp_fridge             real,
  temp_tech               real,
  temp_amasb              real,
  temp_amabb              real,
  temp_water              real,
  -- Humidity (0.0–1.0)
  hum_salon               real,
  hum_fridge              real,
  hum_tech                real,
  hum_amasb               real,
  hum_amabb               real,
  -- Rigging (Newtons)
  rig_port                real,
  rig_sb                  real,
  -- Engine
  eng_rpm                 real,
  eng_run_sec             real,
  eng_temp_k              real,
  eng_alt_v               real,
  -- Rudder
  rudder_rad              real,
  -- Shelly relay states (0=off, 1=on)
  shelly_108              smallint,
  shelly_102              smallint,
  shelly_118              smallint,
  -- Victron relays
  relay_0                 smallint,
  relay_1                 smallint,
  -- Server health
  server_last_check_ok    boolean,
  server_last_check_at    timestamptz,
  constraint telemetry_singleton check (id = 1)
);

alter table public.telemetry enable row level security;

-- ── Telemetry history (time-series subset, pruned after 7 days) ──────────────
create table public.telemetry_history (
  id                   bigserial primary key,
  recorded_at          timestamptz not null default now(),
  batt_main_soc        real,
  batt_main_v          real,
  batt_main_a          real,
  solar_total_w        real,
  solar_yield_today_j  real,
  nav_lat              double precision,
  nav_lon              double precision,
  env_pressure_pa      real,
  tank_fw              real,
  tank_dsl             real,
  eng_rpm              real,
  temp_salon           real
);

create index on public.telemetry_history (recorded_at desc);
alter table public.telemetry_history enable row level security;

-- ── Relay commands (browser writes, Cerbo polls and clears) ──────────────────
create table public.relay_commands (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  device        text not null,     -- 'victron_relay' | 'shelly'
  channel       text not null,     -- '0', '1', '108', '102', '118'
  desired_state smallint not null, -- 0 or 1
  executed_at   timestamptz,
  executed_by   text
);

create index on public.relay_commands (executed_at) where executed_at is null;
alter table public.relay_commands enable row level security;

-- ── Anchor config (browser + Cerbo both read/write) ──────────────────────────
create table public.anchor_config (
  id             integer primary key default 1,
  updated_at     timestamptz not null default now(),
  active         boolean not null default false,
  lat            double precision,
  lon            double precision,
  radius_m       integer not null default 30,
  chain_length_m integer not null default 20,
  bearing_deg    integer not null default 0,
  alarm_delay_s  integer not null default 10,
  alarming       boolean not null default false,
  constraint anchor_config_singleton check (id = 1)
);

alter table public.anchor_config enable row level security;

-- ── User roles ────────────────────────────────────────────────────────────────
create table public.user_roles (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  role                  text not null default 'viewer',
  force_password_change boolean not null default false,
  created_at            timestamptz not null default now(),
  unique (user_id)
);

alter table public.user_roles enable row level security;

-- ── Seed singleton rows ───────────────────────────────────────────────────────
insert into public.telemetry (id) values (1) on conflict do nothing;
insert into public.anchor_config (id) values (1) on conflict do nothing;
