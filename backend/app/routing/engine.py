"""Trotro routing engine.

The network is a weighted directed graph:

  * Each station has a **hub** node (the street-level point where you walk in/out).
  * Each (route, stop) has a **board** node.
  * Edges:
      - ``ride``   : consecutive board nodes on the same route  (fare + minutes)
      - ``board``  : hub -> board node at that station           (wait/board penalty, +1 transfer)
      - ``alight`` : board node -> hub                           (free)
      - ``walk``   : hub -> hub within walking radius, and ORIGIN/DEST -> nearby hubs

Trips are planned by walking from ORIGIN to nearby station hubs, riding/transferring through the
graph, and walking from a hub to DEST. We run a **lexicographic Dijkstra** over the cost vector
``(transfers, fare, minutes)`` and reorder the comparison key per optimisation mode:

  * ``fastest``  -> (minutes, fare, transfers)
  * ``cheapest`` -> (fare, minutes, transfers)
  * ``fewest``   -> (transfers, minutes, fare)

The exact same algorithm is ported to TypeScript in ``frontend/src/engine`` so offline results
match the server byte-for-byte.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from typing import Literal

from .geo import haversine_m

Mode = Literal["fastest", "cheapest", "fewest"]

# Defaults; overridable per-plan (server passes values from Settings).
DEFAULTS = {
    "walk_radius_m": 900.0,
    "walk_speed_mps": 1.25,
    "board_penalty_min": 4.0,
    "transfer_penalty_min": 3.0,
}


@dataclass
class StationT:
    id: str
    name: str
    lat: float
    lon: float
    town: str | None = None


@dataclass
class RouteStopT:
    station_id: str
    seq: int
    fare_from_prev: float
    minutes_from_prev: float


@dataclass
class RouteT:
    id: str
    name: str
    stops: list[RouteStopT]
    color: str | None = None


@dataclass
class Edge:
    to: str
    minutes: float
    fare: float
    transfers: int
    kind: str  # walk|ride|board|alight
    route_id: str | None = None
    from_station: str | None = None
    to_station: str | None = None
    distance_m: float = 0.0


@dataclass
class Leg:
    kind: str  # walk|ride
    from_station: str | None
    to_station: str | None
    from_name: str | None
    to_name: str | None
    route_id: str | None
    route_name: str | None
    fare: float
    minutes: float
    distance_m: float
    num_stops: int = 0


@dataclass
class Itinerary:
    mode: Mode
    total_fare: float
    total_minutes: float
    transfers: int
    walk_distance_m: float
    legs: list[Leg]


@dataclass
class Graph:
    stations: dict[str, StationT] = field(default_factory=dict)
    routes: dict[str, RouteT] = field(default_factory=dict)
    adj: dict[str, list[Edge]] = field(default_factory=dict)
    opts: dict = field(default_factory=lambda: dict(DEFAULTS))

    def _edge(self, frm: str, e: Edge) -> None:
        self.adj.setdefault(frm, []).append(e)


def build_graph(
    stations: list[StationT], routes: list[RouteT], opts: dict | None = None
) -> Graph:
    o = dict(DEFAULTS)
    if opts:
        o.update({k: v for k, v in opts.items() if v is not None})
    g = Graph(opts=o)
    g.stations = {s.id: s for s in stations}
    g.routes = {r.id: r for r in routes}

    def hub(sid: str) -> str:
        return f"hub:{sid}"

    def bnode(rid: str, seq: int) -> str:
        return f"rs:{rid}:{seq}"

    # Route ride/board/alight edges
    for r in routes:
        stops = sorted(r.stops, key=lambda s: s.seq)
        for i, st in enumerate(stops):
            b = bnode(r.id, st.seq)
            h = hub(st.station_id)
            # board: hub -> board node (costs a wait + one transfer)
            g._edge(
                h,
                Edge(
                    to=b,
                    minutes=o["board_penalty_min"],
                    fare=0.0,
                    transfers=1,
                    kind="board",
                    route_id=r.id,
                    from_station=st.station_id,
                    to_station=st.station_id,
                ),
            )
            # alight: board node -> hub (free)
            g._edge(
                b,
                Edge(
                    to=h,
                    minutes=0.0,
                    fare=0.0,
                    transfers=0,
                    kind="alight",
                    route_id=r.id,
                    from_station=st.station_id,
                    to_station=st.station_id,
                ),
            )
            # ride: board(i) -> board(i+1)
            if i + 1 < len(stops):
                nxt = stops[i + 1]
                g._edge(
                    b,
                    Edge(
                        to=bnode(r.id, nxt.seq),
                        minutes=max(nxt.minutes_from_prev, 0.0),
                        fare=max(nxt.fare_from_prev, 0.0),
                        transfers=0,
                        kind="ride",
                        route_id=r.id,
                        from_station=st.station_id,
                        to_station=nxt.station_id,
                    ),
                )

    # Walking transfers between nearby station hubs (bidirectional)
    slist = list(stations)
    radius = o["walk_radius_m"]
    for i in range(len(slist)):
        for j in range(i + 1, len(slist)):
            a, b = slist[i], slist[j]
            d = haversine_m(a.lat, a.lon, b.lat, b.lon)
            if d <= radius:
                mins = d / o["walk_speed_mps"] / 60.0
                for x, y in ((a, b), (b, a)):
                    g._edge(
                        hub(x.id),
                        Edge(
                            to=hub(y.id),
                            minutes=mins,
                            fare=0.0,
                            transfers=0,
                            kind="walk",
                            from_station=x.id,
                            to_station=y.id,
                            distance_m=d,
                        ),
                    )
    return g


def _order_key(mode: Mode, transfers: int, fare: float, minutes: float) -> tuple:
    if mode == "cheapest":
        return (round(fare, 2), minutes, transfers)
    if mode == "fewest":
        return (transfers, minutes, round(fare, 2))
    return (minutes, round(fare, 2), transfers)  # fastest


def _nearest_hubs(g: Graph, lat: float, lon: float) -> list[tuple[str, float, float]]:
    """Return (station_id, distance_m, walk_minutes) for stations within walk radius."""
    out = []
    for s in g.stations.values():
        d = haversine_m(lat, lon, s.lat, s.lon)
        if d <= g.opts["walk_radius_m"]:
            out.append((s.id, d, d / g.opts["walk_speed_mps"] / 60.0))
    out.sort(key=lambda t: t[1])
    return out[:8]


def plan(
    g: Graph,
    origin: tuple[float, float],
    dest: tuple[float, float],
    mode: Mode = "fastest",
) -> Itinerary | None:
    """Single-mode plan. ``origin``/``dest`` are (lat, lon)."""
    olat, olon = origin
    dlat, dlon = dest

    origin_edges = [
        Edge(to=f"hub:{sid}", minutes=mins, fare=0.0, transfers=0, kind="walk",
             to_station=sid, distance_m=d)
        for sid, d, mins in _nearest_hubs(g, olat, olon)
    ]
    dest_hubs = {f"hub:{sid}": (d, mins) for sid, d, mins in _nearest_hubs(g, dlat, dlon)}
    if not origin_edges or not dest_hubs:
        return None

    # Dijkstra from virtual ORIGIN. Final walk to DEST is added when a hub is popped.
    start = "ORIGIN"
    adj_origin = {start: origin_edges}

    def neighbours(node: str) -> list[Edge]:
        if node == start:
            return adj_origin[start]
        return g.adj.get(node, [])

    # cost vector accumulators
    best: dict[str, tuple] = {start: (0, 0.0, 0.0)}
    prev: dict[str, tuple[str, Edge]] = {}
    counter = 0
    pq: list[tuple[tuple, int, str, tuple]] = [(_order_key(mode, 0, 0, 0), 0, start, (0, 0.0, 0.0))]

    dest_node = "DEST"

    while pq:
        key, _, node, (tr, fare, mins) = heapq.heappop(pq)
        cur = best.get(node)
        if cur is not None and _order_key(mode, *_as3(cur)) < key:
            continue

        # If this is a hub near the destination, offer a final walk edge to DEST.
        edges = list(neighbours(node))
        if node in dest_hubs:
            d, wm = dest_hubs[node]
            edges = edges + [Edge(to=dest_node, minutes=wm, fare=0.0, transfers=0,
                                  kind="walk", distance_m=d)]

        for e in edges:
            ntr = tr + e.transfers
            nfare = fare + e.fare
            nmins = mins + e.minutes
            nkey = _order_key(mode, ntr, nfare, nmins)
            cand = (ntr, nfare, nmins)
            if e.to not in best or nkey < _order_key(mode, *_as3(best[e.to])):
                best[e.to] = cand
                prev[e.to] = (node, e)
                counter += 1
                heapq.heappush(pq, (nkey, counter, e.to, cand))

    if dest_node not in prev:
        return None

    # Reconstruct edge path ORIGIN..DEST
    path: list[Edge] = []
    node = dest_node
    while node != start:
        pnode, e = prev[node]
        path.append(e)
        node = pnode
    path.reverse()
    return _build_itinerary(g, mode, path)


def _as3(t: tuple) -> tuple[int, float, float]:
    return (t[0], t[1], t[2])


def _build_itinerary(g: Graph, mode: Mode, path: list[Edge]) -> Itinerary:
    legs: list[Leg] = []
    total_fare = 0.0
    total_min = 0.0
    walk_dist = 0.0
    transfers = 0

    def sname(sid: str | None) -> str | None:
        return g.stations[sid].name if sid and sid in g.stations else None

    i = 0
    while i < len(path):
        e = path[i]
        if e.kind == "walk":
            total_min += e.minutes
            walk_dist += e.distance_m
            legs.append(
                Leg("walk", e.from_station, e.to_station, sname(e.from_station),
                    sname(e.to_station), None, None, 0.0, e.minutes, e.distance_m)
            )
            i += 1
        elif e.kind == "board":
            transfers += 1
            # consume the following ride edges of the same route
            rid = e.route_id
            board_station = e.from_station
            fare = 0.0
            mins = e.minutes  # includes board penalty
            j = i + 1
            last_station = board_station
            stops = 0
            while j < len(path) and path[j].kind == "ride" and path[j].route_id == rid:
                fare += path[j].fare
                mins += path[j].minutes
                last_station = path[j].to_station
                stops += 1
                j += 1
            total_fare += fare
            total_min += mins
            legs.append(
                Leg("ride", board_station, last_station, sname(board_station),
                    sname(last_station), rid, g.routes[rid].name if rid in g.routes else None,
                    round(fare, 2), mins, 0.0, stops)
            )
            # skip the trailing alight edge if present
            if j < len(path) and path[j].kind == "alight":
                j += 1
            i = j
        else:
            i += 1  # stray alight, skip

    # transfers counted = number of boardings; itinerary transfers = boardings - 1
    return Itinerary(
        mode=mode,
        total_fare=round(total_fare, 2),
        total_minutes=round(total_min, 1),
        transfers=max(transfers - 1, 0),
        walk_distance_m=round(walk_dist),
        legs=legs,
    )


def plan_all(
    g: Graph, origin: tuple[float, float], dest: tuple[float, float]
) -> dict[str, Itinerary]:
    """Return one itinerary per mode, de-duplicated by leg signature."""
    out: dict[str, Itinerary] = {}
    for mode in ("fastest", "cheapest", "fewest"):
        it = plan(g, origin, dest, mode)  # type: ignore[arg-type]
        if it:
            out[mode] = it
    return out
