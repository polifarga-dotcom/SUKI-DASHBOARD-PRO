-- VRM API credentials in anchor_config
ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS vrm_api_token      text,
  ADD COLUMN IF NOT EXISTS vrm_installation_id integer;
