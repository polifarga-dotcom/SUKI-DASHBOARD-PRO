-- Server-side auto-trip detection
-- auto_trip_enabled : mirrors the browser toggle; server reads this to decide whether to auto-start
-- auto_fast_since   : set by log-position when SOG first hits ≥ 1.5 kn; cleared on start or stop

ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS auto_trip_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_fast_since   timestamptz;
