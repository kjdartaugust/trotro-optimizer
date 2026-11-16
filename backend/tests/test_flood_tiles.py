"""FloodWatch's risk cells, as the app ships them (app/etl/flood_tiles.py)."""
import json
import math

from app.etl import flood_tiles
from app.etl.flood_tiles import build, fetch_tiles, network_box, pack, pack_lines, write, write_lines


def hexagon(lat: float, lon: float, h3: str, risk: float, radius: float = 0.004) -> dict:
    """A cell the way FloodWatch's /risk/tiles sends one: its outline, closed, and its score."""
    ring = [[lon + radius * math.cos(math.radians(a)), lat + radius * math.sin(math.radians(a))]
            for a in range(0, 360, 60)]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring + [ring[0]]]},
        "properties": {"h3_index": h3, "risk_score": risk, "band": "high", "confidence": 0.6},
    }


def test_a_cell_is_its_centre_and_its_score():
    cells = pack([hexagon(5.6123456, -0.2054321, "88a", 48.52)])
    assert cells == [[5.61235, -0.20543, 48.5]]


def test_cells_come_out_once_each_and_in_order():
    features = [hexagon(5.7, -0.1, "b", 10), hexagon(5.6, -0.2, "a", 70), hexagon(5.7, -0.1, "b", 10)]
    assert pack(features) == [[5.6, -0.2, 70.0], [5.7, -0.1, 10.0]]


def test_the_area_asked_for_is_the_networks_stops_and_a_little_more():
    bundle = {"stations": [{"lat": 5.55, "lon": -0.30}, {"lat": 5.70, "lon": -0.10}]}
    w, s, e, n = network_box(bundle, margin=0.02)
    assert (round(w, 2), round(s, 2), round(e, 2), round(n, 2)) == (-0.32, 5.53, -0.08, 5.72)


class _Answer:
    def __init__(self, features):
        self._features = features

    def raise_for_status(self):
        pass

    def json(self):
        return {"features": self._features}


class _FloodWatch:
    """Answers /risk/tiles with at most PAGE cells of those whose centre is in the box asked for."""

    def __init__(self, cells):
        self.cells = cells
        self.asked = []

    def get(self, url, params):
        w, s, e, n = (float(x) for x in params["bbox"].split(","))
        self.asked.append((w, s, e, n))
        inside = [c for c in self.cells if w <= c["lon"] <= e and s <= c["lat"] <= n]
        return _Answer([hexagon(c["lat"], c["lon"], c["h3"], 20) for c in inside][: flood_tiles.PAGE])


def test_an_answer_cut_short_is_asked_for_again_in_quarters(monkeypatch):
    monkeypatch.setattr(flood_tiles, "PAGE", 4)
    # Seven cells: three in the south-west quarter, one in each of the others, one on its own row.
    spots = [(5.51, -0.39), (5.52, -0.38), (5.53, -0.37), (5.51, -0.11), (5.79, -0.39), (5.79, -0.11), (5.78, -0.12)]
    cells = [{"lat": la, "lon": lo, "h3": f"c{i}"} for i, (la, lo) in enumerate(spots)]
    api = _FloodWatch(cells)
    got = fetch_tiles(api, (-0.4, 5.5, -0.1, 5.8))
    assert sorted(f["properties"]["h3_index"] for f in got) == [f"c{i}" for i in range(7)]
    assert len(api.asked) == 5  # the whole box, then its four quarters


def test_the_file_reads_back_as_written(tmp_path):
    doc = build([hexagon(5.6, -0.2, "a", 70), hexagon(5.7, -0.1, "b", 10)], "logistic-v2")
    out = tmp_path / "data" / "floodrisk.json"
    write(doc, out)
    text = out.read_text(encoding="utf-8")
    assert json.loads(text) == doc
    assert doc["within_m"] == 400 and doc["model"] == "logistic-v2"
    # One cell a line, so a rebuild's diff shows which cells moved.
    assert "    [5.6,-0.2,70.0],\n    [5.7,-0.1,10.0]\n" in text


def test_floodwatchs_own_scores_are_kept_for_the_tests(tmp_path):
    routes = [
        {"id": "osm-9", "from_stop": "Kaneshie", "to_stop": "Shalom", "baseline_risk": 66.34, "hours": []},
        {"id": "osm-10", "from_stop": "Mayera / Adusa", "to_stop": "Achimota", "baseline_risk": 41.0},
        {"id": "osm-11", "from_stop": None, "to_stop": None, "baseline_risk": 12.0},  # no ends to know it by
    ]
    lines = pack_lines(routes)
    assert lines == [
        {"id": "osm-10", "ends": ["Mayera / Adusa", "Achimota"], "baseline": 41.0},
        {"id": "osm-9", "ends": ["Kaneshie", "Shalom"], "baseline": 66.3},
    ]
    out = tmp_path / "floodwatch_lines.json"
    write_lines(lines, "2026-11-16", out)
    assert json.loads(out.read_text(encoding="utf-8")) == {"built": "2026-11-16", "lines": lines}


def test_the_shipped_cells_and_scores_were_built_together():
    """The app's cells and the scores its tests check them against are one snapshot of FloodWatch."""
    cells = json.loads(flood_tiles.OUT.read_text(encoding="utf-8"))
    lines = json.loads(flood_tiles.LINES_OUT.read_text(encoding="utf-8"))
    assert cells["built"] == lines["built"]
    assert len(cells["tiles"]) > 500 and len(lines["lines"]) > 200
    assert all(len(t) == 3 and 0 <= t[2] <= 100 for t in cells["tiles"])
