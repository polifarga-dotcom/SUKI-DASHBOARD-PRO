-- Distance from GPS/compass receiver to bow (meters)
-- Used to offset anchor position forward when dropping hook
ALTER TABLE public.boats
  ADD COLUMN IF NOT EXISTS gps_to_bow_m integer NOT NULL DEFAULT 0;
