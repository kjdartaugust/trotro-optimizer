# TroTro Optimizer 🚐

A **crowdsourced, offline-first trotro (shared minibus) route & fare optimizer for Ghana.**
Find the best route between two points — which trotros to take, where to change, estimated
fare and time — built on community data and working fully offline.

---

## Features

- **Route engine** — Multi-leg trotro routing (station → station with transfers). Returns
  *fastest / cheapest / fewest-changes* options, walking legs to/from stations, and fare per
  leg + total. The network is modelled as a weighted graph (stations = nodes, route segments =
  edges) and solved with a multi-criteria Dijkstra. The same algorithm runs on the server
  (Python) and in the browser (TypeScript) so results are identical online and offline.
- **Crowdsourcing** — Users submit and correct routes, fares, and station locations. Fare
  changes (fuel-price driven) propagate through community reports with **trust/verification
  scoring** and a **moderation queue**. Contributions are auto-applied once they cross a
  confidence threshold; otherwise a moderator reviews them.
- **Offline-first** — The full routing dataset is packaged and downloaded to the device
  (IndexedDB). Routing works with **zero network**. When back online the client pulls deltas
  (`/sync/changes?since=…`) and pushes queued contributions.

## Why Next.js PWA (not Expo)

| Concern | Next.js PWA | Expo / RN |
|---|---|---|
| Distribution in Ghana | Instant URL, "Add to Home Screen", no store | App-store friction, updates gated |
| Offline | Service Worker + IndexedDB (full parity) | AsyncSQLite (also good) |
| One codebase / deploy | Single repo, edge-deployable | Needs EAS build pipeline |
| Maps offline | MapLibre GL + local vector tiles | MapLibre RN |

For a data-first utility that must reach low-end Android phones with flaky data plans, an
installable PWA is the lowest-friction path to *true* offline. The architecture keeps the map
and routing engine framework-agnostic, so an Expo shell can be added later reusing the same
`packages/engine` TypeScript core.

---

## Architecture

```
trotro-optimizer/
├── backend/            FastAPI service (routing, crowdsourcing, moderation, sync, auth)
│   ├── app/
│   │   ├── routing/    Graph + multi-criteria Dijkstra (server mirror of TS engine)
│   │   ├── routers/    /routes /stations /contributions /moderation /sync /auth
│   │   ├── etl/        builds seed/accra.json from OpenStreetMap
│   │   └── ...
│   ├── migrations/     SQL schema (Postgres + PostGIS + H3 spatial index)
│   ├── seed/           the network: accra.json (OpenStreetMap), demo.json (17-stop test network)
│   └── tests/
├── frontend/           Next.js 14 PWA (App Router, MapLibre, IndexedDB, offline engine)
│   └── src/
│       ├── engine/     TypeScript routing engine (offline, mirrors backend)
│       └── lib/        sync, db (IndexedDB), api client
├── docker-compose.yml  Postgres/PostGIS + Redis + backend + frontend
└── .github/workflows/  CI (lint, test, build)
```

**Stack:** Next.js 14 (PWA) · FastAPI · Postgres 16 + PostGIS + H3 · Redis · SQLAlchemy 2 ·
Supabase-compatible JWT auth · MapLibre GL · Docker Compose · GitHub Actions.

---

## Quick start (Docker)

```bash
cp .env.example .env          # fill in secrets (JWT secret etc.)
docker compose up --build     # brings up db, redis, backend (:8000), frontend (:3000)
```

The backend loads the network (`backend/seed/accra.json`) into the database each time it starts;
`docker compose exec backend python -m app.seed` does the same by hand.

- API docs (OpenAPI): http://localhost:8000/docs
- App: http://localhost:3000

## Local dev (without Docker)

