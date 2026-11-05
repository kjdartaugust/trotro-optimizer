"""Draw each trotro route along the roads it drives: ``frontend/public/network/shapes.json``.

The network bundle (``seed/accra.json``) knows each route's stops; OSM's route relations also list
the roads between them, in order. This joins each relation's road pieces into one line (the way
FloodWatch Ghana draws the same routes), trims it to the route's first and last stop, simplifies
it to about 5 m and writes it as an encoded polyline, keyed by the route's id in the app. The app
draws the network from it and cuts each trip's rides out of it; a route without a line here is
drawn stop to stop instead.

    python -m app.etl.osm_shapes                  # fetch from Overpass
    python -m app.etl.osm_shapes --from ways.json # a saved answer to QUERY

Run it after ``app.etl.osm_network`` rebuilds the bundle. The lines are © OpenStreetMap
contributors, under the ODbL: keep the credit wherever they are shown.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import time
from functools import cache
from pathlib import Path

import httpx

from ..ids import route_uuid
from .osm_network import BUNDLE, UA, fetch

log = logging.getLogger("etl.osm_shapes")

OUT = Path(__file__).resolve().parents[3] / "frontend" / "public" / "network" / "shapes.json"

# The routes' relations, then each road they use, once. Asking for the relations' geometry
# directly repeats a trunk road in every route that drives it.
QUERY = """
[out:json][timeout:300];
area["name"="Greater Accra Region"]->.a;
relation["route"~"^(bus|minibus|share_taxi)$"]["network"="trô trô"](area.a)->.r;
.r out body;
way(r.r);
out geom;
"""

SIMPLIFY_M = 2.0  # roundabouts still round at street level, at ~70 KB gzipped for every route

# A few relations have a road piece missing. OSRM, a free router over the same OSM roads, gives
# the drivable way between the loose ends (build time only). A gap it can't fill and longer than
# MAX_GAP_M would be a straight line through houses, and one over MAX_FILL_M is most of the route
# unmapped, where the router would only be guessing: either way the route is drawn stop to stop.
OSRM = "https://router.project-osrm.org/route/v1/driving/"
FILL_FROM_M = 50.0
MAX_GAP_M = 300.0
MAX_FILL_M = 2500.0

# A stop this far from its route's line means the line doesn't follow the route: with more than
# FAR_SHARE of its stops that far away, the route is drawn stop to stop.
FAR_M = 250.0
FAR_SHARE = 0.1

# (node id, lng, lat)
Node = tuple[int, float, float]
LngLat = tuple[float, float]

_R = 6_371_000.0
_COS = math.cos(math.radians(5.6))  # Accra: east-west metres per degree shrink by this


def _xy(p: LngLat) -> tuple[float, float]:
    """Metres on a flat map of Accra; good to well under a metre across the region."""
    return math.radians(p[0]) * _R * _COS, math.radians(p[1]) * _R


def _metres(a: LngLat, b: LngLat) -> float:
    (ax, ay), (bx, by) = _xy(a), _xy(b)
    return math.hypot(bx - ax, by - ay)


# ── Joining a relation's roads into one line (after FloodWatch's osm_routes) ────────────────────

def _pieces(rel: dict, ways: dict[int, dict]) -> list[list[Node]]:
    """The roads a relation drives, in order; stops and platforms left out."""
    out = []
    for m in rel.get("members", []):
        if m["type"] != "way" or m.get("role", "") not in ("", "forward", "backward"):
            continue
        w = ways.get(m["ref"])
        if w and len(w.get("nodes", [])) >= 2:
            out.append([(n, g["lon"], g["lat"])
                        for n, g in zip(w["nodes"], w["geometry"], strict=True)])
    return out


def _arc(ring: list[Node], start: int, end_ids: set[int]) -> list[Node]:
    """Round a closed way (a roundabout) in its own direction, from the node we entered at to the
    first node the next road leaves from."""
    nodes = ring[:-1]  # first and last are the same node
    ids = [n[0] for n in nodes]
    i = ids.index(start)
    arc = [nodes[i]]
    for k in range(1, len(nodes)):
        node = nodes[(i + k) % len(nodes)]
        arc.append(node)
        if node[0] in end_ids:
            return arc
    return [nodes[i]]  # the next road doesn't touch it: pass straight through


def stitch(pieces: list[list[Node]]) -> tuple[list[Node], list[tuple[int, float]]]:
    """Join a route's road pieces, in member order, into one path.

    Returns the path and its gaps: where it had to jump between pieces that don't meet, as
    (index of the node landed on, metres). Empty for a clean relation."""
    if not pieces:
        return [], []
    first = pieces[0]
    if len(pieces) > 1:
        # Point the first road at the second.
        ends = {pieces[1][0][0], pieces[1][-1][0]}
        if first[0][0] in ends and first[-1][0] not in ends:
            first = first[::-1]
    path: list[Node] = list(first)
    gaps: list[tuple[int, float]] = []
    for k, piece in enumerate(pieces[1:], start=1):
        end = path[-1][0]
        ids = {n[0] for n in piece}
        if piece[0][0] == piece[-1][0] and end in ids:
            after = pieces[k + 1] if k + 1 < len(pieces) else []
            path += _arc(piece, end, {n[0] for n in after})[1:]
            continue
        if piece[0][0] == end:
            path += piece[1:]
        elif piece[-1][0] == end:
            path += piece[::-1][1:]
        elif len(path) == len(first) and path[0][0] in (piece[0][0], piece[-1][0]):
            # We guessed the first road's direction wrong: turn it round.
            path.reverse()
            path += piece[1:] if piece[0][0] == path[-1][0] else piece[::-1][1:]
        else:
            a = (path[-1][1], path[-1][2])
            flip = _metres(a, (piece[-1][1], piece[-1][2])) < _metres(a, (piece[0][1], piece[0][2]))
            near = piece[::-1] if flip else piece
            gaps.append((len(path), _metres(a, (near[0][1], near[0][2]))))
            path += near
    return path, gaps


@cache  # routes that share a road share its missing piece: ask once
def road_between(a: LngLat, b: LngLat) -> tuple[LngLat, ...] | None:
    """The drivable way from a to b, by OSRM; None if there isn't a sensible one."""
    try:
        r = httpx.get(f"{OSRM}{a[0]},{a[1]};{b[0]},{b[1]}",
                      params={"overview": "full", "geometries": "geojson"},
                      headers=UA, timeout=30)
        r.raise_for_status()
        route = r.json()["routes"][0]
    except (httpx.HTTPError, ValueError, KeyError, IndexError) as e:
        log.warning("OSRM %s -> %s: %s", a, b, e)
        return None
    finally:
        time.sleep(1)  # the public server asks for at most one request a second
    if route["distance"] > 3 * _metres(a, b) + 500:
        return None  # a detour round something, not the missing stretch of road
    return tuple(tuple(c) for c in route["geometry"]["coordinates"])


