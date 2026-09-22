-- MFD Anchor client: dedicated api key per boat (separate from plugin_api_key
-- used by the SignalK bridge — different privilege level, rotate independently)
ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS mfd_api_key text;

UPDATE public.anchor_config
  SET mfd_api_key = 'mfd-' || encode(gen_random_bytes(24), 'hex')
  WHERE mfd_api_key IS NULL;
