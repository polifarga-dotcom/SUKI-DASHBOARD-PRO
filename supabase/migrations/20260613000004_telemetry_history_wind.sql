-- Add wind + nav columns to telemetry_history so the alarm chart has data
-- even when the boat is not on an active trip (log_entries is trip-only).
ALTER TABLE public.telemetry_history
  ADD COLUMN IF NOT EXISTS env_aws_ms  real,
  ADD COLUMN IF NOT EXISTS env_awa_rad real,
  ADD COLUMN IF NOT EXISTS nav_hdg_rad real,
  ADD COLUMN IF NOT EXISTS nav_sog_ms  real;

-- Redefine trigger to include the new wind/nav fields.
-- Guard condition (nav_lat IS NOT NULL) is kept — ensures we always have a
-- position anchor for the history row.
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
         env_pressure_pa, tank_fw, tank_dsl, eng_rpm, temp_salon,
         env_aws_ms, env_awa_rad, nav_hdg_rad, nav_sog_ms)
      VALUES
        (NEW.boat_id, NEW.nav_lat, NEW.nav_lon, NOW(),
         NEW.batt_main_soc, NEW.batt_main_v, NEW.batt_main_a,
         NEW.solar_total_w, NEW.solar_yield_today_j,
         NEW.env_pressure_pa, NEW.tank_fw, NEW.tank_dsl,
         NEW.eng_rpm, NEW.temp_salon,
         NEW.env_aws_ms, NEW.env_awa_rad, NEW.nav_hdg_rad, NEW.nav_sog_ms);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
