-- Add AWA (Apparent Wind Angle) and AWS (Apparent Wind Speed) to log_entries
-- These are critical metrics for sailing performance analysis

ALTER TABLE public.log_entries
  ADD COLUMN IF NOT EXISTS apparent_wind_speed_kn NUMERIC,
  ADD COLUMN IF NOT EXISTS apparent_wind_angle_deg NUMERIC;

-- Indices for these columns are not necessary; they're not frequently filtered on
-- (unlike logged_at, trip_id, boat_id which are already indexed)
