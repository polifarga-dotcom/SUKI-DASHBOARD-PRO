-- Restore the unique constraints the app's upserts (onConflict) rely on.
-- After the move to the new project (2026-09-21) at least sensor_alarms(boat_id, sensor)
-- was missing, so every alarm save failed with 42P10 ("no unique or exclusion constraint
-- matching the ON CONFLICT specification"). Idempotent: only adds what is missing.

-- sensor_alarms may hold duplicates without the constraint: keep the newest row per boat + sensor
DELETE FROM public.sensor_alarms a
USING public.sensor_alarms b
WHERE a.boat_id = b.boat_id
  AND a.sensor = b.sensor
  AND (a.updated_at, a.id::text) < (b.updated_at, b.id::text);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('sensor_alarms',        ARRAY['boat_id', 'sensor']),
    ('anchor_config',        ARRAY['boat_id']),
    ('telegram_subscribers', ARRAY['boat_id', 'chat_id']),
    ('boat_members',         ARRAY['boat_id', 'user_id']),
    ('user_roles',           ARRAY['user_id']),
    ('system_config',        ARRAY['key']),
    ('telemetry',            ARRAY['boat_id'])
  ) AS t(tbl, cols)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = ('public.' || r.tbl)::regclass
        AND i.indisunique
        AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
               FROM pg_attribute a
              WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey))
            = (SELECT array_agg(c ORDER BY c) FROM unnest(r.cols) c)
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (%s)',
                     r.tbl, r.tbl || '_' || array_to_string(r.cols, '_') || '_key',
                     (SELECT string_agg(quote_ident(c), ', ') FROM unnest(r.cols) c));
      RAISE NOTICE 'added UNIQUE (%) on %', array_to_string(r.cols, ', '), r.tbl;
    END IF;
  END LOOP;
END $$;
