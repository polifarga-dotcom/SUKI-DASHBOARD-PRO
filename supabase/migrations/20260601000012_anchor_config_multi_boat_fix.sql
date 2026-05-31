-- Fix anchor_config for multi-boat support.
-- Root causes:
--   1. anchor_config_singleton CHECK constraint — only allowed id=1 (original single-boat design)
--   2. id DEFAULT 1 (literal) — every new INSERT got id=1, violating PK
-- Both caused every non-SUKI boat anchor_config insert to silently fail.

-- 1. Drop the old singleton guard
ALTER TABLE public.anchor_config
  DROP CONSTRAINT IF EXISTS anchor_config_singleton;

-- 2. Create a proper sequence for id
CREATE SEQUENCE IF NOT EXISTS anchor_config_id_seq START WITH 2;
ALTER TABLE public.anchor_config
  ALTER COLUMN id SET DEFAULT nextval('anchor_config_id_seq');
SELECT setval('anchor_config_id_seq', GREATEST((SELECT MAX(id) FROM public.anchor_config), 1) + 1);

-- 3. One config row per boat (enables upsert)
ALTER TABLE public.anchor_config
  ADD CONSTRAINT anchor_config_boat_id_key UNIQUE (boat_id);

-- 4. Back-fill missing rows for all boats that have no config row yet
INSERT INTO public.anchor_config (
  boat_id, active, radius_m, chain_length_m, bearing_deg,
  alarm_delay_s, alarming, cloud_enabled, plugin_api_key
)
SELECT
  b.id,
  false, 50, 30, 0, 30, false, false,
  'sk-' || encode(gen_random_bytes(24), 'hex')
FROM public.boats b
WHERE NOT EXISTS (
  SELECT 1 FROM public.anchor_config ac WHERE ac.boat_id = b.id
);
