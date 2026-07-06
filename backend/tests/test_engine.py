"""Routing-engine tests: multi-leg planning, transfers, and mode selection."""
import json
from pathlib import Path

import pytest

from app.routing.engine import (
    RouteStopT,
    RouteT,
    StationT,
    build_graph,
    plan,
    plan_all,
)

SEED = json.loads(
    (Path(__file__).resolve().parents[2] / "seed" / "accra.json").read_text(encoding="utf-8")
)


def _accra_graph():
    slug_to_id = {s["slug"]: s["slug"] for s in SEED["stations"]}
    stations = [
        StationT(id=s["slug"], name=s["name"], lat=s["lat"], lon=s["lon"], town=s.get("town"))
        for s in SEED["stations"]
    ]
    routes = []
    for i, r in enumerate(SEED["routes"]):
        stops = [
            RouteStopT(
                station_id=slug_to_id[st["slug"]],
                seq=j,
                fare_from_prev=st.get("fare", 0),
                minutes_from_prev=st.get("min", 0),
            )
            for j, st in enumerate(r["stops"])
        ]
        routes.append(RouteT(id=f"r{i}", name=r["name"], stops=stops))
    return build_graph(stations, routes), {s["slug"]: s for s in SEED["stations"]}


def test_direct_route_single_leg():
    g, S = _accra_graph()
    circle, kaneshie = S["circle"], S["kaneshie"]
    it = plan(g, (circle["lat"], circle["lon"]), (kaneshie["lat"], kaneshie["lon"]), "cheapest")
    assert it is not None
    ride_legs = [leg for leg in it.legs if leg.kind == "ride"]
    assert len(ride_legs) == 1
    assert it.transfers == 0
    assert it.total_fare > 0


def test_multi_leg_with_transfer():
    """Adenta is only reachable via Madina, forcing a transfer from a Circle-origin trip."""
    g, S = _accra_graph()
    circle, adenta = S["circle"], S["adenta"]
    it = plan(g, (circle["lat"], circle["lon"]), (adenta["lat"], adenta["lon"]), "fastest")
    assert it is not None
    ride_legs = [leg for leg in it.legs if leg.kind == "ride"]
    assert len(ride_legs) >= 2  # Circle->Madina then Madina->Adenta
    assert it.transfers >= 1
    # Fare is the sum of the ridden segments.
    assert it.total_fare == pytest.approx(sum(leg.fare for leg in ride_legs), abs=0.01)


def test_modes_differ_or_tie():
    g, S = _accra_graph()
    circle, madina = S["circle"], S["madina"]
    res = plan_all(g, (circle["lat"], circle["lon"]), (madina["lat"], madina["lon"]))
    assert set(res) == {"fastest", "cheapest", "fewest"}
    # cheapest total_fare must be <= fastest total_fare
    assert res["cheapest"].total_fare <= res["fastest"].total_fare + 1e-6


def test_walking_only_when_close():
    """Two points a few metres apart with no route between them -> walk leg, no ride."""
    stations = [StationT("a", "A", 5.5600, -0.2000), StationT("b", "B", 5.5605, -0.2000)]
    g = build_graph(stations, [])
    it = plan(g, (5.5600, -0.2000), (5.5605, -0.2000), "fastest")
    # No routes exist, so there is no boardable trip; engine returns None (walk-only handled by UI).
    assert it is None or all(leg.kind == "walk" for leg in it.legs)


def test_unreachable_returns_none():
    g, S = _accra_graph()
    # A point far out in the ocean, nowhere near a station.
    it = plan(g, (4.0, -2.0), (S["circle"]["lat"], S["circle"]["lon"]), "fastest")
    assert it is None
