"""The map's route lines: joining a relation's roads, fitting the line to the route's stops."""
import json
from pathlib import Path

from app.etl import osm_shapes as m
from app.ids import route_uuid

SHAPES = Path(__file__).resolve().parents[2] / "frontend" / "public" / "network" / "shapes.json"


def test_polyline_round_trip_and_googles_example():
    assert m.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@") == [(-120.2, 38.5), (-120.95, 40.7), (-126.453, 43.252)]
    pts = [(-0.20511, 5.60012), (-0.19, 5.61), (-0.1, 5.55)]
    assert m.decode(m.encode(pts)) == pts


def _way(wid, nodes):
    return {"type": "way", "id": wid, "nodes": [n for n, _, _ in nodes],
            "geometry": [{"lon": x, "lat": y} for _, x, y in nodes]}


def test_stitch_turns_pieces_round_and_reports_gaps():
    a = [(1, -0.20, 5.60), (2, -0.19, 5.60)]
    b = [(3, -0.18, 5.60), (2, -0.19, 5.60)]  # mapped the other way
    c = [(4, -0.17, 5.60), (5, -0.16, 5.60)]  # doesn't touch b: a gap
    path, gaps = m.stitch([a, b, c])
    assert [n for n, _, _ in path] == [1, 2, 3, 4, 5]
    assert len(gaps) == 1 and gaps[0][0] == 3 and 1000 < gaps[0][1] < 1200


def test_stops_are_placed_in_order_and_the_line_trimmed_to_them():
    line = [(-0.20, 5.60), (-0.19, 5.60), (-0.19, 5.61)]
    placed = m.match_stops(line, [(-0.199, 5.6001), (-0.191, 5.6), (-0.19, 5.605)])
    assert [seg for seg, _, _ in placed] == [0, 0, 1]
    trimmed = m.trim(line, placed[0][:2], placed[-1][:2])
    assert trimmed[1] == (-0.19, 5.60)
    assert m._metres(trimmed[0], (-0.199, 5.60)) < 1
    assert m._metres(trimmed[-1], (-0.19, 5.605)) < 1


def test_simplify_keeps_the_corners_only():
    straight = [(-0.2 + i * 0.001, 5.6) for i in range(11)] + [(-0.19, 5.61)]
    assert m.simplify(straight) == [(-0.2, 5.6), (-0.19, 5.6), (-0.19, 5.61)]


def test_build_keys_lines_by_route_id_and_falls_back_without_roads():
    osm = {"elements": [
        {"type": "relation", "id": 7, "members": [
            {"type": "way", "ref": 10, "role": ""}, {"type": "way", "ref": 11, "role": ""}]},
        _way(10, [(1, -0.20, 5.60), (2, -0.19, 5.60)]),
        _way(11, [(2, -0.19, 5.60), (3, -0.19, 5.61)]),
    ]}
    stations = [{"slug": s, "lon": x, "lat": y} for s, x, y in
                (("a", -0.2, 5.6), ("b", -0.19, 5.6), ("c", -0.19, 5.61))]
    bundle = {"stations": stations, "routes": [
        {"key": "osm-r7", "stops": [{"slug": "a"}, {"slug": "b"}, {"slug": "c"}]},
        {"key": "osm-r8", "stops": [{"slug": "a"}, {"slug": "c"}]},  # no relation in the answer
    ]}
    lines, stats = m.build(osm, bundle, route=lambda a, b: None)
    assert list(lines) == [route_uuid("osm-r7")]
    assert m.decode(lines[route_uuid("osm-r7")]) == [(-0.2, 5.6), (-0.19, 5.6), (-0.19, 5.61)]
    assert stats["missing"] == ["osm-r8"]


def test_the_shipped_lines_are_keyed_by_network_route_ids():
    doc = json.loads(SHAPES.read_text(encoding="utf-8"))
    bundle = json.loads(m.BUNDLE.read_text(encoding="utf-8"))
    ids = {route_uuid(r["key"]) for r in bundle["routes"]}
    assert len(doc["routes"]) > 500
    assert set(doc["routes"]) <= ids