**Backend**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# start Postgres+PostGIS and Redis (docker compose up db redis)
alembic upgrade head            # or: psql < migrations/0001_init.sql
python -m app.seed              # load the network (safe to repeat; see below)
uvicorn app.main:app --reload
```

**Frontend**
```bash
cd frontend
npm install
npm run dev
```

---

## API overview

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/health` | – | liveness / readiness |
| `POST` | `/auth/token` (dev) | – | dev-only token mint (prod uses Supabase JWT) |
| `GET`  | `/stations` | – | list/search stations (bbox, near) |
| `POST` | `/stations` | user | propose a new/edited station (contribution) |
| `GET`  | `/routes` | – | list routes/segments |
| `POST` | `/routes/plan` | – | **plan a trip** (from/to coords → itineraries) |
| `POST` | `/contributions` | user | submit route/fare/station correction |
| `POST` | `/contributions/{id}/vote` | user | up/down-vote a contribution |
| `GET`  | `/moderation/queue` | mod | pending contributions |
| `POST` | `/moderation/{id}/decision` | mod | approve/reject |
| `GET`  | `/sync/dataset` | – | full offline snapshot (versioned) |
| `GET`  | `/sync/changes?since=` | – | deltas since a version cursor |
| `POST` | `/sync/push` | user | push queued offline contributions |

Full schema at `/docs` (Swagger) and `/openapi.json`.

## The network: Accra's trotros, from OpenStreetMap

`backend/seed/accra.json` holds **547 routes** (one per direction) and **1,753 stations**, built
from OpenStreetMap, where Accra's trotro network is mapped as public-transport routes (network
`trô trô`, from the 2015 Accra Mobility survey), each listing its stops in order.

- **Stations.** A stop is usually mapped once per side of the road, and a big station as several
  platforms; same-named stops within 300 m become one station. Each gets the nearest OSM place
  as its area, which tells apart stops that share a name.
- **Times.** Each route's own `travel_time`, shared between its stops by distance.
- **Fares are estimates** until riders report real ones: the minimum approved trotro fare when
  you board (GH¢5.50 since the 8% rise of 26 September 2026), plus GH¢0.25 per km of road. A
  route's `board_fare` is charged once per boarding; its stops' `fare_from_prev` add to it.
- **Walking** is to your first trotro, between two trotros, and from your last one, never stop
  after stop: with stops a few hundred metres apart, the cheapest trip would otherwise be a free
  walk across the city.

Rebuild it (then regenerate the parity fixture, below):

```bash
cd backend
python -m app.etl.osm_network            # fetches from Overpass, writes seed/accra.json
python -m tests.parity                   # the trips both engines must agree on
```

**Loading it.** `python -m app.seed` syncs the database to the bundle, and the backend container
runs it on every boot, so a deploy is all it takes. Ids are stable (from OSM ids), so it never
duplicates anything. The first time it meets a database, it retires the rows an earlier seed
loaded that the bundle doesn't have (the old demo network), and devices are told to drop them at
their next sync. After that it only adds stations and routes that are missing. It never edits a
row, so riders' fare reports and corrections survive every redeploy.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.

## Trust & moderation model

Each user has a `trust_score` (0–100). A contribution's weight = f(reporter trust, corroborating
votes, recency). When weighted confidence ≥ `AUTO_APPROVE_THRESHOLD` the change is applied and
the underlying record's `verified` flag/`confidence` is updated; otherwise it enters the
moderation queue. Approvals raise the reporter's trust; rejections lower it. Fare reports are
time-decayed so fuel-price jumps converge quickly on the new consensus.

## Deployment

The reference deployment uses **free tiers only**: **Neon** (Postgres + PostGIS), **Render**
(backend Docker), **Vercel** (Next.js PWA). Every value below comes from `.env.example`; nothing
is hard-coded, so anyone can reproduce this from scratch.

### Live URLs

| Piece | URL |
| --- | --- |
| Frontend (Vercel) | https://frontend-blush-five-v3pge1dl9r.vercel.app |
| Backend API (Render) | https://trotro-api-gblb.onrender.com — `/health`, `/docs` |
| Database host (Neon) | `ep-ancient-tree-assg5it7.c-4.eu-central-1.aws.neon.tech` (`neondb`) |

### 1. Database — Neon (Postgres + PostGIS)

