-- anchor-alarm-cron: Schedule the anchor-check Edge Function every minute
--
-- Prerequisites (enable in Supabase Dashboard → Database → Extensions):
--   • pg_cron
--   • pg_net
--
-- A random shared secret is stored in Vault as 'cron_secret'.
-- Generate via SQL:
--   SELECT vault.create_secret(gen_random_uuid()::text, 'cron_secret',
--     'Shared secret for anchor-check pg_cron authentication');
--
-- The anchor-check Edge Function reads this secret from Vault at runtime
-- and verifies the Authorization header matches.
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
                   WHERE name = 'cron_secret'
                   LIMIT 1
                 )
               ),
    body    := '{}'::jsonb
  );
  $$
);
