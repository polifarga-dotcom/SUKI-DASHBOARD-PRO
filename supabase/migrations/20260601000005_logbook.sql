-- ── Digital Logbook ────────────────────────────────────────────────────────
-- Two tables: log_trips (voyages) and log_entries (per-hour records)
-- Both are boat-scoped and protected by RLS.

-- Trips (one row = one voyage / leg)
CREATE TABLE IF NOT EXISTS public.log_trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id      uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
  name         text,                          -- e.g. "Palma → Menorca"
  from_port    text,
  to_port      text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,                   -- null = trip still active
  -- Summary stats (updated when trip ends, or updated live)
  total_nm     numeric(8,2),
  sail_nm      numeric(8,2),
  motor_nm     numeric(8,2),
  avg_sog_kn   numeric(5,2),
  max_sog_kn   numeric(5,2),
  engine_hours numeric(6,2),                 -- total engine hours during trip
  notes        text,
  created_at   timestamptz DEFAULT now()
);

-- Log entries (one row ≈ one hourly snapshot or manual entry)
CREATE TABLE IF NOT EXISTS public.log_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid REFERENCES public.log_trips(id) ON DELETE CASCADE,
  boat_id      uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
  logged_at    timestamptz NOT NULL DEFAULT now(),
  -- Position
  lat          numeric(9,6),
  lon          numeric(9,6),
  cog_deg      numeric(5,1),
  sog_kn       numeric(5,2),
  -- Distance leg (nm since last entry)
  distance_nm  numeric(6,3),
  -- Propulsion
  engine_on    boolean DEFAULT false,
  engine_rpm   integer,
  engine_hours numeric(6,2),                 -- cumulative engine hours at log time
  -- Sail state (free text: "Full sail", "Reef 1 + Solent", etc.)
  sails        text,
  -- Weather at log time
  wind_speed_kn  numeric(5,1),
  wind_dir_deg   numeric(5,1),
  baro_hpa       numeric(6,1),
  air_temp_c     numeric(5,1),
  water_temp_c   numeric(5,1),
  -- Sea state
  wave_height_m  numeric(4,2),
  wave_period_s  numeric(4,1),
  -- Notes
  notes        text,
  -- Source: 'auto' (system) or 'manual' (user)
  source       text DEFAULT 'manual' CHECK (source IN ('auto','manual')),
  created_at   timestamptz DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS log_trips_boat_id_idx      ON public.log_trips(boat_id, started_at DESC);
CREATE INDEX IF NOT EXISTS log_entries_trip_id_idx    ON public.log_entries(trip_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS log_entries_boat_id_idx    ON public.log_entries(boat_id, logged_at DESC);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.log_trips   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.log_entries ENABLE ROW LEVEL SECURITY;

-- Boat members can read all trips/entries for their boat
CREATE POLICY "members read log_trips"
  ON public.log_trips FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.boat_members
    WHERE boat_id = log_trips.boat_id AND user_id = auth.uid()
  ));

-- Admins (masters) can insert / update / delete trips
CREATE POLICY "admins manage log_trips"
  ON public.log_trips FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.boat_members
    WHERE boat_id = log_trips.boat_id AND user_id = auth.uid() AND role = 'admin'
  ));

CREATE POLICY "members read log_entries"
  ON public.log_entries FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.boat_members
    WHERE boat_id = log_entries.boat_id AND user_id = auth.uid()
  ));

CREATE POLICY "admins manage log_entries"
  ON public.log_entries FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.boat_members
    WHERE boat_id = log_entries.boat_id AND user_id = auth.uid() AND role = 'admin'
  ));
