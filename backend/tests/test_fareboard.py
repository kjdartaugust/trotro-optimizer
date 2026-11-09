"""Fare boards: reading a photo with any vision model, and putting a board's fares into the routes."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import fareboard
from app.config import settings
from app.fares import fit_route
from app.main import app
from app.routers import fareboards as router_mod
from app.schemas import ContributionCreate

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


# ── Reading what a model says ──────────────────────────────────────────────────────────────────

def test_parse_reply_takes_the_json_and_checks_each_row():
    reply = """Here you go:
```json
{"station": "Madina Station", "effective": "2026-09-26",
 "rows": [{"to": "Circle", "fare": 9.8}, {"to": "  Legon ", "fare": "GH¢ 6.50"},
          {"to": "circle", "fare": 10}, {"to": "Call 0244123456", "fare": 244123456},
          {"to": "", "fare": 5}, {"to": "Adenta", "fare": "free"}]}
```"""
    board = fareboard.parse_reply(reply)
    assert board.station == "Madina Station"
    assert board.effective == "2026-09-26"
    assert board.rows == [{"to": "Circle", "fare": 9.8}, {"to": "Legon", "fare": 6.5}]


def test_parse_reply_rejects_a_reply_with_no_json():
    with pytest.raises(ValueError):
        fareboard.parse_reply("I can't see a fare board in this photo.")


def test_parse_reply_drops_a_bad_date():
    assert fareboard.parse_reply('{"effective": "26th Sept", "rows": []}').effective is None


def test_sniff_goes_by_the_bytes():
    assert fareboard.sniff(JPEG) == "image/jpeg"
    assert fareboard.sniff(b"\x89PNG\r\n\x1a\n....") == "image/png"
    assert fareboard.sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert fareboard.sniff(b"%PDF-1.7") is None


# ── Any model, from settings ───────────────────────────────────────────────────────────────────

@pytest.fixture
def two_models(monkeypatch):
    """A main model and one fallback, as a host would set them; the fallback's key comes from the
    env var it names, never from the JSON."""
    monkeypatch.setattr(settings, "vision_base_url", "https://main.example/v1")
    monkeypatch.setattr(settings, "vision_model", "main-vision")
    monkeypatch.setattr(settings, "vision_api_key", "main-key")
    monkeypatch.setattr(
        settings,
        "vision_fallbacks",
        json.dumps([{"base_url": "https://backup.example/api/v1/", "model": "backup-vision", "key_env": "BACKUP_KEY"}]),
    )
    monkeypatch.setenv("BACKUP_KEY", "backup-key")


@pytest.fixture
def no_models(monkeypatch):
    for name in ("vision_base_url", "vision_model", "vision_api_key", "vision_fallbacks"):
        monkeypatch.setattr(settings, name, "")


def test_providers_in_order(two_models):
    ps = fareboard.providers()
    assert [(p.base_url, p.model, p.api_key) for p in ps] == [
        ("https://main.example/v1", "main-vision", "main-key"),
        ("https://backup.example/api/v1/", "backup-vision", "backup-key"),
    ]


def _answer(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


async def test_read_board_falls_back_when_the_first_model_fails(two_models):
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        seen.append((str(req.url), req.headers.get("authorization"), body["model"]))
        image = body["messages"][0]["content"][1]["image_url"]["url"]
        assert image.startswith("data:image/jpeg;base64,")
        if "main.example" in str(req.url):
            return httpx.Response(429, json={"error": "over the free quota"})
        return _answer('{"rows": [{"to": "Kaneshie", "fare": 7.6}]}')

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        board = await fareboard.read_board(JPEG, client)
    assert board.rows == [{"to": "Kaneshie", "fare": 7.6}]
    assert seen == [
        ("https://main.example/v1/chat/completions", "Bearer main-key", "main-vision"),
        ("https://backup.example/api/v1/chat/completions", "Bearer backup-key", "backup-vision"),
    ]


async def test_read_board_says_when_no_model_could_read_it(two_models):
    def handler(req: httpx.Request) -> httpx.Response:
        return _answer("Sorry, too blurry.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(fareboard.Unreadable):
            await fareboard.read_board(JPEG, client)


async def test_read_board_without_a_model(no_models):
    with pytest.raises(fareboard.NotConfigured):
        await fareboard.read_board(JPEG)


# ── The API ────────────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def api(monkeypatch):
    router_mod._by_address.clear()
    router_mod._all.clear()
    return TestClient(app)


def test_status_and_read_without_a_model(api, no_models):
    assert api.get("/fareboards/status").json() == {"reader": False}
    res = api.post("/fareboards/read", files={"photo": ("board.jpg", JPEG, "image/jpeg")})
    assert res.status_code == 503


def test_read_returns_the_rows(api, two_models, monkeypatch):
    async def fake(photo, client=None):
        return fareboard.Board(rows=[{"to": "Circle", "fare": 9.8}], station="Madina", effective=None)

    monkeypatch.setattr(fareboard, "read_board", fake)
    assert api.get("/fareboards/status").json() == {"reader": True}
    res = api.post("/fareboards/read", files={"photo": ("board.jpg", JPEG, "image/jpeg")})
    assert res.status_code == 200
    assert res.json() == {"rows": [{"to": "Circle", "fare": 9.8}], "station": "Madina", "effective": None}


def test_read_refuses_what_isnt_a_photo(api, two_models):
    res = api.post("/fareboards/read", files={"photo": ("board.jpg", b"%PDF-1.7 ...", "image/jpeg")})
    assert res.status_code == 415


def test_reads_are_capped_per_address(api, two_models, monkeypatch):
    async def fake(photo, client=None):
        return fareboard.Board()

    monkeypatch.setattr(fareboard, "read_board", fake)
    monkeypatch.setattr(settings, "fareboard_reads_per_hour", 2)
    codes = [
        api.post("/fareboards/read", files={"photo": ("b.jpg", JPEG, "image/jpeg")}).status_code for _ in range(3)
    ]
    assert codes == [200, 200, 429]


# ── What a rider sends ─────────────────────────────────────────────────────────────────────────

def test_a_fareboard_contribution_is_checked():
    ok = {"station_id": "s1", "rows": [{"to": "Circle", "fare": 9.8, "to_station_id": "s2"}], "read": "photo"}
    assert ContributionCreate(kind="fareboard", payload=ok).kind == "fareboard"
    for bad in (
        {"rows": ok["rows"]},
        {"station_id": "s1", "rows": []},
        {"station_id": "s1", "rows": [{"to": "Circle", "fare": 0}]},
        {"station_id": "s1", "rows": [{"to": "", "fare": 9.8}]},
        {"station_id": "s1", "rows": [{"to": "Circle", "fare": True}]},
    ):
        with pytest.raises(ValidationError):
            ContributionCreate(kind="fareboard", payload=bad)


# ── Putting a board's fares into the routes ────────────────────────────────────────────────────

STOPS = ["S", "a", "b", "c", "d"]
SEG = [0.0, 1.0, 1.0, 2.0, 2.0]


def fare(stops, seg, board, at, to):
    i, j = stops.index(at), stops.index(to)
    return round(board + sum(seg[i + 1 : j + 1]), 2)


def test_fit_route_makes_each_listed_fare_exact():
    board, seg = fit_route(STOPS, SEG, 5.5, "S", {"b": 9.8, "d": 12.0})
    assert board == 5.5
    assert fare(STOPS, seg, board, "S", "b") == 9.8
    assert fare(STOPS, seg, board, "S", "d") == 12.0
    # Shared out like the old estimates (1:1 to b, 2:2 to d).
    assert seg == [0.0, 2.15, 2.15, 1.1, 1.1]


def test_fit_route_keeps_rounding_exact():
    board, seg = fit_route(["S", "a", "b", "c"], [0, 1, 1, 1], 5.5, "S", {"c": 9.8})
    assert fare(["S", "a", "b", "c"], seg, board, "S", "c") == 9.8


def test_fit_route_leaves_the_route_before_the_station_alone():
    stops, seg0 = ["x", "S", "a", "b"], [0.0, 3.0, 1.0, 1.0]
    board, seg = fit_route(stops, seg0, 5.5, "S", {"b": 8.0})
    assert seg[1] == 3.0
    assert fare(stops, seg, board, "S", "b") == 8.0


def test_fit_route_lowers_the_minimum_when_the_board_says_so():
    board, seg = fit_route(STOPS, SEG, 5.5, "S", {"a": 5.0})
    assert board == 5.0 and seg[1] == 0.0


def test_fit_route_ignores_a_further_stop_that_costs_less():
    board, seg = fit_route(STOPS, SEG, 5.5, "S", {"b": 9.8, "d": 7.0})
    assert fare(STOPS, seg, board, "S", "b") == 9.8
    assert seg[3:] == SEG[3:]


def test_fit_route_none_when_the_board_prices_nothing_on_it():
    assert fit_route(STOPS, SEG, 5.5, "S", {"zz": 9.0}) is None
    assert fit_route(STOPS, SEG, 5.5, "b", {"a": 9.0}) is None  # a comes before b
    assert fit_route(STOPS, SEG, 5.5, "nope", {"a": 9.0}) is None
