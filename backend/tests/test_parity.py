"""The Python engine still answers the real-network trips in fixtures/parity.json (the TypeScript
engine is held to the same file in engine.test.ts)."""
import json

import pytest

from tests.parity import FIXTURE, load_bundle, results


def test_fixture_matches_the_seed():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture["osm_base"] == load_bundle()["meta"].get("osm_base"), (
        "seed/accra.json was rebuilt: regenerate the fixture with `python -m tests.parity`"
    )


def test_python_engine_matches_fixture():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))["trips"]
    got = results(load_bundle())
    assert len(got) == len(fixture)
    for want, have in zip(fixture, got, strict=True):
        assert set(have["plans"]) == set(want["plans"]), want["from"]
        for mode, w in want["plans"].items():
            h = have["plans"][mode]
            assert h["legs"] == w["legs"], (want["from"], want["to"], mode)
            assert h["fare"] == pytest.approx(w["fare"], abs=0.006)
            assert h["minutes"] == pytest.approx(w["minutes"], abs=0.06)
            assert h["transfers"] == w["transfers"]
            assert h["walk_m"] == pytest.approx(w["walk_m"], abs=1)


def test_most_trips_find_a_plan():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))["trips"]
    assert sum(bool(t["plans"]) for t in fixture) >= len(fixture) * 0.8
