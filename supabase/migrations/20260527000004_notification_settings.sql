-- Add notification and cloud settings to anchor_config
ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS telegram_token       text,
  ADD COLUMN IF NOT EXISTS telegram_chat_ids    text,
  ADD COLUMN IF NOT EXISTS pushover_app_token   text,
  ADD COLUMN IF NOT EXISTS pushover_user_keys   text,
  ADD COLUMN IF NOT EXISTS cloud_enabled        boolean NOT NULL DEFAULT true;
