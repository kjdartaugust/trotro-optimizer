-- Where riders say a place really is: a "place" contribution moves a place's pin onto its
-- building (app/apply.py). Devices get them through /sync. Idempotent: `python -m app.seed` runs
-- it on every boot, after 0001.
CREATE TABLE IF NOT EXISTS place_fixes (
    key        varchar(200) PRIMARY KEY,
    name       varchar(160) NOT NULL,
    from_lat   double precision NOT NULL,
    from_lon   double precision NOT NULL,
    lat        double precision NOT NULL,
    lon        double precision NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version    integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_place_fixes_version ON place_fixes (version);
