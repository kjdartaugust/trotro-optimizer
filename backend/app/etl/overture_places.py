"""Build ``frontend/public/network/places.json``: the shops, offices, schools, clinics, churches and
the rest of Accra's places from Overture Maps, for the map and for search (offline too).

OpenStreetMap, which the street tiles and online search use, knows few of Accra's businesses.
Overture's places come from Meta, Microsoft and others' business listings, refreshed monthly. This
keeps the ones Overture is fairly sure of (``MIN_CONFIDENCE``) inside the trotro network's area,
merges the copies of one place, gives each a kind (label + map icon), a tier (the zoom it shows
from) and its street when the address names one. A place both lists have shows once on the map,
under the plainer name: OSM's when the names match (``on_osm_map``; search still finds Overture's
copy offline), Overture's when OSM's is the same name and more (``hide_osm``: "Zoomlion Ghana
Limited" over OSM's "Zoomlion Ghana Limited Headquarters"), and at OSM's spot, on the building.

    pip install overturemaps                      # only for this script, not the server
    python -m app.etl.overture_places             # download both, write places.json
    python -m app.etl.overture_places --file accra_places.parquet --osm pois.json

``--file`` is ``overturemaps download --bbox=<area> -f geoparquet --type=place`` saved earlier;
``--osm`` is an Overpass answer (``OSM_QUERY``) saved earlier.

Overture's places are under CDLA Permissive 2.0: credit "Overture Maps Foundation" wherever they
are shown. The OSM places are only compared against, not copied.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import re
import struct
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import httpx

from ..routing.geo import haversine_m
from .osm_network import UA

log = logging.getLogger("etl.overture_places")

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / "backend" / "seed" / "accra.json"
OUT = ROOT / "frontend" / "public" / "network" / "places.json"

MIN_CONFIDENCE = 0.5  # Overture's own score; below it, many are closed, moved or duplicated
MARGIN = 0.09  # degrees round the stops, as the app's place search (lib/network.ts areaOf)
SAME_PLACE_M = 100  # one place listed twice by Overture's sources
OSM_SAME_M = 150  # a place OpenStreetMap already has, under the same name
ONE_PLACE_M = 300  # ... or under its name and more ("Zoomlion Ghana Limited" / "... Headquarters": 171 m apart)
CORE_MIN = 8  # letters a name needs before "contains it" means the same place ("Shell" isn't enough)
OSM_PART_M = 80  # shorter names (5+ letters) only count this close
TOWN_M = 2500  # the area named in search results: the nearest stop's town, if this close
MAX_STREET = 40  # longer than this, Overture's address is a description, not a street

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
OSM_QUERY = """[out:json][timeout:180];
(
  nwr["name"]["amenity"]({b});
  nwr["name"]["shop"]({b});
  nwr["name"]["office"]({b});
  nwr["name"]["tourism"]({b});
  nwr["name"]["leisure"]({b});
  nwr["name"]["healthcare"]({b});
  nwr["name"]["craft"]({b});
);
out center tags qt;"""

# Overture's basic_category -> (label in search, map icon class: OpenMapTiles' kinds, lib/mapPlaces.ts)
KINDS: dict[str, tuple[str, str]] = {
    "christian_place_of_worship": ("Church", "religious_christian"),
    "muslim_place_of_worship": ("Mosque", "religious_muslim"),
    "hindu_place_of_worship": ("Temple", "place_of_worship"),
    "jewish_place_of_worship": ("Synagogue", "religious_jewish"),
    "place_of_worship": ("Place of worship", "place_of_worship"),
    "religious_organization": ("Religious organisation", "place_of_worship"),
    "place_of_learning": ("School", "school"),
    "education": ("School", "school"),
    "specialty_school": ("School", "school"),
    "educational_service": ("Education", "school"),
    "tutoring_service": ("Tutoring", "school"),
    "preschool": ("Nursery school", "school"),
    "elementary_school": ("Primary school", "school"),
    "middle_school": ("Junior high school", "school"),
    "high_school": ("Senior high school", "school"),
    "college_university": ("University or college", "college"),
    "campus_building": ("Campus building", "college"),
    "research_institute": ("Research institute", "college"),
    "library": ("Library", "library"),
    "restaurant": ("Restaurant", "restaurant"),
    "casual_eatery": ("Eatery", "restaurant"),
    "food_service": ("Food", "restaurant"),
    "food_and_drink": ("Food and drink", "restaurant"),
    "fast_food_restaurant": ("Fast food", "fast_food"),
    "food_truck_stand": ("Food stand", "fast_food"),
    "cafe": ("Cafe", "cafe"),
    "coffee_shop": ("Coffee shop", "cafe"),
    "smoothie_juice_bar": ("Juice bar", "cafe"),
    "non_alcoholic_beverage_venue": ("Drinks", "cafe"),
    "bar": ("Bar", "bar"),
    "lounge": ("Lounge", "bar"),
    "dance_club": ("Night club", "bar"),
    "alcoholic_beverage_venue": ("Drinking spot", "bar"),
    "brewery": ("Brewery", "beer"),
    "distillery": ("Distillery", "beer"),
    "winery": ("Winery", "bar"),
    "hotel": ("Hotel", "lodging"),
    "lodging": ("Lodging", "lodging"),
    "resort": ("Resort", "lodging"),
    "private_lodging": ("Guest house", "lodging"),
    "bed_and_breakfast": ("Guest house", "lodging"),
    "inn": ("Inn", "lodging"),
    "hospital": ("Hospital", "hospital"),
    "emergency_or_urgent_care_facility": ("Emergency care", "hospital"),
    "emergency_department": ("Emergency care", "hospital"),
    "health_care": ("Clinic", "doctors"),
    "outpatient_care_facility": ("Clinic", "doctors"),
    "primary_care_or_general_clinic": ("Clinic", "doctors"),
    "specialized_medical_facility": ("Clinic", "doctors"),
    "specialized_health_care": ("Clinic", "doctors"),
    "medical_service": ("Medical service", "doctors"),
    "diagnostics_imaging_or_lab_service": ("Lab", "doctors"),
    "vision_or_eye_care_clinic": ("Eye clinic", "doctors"),
    "behavioral_or_mental_health_clinic": ("Clinic", "doctors"),
    "physical_medicine_and_rehabilitation": ("Physiotherapy", "doctors"),
    "reproductive_perinatal_and_womens_care": ("Maternity", "doctors"),
    "pediatric_clinic": ("Children's clinic", "doctors"),
    "complementary_and_alternative_medicine": ("Herbal clinic", "doctors"),
    "wellness_service": ("Wellness", "doctors"),
    "dental_clinic": ("Dentist", "dentist"),
    "pharmacy_and_drug_store": ("Pharmacy", "pharmacy"),
    "animal_or_pet_service": ("Vet", "veterinary"),
    "gas_station": ("Fuel station", "fuel"),
    "fueling_station": ("Fuel station", "fuel"),
    "automotive_service": ("Car repair", "car"),
    "vehicle_service": ("Car service", "car"),
    "auto_dealer": ("Car dealer", "car"),
    "vehicle_dealer": ("Vehicle dealer", "car"),
    "vehicle_parts_store": ("Car parts", "car"),
    "taxi_or_ride_share_service": ("Taxi", "car"),
    "parking": ("Parking", "parking"),
    "bank_or_credit_union": ("Bank", "bank"),
    "atm": ("ATM", "bank"),
    "financial_service": ("Finance", "bank"),
    "government_office": ("Government office", "town_hall"),
    "government_department": ("Government office", "town_hall"),
    "community_and_government": ("Public office", "town_hall"),
    "courthouse": ("Court", "town_hall"),
    "military_site": ("Military", "town_hall"),
    "police_station": ("Police", "police"),
    "fire_station": ("Fire station", "fire_station"),
    "embassy": ("Embassy", "embassy"),
    "jail_or_prison": ("Prison", "prison"),
    "public_utility": ("Utility", "office"),
    "electric_utility_provider": ("Electricity company", "office"),
    "water_utility_provider": ("Water company", "office"),
    "shopping_mall": ("Shopping mall", "commercial"),
    "department_store": ("Department store", "shop"),
    "shopping": ("Shop", "shop"),
    "specialty_store": ("Shop", "shop"),
    "discount_store": ("Shop", "shop"),
    "fashion_and_apparel_store": ("Clothes", "clothing_store"),
    "electronics_store": ("Electronics", "shop"),
    "hardware_home_and_garden_store": ("Hardware", "shop"),
    "food_and_beverage_store": ("Food shop", "grocery"),
    "convenience_store": ("Mini mart", "grocery"),
    "warehouse_club_store": ("Supermarket", "grocery"),
    "farmers_market": ("Market", "grocery"),
    "market": ("Market", "grocery"),
    "personal_care_and_beauty_store": ("Beauty shop", "shop"),
    "books_music_and_video_store": ("Books", "shop"),
    "arts_crafts_and_hobby_store": ("Crafts", "gift"),
    "flowers_and_gifts_store": ("Gifts", "gift"),
    "sporting_goods_store": ("Sports shop", "shop"),
    "animal_and_pet_store": ("Pet shop", "shop"),
    "musical_instrument_and_pro_audio_store": ("Music shop", "music"),
    "office_supply_store": ("Stationery", "shop"),
    "second_hand_store": ("Second-hand shop", "shop"),
    "toys_and_games_store": ("Toys", "shop"),
    "personal_or_beauty_service": ("Salon", "hairdresser"),
    "laundry_service": ("Laundry", "laundry"),
    "park": ("Park", "park"),
    "garden": ("Garden", "garden"),
    "beach": ("Beach", "park"),
    "national_park": ("Park", "park"),
    "nature_reserve": ("Nature reserve", "park"),
    "stadium_arena": ("Stadium", "stadium"),
    "sport_field": ("Sports field", "pitch"),
    "sport_court": ("Court", "pitch"),
    "sport_or_fitness_facility": ("Sports centre", "pitch"),
    "gym": ("Gym", "pitch"),
    "fitness_studio": ("Gym", "pitch"),
    "swimming_pool": ("Swimming pool", "swimming"),
    "golf_course": ("Golf course", "golf"),
    "playground": ("Playground", "playground"),
    "zoo": ("Zoo", "zoo"),
    "aquarium": ("Aquarium", "aquarium"),
    "amusement_park": ("Amusement park", "amusement_park"),
    "movie_theater": ("Cinema", "cinema"),
    "theatre_venue": ("Theatre", "theatre"),
    "music_venue": ("Music venue", "music"),
    "event_venue": ("Event venue", "theatre"),
    "festival_venue": ("Event venue", "theatre"),
    "art_gallery": ("Gallery", "art_gallery"),
    "museum": ("Museum", "museum"),
    "monument": ("Monument", "monument"),
    "sculpture_statue": ("Monument", "monument"),
    "historic_site": ("Historic site", "monument"),
    "castle": ("Castle", "castle"),
    "fort": ("Fort", "castle"),
    "lighthouse": ("Lighthouse", "lighthouse"),
    "airport": ("Airport", "airport"),
    "air_transport_facility_or_service": ("Airport", "airport"),
    "train_station": ("Train station", "railway"),
    "public_transit_facility_or_service": ("Transport", "bus"),
    "real_estate_service": ("Real estate", "office"),
    "professional_service": ("Business", "office"),
    "corporate_or_business_office": ("Office", "office"),
}
# Then by the top of Overture's category tree.
BY_TOP: dict[str, tuple[str, str]] = {
    "food_and_drink": ("Food and drink", "restaurant"),
    "shopping": ("Shop", "shop"),
    "education": ("School", "school"),
    "health_care": ("Clinic", "doctors"),
    "lodging": ("Lodging", "lodging"),
    "community_and_government": ("Public office", "town_hall"),
    "arts_and_entertainment": ("Entertainment", "theatre"),
    "sports_and_recreation": ("Sports", "pitch"),
    "cultural_and_historic": ("Historic site", "monument"),
    "travel_and_transportation": ("Travel", "office"),
    "lifestyle_services": ("Service", "office"),
    "services_and_business": ("Business", "office"),
}
OTHER = ("Place", "place")
# Places riders steer by: shown from further out.
LANDMARK = {"hospital", "college", "commercial", "lodging", "fuel", "bank", "stadium", "police", "town_hall",
            "airport", "museum", "embassy", "grocery", "cinema", "castle"}


def squash(s: str) -> str:
    """Spelling-blind: lowercase, no accents, letters and digits only, doubled letters once (as
    lib/search.ts ``squash``)."""
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"(.)\1+", r"\1", re.sub(r"[^0-9a-z]", "", s))


def tidy(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip()


PHONE = re.compile(r"\+?\d[\d\s/().-]{6,}\d")
LONG_NAME = 60  # longer is usually an advert pasted into the name ("... - Door 2 door shipping")


def clean_name(name: str) -> str:
    """A place's name without phone numbers, and cut at its first break when it runs on."""
    name = tidy(PHONE.sub(" ", name)).strip(" -,.|/:")
    if len(name) > LONG_NAME:
        for sep in (" - ", " | ", ". ", ", ", ": "):
            head = name.split(sep)[0].strip()
            if 3 <= len(head) < len(name):
                name = head
                break
    return tidy(name)


