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
│   │   └── ...
│   ├── migrations/     SQL schema (Postgres + PostGIS + H3 spatial index)
│   └── tests/
├── frontend/           Next.js 14 PWA (App Router, MapLibre, IndexedDB, offline engine)
│   └── src/
│       ├── engine/     TypeScript routing engine (offline, mirrors backend)
│       └── lib/        sync, db (IndexedDB), api client
├── seed/               Accra stations + routes seed dataset (JSON)
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
# seed the database (first run):
docker compose exec backend python -m app.seed
```

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
uvicorn app.main:app --reload
python -m app.seed
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
| Frontend (Vercel) | _set after deploy_ |
| Backend API (Render) | _set after deploy_ |
| Database host (Neon) | _set after deploy_ |

### 1. Database — Neon (Postgres + PostGIS)

1. Create a project at [neon.tech](https://neon.tech) (free tier). Region closest to Render.
2. Copy the connection string — use the **direct** endpoint (the host **without** `-pooler`;
   asyncpg + Neon's PgBouncer pooler clashes on prepared statements). You need **two forms**
   (same credentials, different driver):
   - `DATABASE_URL` — scheme `postgresql+asyncpg://…` with `?ssl=require`. Use `ssl=require`,
     **not** `sslmode=require`: SQLAlchemy's asyncpg dialect forwards `sslmode` as a kwarg that
     asyncpg rejects, whereas `ssl=require` is accepted by both the app and the raw-asyncpg migration.
   - `DATABASE_URL_SYNC` — scheme `postgresql+psycopg://…` with `?sslmode=require` (psycopg wants `sslmode`).
3. Apply the schema + seed **once**, from `backend/` with those vars exported:
   ```bash
   pip install -r requirements.txt
   DATABASE_URL='postgresql+asyncpg://…?sslmode=require' python -m scripts.init_db   # extensions, tables, PostGIS geom, indexes
   DATABASE_URL='postgresql+asyncpg://…?sslmode=require' python -m app.seed          # 17 Accra stations, 10 routes
   ```
   `init_db` is idempotent (`IF NOT EXISTS`); re-running is safe.

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

- **Code change** → `git push`. Render (`autoDeploy: true`) and Vercel both rebuild on push to the
  default branch. That's the whole loop.
- **Frontend only, on demand** → `vercel --cwd frontend --prod`.
- **Backend only, on demand** → Render dashboard → **Manual Deploy → Deploy latest commit**.
- **Env var change** → edit it in the Render/Vercel dashboard, then trigger a redeploy (env
  changes don't rebuild automatically).
- **Schema change** → add a new `backend/migrations/NNNN_*.sql`, then re-run `python -m scripts.init_db`
  against `DATABASE_URL` (idempotent).

See `.env.example` for every variable and `docker-compose.yml` for the local topology.

## Tests

```bash
cd backend && pytest              # routing engine + API + trust scoring
cd frontend && npm test           # engine parity + sync logic
```

## License

MIT.
