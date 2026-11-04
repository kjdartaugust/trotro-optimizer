"""Build ``backend/seed/accra.json``, Accra's trotro network, from OpenStreetMap.

OSM maps Accra's trotros as public-transport route relations (network "trô trô", one per
direction, from the 2015 Accra Mobility survey), each listing its stops in order. This turns
them into the app's network:

* **stations**: the stops. A stop is usually mapped twice, once per side of the road, and a big
  station as several platforms, so same-named stops close together become one station.
* **routes**: each relation's stops in order, with the time and an estimated fare for each leg.

Times come from each relation's ``travel_time`` (minutes, end to end), shared out by distance.
Fares are not in OSM, so they are estimates until riders report real ones: the minimum fare when
you board (``BOARD_FARE``), plus ``PER_KM`` for each kilometre of road.

    python -m app.etl.osm_network                    # fetch from Overpass, write seed/accra.json
    python -m app.etl.osm_network --from routes.json --places places.json

The data is © OpenStreetMap contributors, under the ODbL (openstreetmap.org/copyright): keep the
credit wherever it is shown.
"""
from __future__ import annotations

import argparse
import json
import logging
import re
from collections import Counter
from pathlib import Path

import httpx

from ..routing.geo import haversine_m

log = logging.getLogger("etl.osm_network")

BUNDLE = Path(__file__).resolve().parents[2] / "seed" / "accra.json"

# Overpass's usage policy wants an identifying User-Agent, and the main server is often at
# capacity; the mirrors carry the same data (sometimes a few months behind, see osm_base).
UA = {"User-Agent": "TrotroOptimizer/0.1 (trotro network ETL; github.com/kjdartaugust/trotro-optimizer)"}
MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)

ROUTES_QUERY = """
[out:json][timeout:300];
area["name"="Greater Accra Region"]->.a;
relation["route"~"^(bus|minibus|share_taxi)$"]["network"="trô trô"](area.a)->.r;
.r out body;
node(r.r);
out body;
"""

# Places name the area a station is in, which tells apart stops that share a name.
PLACES_QUERY = """
[out:json][timeout:180];
node["place"~"^(city|town|suburb|quarter|neighbourhood|village)$"]["name"]({bbox});
out body;
"""

MERGE_M = 300.0          # same-named stops closer than this are one station
UNNAMED_MERGE_M = 150.0  # an unnamed stop this close to a named station joins it
PLACE_MAX_M = 5000.0     # a station's area: the nearest place within this distance

ROAD_FACTOR = 1.3        # road distance over straight-line distance, on average
FALLBACK_KMH = 18.0      # for the few routes with no usable travel_time
MIN_KMH, MAX_KMH = 5.0, 60.0  # a travel_time implying a speed outside this is ignored

# GH¢5.50 is the lowest approved trotro fare since the 8% rise of 26 Sep 2026 (GPRTU/GRTCC
# schedule, GH¢5.50 to GH¢36.80). The schedule is per route, not per km; GH¢0.25/km on top of
# the minimum lands near the published full-route fares (Circle–Madina GH¢9, Circle–Kasoa
# GH¢12, accratrotro.com, "use only as a guide").
BOARD_FARE = 5.50
PER_KM = 0.25

PALETTE = (
    "#e63946", "#457b9d", "#2a9d8f", "#f4a261", "#8338ec", "#ff006e",
    "#3a86ff", "#fb5607", "#06d6a0", "#ffbe0b", "#118ab2", "#ef476f",
)


def normalise(name: str) -> str:
    """The key that decides whether two stops share a name."""
    return re.sub(r"\s+", " ", re.sub(r"[.'’`,]", "", name)).strip().lower()


def _stop_nodes(osm: dict) -> tuple[list[dict], dict[int, dict]]:
    elements = osm.get("elements", [])
    relations = sorted(
        (e for e in elements
         if e.get("type") == "relation" and (e.get("tags") or {}).get("network") == "trô trô"),
        key=lambda e: e["id"],
    )
    nodes = {e["id"]: e for e in elements if e.get("type") == "node"}
    return relations, nodes


