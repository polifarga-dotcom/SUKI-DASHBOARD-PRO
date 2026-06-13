-- GPS fallback columns for tracking page
-- vrm_gps_*    : from VRM diagnostics API (polled every minute via vrm-poll cron)
-- inreach_gps_*: from Garmin InReach MapShare (cached in public-boat-tracker, refreshed every ~10 min)
ALTER TABLE public.telemetry
  ADD COLUMN IF NOT EXISTS vrm_gps_lat     double precision,
  ADD COLUMN IF NOT EXISTS vrm_gps_lon     double precision,
  ADD COLUMN IF NOT EXISTS vrm_gps_at      timestamptz,
  ADD COLUMN IF NOT EXISTS inreach_gps_lat double precision,
  ADD COLUMN IF NOT EXISTS inreach_gps_lon double precision,
  ADD COLUMN IF NOT EXISTS inreach_gps_at  timestamptz;
