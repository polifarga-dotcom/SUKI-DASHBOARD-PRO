-- Public tracking per boat
ALTER TABLE public.boats
  ADD COLUMN IF NOT EXISTS tracking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_slug    text    UNIQUE;

-- Default slug from boat name
UPDATE public.boats
  SET tracking_slug = lower(regexp_replace(name, '\s+', '-', 'g'))
  WHERE tracking_slug IS NULL;
