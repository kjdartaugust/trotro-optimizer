"""A rider moving a place's pin: what the API takes (app/schemas.py) and the hourly cap
(app/limits.py). Against a real database: test_place_fix_db.py."""
import pytest
from pydantic import ValidationError

from app.config import settings
from app.limits import place_fix_allowed
from app.schemas import ContributionCreate, PushItem, PushRequest

# Overture's Zoomlion spot on University Farm Rd, and the building OpenStreetMap maps 171 m south.
ROAD = [-0.11304, 5.67345]
BUILDING = [-0.11337, 5.67193]


def move(**payload):
    p = {"key": "zomlionghanalimited@-0.11304,5.67345", "name": "Zoomlion Ghana Limited", "from": ROAD, "to": BUILDING}
    p.update(payload)
    return ContributionCreate(kind="place", payload=p)


def test_a_pin_moved_onto_its_building_is_taken():
    c = move()
    assert c.kind == "place" and c.payload["to"] == BUILDING
    # The offline outbox sends the same shape.
    assert PushItem(kind="place", payload=c.payload, client_key="k1").payload == c.payload


@pytest.mark.parametrize(
    ("payload", "why"),
    [
        ({"key": ""}, "key"),
        ({"key": "x" * 201}, "key"),
        ({"name": "  "}, "name"),
        ({"to": None}, "both on the app's map"),
        ({"to": [-0.11337]}, "both on the app's map"),
        ({"to": [True, 5.67]}, "both on the app's map"),
        ({"to": ["-0.1", "5.6"]}, "both on the app's map"),
        ({"to": [2.35, 48.85]}, "both on the app's map"),  # Paris: off the app's map
        ({"to": [-0.11304, 5.67346]}, "hasn't moved"),  # 1 m
        ({"to": [-0.11304, 5.71]}, "at most 3 km"),  # 4 km away: across town, not a wrong pin
    ],
)
def test_a_pin_move_must_say_which_place_and_stay_near_it(payload, why):
    with pytest.raises(ValidationError, match=why):
        move(**payload)


def test_a_push_keeps_good_items_and_marks_bad_ones_to_skip():
    good = {"kind": "place", "payload": move().payload, "client_key": "k1"}
    bad = {"kind": "place", "payload": dict(move().payload, to=[2.35, 48.85]), "client_key": "k2"}
    odd = {"kind": "teleport", "payload": {}}
    items = PushRequest(items=[good, bad, odd]).items
    assert isinstance(items[0], PushItem)
    assert [type(i) for i in items[1:]] == [dict, dict]


def test_other_reports_are_not_held_to_the_pin_rules():
    assert ContributionCreate(kind="station", payload={"name": "New stop", "lat": 5.6, "lon": -0.2}).kind == "station"


def test_each_address_moves_so_many_pins_an_hour():
    n = settings.place_fixes_per_hour
    assert all(place_fix_allowed("10.0.0.1", now=1000.0 + i) for i in range(n))
    assert not place_fix_allowed("10.0.0.1", now=1000.0 + n)
    assert place_fix_allowed("10.0.0.2", now=1000.0 + n)  # another rider isn't held up
    assert place_fix_allowed("10.0.0.1", now=1000.0 + 3601 + n)  # an hour on, again
