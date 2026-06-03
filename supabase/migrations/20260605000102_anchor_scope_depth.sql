-- Store depth at anchor set time for accurate scope calculation
-- Scope = chain_length / depth_at_set (does not change with current depth)

ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS anchor_depth_at_set numeric;

COMMENT ON COLUMN public.anchor_config.anchor_depth_at_set IS 'Water depth when anchor was set - used for static scope calculation (chain/depth ratio)';
