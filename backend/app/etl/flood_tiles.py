"""FloodWatch Ghana's flood-risk grid, for flood warnings on trips: ``frontend/src/data/floodrisk.json``.

FloodWatch (the sister app, github.com/kjdartaugust/flood-risk-ghana) scores Accra in H3 cells
about 460 m across, 0 to 100: how badly a spot floods in heavy rain. It calls a trotro line's risk
the worst cell whose centre lies within 400 m of the line. The app applies that same rule to just
the stretch of road a ride covers (``frontend/src/lib/flood.ts``), so it needs each cell's centre
and score: this asks FloodWatch's public API for them and writes them down, a few KB.

    python -m app.etl.flood_tiles                    # ask FloodWatch (its server takes ~2 min to wake)
    python -m app.etl.flood_tiles --from tiles.json --lines routes.json  # saved answers to its
                                                     # /risk/tiles and /routes

It also writes ``tests/fixtures/floodwatch_lines.json``: FloodWatch's own score for each of its
lines, from the same moment. The frontend's tests hold the app's arithmetic to it
(``frontend/src/lib/flood.test.ts``), so the two files are only ever rebuilt together.

The grid changes only when FloodWatch retrains its model or redraws its cells: rebuild then. The
rain, which changes every three hours, is not here: the app reads it through ``/api/flood``.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
from pathlib import Path

import httpx

from .osm_network import BUNDLE, UA

log = logging.getLogger("etl.flood_tiles")

OUT = Path(__file__).resolve().parents[3] / "frontend" / "src" / "data" / "floodrisk.json"
LINES_OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "floodwatch_lines.json"

API = "https://floodwatch-backend-dlni.onrender.com/api/v1"
SITE = "https://floodwatch-ghana-ten.vercel.app"
RESOLUTION = 8
# FloodWatch's rule for a line (its etl/osm_routes.py `set_baselines`): the worst cell whose
# centre is within this many metres. Written into the file so the app and the rule travel together.
WITHIN_M = 400
# Its /risk/tiles answers with at most this many cells: a fuller answer is asked for in quarters.
PAGE = 5000
# Around the network's stops: a ride's road never strays further than this from them.
MARGIN_DEG = 0.02
# Its free server sleeps when idle and takes a minute or two to wake.
TIMEOUT_S = 240.0

Box = tuple[float, float, float, float]  # west, south, east, north


def network_box(bundle: dict, margin: float = MARGIN_DEG) -> Box:
    """The area the network's stops cover, and a little around it."""
    lats = [s["lat"] for s in bundle["stations"]]
    lons = [s["lon"] for s in bundle["stations"]]
    return (min(lons) - margin, min(lats) - margin, max(lons) + margin, max(lats) + margin)


def pack(features: list[dict]) -> list[list[float]]:
    """Each cell as ``[lat, lon, risk]``: its centre to the metre, its score to one decimal.

    A cell arrives as its outline (a closed ring). The mean of a hexagon's corners is its centre:
    within a centimetre of H3's own, so the build needs no H3 library. Sorted, each cell once, so
    the same grid always writes the same file."""
    cells: dict[str, list[float]] = {}
    for f in features:
        ring = f["geometry"]["coordinates"][0]
        corners = ring[:-1] if ring[0] == ring[-1] else ring
        lat = sum(p[1] for p in corners) / len(corners)
        lon = sum(p[0] for p in corners) / len(corners)
        p = f["properties"]
        cells[p["h3_index"]] = [round(lat, 5), round(lon, 5), round(float(p["risk_score"]), 1)]
    return sorted(cells.values())


def fetch_tiles(client: httpx.Client, box: Box) -> list[dict]:
    """Every cell whose centre is in the box, asking again in quarters where the answer was cut."""
    w, s, e, n = box
    r = client.get(f"{API}/risk/tiles", params={"bbox": f"{w},{s},{e},{n}", "res": RESOLUTION})
    r.raise_for_status()
    features = r.json()["features"]
    if len(features) < PAGE:
        return features
    mx, my = (w + e) / 2, (s + n) / 2
    out: list[dict] = []
    for quarter in ((w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)):
        out += fetch_tiles(client, quarter)
    return out


