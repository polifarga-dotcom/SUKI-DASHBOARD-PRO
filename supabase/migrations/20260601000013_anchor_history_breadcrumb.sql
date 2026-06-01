-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013: boat_id for telemetry_history + trigger-based breadcrumb
--                + anchor_history table (last 3 cleared anchors per boat)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. Add boat_id column to telemetry_history
ALTER TABLE public.telemetry_history
  ADD COLUMN IF NOT EXISTS boat_id uuid REFERENCES public.boats(id);

CREATE INDEX IF NOT EXISTS telemetry_history_boat_id_idx
  ON public.telemetry_history (boat_id, recorded_at DESC);

-- 1b. Trigger function: writes one history row per boat per minute
--     Fires after each telemetry UPDATE that has a valid GPS fix.
CREATE OR REPLACE FUNCTION public.record_telemetry_position()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.nav_lat IS NOT NULL AND NEW.boat_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.telemetry_history
      WHERE boat_id = NEW.boat_id
        AND recorded_at > NOW() - INTERVAL '60 seconds'
    ) THEN
      INSERT INTO public.telemetry_history
        (boat_id, nav_lat, nav_lon, recorded_at,
         batt_main_soc, batt_main_v, batt_main_a,
         solar_total_w, solar_yield_today_j,
         env_pressure_pa, tank_fw, tank_dsl, eng_rpm, temp_salon)
      VALUES
        (NEW.boat_id, NEW.nav_lat, NEW.nav_lon, NOW(),
         NEW.batt_main_soc, NEW.batt_main_v, NEW.batt_main_a,
         NEW.solar_total_w, NEW.solar_yield_today_j,
         NEW.env_pressure_pa, NEW.tank_fw, NEW.tank_dsl,
         NEW.eng_rpm, NEW.temp_salon);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS telemetry_position_recorder ON public.telemetry;
CREATE TRIGGER telemetry_position_recorder
  AFTER UPDATE ON public.telemetry
  FOR EACH ROW EXECUTE FUNCTION public.record_telemetry_position();

-- 1c. Replace the old open RLS policy with a boat-scoped one.
--     Rows without boat_id (pre-migration data) remain readable by all authenticated users.
DROP POLICY IF EXISTS "auth users read history" ON public.telemetry_history;

CREATE POLICY "boat members read history"
  ON public.telemetry_history FOR SELECT TO authenticated
  USING (
    boat_id IS NULL
    OR boat_id IN (
      SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 1d. anchor_history — stores the last N cleared anchors per boat
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.anchor_history (
  id             bigserial PRIMARY KEY,
  boat_id        uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
  lat            double precision NOT NULL,
  lon            double precision NOT NULL,
  radius_m       integer NOT NULL DEFAULT 50,
  chain_length_m integer NOT NULL DEFAULT 30,
  bearing_deg    integer NOT NULL DEFAULT 0,
  cleared_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anchor_history_boat_idx
  ON public.anchor_history (boat_id, cleared_at DESC);

ALTER TABLE public.anchor_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "boat members read anchor history"
  ON public.anchor_history FOR SELECT TO authenticated
  USING (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()));

CREATE POLICY "boat members insert anchor history"
  ON public.anchor_history FOR INSERT TO authenticated
  WITH CHECK (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()));

CREATE POLICY "boat members delete anchor history"
  ON public.anchor_history FOR DELETE TO authenticated
  USING (boat_id IN (SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()));
