-- SUKI Dashboard PRO — Pruning Functions
-- Migration 003
-- Called daily by GitHub Actions since Supabase Free Tier has no pg_cron

create or replace function public.prune_telemetry_history()
returns void language sql security definer as $$
  delete from public.telemetry_history
  where recorded_at < now() - interval '7 days';
$$;

create or replace function public.prune_relay_commands()
returns void language sql security definer as $$
  delete from public.relay_commands
  where executed_at is not null
    and executed_at < now() - interval '24 hours';
$$;
