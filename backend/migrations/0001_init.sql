-- TroTro Optimizer — initial schema (Postgres 16 + PostGIS).
-- Auto-applied by the postgis/postgis container via /docker-entrypoint-initdb.d.
-- For managed Postgres (Supabase) run this once with:  psql "$DATABASE_URL_SYNC" -f 0001_init.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
-- Optional spatial routing acceleration; ignore if unavailable on your host:
-- CREATE EXTENSION IF NOT EXISTS pgrouting;
-- CREATE EXTENSION IF NOT EXISTS h3;

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email        VARCHAR(255) UNIQUE,
    display_name VARCHAR(120),
    trust_score  DOUBLE PRECISION NOT NULL DEFAULT 20,
    role         VARCHAR(20) NOT NULL DEFAULT 'user',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    version      INTEGER NOT NULL DEFAULT 1
);

-- ---------- stations ----------
CREATE TABLE IF NOT EXISTS stations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(160) NOT NULL,
    town       VARCHAR(120),
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    -- PostGIS point kept in sync with lat/lon for server-side spatial queries (bbox, KNN).
    geom       geography(Point, 4326) GENERATED ALWAYS AS (ST_MakePoint(lon, lat)::geography) STORED,
    h3         VARCHAR(20),
    verified   BOOLEAN NOT NULL DEFAULT false,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_stations_geom ON stations USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_stations_h3 ON stations (h3);
CREATE INDEX IF NOT EXISTS ix_stations_version ON stations (version);

-- ---------- routes ----------
CREATE TABLE IF NOT EXISTS routes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(200) NOT NULL,
    operator   VARCHAR(120),
    color      VARCHAR(9),
    verified   BOOLEAN NOT NULL DEFAULT false,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_routes_version ON routes (version);

-- ---------- route_stops (ordered edges) ----------
CREATE TABLE IF NOT EXISTS route_stops (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id          UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    station_id        UUID NOT NULL REFERENCES stations(id),
    seq               INTEGER NOT NULL,
    fare_from_prev    NUMERIC(6,2) NOT NULL DEFAULT 0,
    minutes_from_prev DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uq_route_seq UNIQUE (route_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_route_stops_route ON route_stops (route_id);
CREATE INDEX IF NOT EXISTS ix_route_stops_station ON route_stops (station_id);

-- ---------- contributions ----------
CREATE TABLE IF NOT EXISTS contributions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        VARCHAR(20) NOT NULL,             -- station|route|fare
    target_id   UUID,
    payload     JSONB NOT NULL,
    note        TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
    confidence  DOUBLE PRECISION NOT NULL DEFAULT 0,
    reporter_id UUID REFERENCES users(id),
    reviewed_by UUID REFERENCES users(id),
    client_key  VARCHAR(80) UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_contributions_status ON contributions (status);

-- ---------- votes ----------
CREATE TABLE IF NOT EXISTS votes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    value           INTEGER NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uq_one_vote UNIQUE (contribution_id, user_id)
);
