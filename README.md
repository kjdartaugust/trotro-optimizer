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

- **Backend**: any container host (Fly.io / Render / Railway / Cloud Run) using `backend/Dockerfile`.
- **DB/Auth**: Supabase (Postgres + PostGIS + Auth) — set `DATABASE_URL` + `SUPABASE_JWT_SECRET`.
- **Redis**: Upstash / managed Redis — set `REDIS_URL`.
- **Frontend**: Vercel / Netlify / any static+edge host — set `NEXT_PUBLIC_API_URL`.

See `.env.example` for every variable and `docker-compose.yml` for the local topology.

## Tests

```bash
cd backend && pytest              # routing engine + API + trust scoring
cd frontend && npm test           # engine parity + sync logic
```

## License

MIT.
