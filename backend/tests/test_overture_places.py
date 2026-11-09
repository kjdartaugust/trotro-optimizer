"""Overture's places -> the app's places file (app/etl/overture_places.py), on made-up rows."""
import struct

from app.etl.overture_places import build, clean_name, kind_of, point, squash, tier_of


def wkb(lon: float, lat: float) -> bytes:
    return struct.pack("<BIdd", 1, 1, lon, lat)


def row(name, lon, lat, conf=0.9, basic=None, top=None, status=None):
    return {
        "names": {"primary": name},
        "confidence": conf,
        "operating_status": status,
        "geometry": wkb(lon, lat),
        "basic_category": basic,
        "taxonomy": {"primary": basic, "hierarchy": [top, basic]} if top else None,
    }


STATIONS = [
    {"slug": "a", "name": "Zoomlion Bus Stop", "lat": 5.6735, "lon": -0.1134, "town": "Nmai Dzorm"},
    {"slug": "b", "name": "Kaneshie", "lat": 5.57, "lon": -0.235, "town": "Kaneshie"},
]


def test_squash_matches_the_apps_search():
    # lib/search.ts squash: these must come out the same in both, or the map and search disagree.
    assert squash("Zoom lion") == squash("Zoomlion") == "zomlion"
    assert squash("Trassaco") == "trasaco"
    assert squash("Café Kwaku's") == "cafekwakus"


def test_names_lose_phone_numbers_and_pasted_adverts():
    assert clean_name("Mizprom Herbal Centre +233245304968") == "Mizprom Herbal Centre"
    assert clean_name("Wellness activist 0307098410/ 0248787472") == "Wellness activist"
    assert (
        clean_name("Karima Auto & Shipping Ltd. Accra - Door 2 door & car shipping from United States to Ghana.")
        == "Karima Auto & Shipping Ltd. Accra"
    )
    farm = "Frangladys Fruits Farm. Gbefi, Kpando Municipality, Volta Region, Ghana."
    assert clean_name(farm) == "Frangladys Fruits Farm"
    assert clean_name("Zoomlion  Ghana Limited") == "Zoomlion Ghana Limited"
    assert clean_name("Accra Mall") == "Accra Mall"


def test_reads_a_wkb_point():
    assert point(wkb(-0.11304, 5.67345)) == (-0.11304, 5.67345)
    assert point(b"\x00") is None


def test_kinds_come_from_overtures_category_or_its_tree():
    assert kind_of({"basic_category": "pharmacy_and_drug_store"}) == ("Pharmacy", "pharmacy")
    assert kind_of({"basic_category": "chop_bar", "taxonomy": {"hierarchy": ["food_and_drink", "chop_bar"]}}) == (
        "Food and drink",
        "restaurant",
    )
    assert kind_of({"basic_category": None, "taxonomy": None}) == ("Place", "place")


def test_landmarks_and_sure_places_show_from_further_out():
    assert tier_of("hospital", 0.85) == 1
    assert tier_of("hospital", 0.6) == 2
    assert tier_of("office", 0.91) == 2
    assert tier_of("office", 0.6) == 3


def test_keeps_sure_open_places_in_the_area_once_each():
    rows = [
        row("Zoomlion Ghana Limited", -0.11304, 5.67345, 0.91, "public_utility"),
        row("Zoomlion  Ghana Limited", -0.11330, 5.67360, 0.70, "public_utility"),  # the same, listed again
        row("Unsure Shop", -0.114, 5.672, 0.3, "shopping"),
        row("Closed Bar", -0.115, 5.671, 0.9, "bar", status="permanently_closed"),
        row("Ho Market", 0.47, 6.6, 0.9, "market"),  # far outside the trotro area
        row("Melcom Spintex", -0.2349, 5.5701, 0.8, "department_store"),
        row("Kaneshie Market", -0.2361, 5.5702, 0.95, "market"),
    ]
    osm = [(-0.2350, 5.5702, "Melcom"), (-0.2362, 5.5703, "Kaneshie Market")]
    data = build(rows, osm, STATIONS, "2026-10-21.0")

    assert data["source"] == "Overture Maps Foundation, release 2026-10-21.0, CDLA Permissive 2.0"
    places = {p[2]: p for p in data["places"]}
    assert set(places) == {"Zoomlion Ghana Limited", "Melcom Spintex", "Kaneshie Market"}

    lon, lat, name, kind, tier, town, sure, on_osm = places["Zoomlion Ghana Limited"]
    assert (lon, lat) == (-0.11304, 5.67345)  # the surer copy
    assert data["kinds"][kind] == ["Utility", "office"]
    assert data["towns"][town] == "Nmai Dzorm"
    assert (tier, sure, on_osm) == (2, 91, 0)

    # OpenStreetMap already draws these: under the same name, or a shorter one close by.
    assert places["Kaneshie Market"][7] == 1
    assert places["Melcom Spintex"][7] == 1
