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
  confidence threshold; otherwise a moderator reviews them. A photo of a station's **fare board**
  sends every fare on it at once (below).
- **Offline-first** — The full routing dataset is packaged and downloaded to the device
  (IndexedDB). Routing works with **zero network**. When back online the client pulls deltas
  (`/sync/changes?since=…`) and pushes queued contributions.

## The app

Built for a phone first, the way Google or Apple Maps works:

- **A real map of Accra, full screen.** OpenFreeMap streets and place names (free, no key),
  light or dark as the phone is set. All 547 trotro lines are drawn along the roads they drive
  (`frontend/public/network/shapes.json`, below), faint enough that the busy corridors build up.
  Tap a line to see its stops, times and fares; tap a road that many share to see them all; tap
  a stop to start or end a trip there.
- **The places on it, like a map app.** Shops, offices, schools, clinics, churches and mosques,
  fuel stations, banks: each with its icon and a name in the colour of its kind, the busiest or
  surest from zoom 14.5 and the rest as you zoom in. OpenStreetMap's places come with the street
  tiles; Overture's list adds ~16,000 more of Accra's businesses (below). Tap one to see what and
  where it is, the nearest trotro stop, and "Go here" / "Start here".
- **Start from anywhere.** Search a stop (offline, as you type), any place the trotros reach
  (Overture's places on the phone, offline too, and Photon, OpenStreetMap's place search,
  online), "Where I am", or choose a spot on the map. Swap, recent trips, and a link for every
  trip and line (`/?from=…&to=…`, `/?line=…`) to share on WhatsApp.