GPS_CODE = re.compile(r"\b[A-Z]{2}\s*-?\s*\d{3,4}\s*-?\s*\d{3,4}\b")  # GhanaPostGPS: "GA-183-8164"
PLUS_CODE = re.compile(r"\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b")  # "GPCQ+VH3"
GPS_WORDS = re.compile(r"(digital address|ghana ?post( gps)?|gps)\s*:?", re.I)
# An address worth showing names a road or a building, not just a company or a town.
STREETISH = re.compile(
    r"\b(road|rd|street|st|avenue|ave|lane|ln|close|crescent|cres|drive|dr|highway|hwy|high way|junction|"
    r"link|way|loop|circle|roundabout|bypass|boulevard|blvd|motorway|square|sq|plaza|mall|market|building|"
    r"house|tower|centre|center|estate|court|terrace|row)\b",
    re.I,
)
# A spot several businesses share is the venue's own when their address names one (a mall's shops).
VENUE = re.compile(
    r"\b(mall|market|plaza|complex|tower|building|house|centre|center|hospital|university|hotel)\b", re.I
)


def street_of(row: dict, name: str) -> str:
    """The street from Overture's address ("University Farm Rd"), or "" when it has none worth
    showing: codes, phone numbers and directions are dropped, a long one is cut at its first comma,
    and one that names no road or building ("Damerko company limited") isn't shown."""
    address = (row.get("addresses") or [{}])[0] or {}
    s = (address.get("freeform") or "").replace("\\n", ", ").replace("\n", ", ")
    s = PHONE.sub(" ", GPS_WORDS.sub(" ", PLUS_CODE.sub(" ", GPS_CODE.sub(" ", s))))
    s = re.sub(r"(\s*,\s*)+", ", ", tidy(s)).strip(" ,.-#")
    if len(s) > MAX_STREET:
        s = s.split(", ")[0].strip(" ,.-#")
    if not (3 <= len(s) <= MAX_STREET) or not STREETISH.search(s) or squash(s) == squash(name):
        return ""
    # "kokrobite road bortianor", "ACCRA - CAPE COAST RD": as a sign would write them.
    return s.title() if s.islower() or s.isupper() else s


