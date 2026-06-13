-- Reduce telemetry_history retention from 7 days to 25 hours.
-- Consumers: anchor map (2h), alarm charts (24h) — 25h covers all with a small buffer.
-- Effect: ~7x less stored data compared to current 7-day retention.
CREATE OR REPLACE FUNCTION public.prune_telemetry_history()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM public.telemetry_history
  WHERE recorded_at < now() - INTERVAL '25 hours';
$$;

-- Prune existing rows beyond 25h immediately
SELECT public.prune_telemetry_history();
