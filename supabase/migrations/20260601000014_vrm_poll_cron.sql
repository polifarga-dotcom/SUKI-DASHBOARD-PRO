-- vrm-poll cron: Call the vrm-poll Edge Function every minute.
-- Fetches VRM diagnostics (solar, inverter, temps, humidity) for all boats
-- with VRM credentials and upserts to the telemetry table.
-- This replaces the equivalent functionality in server.py's _supabase_push_loop.

-- Remove existing schedule if re-running migration
SELECT cron.unschedule('vrm-poll') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'vrm-poll'
);

SELECT cron.schedule(
  'vrm-poll',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/vrm-poll',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
