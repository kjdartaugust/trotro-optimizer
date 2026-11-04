"""Engine parity on the real network: the Python engine's answers to a fixed set of trips.

``fixtures/parity.json`` holds them; test_parity.py checks the Python engine still gives them and
frontend/src/engine/engine.test.ts checks the TypeScript engine gives the same. Regenerate it after
rebuilding seed/accra.json or changing routing on purpose (then port the change to TypeScript):

    python -m tests.parity
"""
from __future__ import annotations

import json
from pathlib import Path

from app.routing.engine import Itinerary, RouteStopT, RouteT, StationT, build_graph, plan_all

BACKEND = Path(__file__).resolve().parents[1]
SEED = BACKEND / "seed" / "accra.json"
FIXTURE = BACKEND / "tests" / "fixtures" / "parity.json"
TRIPS = 30


def load_bundle() -> dict:
    return json.loads(SEED.read_text(encoding="utf-8"))


def graph(bundle: dict):
    stations = [StationT(s["slug"], s["name"], s["lat"], s["lon"], s.get("town")) for s in bundle["stations"]]
    routes = [
        RouteT(
            r["key"],
            r["name"],
            [RouteStopT(st["slug"], i, st["fare"], st["min"]) for i, st in enumerate(r["stops"])],
            r.get("color"),
            r.get("board_fare", 0.0),
        )
        for r in bundle["routes"]
    ]
    return build_graph(stations, routes)


def trips(bundle: dict) -> list[list[list[float]]]:
    """Spread over the network: origins stepping through the stations, destinations further on."""
    st = bundle["stations"]
    n = len(st)
    out = []
    for i in range(TRIPS):
        a, b = st[(i * n) // TRIPS], st[(i * n // TRIPS + n // 2 + 37 * i) % n]
        out.append([[a["lat"], a["lon"]], [b["lat"], b["lon"]]])
    return out


def summary(it: Itinerary) -> dict:
    return {
        "fare": it.total_fare,
        "minutes": it.total_minutes,
        "transfers": it.transfers,
        "walk_m": it.walk_distance_m,
        "legs": [[leg.kind, leg.from_station, leg.to_station, leg.route_id, leg.num_stops] for leg in it.legs],
    }


def results(bundle: dict) -> list[dict]:
    g = graph(bundle)
    return [
        {"from": o, "to": d, "plans": {m: summary(it) for m, it in plan_all(g, tuple(o), tuple(d)).items()}}
        for o, d in trips(bundle)
    ]


def main() -> None:
    bundle = load_bundle()
    FIXTURE.parent.mkdir(exist_ok=True)
    data = {"osm_base": bundle["meta"].get("osm_base"), "trips": results(bundle)}
    FIXTURE.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    planned = sum(bool(t["plans"]) for t in data["trips"])
    print(f"wrote {FIXTURE}: {len(data['trips'])} trips, {planned} with a plan")


if __name__ == "__main__":
    main()
