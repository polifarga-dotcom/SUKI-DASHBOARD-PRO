-- Anchor alarm escalation state machine columns.
-- Replaces the simple one-shot trigger/clear with a full server.py-equivalent
-- state machine: grace period → first alert → escalating notifications (15 min × 5,
-- then 60 min) → Telegram mute → Pushover cancel-on-clear.

ALTER TABLE public.anchor_config
  ADD COLUMN IF NOT EXISTS alarm_started_at      timestamptz,
  ADD COLUMN IF NOT EXISTS alarm_notify_count    int          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alarm_next_notify_at  timestamptz,
  ADD COLUMN IF NOT EXISTS alarm_telegram_muted  bool         NOT NULL DEFAULT false;

-- alarm_delay_s already exists (added in 20260527000001_initial.sql).
-- No rename needed — edge function will use alarm_delay_s.
