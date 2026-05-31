-- Add engine_hours_start to log_trips
-- Stores the absolute engine-hours counter value at the moment a trip starts.
-- Allows reliable motor-time delta calculation:
--   engine_hours (delta) = engine_hours counter at end − engine_hours_start
-- even when individual log_entries have sparse / null engine_hours values.

ALTER TABLE public.log_trips
  ADD COLUMN IF NOT EXISTS engine_hours_start numeric;
