-- Second diesel tank (e.g. SUKI's 40 l Gobius "Diesel Day Tank", SignalK tanks.fuel.4).
-- The bridge plugin fills it from the second-lowest fuel/diesel tank instance.
alter table public.telemetry add column if not exists tank_dsl2 real;