def model_version(client: httpx.Client, lat: float, lon: float) -> str | None:
    """Which of FloodWatch's models scored the grid, for the file's record."""
    try:
        r = client.get(f"{API}/risk/point", params={"lat": lat, "lng": lon})
        r.raise_for_status()
        return r.json().get("model_version")
    except (httpx.HTTPError, ValueError):
        return None


def pack_lines(routes: list[dict]) -> list[dict]:
    """FloodWatch's lines as the tests need them: its id, the two ends, and its own score."""
    return sorted(
        ({"id": r["id"], "ends": [r["from_stop"], r["to_stop"]], "baseline": round(float(r["baseline_risk"]), 1)}
         for r in routes if r.get("from_stop") and r.get("to_stop")),
        key=lambda line: line["id"],
    )


def write_lines(lines: list[dict], built: str, path: Path = LINES_OUT) -> None:
    rows = ",\n".join("    " + json.dumps(line, ensure_ascii=False, separators=(",", ":")) for line in lines)
    head = json.dumps({"built": built}, indent=2)[:-2]
    path.write_text(head + ',\n  "lines": [\n' + rows + "\n  ]\n}\n", encoding="utf-8")


def build(features: list[dict], model: str | None, today: dt.date | None = None) -> dict:
    return {
        "source": f"FloodWatch Ghana flood-risk cells (H3 resolution {RESOLUTION}), {SITE}",
        "model": model,
        "built": (today or dt.date.today()).isoformat(),
        "within_m": WITHIN_M,
        "tiles": pack(features),
    }


def write(doc: dict, path: Path = OUT) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # One cell per line: a rebuild's diff shows which cells changed.
    rows = ",\n".join("    " + json.dumps(t, separators=(",", ":")) for t in doc["tiles"])
    head = {k: v for k, v in doc.items() if k != "tiles"}
    text = json.dumps(head, ensure_ascii=False, indent=2)[:-2] + ',\n  "tiles": [\n' + rows + "\n  ]\n}\n"
    path.write_text(text, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="saved", type=Path, help="a saved answer to FloodWatch's /risk/tiles")
    ap.add_argument("--lines", type=Path, help="with --from: a saved answer to its /routes, from the same moment")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.saved:
        features = json.loads(args.saved.read_text(encoding="utf-8"))["features"]
        routes = json.loads(args.lines.read_text(encoding="utf-8")) if args.lines else None
        model = None
        if args.out.exists():  # keep the record of which model it was
            model = json.loads(args.out.read_text(encoding="utf-8")).get("model")
    else:
        box = network_box(json.loads(BUNDLE.read_text(encoding="utf-8")))
        with httpx.Client(timeout=TIMEOUT_S, headers=UA) as client:
            features = fetch_tiles(client, box)
            model = None
            if features:
                lat, lon, _ = pack(features[:1])[0]
                model = model_version(client, lat, lon)
            r = client.get(f"{API}/routes")
            r.raise_for_status()
            routes = r.json()
    if not features:
        raise SystemExit("FloodWatch sent no cells: nothing written.")
    doc = build(features, model)
    write(doc, args.out)
    if routes is None:
        log.warning("No --lines given: %s is left as it was, and may no longer match the cells.", LINES_OUT)
    else:
        write_lines(pack_lines(routes), doc["built"])
    risks = [t[2] for t in doc["tiles"]]
    log.info(
        "%d cells (model %s): %d at 60+, %d at 45-60, %d at 30-45, %d below; wrote %s (%d KB)",
        len(risks), model or "unknown",
        sum(r >= 60 for r in risks), sum(45 <= r < 60 for r in risks),
        sum(30 <= r < 45 for r in risks), sum(r < 30 for r in risks),
        args.out, args.out.stat().st_size // 1024,
    )


if __name__ == "__main__":
    main()
