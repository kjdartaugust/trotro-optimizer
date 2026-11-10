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
python -m app.seed                   # sync the DB's network to seed/accra.json (safe to repeat)
python -m app.seed --reset --file seed/demo.json   # dev: the 17-station demo network instead
python -m app.etl.osm_network        # rebuild seed/accra.json from OpenStreetMap (Overpass)
python -m app.etl.osm_shapes         # rebuild the map's route lines (frontend/public/network/shapes.json)
python -m app.etl.overture_places    # rebuild the map's/search's places (public/network/places.json; pip install overturemaps)
python -m tests.parity               # regenerate tests/fixtures/parity.json after either of these
pytest                               # all tests (test_seed needs Postgres; skipped without)
pytest tests/test_engine.py -k plan  # single test / filter
```

Frontend (from `frontend/`):
```bash
npm install
npm run dev                          # app on :3000
npm test                             # engine parity, route lines, trip options (vitest)
npm run build
npm run snapshot                     # refresh public/network/dataset.json from the live API
```

Full stack: `docker compose up --build` (Postgres/PostGIS + Redis + backend + frontend), then
`docker compose exec backend python -m app.seed`.

## Architecture (the parts that span files)

**Routing engine.** The network is a directed weighted graph built in `routing/engine.py`:
station **hub** nodes (street level) + per-`(route, stop)` **board** nodes. Edges are `walk`
(hub↔hub within `walk_radius_m`, plus ORIGIN/DEST → nearby hubs), `board` (hub→board, costs a wait
penalty, the route's `board_fare` and +1 transfer), `alight` (board→hub, free), and `ride`
(consecutive board nodes, carries `fare`/`minutes`). Trips run a **lexicographic Dijkstra** over
the cost vector `(transfers, fare, minutes)`; the comparison key is reordered per mode
(`fastest`/`cheapest`/`fewest`), and equal keys pop in push order (heapq's counter; the TS heap
copies it). The engine is pure and dataset-driven so the same code serves the API and unit tests,
and is mirrored in TS.

**Walks never chain.** Each station also has a **foot** node: walk edges go hub→foot (and
ORIGIN→foot), a foot node can only board, and the final walk to DEST starts at a hub. With the
real network's stops 50–500 m apart, chained walks made "cheapest" a free 12 km walk.

**Access walks.** ORIGIN/DEST connect to the 8 nearest stations within `walk_radius_m` (900 m);
when none is that close, to the 8 nearest within `access_radius_m` (3 km), so places just past
900 m from a mapped stop (much of Accra) still get a trip (`_nearest_hubs` / `nearestHubs`). The
UI (`app/page.tsx`) names the nearest stop beyond 3 km and offers to start or end there.

**Parity is tested on the real network**: `backend/tests/fixtures/parity.json` is the Python
engine's answers to 30 station-to-station trips over `seed/accra.json` plus `FAR_TRIPS` (real
places beyond 900 m of a stop, one beyond 3 km); `test_parity.py` and `engine.test.ts` hold
both engines to it. Regenerate it (`python -m tests.parity`) after rebuilding the seed or changing
routing on purpose, then port the change.

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

**Fare boards.** A `fareboard` contribution is a station's posted list: payload `station_id` +
`rows` of `{to, fare, to_station_id|null}` (checked in `schemas.ContributionCreate`). On approval
`fares.apply_fareboard` runs `fit_route` on every route through the station: the segments after it
are set so boarding there and alighting at each listed stop costs exactly that fare (difference
shared by the old per-segment weights; a fare cheaper than an earlier one is skipped; `board_fare`
only ever lowered). Rows with no `to_station_id` are lines the network lacks, kept as leads. Photos
are read by `fareboard.read_board` with whichever OpenAI-compatible vision model the host sets
(`VISION_BASE_URL/MODEL/API_KEY`, then `VISION_FALLBACKS`; none is assumed, keys only from env)
and never stored; `routers/fareboards.py` caps reads per address/hour and per day. Frontend:
`components/FareBoardForm.tsx`, `lib/fareboard.ts` (`shrink`, `reachable`, `matchDestination`).

**Sync model.** Every row has a monotonic `version` (see `TimestampMixin`). `/sync/dataset` returns
a full snapshot to seed a device; `/sync/changes?since=<cursor>` returns rows with `version >
cursor`, plus the ids in `retired_rows` newer than the cursor (`deleted_*_ids`) for the device to
drop; `/sync/push` replays offline-queued contributions, made idempotent by a client-supplied
`client_key`. The frontend stores the dataset in IndexedDB and routes against it locally;
`NETWORK_GENERATION` in `sync.ts` forces a full re-download when bumped. `dataset_version`
(loader.py) includes retired rows, and the loader reads rows in id order, as IndexedDB does.

**The network** is `backend/seed/accra.json`, built by `app/etl/osm_network.py` from OSM (stops,
order, `travel_time`; fares estimated: `board_fare` GH¢5.50 + GH¢0.25/km). `app/seed.py` syncs it
and the Dockerfile runs `python -m app.seed --boot` before uvicorn, which also applies every
migration after 0001. Ids are uuid5 of OSM ids. The first sync against a database retires the
rows an earlier seed loaded (`created_by` empty) that the bundle lacks; after that it only
inserts missing rows and never edits one, so community edits survive deploys. `backend/seed/` is
inside the Docker build context (`./backend`); the repo root is not.

**Auth.** `auth.py` verifies Supabase-issued JWTs (HS256 via `SUPABASE_JWT_SECRET`); `sub` → local
`users` row (upserted) carrying `trust_score` + `role`. With `DEV_AUTH=true`, `POST /auth/token`
mints tokens so the flow is testable without a Supabase project. `require_moderator` gates
moderation endpoints.

**The app (frontend).** One map page (`app/page.tsx`): `TripMap` (MapLibre over OpenFreeMap
styles; the network, stops and the open trip/line as GeoJSON layers under the place labels), a
`Sheet` (drag-up on phones, side panel ≥900px), and what's in it: `SearchPanel`, `TripFields`,
`Options`, `Steps`, `Cards` (line, lines-on-a-road, stop, dropped pin). `lib/network.ts` builds
the lookups the screens need once per sync; `lib/trip.ts` merges modes that agree and keeps
recents/links. Planning runs in `lib/plan.worker.ts` (`lib/plan.ts` falls back to the main
thread). The map's padding is set on the map (`setPadding`), never per `flyTo`/`fitBounds`:
MapLibre adds a move's padding to the map's, and mixing them left no room to frame a trip.

**Place search** (`lib/places.ts`): Photon results kept to `Network.area` (the stops' bounds +
~10 km), ranked by name match (`nameMatch`: spaces/doubled letters ignored via `search.squash`)
then distance from the rider (`me`: only read silently when geolocation is already granted) or
else the map's centre (`TripMap onMoved`). Never from a fixed point. No hits with a space in the
query: retried without spaces ("Zoom lion"). Overture's places (`lib/morePlaces.ts`,
`findMorePlaces`) answer first and offline; `SearchPanel` merges them with Photon's through
`rankPlaces`: within 300 m, the same squashed name, or one name (8+ letters) inside the other, is
one place, kept as the name typed, else the better match, else the shorter name ("Zoomlion Ghana
Limited" over OSM's "... Headquarters", 171 m apart).

**Places on the map** (`lib/mapPlaces.ts`): OpenStreetMap's POIs from the tiles' `poi` layer and
Overture's from `public/network/places.json` (source `places`) share one look (icon by `class`,
name coloured by kind) and three tiers by zoom (14.5/15.5/16.5), stacked above our lines and
under street/town names (`placesBefore`). Overture features carry the tiles' property names
(`class`, `name`, `rank`, plus `tier`, `i`) so one style draws both; `icon-image` must not take
`["image", null]` (an error that hides the icon), hence `to-string`. Taps on a place give
`onTap(at, {name, i})`. `places.json` is built by `app/etl/overture_places.py` (needs
`pip install overturemaps`; not a server dependency): confidence ≥ 0.5, copies merged, kind and
tier per place, street from Overture's address when it names a road or building (`street_of`).
A place in both lists shows once, the plainer name: `on_osm_map` where OSM has the same name (or a
shorter one inside Overture's); `hide_osm` (OSM names the app filters out of the tiles' layers,
`mapPlaces.osmFilter`) where OSM's is Overture's and more, only for names OSM uses once in the
area. Under the same name or a fuller one, the place also takes OSM's spot (mappers put it on the
building; Overture's Zoomlion sat on the road); under a shorter one (a market, a mall) it keeps its
own. A guessed spot is left out unless OSM has the place: a point several different businesses
share (an area or street turned into a point: 293 listings sat on 5.55, -0.2 "Accra"; kept when
most give the same venue address), a coarse one (4 decimals or fewer), and listings named just a
town ("Nungua"). OSM's spot only counts when it isn't coarse or shared either. The app fetches `places.json?v=<hash>` (`next.config.mjs`), so a new file arrives with the app
that reads it, not a cached one a visit later. Rebuild it monthly (Overture's releases) or after the
network's area changes. Credit
"Overture Maps Foundation" wherever places show. The theme switch uses `setStyle(..., {diff:
false})`: a diffed style drops our layers with no `style.load` to re-add them.

**Route lines.** `app/etl/osm_shapes.py` writes one encoded polyline per route id to
`frontend/public/network/shapes.json`; `lib/shapes.ts` decodes it and cuts rides out with
`matchStops`, which mirrors `match_stops` in the ETL (stops placed on the line in order). A route
without a line is drawn stop to stop. Rebuild after `osm_network`.

**First visit.** `ensureNetwork` (sync.ts) loads `public/network/dataset.json`, the API's
`/sync/dataset` saved by `npm run snapshot`, from the CDN; `pull` then asks the API for changes
since its version. Excluded from the PWA precache (it lives in IndexedDB after the first visit).
Refresh it whenever the API's network is rebuilt.

## Conventions

- Spatial data is kept as plain `lat`/`lon` floats in the ORM (PostGIS geometry columns are added
  in `migrations/` for server-side queries) so the offline TS engine needs no PostGIS.
- Fares are GHS; a route's fare/time lives on each `RouteStop` as `*_from_prev` (cost of the segment
  from the previous stop), so boarding at A and alighting at B sums the intermediate segments, plus
  the route's `board_fare` once per boarding.
- OSM data is ODbL: keep the "© OpenStreetMap contributors" credit wherever stops/routes are shown.
- When editing routing behaviour, update **both** engines and the parity test.
