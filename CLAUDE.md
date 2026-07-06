# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Crowdsourced, offline-first trotro (shared minibus) route & fare optimizer for Ghana. A FastAPI
backend + Next.js PWA frontend. The defining constraint: **routing must work fully offline**, so
the graph routing algorithm exists twice — Python (`backend/app/routing/engine.py`) and TypeScript
(`frontend/src/engine/`) — and the two must stay behaviourally identical. Changing routing logic in
one place means porting the change to the other.

## Commands

Backend (from `backend/`):
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload        # API on :8000, docs at /docs
python -m app.seed                   # load Accra seed dataset into the DB
pytest                               # all tests
pytest tests/test_engine.py -k plan  # single test / filter
```

Frontend (from `frontend/`):
```bash
npm install
npm run dev                          # app on :3000
npm test                             # engine-parity + sync tests (vitest)
npm run build
```

Full stack: `docker compose up --build` (Postgres/PostGIS + Redis + backend + frontend), then
`docker compose exec backend python -m app.seed`.

## Architecture (the parts that span files)

**Routing engine.** The network is a directed weighted graph built in `routing/engine.py`:
station **hub** nodes (street level) + per-`(route, stop)` **board** nodes. Edges are `walk`
(hub↔hub within `walk_radius_m`, plus ORIGIN/DEST → nearby hubs), `board` (hub→board, costs a wait
penalty and +1 transfer), `alight` (board→hub, free), and `ride` (consecutive board nodes, carries
`fare`/`minutes`). Trips run a **lexicographic Dijkstra** over the cost vector `(transfers, fare,
minutes)`; the comparison key is reordered per mode (`fastest`/`cheapest`/`fewest`). The engine is
pure and dataset-driven so the same code serves the API and unit tests, and is mirrored in TS.

**Graph loading & caching.** `loader.py` reads stations/routes/stops from the DB into engine
dataclasses and memoises the built `Graph` per-process, keyed by `dataset_version` (the max row
`version` across stations+routes). Any write bumps versions and invalidates the cache. Redis
(`redis_client.py`) caches `/routes/plan` responses but is best-effort — never block routing on it.

**Crowdsourcing → trust → auto-apply.** Every mutation (new station, route, fare report) is a
`Contribution`, not a direct write. `services.ingest_contribution` computes a confidence
(`trust.py`: reporter trust + trust-weighted votes + time-decay for fares). If confidence ≥
`AUTO_APPROVE_THRESHOLD` it is applied immediately via `apply.py` (which mutates the canonical
tables and bumps `version`); otherwise it waits in the moderation queue. Approvals raise the
reporter's `trust_score`, rejections lower it. `apply_contribution` is the **only** path that edits
canonical station/route data.

**Sync model.** Every row has a monotonic `version` (see `TimestampMixin`). `/sync/dataset` returns
a full snapshot to seed a device; `/sync/changes?since=<cursor>` returns rows with `version >
cursor`; `/sync/push` replays offline-queued contributions, made idempotent by a client-supplied
`client_key`. The frontend stores the dataset in IndexedDB and routes against it locally.

**Auth.** `auth.py` verifies Supabase-issued JWTs (HS256 via `SUPABASE_JWT_SECRET`); `sub` → local
`users` row (upserted) carrying `trust_score` + `role`. With `DEV_AUTH=true`, `POST /auth/token`
mints tokens so the flow is testable without a Supabase project. `require_moderator` gates
moderation endpoints.

## Conventions

- Spatial data is kept as plain `lat`/`lon` floats in the ORM (PostGIS geometry columns are added
  in `migrations/` for server-side queries) so the offline TS engine needs no PostGIS.
- Fares are GHS; a route's fare/time lives on each `RouteStop` as `*_from_prev` (cost of the segment
  from the previous stop), so boarding at A and alighting at B sums the intermediate segments.
- When editing routing behaviour, update **both** engines and the parity test.
