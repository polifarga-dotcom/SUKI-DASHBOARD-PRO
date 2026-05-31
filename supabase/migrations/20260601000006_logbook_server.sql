-- ── Server-side logging support ─────────────────────────────────────────────
-- is_auto: true when the trip was started by the auto-trip engine (not manually)
-- auto_slow_since: set by log-position Edge Function when speed < 1.5 kn,
--                  used to detect 15-min stop condition while browser is closed
ALTER TABLE public.log_trips
  ADD COLUMN IF NOT EXISTS is_auto         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_slow_since timestamptz;

-- engine_temp_c was applied live via MCP in a prior session; included here
-- with IF NOT EXISTS so this migration is idempotent.
ALTER TABLE public.log_entries
  ADD COLUMN IF NOT EXISTS engine_temp_c numeric;
