-- SUKI Dashboard PRO — Shelly Cloud Integration
-- Migration 005

-- Shelly Cloud Credentials in anchor_config
ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS shelly_cloud_server  text,
  ADD COLUMN IF NOT EXISTS shelly_cloud_auth_key text;

-- Neue Tabelle: live Shelly-Geräteliste (gefüllt von server.py via Shelly Cloud API)
CREATE TABLE public.shelly_devices (
  id         text        PRIMARY KEY,
  name       text        NOT NULL DEFAULT '',
  type       text,
  online     boolean     NOT NULL DEFAULT false,
  state      smallint,                               -- 0=aus, 1=an, null=unbekannt
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.shelly_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth users read shelly devices"
  ON public.shelly_devices FOR SELECT TO authenticated USING (true);