def area(stations: list[dict]) -> tuple[float, float, float, float]:
    lats = [s["lat"] for s in stations]
    lons = [s["lon"] for s in stations]
    return (min(lons) - MARGIN, min(lats) - MARGIN, max(lons) + MARGIN, max(lats) + MARGIN)


def kind_of(row: dict) -> tuple[str, str]:
    basic = row.get("basic_category")
    if basic in KINDS:
        return KINDS[basic]
    tree = (row.get("taxonomy") or {}).get("hierarchy") or []
    return BY_TOP.get(tree[0], OTHER) if tree else OTHER


def tier_of(cls: str, confidence: float) -> int:
    """1 shows from zoom 14.5, 2 from 15.5, 3 from 16.5 (lib/mapPlaces.ts)."""
    if cls in LANDMARK and confidence >= 0.8:
        return 1
    if cls in LANDMARK or confidence >= 0.8:
        return 2
    return 3


def point(geom) -> tuple[float, float] | None:
    """(lon, lat) of a WKB point, or of a bbox dict's corner."""
    if isinstance(geom, (bytes, bytearray)) and len(geom) >= 21:
        order = "<" if geom[0] == 1 else ">"
        (kind,) = struct.unpack(order + "I", geom[1:5])
        if kind % 1000 == 1:
            return struct.unpack(order + "dd", geom[5:21])
    return None