def mend(path: list[Node], gaps: list[tuple[int, float]], route=road_between,
         ) -> list[LngLat] | None:
    """The path as (lng, lat), with its gaps driven along real roads; None if a long gap
    couldn't be filled."""
    coords = [(lng, lat) for _, lng, lat in path]
    for at, metres in reversed(gaps):  # back to front, so earlier indices hold
        if metres < FILL_FROM_M:
            continue
        if metres > MAX_FILL_M:
            return None
        road = route(coords[at - 1], coords[at])
        if road is None:
            if metres > MAX_GAP_M:
                return None
            continue
        coords[at:at] = list(road[1:-1])
    return coords


# ── Fitting the line to the route's stops ────────────────────────────────────────────────────────

def simplify(coords: list[LngLat], tol_m: float = SIMPLIFY_M) -> list[LngLat]:
    """Douglas-Peucker: drop the points that sit within ``tol_m`` of the line through the rest."""
    if len(coords) < 3:
        return list(coords)
    xy = [_xy(p) for p in coords]
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        far, far_d = -1, tol_m
        for i in range(a + 1, b):
            px, py = xy[i]
            d = (abs(dy * (px - ax) - dx * (py - ay)) / seg if seg
                 else math.hypot(px - ax, py - ay))
            if d > far_d:
                far, far_d = i, d
        if far >= 0:
            keep[far] = True
            stack += [(a, far), (far, b)]
    return [p for p, k in zip(coords, keep, strict=True) if k]


def _project(p: LngLat, a: LngLat, b: LngLat) -> tuple[float, float]:
    """Where ``p`` lands on segment a→b: (fraction along it, metres away)."""
    (px, py), (ax, ay), (bx, by) = _xy(p), _xy(a), _xy(b)
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    t = 0.0 if not len2 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
    return t, math.hypot(ax + t * dx - px, ay + t * dy - py)


# A trotro passes a stop where the line first comes this close to the best it ever gets: on a
# road it drives twice, the first time, which is the one in stop order.
SLACK_M = 40.0


def match_stops(line: list[LngLat], stops: list[LngLat]) -> list[tuple[int, float, float]]:
    """Each stop's place on the line, in stop order: (segment, fraction along it, metres away).

    A stop is never placed before the one ahead of it. Mirrored by ``matchStops`` in the app's
    ``lib/shapes.ts``, which cuts trips' rides out of the lines the same way."""
    out = []
    seg, frac = 0, 0.0
    for s in stops:
        cand = []
        for k in range(seg, len(line) - 1):
            t, d = _project(s, line[k], line[k + 1])
            if k == seg and t < frac:
                t, d = frac, _metres(s, _at(line, k, frac))
            cand.append((k, t, d))
        if not cand:  # a one-point line
            out.append((0, 0.0, _metres(s, line[0])))
            continue
        best = min(c[2] for c in cand)
        i = next(i for i, c in enumerate(cand) if c[2] <= best + SLACK_M)
        while i + 1 < len(cand) and cand[i + 1][2] < cand[i][2]:
            i += 1  # down to the closest point of that pass
        seg, frac, d = cand[i]
        out.append((seg, frac, d))
    return out