- **Search like a map app.** Places whose name matches come first, then the nearest to you (when
  the phone already shares your location; the app never asks just to search) or to where the
  map is looking, each with how far it is and its street. Only places inside the network's area
  plus ~10 km (a place in Ho can't be reached by an Accra trotro). Spaces and doubled letters
  don't matter ("Zoom lion", "Trassaco"), and "Can't find it? Choose on the map" is always there.
- **Compare at a glance.** Fastest, cheapest and fewest changes side by side (one card when they
  agree), then step by step: walk here, take the trotro to Nungua, the stops on the way, get off
  at GBC Second, the fare for each part, "Paid something else?" to report it.
- **A swipe-up sheet** over the map on phones; a side panel on a laptop.
- **Fast on a first visit.** The network ships with the app (`public/network/dataset.json`), so
  it opens in seconds from the CDN instead of waiting up to a minute for the free-tier API to
  wake; the app then asks the API only for what changed. Trips are planned in a web worker, so
  the map never stalls.

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
│   │   ├── etl/        builds seed/accra.json and the route lines (OpenStreetMap), places.json (Overture)
│   │   └── ...
│   ├── migrations/     SQL schema (Postgres + PostGIS + H3 spatial index)
│   ├── seed/           the network: accra.json (OpenStreetMap), demo.json (17-stop test network)
│   └── tests/
├── frontend/           Next.js 14 PWA (App Router, MapLibre, IndexedDB, offline engine)
│   ├── public/network/ dataset.json (first-run network snapshot), shapes.json (route lines), places.json
│   ├── scripts/        snapshot.mjs: refresh dataset.json from the API
│   └── src/
│       ├── app/        the map page and the report page
│       ├── components/ map, sheet, search, trip options and steps, line/stop cards
│       ├── engine/     TypeScript routing engine (offline, mirrors backend)
│       └── lib/        sync, db (IndexedDB), api client, planner worker, shapes, places, trips
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
| `GET`  | `/fareboards/status` | – | whether this server can read fare board photos |
| `POST` | `/fareboards/read` | – | read a fare board photo (multipart `photo`) into rows; not stored |

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
  walk across the city. Walks are up to 900 m, except the first and last when no stop is that
  close: then the trip walks to the nearest stops up to 3 km away (`access_radius_m`), since
  plenty of Accra (Spintex, Weija, Kasoa, Oyarifa...) is just past 900 m from a mapped stop. Such
  a walk of 1.5 km or more says a taxi may be quicker. Further than 3 km, the app names the
  nearest stop and its distance, with a button to start or end the trip there.

**Route lines.** OSM's relations also list the roads each route drives. `app/etl/osm_shapes.py`
joins them into one line per route (the way FloodWatch Ghana draws the same routes), fills a
missing piece of road under 2.5 km with OSRM, trims each line to its first and last stop,
simplifies it to 2 m and writes `frontend/public/network/shapes.json`: 533 of the 547 routes,
~70 KB gzipped. The other 14 have gaps in their mapped roads, or lines that don't pass their
stops, and are drawn stop to stop. A trip's ride is cut out of its route's line between the stops
it boards and leaves at.

Rebuild it all (then regenerate the parity fixture, below):

```bash
cd backend
python -m app.etl.osm_network            # fetches from Overpass, writes seed/accra.json
python -m app.etl.osm_shapes             # the route lines, frontend/public/network/shapes.json
python -m tests.parity                   # the trips both engines must agree on
```

Once the API serves a rebuilt network, refresh the app's copy: `cd frontend && npm run snapshot`
(and bump `NETWORK_GENERATION` in `src/lib/sync.ts` if devices must drop what they hold).

**Loading it.** `python -m app.seed` syncs the database to the bundle, and the backend container
runs it on every boot, so a deploy is all it takes. Ids are stable (from OSM ids), so it never
duplicates anything. The first time it meets a database, it retires the rows an earlier seed
loaded that the bundle doesn't have (the old demo network), and devices are told to drop them at
their next sync. After that it only adds stations and routes that are missing. It never edits a
row, so riders' fare reports and corrections survive every redeploy.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.

## Places: OpenStreetMap's and Overture's

OpenStreetMap knows few of Accra's businesses, so the map and search also use
[Overture Maps](https://overturemaps.org)' places, built from Meta's, Microsoft's and others'
business listings and refreshed monthly. `app/etl/overture_places.py` takes the ones in the
network's area (the stops' bounds plus ~10 km) that Overture is fairly sure of (confidence
≥ 0.5), merges a place listed twice, gives each a kind (a label for search, a map icon) and a
tier (the zoom it shows from), keeps its street when Overture's address names one ("University
Farm Rd"), and names its area after the nearest stop's town. A place in both lists shows once,
under the plainer name: OpenStreetMap's when the names are the same (its tiles draw it; search
still finds Overture's copy offline), Overture's when OSM's is the same name and more
("Zoomlion Ghana Limited" and OSM's "Zoomlion Ghana Limited Headquarters", 171 m apart: OSM's
is left off the map by name). Search merges the two the same way, keeping the name that was
typed. It writes `frontend/public/network/places.json`: release 2026-10-21.0 has 16,171 places,
8,580 with a street, ~330 KB over the wire. The app loads it after the network and the service
worker keeps it, so search finds them offline.

```bash
pip install overturemaps                 # only for this script, not the server
cd backend
python -m app.etl.overture_places        # downloads Overture's places and OSM's for comparison
```

Places © [Overture Maps Foundation](https://overturemaps.org), CDLA Permissive 2.0.

## Fare boards

Every GPRTU station puts up its own list: the places its trotros go and the fare to each, changed
when fares change. That list is both the station's current lines and its official fares, so the
report page leads with it: **A fare board**.

1. **The station.** Search it, or "I'm at the station" (the nearest stop within 400 m).
2. **The board.** A photo, shrunk on the phone to ~1600 px, is read on the server by a vision model
   (`backend/app/fareboard.py`) and thrown away; or the rows are typed in. The model's answer is
   checked row by row: fares between GH¢0.50 and 500 (a phone number isn't a fare), each place
   once, 80 rows at most.
3. **The rows.** Each destination is matched to a stop that the station's lines reach after it
   ("Legon Second: 9 lines from Madina"). One that no line reaches is a trotro the network doesn't
   have yet: it's sent too, as a lead for mapping it.
4. **Sent** as a `fareboard` contribution (offline-first, like every report). Once approved,
   `app/fares.py` sets each route leaving the station so that boarding there and getting off at a
   listed stop costs exactly the board's fare: the segments in between share the difference the
   way the estimates did (by distance), and the rest of the route is left alone.

**Which model reads it is the host's choice, none is built in**: anything behind an OpenAI-style
chat-completions API that can see images (Gemini, OpenRouter, Groq, Mistral, OpenAI, Anthropic, a
local Ollama...). Set `VISION_BASE_URL`, `VISION_MODEL` and `VISION_API_KEY` on the server (base
URLs in `.env.example`), and optionally `VISION_FALLBACKS`, tried in order when the first fails.
Unset, the page skips the photo and riders type the board in. Reads are capped at
`FAREBOARD_READS_PER_HOUR` per address (20) and `FAREBOARD_READS_PER_DAY` in all (300), to stay
inside free tiers.

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
cd backend && pytest              # routing engine + API + trust scoring + the OSM import + route lines + places
cd frontend && npm test           # engine parity, route lines, trip options, place search and the places file
```

Both engines are held to the same answers on 30 real trips across the network
(`backend/tests/fixtures/parity.json`); the network sync is tested against CI's Postgres.

## License

MIT.
