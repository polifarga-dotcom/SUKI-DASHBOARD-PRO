-- SignalK Bridge: api key per boat + multi-boat telemetry support
-- Migration 20260601000009

-- ── 1. plugin_api_key on anchor_config ────────────────────────────────────────
ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS plugin_api_key text;

-- Generate a secure random key for every existing boat row that doesn't have one
UPDATE public.anchor_config
  SET plugin_api_key = 'sk-' || encode(gen_random_bytes(24), 'hex')
  WHERE plugin_api_key IS NULL;

-- ── 2. Telemetry table: lift singleton constraint for multi-boat support ───────
-- The table was originally SUKI-only (CHECK id = 1). Remove that so every boat
-- can have its own telemetry row, while SUKI's row stays at id = 1.
ALTER TABLE public.telemetry
  DROP CONSTRAINT IF EXISTS telemetry_singleton;

-- Create a sequence that starts at 2 so SUKI's row (id = 1) is never touched
CREATE SEQUENCE IF NOT EXISTS telemetry_id_seq START WITH 2;
ALTER TABLE public.telemetry
  ALTER COLUMN id SET DEFAULT nextval('telemetry_id_seq');

-- Unique index on boat_id — required for upsert onConflict:'boat_id'
-- WHERE boat_id IS NOT NULL guards against the unlikely null-boat_id orphan row
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_boat_id_unique
  ON public.telemetry (boat_id)
  WHERE boat_id IS NOT NULL;
