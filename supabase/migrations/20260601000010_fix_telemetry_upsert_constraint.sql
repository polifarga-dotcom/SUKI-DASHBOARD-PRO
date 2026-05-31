-- The partial unique index (WHERE boat_id IS NOT NULL) doesn't match
-- PostgreSQL's ON CONFLICT (boat_id) clause used by the signalk-ingest
-- edge function via PostgREST. Partial indexes require the predicate to
-- be included in the ON CONFLICT target, which the Supabase JS client
-- cannot express. Replace with a plain UNIQUE constraint.
--
-- PostgreSQL already treats NULLs as distinct for unique constraints,
-- so multiple NULL boat_ids would still be allowed (not that they occur).

DROP INDEX IF EXISTS public.telemetry_boat_id_unique;
ALTER TABLE public.telemetry
  ADD CONSTRAINT telemetry_boat_id_unique UNIQUE (boat_id);
