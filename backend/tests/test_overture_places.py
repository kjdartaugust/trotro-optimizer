"""Overture's places -> the app's places file (app/etl/overture_places.py), on made-up rows."""
import struct

from app.etl.overture_places import build, clean_name, kind_of, point, squash, street_of, tier_of


def wkb(lon: float, lat: float) -> bytes:
    return struct.pack("<BIdd", 1, 1, lon, lat)


def row(name, lon, lat, conf=0.9, basic=None, top=None, status=None, address=None):
    return {
        "names": {"primary": name},
        "confidence": conf,
        "operating_status": status,
        "geometry": wkb(lon, lat),
        "basic_category": basic,
        "taxonomy": {"primary": basic, "hierarchy": [top, basic]} if top else None,
        "addresses": [{"freeform": address, "country": "GH"}] if address else None,
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

    lon, lat, name, kind, tier, town, sure, on_osm, street = places["Zoomlion Ghana Limited"]
    assert (lon, lat) == (-0.11304, 5.67345)  # the surer copy
    assert data["kinds"][kind] == ["Utility", "office"]
    assert data["towns"][town] == "Nmai Dzorm"
    assert (tier, sure, on_osm, street) == (2, 91, 0, -1)

    # OpenStreetMap already draws these: under the same name, or a shorter one close by.
    assert places["Kaneshie Market"][7] == 1
    assert places["Melcom Spintex"][7] == 1
    # The same name sits where OSM puts it; a shorter OSM name ("Melcom") may be what it's inside.
    assert places["Kaneshie Market"][:2] == [-0.2362, 5.5703]
    assert places["Melcom Spintex"][:2] == [-0.2349, 5.5701]


def test_streets_worth_showing():
    def street(address, name="Somewhere"):
        return street_of({"addresses": [{"freeform": address, "country": "GH"}]}, name)

    assert street("University Farm Rd") == "University Farm Rd"
    assert street("GPCQ+VH3, Armah Polisi Street") == "Armah Polisi Street"
    assert street("Digital Address: CG-0112-1330 Kasoa Rd") == "Kasoa Rd"
    assert street("kokrobite road bortianor") == "Kokrobite Road Bortianor"
    assert street("393 Mallam Gbawe road, first floor Joscom grocery store building. GPS GS - 0141 - 4047") == (
        "393 Mallam Gbawe road"
    )
    assert street("Damerko company limited") == ""  # names no road or building
    assert street("Kasoa") == ""
    assert street("Spintex Road", name="Spintex Road") == ""  # just its own name again
    assert street_of({"addresses": None}, "x") == ""


def test_the_same_place_in_both_lists_shows_once_under_the_plainer_name():
    rows = [
        row("Zoomlion Ghana Limited", -0.11304, 5.67345, 0.91, "public_utility", address="University Farm Rd"),
        row("Star Oil Ghana", -0.2349, 5.5701, 0.8, "gas_station"),
    ]
    osm = [
        # OSM's building, 171 m away, under the same name and more: Overture's plainer name shows.
        (-0.11336, 5.67195, "Zoomlion Ghana Limited Headquarters"),
        # A name OSM uses twice can't be hidden by name without hiding both.
        (-0.2350, 5.5702, "Star Oil Ghana Filling Station"),
        (-0.3000, 5.6000, "Star Oil Ghana Filling Station"),
    ]
    data = build(rows, osm, STATIONS, "2026-10-21.0")
    places = {p[2]: p for p in data["places"]}
    assert data["hide_osm"] == ["Zoomlion Ghana Limited Headquarters"]
    assert places["Zoomlion Ghana Limited"][7] == 0  # drawn
    assert data["streets"][places["Zoomlion Ghana Limited"][8]] == "University Farm Rd"
    # ... on the building, where OSM puts it, not on the street of its address.
    assert places["Zoomlion Ghana Limited"][:2] == [-0.11336, 5.67195]
    # A fuller OSM name used twice isn't hidden, but the place still moves onto the nearer copy.
    assert places["Star Oil Ghana"][:2] == [-0.2350, 5.5702]
