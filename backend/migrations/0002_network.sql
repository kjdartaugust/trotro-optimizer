-- Accra's real trotro network (backend/seed/accra.json, from OpenStreetMap).
-- Idempotent: `python -m app.seed` runs it on every boot, after 0001.

-- What a trotro charges when you board, wherever you get on: a leg costs board_fare plus the
-- fare_from_prev of each segment ridden. 0 keeps the old segments-only fares.
ALTER TABLE routes ADD COLUMN IF NOT EXISTS board_fare numeric(6,2) NOT NULL DEFAULT 0;

-- Stations and routes taken out of the network, so devices drop them on their next
-- /sync/changes (the version is the sync cursor, as on every other row).
CREATE TABLE IF NOT EXISTS retired_rows (
    id         uuid PRIMARY KEY,
    kind       varchar(20) NOT NULL,            -- station|route
    version    integer NOT NULL,
    retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_retired_rows_version ON retired_rows (version);