1. Create a project at [neon.tech](https://neon.tech) (free tier). Region closest to Render.
2. Copy the connection string — use the **direct** endpoint (the host **without** `-pooler`;
   asyncpg + Neon's PgBouncer pooler clashes on prepared statements). You need **two forms**
   (same credentials, different driver):
   - `DATABASE_URL` — scheme `postgresql+asyncpg://…` with `?ssl=require`. Use `ssl=require`,
     **not** `sslmode=require`: SQLAlchemy's asyncpg dialect forwards `sslmode` as a kwarg that
     asyncpg rejects, whereas `ssl=require` is accepted by both the app and the raw-asyncpg migration.
   - `DATABASE_URL_SYNC` — scheme `postgresql+psycopg://…` with `?sslmode=require` (psycopg wants `sslmode`).
3. Apply the base schema **once**, from `backend/` with those vars exported:
   ```bash
   pip install -r requirements.txt
   DATABASE_URL='postgresql+asyncpg://…?sslmode=require' python -m scripts.init_db   # extensions, tables, PostGIS geom, indexes
   ```
   `init_db` is idempotent (`IF NOT EXISTS`); re-running is safe. The network loads by itself
   when the backend starts (later migrations too); `python -m app.seed` does it by hand.

### 2. Backend — Render (Docker, free web service)

`render.yaml` is a one-click Blueprint. In the Render dashboard: **New → Blueprint → pick this
repo**. It builds `backend/Dockerfile` and binds `$PORT` automatically. Set the two secrets it
prompts for (`sync: false`, never stored in git):

- `DATABASE_URL` / `DATABASE_URL_SYNC` — the Neon strings from step 1.
- `CORS_ORIGINS` — leave blank for now; fill in the Vercel origin after step 3.

`SUPABASE_JWT_SECRET` is auto-generated; `DEV_AUTH=true` lets `POST /auth/token` mint tokens
without a Supabase project. `REDIS_URL` is optional — the API degrades gracefully without it.
Health check is `/health`.

### 3. Frontend — Vercel (Next.js PWA)

Import the repo in Vercel with **Root Directory = `frontend`**. Set one env var:

- `NEXT_PUBLIC_API_URL` = your Render backend URL (e.g. `https://trotro-api.onrender.com`).

Or from the CLI, at the repo root:
```bash
vercel --cwd frontend --prod
```

### 4. Wire CORS + verify

1. Back in Render, set `CORS_ORIGINS` to your Vercel origin (e.g. `https://trotro.vercel.app`)
   and let it redeploy.
2. Open the Vercel URL. Loading the map/dataset issues a live cross-origin call to Render → Neon.
3. Confirm persistence end-to-end: submit a fare/route contribution in the app, then check it
   landed with `curl https://<render-url>/sync/changes?since=0` (the new row appears) — proving
   frontend → backend → Neon writes are flowing.

### How to redeploy

- **Backend** → `git push`. Render (`autoDeploy: true`) rebuilds on push to the default branch.
- **Frontend** → `vercel --cwd frontend --prod` (this project deploys via the Vercel CLI, not a
  git integration). Required after any `NEXT_PUBLIC_*` change, since those are inlined at build time.
- **Env var change** → edit it in the Render/Vercel dashboard, then trigger a redeploy (env
  changes don't rebuild automatically).
- **Schema change** → add a new, idempotent `backend/migrations/NNNN_*.sql`: the backend runs
  every migration after 0001 when it starts (`python -m app.seed --boot`).

### Keeping the free tier warm

`.github/workflows/keep-alive.yml` pings `/health` every ~10 min so Render doesn't cold-start
(and the health check's `SELECT 1` wakes Neon). Trigger it by hand from the Actions tab
("Run workflow"). For a fork, set a repo Variable `BACKEND_URL` to your own backend; GitHub
disables scheduled workflows after 60 days of repo inactivity (any push re-enables them).

See `.env.example` for every variable and `docker-compose.yml` for the local topology.

## Tests

```bash
cd backend && pytest              # routing engine + API + trust scoring + the OSM import
cd frontend && npm test           # engine parity + sync logic
```

Both engines are held to the same answers on 30 real trips across the network
(`backend/tests/fixtures/parity.json`); the network sync is tested against CI's Postgres.

## License

MIT.
