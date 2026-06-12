-- ── Shared App Telegram Bot ───────────────────────────────────────────────
-- system_config: global key/value store, service_role access only (no RLS policy needed
-- since the table has no public policy — only Edge Functions with service_role can touch it)
CREATE TABLE IF NOT EXISTS public.system_config (
  key   text PRIMARY KEY,
  value text
);

-- Seed initial bot token for @SukiProBot
INSERT INTO public.system_config (key, value)
VALUES ('telegram_bot_token', '8706350470:AAEOGxySFR5x_jjzP7hsXQE92fYkn0C_UEY')
ON CONFLICT (key) DO NOTHING;

-- telegram_subscribers: maps chat_id → boat for app-wide bot notifications
CREATE TABLE IF NOT EXISTS public.telegram_subscribers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id    uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
  chat_id    text NOT NULL,
  label      text,            -- first_name from Telegram, or custom
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (boat_id, chat_id)
);

-- RLS: boat members can read their own boat's subscribers; inserts go via webhook (service_role)
ALTER TABLE public.telegram_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members can view their boat subscribers"
  ON public.telegram_subscribers FOR SELECT
  USING (
    boat_id IN (
      SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "members can delete their boat subscribers"
  ON public.telegram_subscribers FOR DELETE
  USING (
    boat_id IN (
      SELECT boat_id FROM public.boat_members WHERE user_id = auth.uid()
    )
  );

-- Migration tracking per boat: null = not yet prompted, true = done (banner gone forever)
ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS telegram_migration_done boolean DEFAULT null;
