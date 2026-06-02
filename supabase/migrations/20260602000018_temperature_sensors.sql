-- Manage custom names for temperature sensors per boat
-- Temperature sensors are identified by instance ID (20-29 for SUKI)

CREATE TABLE public.temperature_sensors (
  id              bigserial PRIMARY KEY,
  boat_id         uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
  instance        integer NOT NULL CHECK (instance > 0),
  custom_name     text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- One sensor per boat per instance
  UNIQUE(boat_id, instance)
);

CREATE INDEX temperature_sensors_boat_id_idx
  ON public.temperature_sensors(boat_id);

-- RLS: boat members can read/write their boat's sensor names
ALTER TABLE public.temperature_sensors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "boat members read sensor names"
  ON public.temperature_sensors FOR SELECT TO authenticated
  USING (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()));

CREATE POLICY "boat members write sensor names"
  ON public.temperature_sensors FOR INSERT TO authenticated
  WITH CHECK (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()));

CREATE POLICY "boat members update sensor names"
  ON public.temperature_sensors FOR UPDATE TO authenticated
  USING (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()))
  WITH CHECK (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()));

CREATE POLICY "boat members delete sensor names"
  ON public.temperature_sensors FOR DELETE TO authenticated
  USING (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()));

-- Pre-populate defaults for SUKI (boat_id will be inserted by user or migration script)
-- This is intentionally left empty; the app will seed defaults on first load