class _Sets:
    """Union-find over indexes."""

    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, i: int) -> int:
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def join(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def _centre(members: list[dict]) -> tuple[float, float]:
    return (sum(n["lat"] for n in members) / len(members),
            sum(n["lon"] for n in members) / len(members))


def cluster_stops(nodes: list[dict]) -> tuple[list[dict], dict[int, str]]:
    """Group stop nodes into stations. Returns (stations, node id -> station slug).

    Same-named stops within ``MERGE_M`` of each other, directly or through a chain of them, are
    one station; an unnamed stop joins the nearest named station within ``UNNAMED_MERGE_M``,
    or becomes a station of its own. Slugs are ``osm-n<smallest node id>``, so they stay put
    when the data is rebuilt.
    """
    named: dict[str, list[dict]] = {}
    unnamed: list[dict] = []
    for n in sorted(nodes, key=lambda n: n["id"]):
        name = ((n.get("tags") or {}).get("name") or "").strip()
        if name:
            named.setdefault(normalise(name), []).append(n)
        else:
            unnamed.append(n)

    stations: list[dict] = []
    members_of: dict[str, list[dict]] = {}
    for key in sorted(named):
        group = named[key]
        sets = _Sets(len(group))
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                if haversine_m(a["lat"], a["lon"], b["lat"], b["lon"]) <= MERGE_M:
                    sets.join(i, j)
        clusters: dict[int, list[dict]] = {}
        for i, n in enumerate(group):
            clusters.setdefault(sets.find(i), []).append(n)
        for members in clusters.values():
            names = Counter(n["tags"]["name"].strip() for n in members)
            top = max(names.values())
            # Most used spelling; ties go to the spelling of the lowest node id.
            name = next(n["tags"]["name"].strip() for n in members
                        if names[n["tags"]["name"].strip()] == top)
            lat, lon = _centre(members)
            slug = f"osm-n{min(n['id'] for n in members)}"
            stations.append({"slug": slug, "name": name, "lat": lat, "lon": lon})
            members_of[slug] = members

    for n in unnamed:
        best, best_d = None, UNNAMED_MERGE_M
        for s in stations:
            d = haversine_m(n["lat"], n["lon"], s["lat"], s["lon"])
            if d <= best_d:
                best, best_d = s, d
        if best is not None:
            members_of[best["slug"]].append(n)
        else:
            slug = f"osm-n{n['id']}"
            stations.append({"slug": slug, "name": None, "lat": n["lat"], "lon": n["lon"]})
            members_of[slug] = [n]

    node_to_slug = {n["id"]: slug for slug, members in members_of.items() for n in members}
    stations.sort(key=lambda s: s["slug"])
    return stations, node_to_slug


def nearest_place(lat: float, lon: float, places: list[dict]) -> str | None:
    best, best_d = None, PLACE_MAX_M
    for p in places:
        d = haversine_m(lat, lon, p["lat"], p["lon"])
        if d < best_d:
            best, best_d = p["tags"]["name"], d
    return best


def route_name(tags: dict) -> str:
    """"Trotro 282 : Shalom → Kaneshie" -> "Shalom → Kaneshie"."""
    name = (tags.get("name") or "").strip()
    if " : " in name:
        name = name.split(" : ", 1)[1].strip()
    if not name and tags.get("from") and tags.get("to"):
        name = f"{tags['from'].strip()} → {tags['to'].strip()}"
    return name or f"Trotro {tags.get('ref', '').strip()}".strip()


def _minutes(tags: dict, road_km: float) -> float | None:
    """The relation's end-to-end travel_time, if it gives a believable speed."""
    try:
        mins = float(str(tags.get("travel_time", "")).strip())
    except ValueError:
        return None
    if mins <= 0 or road_km <= 0:
        return None
    kmh = road_km / (mins / 60.0)
    return mins if MIN_KMH <= kmh <= MAX_KMH else None


def build_route(rel: dict, node_to_slug: dict[int, str], by_slug: dict[str, dict]) -> dict | None:
    slugs: list[str] = []
    for m in rel.get("members", []):
        if m.get("type") != "node" or m.get("ref") not in node_to_slug:
            continue
        slug = node_to_slug[m["ref"]]
        if not slugs or slugs[-1] != slug:  # a stop's stop + platform, or both sides, once
            slugs.append(slug)
    if len(slugs) < 2:
        return None

    seg_km = [0.0] + [
        haversine_m(by_slug[a]["lat"], by_slug[a]["lon"], by_slug[b]["lat"], by_slug[b]["lon"])
        / 1000.0 * ROAD_FACTOR
        for a, b in zip(slugs, slugs[1:], strict=False)
    ]
    road_km = sum(seg_km)
    tags = rel.get("tags") or {}
    total_min = _minutes(tags, road_km)
    stops = []
    for slug, km in zip(slugs, seg_km, strict=True):
        if total_min is not None:
            mins = total_min * km / road_km if road_km else 0.0
        else:
            mins = km / FALLBACK_KMH * 60.0
        stops.append({"slug": slug, "fare": round(PER_KM * km, 2), "min": round(mins, 1)})
    return {
        "key": f"osm-r{rel['id']}",
        "name": route_name(tags),
        "ref": (tags.get("ref") or "").strip() or None,
        "operator": (tags.get("operator") or "").strip() or None,
        "color": PALETTE[rel["id"] % len(PALETTE)],
        "board_fare": BOARD_FARE,
        "timed": total_min is not None,
        "stops": stops,
    }


def build(osm: dict, places_osm: dict | None = None) -> dict:
    """The seed bundle for an Overpass answer to ROUTES_QUERY (+ one to PLACES_QUERY)."""
    relations, nodes = _stop_nodes(osm)
    used = {m["ref"] for r in relations for m in r.get("members", []) if m.get("type") == "node"}
    stations, node_to_slug = cluster_stops([nodes[i] for i in sorted(used) if i in nodes])

    places = [p for p in (places_osm or {}).get("elements", []) if (p.get("tags") or {}).get("name")]
    for s in stations:
        s["town"] = nearest_place(s["lat"], s["lon"], places)
        if s["name"] is None:
            s["name"] = f"Stop near {s['town']}" if s["town"] else "Unnamed stop"
        s["lat"], s["lon"] = round(s["lat"], 6), round(s["lon"], 6)

    by_slug = {s["slug"]: s for s in stations}
    routes, skipped = [], 0
    for rel in relations:
        r = build_route(rel, node_to_slug, by_slug)
        if r is None:
            skipped += 1
        else:
            routes.append(r)

    served = {st["slug"] for r in routes for st in r["stops"]}
    stations = [s for s in stations if s["slug"] in served]
    log.info("%d stations from %d stops; %d routes (%d skipped, %d without travel_time)",
             len(stations), len(used), len(routes), skipped, sum(not r["timed"] for r in routes))
    for r in routes:
        del r["timed"]
    return {
        "meta": {
            "city": "Accra",
            "country": "Ghana",
            "currency": "GHS",
            "source": "© OpenStreetMap contributors, ODbL (openstreetmap.org/copyright)",
            "osm_base": (osm.get("osm3s") or {}).get("timestamp_osm_base"),
            "fares": {
                "board": BOARD_FARE,
                "per_km": PER_KM,
                "note": "Estimates: the minimum approved trotro fare when you board, plus a "
                        "per-km charge. Riders' fare reports replace them.",
            },
            "note": "Stops and routes from OpenStreetMap (network 'trô trô'). Times share out "
                    "each route's travel_time by distance; fares are estimates.",
        },
        "stations": stations,
        "routes": routes,
    }


def write_bundle(bundle: dict, path: Path = BUNDLE) -> None:
    """One station or route per line: small diffs when the data is rebuilt."""
    def line(obj: dict) -> str:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

    parts = ['{\n"meta":' + json.dumps(bundle["meta"], ensure_ascii=False, indent=1) + ",\n"]
    parts.append('"stations":[\n' + ",\n".join(line(s) for s in bundle["stations"]) + "\n],\n")
    parts.append('"routes":[\n' + ",\n".join(line(r) for r in bundle["routes"]) + "\n]\n}\n")
    path.write_text("".join(parts), encoding="utf-8")


def fetch(query: str) -> dict:
    """``query``'s answer, from whichever Overpass server has room."""
    errors = []
    for url in MIRRORS:
        try:
            r = httpx.post(url, data={"data": query}, headers=UA, timeout=400)
            r.raise_for_status()
            data = r.json()
            log.info("Overpass %s: data as of %s", url, (data.get("osm3s") or {}).get("timestamp_osm_base"))
            return data
        except (httpx.HTTPError, ValueError) as e:
            log.warning("Overpass %s: %s", url, e)
            errors.append(f"{url}: {e}")
    raise RuntimeError("every Overpass server failed:\n" + "\n".join(errors))


def _bbox(osm: dict, pad: float = 0.02) -> str:
    nodes = [e for e in osm["elements"] if e.get("type") == "node"]
    lats, lons = [n["lat"] for n in nodes], [n["lon"] for n in nodes]
    return f"{min(lats) - pad:.4f},{min(lons) - pad:.4f},{max(lats) + pad:.4f},{max(lons) + pad:.4f}"


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="src", type=Path, help="a saved answer to ROUTES_QUERY")
    ap.add_argument("--places", type=Path, help="a saved answer to PLACES_QUERY")
    ap.add_argument("--out", type=Path, default=BUNDLE)
    args = ap.parse_args()

    osm = json.loads(args.src.read_text(encoding="utf-8")) if args.src else fetch(ROUTES_QUERY)
    places = (json.loads(args.places.read_text(encoding="utf-8")) if args.places
              else fetch(PLACES_QUERY.replace("{bbox}", _bbox(osm))))
    bundle = build(osm, places)
    write_bundle(bundle, args.out)
    log.info("wrote %s", args.out)


if __name__ == "__main__":
    main()
