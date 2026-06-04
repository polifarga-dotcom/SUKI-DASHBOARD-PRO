-- Logbook: add motor/sail time tracking + depth + batt_soc per entry
--
-- log_trips: track motor_time_s and sail_time_s (seconds under motor / under sail)
ALTER TABLE public.log_trips
  ADD COLUMN IF NOT EXISTS motor_time_s integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sail_time_s  integer NOT NULL DEFAULT 0;

-- log_entries: add depth (sailserver standard) and battery SOC at log time
ALTER TABLE public.log_entries
  ADD COLUMN IF NOT EXISTS depth_m   numeric(5,1),
  ADD COLUMN IF NOT EXISTS batt_soc  numeric(4,1);   -- percent 0–100
