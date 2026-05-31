-- ── pg_cron schedule for server-side position logging ───────────────────────
-- Triggers the log-position Edge Function every 2 minutes.
-- Requires pg_cron and pg_net extensions (enable in Supabase Dashboard → Extensions).
-- The service_role_key vault secret must be set before this job fires:
--   INSERT INTO vault.secrets (name, secret)
--   VALUES ('service_role_key', '<SERVICE_ROLE_KEY>');
--   -- or via Dashboard: Database → Vault → Add secret

SELECT cron.schedule(
  'log-position-check',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/log-position',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (
                   SELECT decrypted_secret
                   FROM   vault.decrypted_secrets
                   WHERE  name = 'service_role_key'
                   LIMIT  1
                 )
               ),
    body    := '{}'::jsonb
  );
  $$
);
