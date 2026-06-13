-- Sensor alarm configuration and state per boat
CREATE TABLE public.sensor_alarms (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id             uuid NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  sensor              text NOT NULL,
  -- sensor values: 'wind_speed' | 'wind_dir' | 'pressure' | 'depth' | 'water_temp'
  --                'batt_soc' | 'batt_volt' | 'tank_fw' | 'tank_dsl'
  enabled             boolean NOT NULL DEFAULT false,
  threshold_value     double precision,
  threshold_direction text NOT NULL DEFAULT 'above'
                      CHECK (threshold_direction IN ('above', 'below', 'deviation')),
  hysteresis          double precision,
  grace_period_s      integer NOT NULL DEFAULT 60,
  state               text NOT NULL DEFAULT 'ok'
                      CHECK (state IN ('ok', 'grace', 'alarming')),
  grace_started_at    timestamptz,
  last_alarmed_at     timestamptz,
  alarm_count         integer NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(boat_id, sensor)
);

ALTER TABLE public.sensor_alarms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read sensor alarms"
  ON public.sensor_alarms FOR SELECT TO authenticated
  USING (boat_id IN (
    SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "members insert sensor alarms"
  ON public.sensor_alarms FOR INSERT TO authenticated
  WITH CHECK (boat_id IN (
    SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "members update sensor alarms"
  ON public.sensor_alarms FOR UPDATE TO authenticated
  USING (boat_id IN (
    SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()
  ));

-- pg_cron job: run sensor-alarm-check every minute
SELECT cron.schedule(
  'sensor-alarm-check',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (
      SELECT decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name = 'SUPABASE_URL'
    ) || '/functions/v1/sensor-alarm-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'SUPABASE_SERVICE_ROLE_KEY'
      )
    ),
    body := '{}'::jsonb
  )
  $$
);
