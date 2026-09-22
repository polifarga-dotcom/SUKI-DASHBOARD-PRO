-- Enable RLS on system_config to prevent anon key access to sensitive values
-- (e.g. telegram_bot_token). Edge functions use the service role key which
-- bypasses RLS, so no additional policies are needed.
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;