class Grid:
    """Points bucketed by ~220 m cells, for "anything like this nearby?"."""

    CELL = 0.002

    def __init__(self) -> None:
        self.cells: dict[tuple[int, int], list] = defaultdict(list)

    def key(self, lon: float, lat: float) -> tuple[int, int]:
        return (math.floor(lon / self.CELL), math.floor(lat / self.CELL))

    def add(self, lon: float, lat: float, item) -> None:
        self.cells[self.key(lon, lat)].append((lon, lat, item))

    def near(self, lon: float, lat: float, metres: float):
        r = math.ceil(metres / 111_000 / self.CELL)
        kx, ky = self.key(lon, lat)
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for plon, plat, item in self.cells.get((kx + dx, ky + dy), ()):
                    d = haversine_m(lat, lon, plat, plon)
                    if d <= metres:
                        yield d, item


def read_overture(path: Path | None, bbox: tuple[float, float, float, float]) -> tuple[list[dict], str]:
    """Overture's places in ``bbox`` (from a saved geoparquet, or downloaded), and the release."""
    if path:
        import pyarrow.parquet as pq

        release = "a saved download"
        state = path.with_name(path.name + ".state")
        if state.exists():
            release = json.loads(state.read_text(encoding="utf-8")).get("last_release", release)
        return pq.read_table(path).to_pylist(), release
    from overturemaps import core  # pip install overturemaps

    release = core.get_latest_release() if hasattr(core, "get_latest_release") else "latest"
    reader = core.record_batch_reader("place", bbox)
    return reader.read_all().to_pylist(), release


