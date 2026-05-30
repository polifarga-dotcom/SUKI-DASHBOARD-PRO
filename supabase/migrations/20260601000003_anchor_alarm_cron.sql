-- anchor-alarm-cron: Schedule the anchor-check Edge Function every minute
--
-- Prerequisites (enable in Supabase Dashboard → Database → Extensions):
--   • pg_cron
--   • pg_net
--
-- The SUPABASE_SERVICE_ROLE_KEY is stored in Vault as 'service_role_key'.
-- Set it via: supabase secrets set SERVICE_ROLE_KEY=<key>
-- Or in SQL:  SELECT vault.create_secret('<key>', 'service_role_key');
--
-- The Edge Function URL must match your project ref:
--   https://<project_ref>.supabase.co/functions/v1/anchor-check

-- Remove existing schedule if re-running
SELECT cron.unschedule('anchor-alarm-check') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'anchor-alarm-check'
);

SELECT cron.schedule(
  'anchor-alarm-check',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/anchor-check',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (
                   SELECT decrypted_secret
                   FROM vault.decrypted_secrets
                   WHERE name = 'service_role_key'
                   LIMIT 1
                 )
               ),
    body    := '{}'::jsonb
  );
  $$
);
