"""Building the network from OpenStreetMap: stops into stations, relations into routes."""
import pytest

from app.etl.osm_network import (
    BOARD_FARE,
    PER_KM,
    ROAD_FACTOR,
    build,
    cluster_stops,
    normalise,
    route_name,
)
from app.routing.geo import haversine_m


def node(i, lat, lon, name=None):
    return {"type": "node", "id": i, "lat": lat, "lon": lon, "tags": {"name": name} if name else {}}


def test_normalise_ignores_case_dots_and_apostrophes():
    assert normalise("  St. John's  Junction ") == normalise("st johns junction")


def test_route_name():
    assert route_name({"name": "Trotro 282 : Shalom → Kaneshie"}) == "Shalom → Kaneshie"
    assert route_name({"from": "Circle", "to": "Madina"}) == "Circle → Madina"
    assert route_name({"ref": "7"}) == "Trotro 7"


def test_same_named_stops_across_the_road_are_one_station():
    stations, to_slug = cluster_stops([
        node(1, 5.6000, -0.2000, "Kaneshie"),
        node(2, 5.6005, -0.2000, "kaneshie"),      # ~55 m away: the other side of the road
        node(3, 5.6200, -0.2000, "Kaneshie"),      # ~2.2 km away: another place, same name
        node(4, 5.6001, -0.2003, None),            # unnamed, ~35 m away: same stop
        node(5, 5.7000, -0.2000, None),            # unnamed and alone
    ])
    assert to_slug[1] == to_slug[2] == to_slug[4] == "osm-n1"
    assert to_slug[3] == "osm-n3"
    assert to_slug[5] == "osm-n5"
    by = {s["slug"]: s for s in stations}
    assert by["osm-n1"]["name"] == "Kaneshie"   # the spelling of the lowest node id on a tie
    assert by["osm-n5"]["name"] is None         # named later, from its area
    assert len(stations) == 3


def _osm(travel_time="20"):
    return {
        "osm3s": {"timestamp_osm_base": "2026-11-04T00:00:00Z"},
        "elements": [
            node(1, 5.600, -0.20, "Circle"),
            node(2, 5.6003, -0.20, "Circle"),   # the same stop's other platform
            node(3, 5.610, -0.20, "Lapaz"),
            node(4, 5.620, -0.20, "Achimota"),
            {
                "type": "relation", "id": 99,
                "tags": {"network": "trô trô", "name": "Trotro 9 : Circle → Achimota", "ref": "9",
                         "travel_time": travel_time, "operator": "GPRTU"},
                "members": [
                    {"type": "way", "ref": 1, "role": ""},
                    {"type": "node", "ref": 1, "role": "platform"},
                    {"type": "node", "ref": 2, "role": "stop"},
                    {"type": "node", "ref": 3, "role": "platform"},
                    {"type": "node", "ref": 4, "role": "platform"},
                ],
            },
            {"type": "relation", "id": 7, "tags": {"network": "something else"}, "members": []},
        ],
    }


def test_build_route_times_and_fares():
    places = {"elements": [{"type": "node", "lat": 5.611, "lon": -0.2, "tags": {"name": "Abeka"}}]}
    bundle = build(_osm(), places)
    assert [s["name"] for s in bundle["stations"]] == ["Circle", "Lapaz", "Achimota"]
    assert {s["town"] for s in bundle["stations"]} == {"Abeka"}
    (route,) = bundle["routes"]
    assert route["key"] == "osm-r99"
    assert route["name"] == "Circle → Achimota"
    assert route["board_fare"] == BOARD_FARE
    stops = route["stops"]
    assert [s["slug"] for s in stops] == ["osm-n1", "osm-n3", "osm-n4"]   # platform + stop once
    assert stops[0] == {"slug": "osm-n1", "fare": 0.0, "min": 0.0}
    assert sum(s["min"] for s in stops) == pytest.approx(20, abs=0.2)  # travel_time, shared out
    st = {s["slug"]: s for s in bundle["stations"]}
    km = haversine_m(st["osm-n1"]["lat"], st["osm-n1"]["lon"], st["osm-n3"]["lat"], st["osm-n3"]["lon"]) / 1000
    assert stops[1]["fare"] == pytest.approx(PER_KM * km * ROAD_FACTOR, abs=0.01)
    assert bundle["meta"]["osm_base"] == "2026-11-04T00:00:00Z"
    assert "OpenStreetMap" in bundle["meta"]["source"]


def test_unbelievable_travel_time_falls_back_to_a_speed():
    # 2.6 km of road in 1 minute is 156 km/h: ignored for the fallback speed.
    stops = build(_osm(travel_time="1"))["routes"][0]["stops"]
    assert sum(s["min"] for s in stops) > 5