def read_osm(path: Path | None, bbox: tuple[float, float, float, float]) -> list[tuple[float, float, str]]:
    """OpenStreetMap's named places in ``bbox``: (lon, lat, name)."""
    if path:
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        w, s, e, n = bbox
        query = OSM_QUERY.format(b=f"{s},{w},{n},{e}")
        data, last = None, None
        for url in OVERPASS:
            try:
                r = httpx.post(url, data={"data": query}, headers=UA, timeout=300)
                r.raise_for_status()
                data = r.json()
                break
            except (httpx.HTTPError, ValueError) as err:
                last = err
                log.warning("overpass %s failed: %s", url, err)
        if data is None:
            raise RuntimeError(f"every Overpass server failed: {last}")
    out = []
    for el in data.get("elements", []):
        name = (el.get("tags") or {}).get("name")
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        lon = el.get("lon", (el.get("center") or {}).get("lon"))
        if name and lat is not None and lon is not None:
            out.append((float(lon), float(lat), name))
    return out


def coarse(lon: float, lat: float) -> bool:
    """A spot given to 4 decimals or fewer (~10 m grid): typed in or an area's middle, not a GPS fix."""
    return round(lon, 4) == lon and round(lat, 4) == lat


def build(rows: list[dict], osm: list[tuple[float, float, str]], stations: list[dict], release: str) -> dict:
    w, s, e, n = area(stations)
    # A listing named just "Nungua" or "Adabraka" is the area's page, put anywhere: not a place in it.
    town_keys = {squash(st["town"]) for st in stations if st.get("town")}

    # 1. Sure enough, named, open, inside the area.
    keep = []
    for row in rows:
        conf = float(row.get("confidence") or 0)
        name = clean_name((row.get("names") or {}).get("primary") or "")
        status = row.get("operating_status")
        at = point(row.get("geometry"))
        if at is None and row.get("bbox"):
            at = (row["bbox"]["xmin"], row["bbox"]["ymin"])
        if conf < MIN_CONFIDENCE or not name or not squash(name) or at is None or squash(name) in town_keys:
            continue
        if status not in (None, "open"):
            continue
        lon, lat = at
        if not (w <= lon <= e and s <= lat <= n):
            continue
        keep.append({
            "name": name, "lon": lon, "lat": lat, "conf": conf, "kind": kind_of(row), "key": squash(name),
            "street": street_of(row, name),
        })

    # 2. One place listed twice: keep the surer.
    keep.sort(key=lambda p: -p["conf"])
    grid, places = Grid(), []
    for p in keep:
        if any(q["key"] == p["key"] for _, q in grid.near(p["lon"], p["lat"], SAME_PLACE_M)):
            continue
        grid.add(p["lon"], p["lat"], p)
        places.append(p)

    # 2b. A spot several different businesses share exactly is a guess: an area or a street turned
    #     into one point (293 listings sat on 5.55, -0.2, "Accra"; 51 on "Spintex Road"), as is a
    #     coarse one. Unless OpenStreetMap has the place (step 3 moves it there), it's left out: no
    #     place beats a pin in the wrong spot. A venue's address keeps its shops.
    at_point: dict[tuple[float, float], list[dict]] = defaultdict(list)
    for p in places:
        at_point[(round(p["lon"], 6), round(p["lat"], 6))].append(p)
    for (lon, lat), here in at_point.items():
        shared = len({q["key"] for q in here}) >= 2
        top, times_given = Counter(q["street"] for q in here).most_common(1)[0]
        # Most of them (2 or more) give the same venue.
        venue = top and times_given >= 2 and times_given * 2 >= len(here) and VENUE.search(top)
        for q in here:
            q["guessed"] = bool(shared and not venue) or coarse(lon, lat)

    # 3. The same place in OpenStreetMap? The map shows one of the two, the plainer name:
    #    the same name -> OSM's (its tiles draw it); OSM's is shorter -> OSM's; Overture's is shorter
    #    ("Zoomlion Ghana Limited" vs OSM's "... Headquarters") -> Overture's, and OSM's is hidden by
    #    name, which only works for a name OSM uses once here (a filter hides every copy).
    #    Where OSM has it under the same name or a fuller one, it sits where OSM puts it: mappers put
    #    it on the building, while a listing can sit on its address's street (Zoomlion Ghana Limited
    #    was on University Farm Rd, 171 m from its building). A shorter OSM name is often what it is
    #    inside (a market, a mall), so a place keeps its own spot then.
    #    OSM's own spot only counts when it's a real one: not coarse, not shared by other names.
    osm_grid = Grid()
    times = Counter(name for _, _, name in osm)
    names_at: dict[tuple[float, float], set[str]] = defaultdict(set)
    for lon, lat, name in osm:
        names_at[(round(lon, 6), round(lat, 6))].add(name)
    for lon, lat, name in osm:
        k = squash(name)
        if k:
            real = len(names_at[(round(lon, 6), round(lat, 6))]) == 1 and not coarse(lon, lat)
            osm_grid.add(lon, lat, (k, name, lon, lat, real))
    longer_in_osm: dict[int, set[str]] = defaultdict(set)
    moved = 0
    for i, p in enumerate(places):
        p["osm"] = False
        spots = []  # OSM's copy under the same name (0) or a fuller one (1): (which, metres, lon, lat)
        for d, (k, name, lon, lat, real) in osm_grid.near(p["lon"], p["lat"], ONE_PLACE_M):
            if k == p["key"]:
                if d <= OSM_SAME_M:
                    p["osm"] = True
                    if real:
                        spots.append((0, d, lon, lat))
            elif k in p["key"] and (len(k) >= CORE_MIN or (d <= OSM_PART_M and len(k) >= 5)):
                p["osm"] = True
            elif p["key"] in k and len(p["key"]) >= CORE_MIN:
                if real:
                    spots.append((1, d, lon, lat))
                if times[name] == 1:
                    longer_in_osm[i].add(name)
        if spots:
            _, d, p["lon"], p["lat"] = min(spots)
            moved += d > 0
            p["guessed"] = False
    hide_osm = sorted({
        n for i, names in longer_in_osm.items() if not places[i]["osm"] and not places[i]["guessed"] for n in names
    })
    guessed = sum(p["guessed"] for p in places)
    # Two listings of one name moved onto the same OSM place are one place.
    seen: set[tuple[str, float, float]] = set()
    kept = []
    for p in places:
        spot = (p["key"], round(p["lon"], 6), round(p["lat"], 6))
        if not p["guessed"] and spot not in seen:
            seen.add(spot)
            kept.append(p)
    places = kept

    # 4. The area to name in search: the nearest stop's town.
    stop_grid = Grid()
    for st in stations:
        if st.get("town"):
            stop_grid.add(st["lon"], st["lat"], st["town"])
    towns: dict[str, int] = {}
    streets: dict[str, int] = {}
    kinds: dict[tuple[str, str], int] = {}
    out = []
    for p in sorted(places, key=lambda p: (p["lat"], p["lon"])):
        town = min(stop_grid.near(p["lon"], p["lat"], TOWN_M), default=None, key=lambda t: t[0])
        t = towns.setdefault(town[1], len(towns)) if town else -1
        st = streets.setdefault(p["street"], len(streets)) if p["street"] else -1
        k = kinds.setdefault(p["kind"], len(kinds))
        tier = tier_of(p["kind"][1], p["conf"])
        sure = round(p["conf"] * 100)
        out.append([round(p["lon"], 5), round(p["lat"], 5), p["name"], k, tier, t, sure, int(p["osm"]), st])

    log.info(
        "%d Overture places: %d sure enough, %d after merging copies, %d also in OpenStreetMap, "
        "%d OSM names hidden for a plainer Overture one, %d moved to OSM's spot, %d left out on a guessed "
        "spot, %d kept, %d with a street",
        len(rows), len(keep), len(places) + guessed, sum(p["osm"] for p in places), len(hide_osm), moved,
        guessed, len(places), sum(1 for p in places if p["street"]),
    )
    return {
        "source": f"Overture Maps Foundation, release {release}, CDLA Permissive 2.0",
        "fields": ["lon", "lat", "name", "kind", "tier", "town", "confidence", "on_osm_map", "street"],
        "kinds": [list(k) for k in kinds],
        "towns": list(towns),
        "streets": list(streets),
        "hide_osm": hide_osm,
        "places": out,
    }


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--file", type=Path, help="a saved `overturemaps download` geoparquet")
    ap.add_argument("--osm", type=Path, help="a saved Overpass answer to OSM_QUERY")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    stations = json.loads(BUNDLE.read_text(encoding="utf-8"))["stations"]
    bbox = area(stations)
    rows, release = read_overture(args.file, bbox)
    osm = read_osm(args.osm, bbox)
    data = build(rows, osm, stations, release)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log.info("wrote %s: %d places, %.0f KB", args.out, len(data["places"]), args.out.stat().st_size / 1024)


if __name__ == "__main__":
    main()