def _at(line: list[LngLat], seg: int, t: float) -> LngLat:
    (ax, ay), (bx, by) = line[seg], line[min(seg + 1, len(line) - 1)]
    return ax + t * (bx - ax), ay + t * (by - ay)


def trim(line: list[LngLat], start: tuple[int, float], end: tuple[int, float]) -> list[LngLat]:
    """The line from one place on it to a later one."""
    (s, st), (e, et) = start, end
    out = [_at(line, s, st), *line[s + 1:e + 1], _at(line, e, et)]
    return [p for i, p in enumerate(out) if i == 0 or p != out[i - 1]]


# ── Output ───────────────────────────────────────────────────────────────────────────────────────

def encode(coords: list[LngLat]) -> str:
    """Google's encoded polyline (precision 5, latitude first): ~4 bytes a point, not ~20."""
    out: list[str] = []
    plat = plng = 0
    for lng, lat in coords:
        ilat, ilng = round(lat * 1e5), round(lng * 1e5)
        for v in (ilat - plat, ilng - plng):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return "".join(out)


def decode(s: str) -> list[LngLat]:
    coords: list[LngLat] = []
    i = lat = lng = 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(res >> 1) if res & 1 else res >> 1)
        lat += vals[0]
        lng += vals[1]
        coords.append((lng / 1e5, lat / 1e5))
    return coords


def build(osm: dict, bundle: dict, route=road_between) -> tuple[dict[str, str], dict]:
    """Each bundle route's line (route id -> encoded polyline), and what happened to the rest."""
    ways = {e["id"]: e for e in osm["elements"] if e["type"] == "way"}
    rels = {e["id"]: e for e in osm["elements"] if e["type"] == "relation"}
    where = {s["slug"]: (s["lon"], s["lat"]) for s in bundle["stations"]}

    lines: dict[str, str] = {}
    stats: dict[str, list] = {"missing": [], "unmendable": [], "off_route": []}
    points = 0
    for r in bundle["routes"]:
        rel = rels.get(int(r["key"].removeprefix("osm-r")))
        if rel is None:
            stats["missing"].append(r["key"])
            continue
        path, gaps = stitch(_pieces(rel, ways))
        coords = mend(path, gaps, route) if len(path) >= 2 else None
        if coords is None:
            stats["unmendable"].append(r["key"])
            continue
        line = simplify(coords)
        stops = [where[s["slug"]] for s in r["stops"]]
        placed = match_stops(line, stops)
        far = sum(1 for *_, d in placed if d > FAR_M)
        if far > FAR_SHARE * len(stops):
            stats["off_route"].append((r["key"], far, len(stops)))
            continue
        shape = [(round(x, 5), round(y, 5)) for x, y in
                 trim(line, placed[0][:2], placed[-1][:2])]
        if len(shape) < 2:
            stats["off_route"].append((r["key"], far, len(stops)))
            continue
        points += len(shape)
        lines[route_uuid(r["key"])] = encode(shape)
    stats["points"] = [points]
    return lines, stats


def write(lines: dict[str, str], osm_base: str | None, path: Path = OUT) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    head = {
        "attribution": "Route lines (c) OpenStreetMap contributors, ODbL 1.0. "
                       "https://www.openstreetmap.org/copyright",
        "osm_base": osm_base,
        "encoding": "Google encoded polyline, precision 5",
    }
    # One route per line keeps rebuilds reviewable as a diff.
    body = ",\n".join(f"{json.dumps(k)}:{json.dumps(v)}" for k, v in sorted(lines.items()))
    path.write_text(json.dumps(head)[:-1] + ',"routes":{\n' + body + "\n}}\n", encoding="utf-8")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # a line per OSRM request otherwise
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="src", type=Path, help="a saved answer to QUERY")
    ap.add_argument("--bundle", type=Path, default=BUNDLE)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    osm = json.loads(args.src.read_text(encoding="utf-8")) if args.src else fetch(QUERY)
    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    lines, stats = build(osm, bundle)
    write(lines, (osm.get("osm3s") or {}).get("timestamp_osm_base"), args.out)
    log.info("%d of %d routes drawn along their roads (%d points), wrote %s",
             len(lines), len(bundle["routes"]), stats["points"][0], args.out)
    for key in stats["missing"]:
        log.info("  not in the OSM answer: %s", key)
    for key in stats["unmendable"]:
        log.info("  a gap in its roads too long to fill: %s", key)
    for key, far, n in stats["off_route"]:
        log.info("  line doesn't follow its stops (%d of %d stops over %d m away): %s",
                 far, n, FAR_M, key)


if __name__ == "__main__":
    main()
