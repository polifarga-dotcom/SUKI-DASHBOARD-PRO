-- Add COG (course over ground, radians) to telemetry
-- Separate from nav_hdg_rad (magnetic heading) — needed for accurate TWS vector math
ALTER TABLE public.telemetry
  ADD COLUMN IF NOT EXISTS nav_cog_rad numeric;
