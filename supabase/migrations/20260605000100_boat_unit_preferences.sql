-- Add unit system and time format preferences to boats table
ALTER TABLE public.boats
  ADD COLUMN IF NOT EXISTS unit_system   text DEFAULT 'metric' CHECK (unit_system IN ('metric', 'imperial')),
  ADD COLUMN IF NOT EXISTS time_format   text DEFAULT '24h'     CHECK (time_format IN ('12h', '24h'));

COMMENT ON COLUMN public.boats.unit_system IS 'metric (m, °C) or imperial (feet, °F)';
COMMENT ON COLUMN public.boats.time_format IS '24h or 12h time format';
