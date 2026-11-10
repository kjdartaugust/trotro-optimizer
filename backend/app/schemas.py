from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from .config import settings
from .routing.geo import haversine_m


# ---------- Stations ----------
class StationOut(BaseModel):
    id: str
    name: str
    town: str | None = None
    lat: float
    lon: float
    verified: bool
    confidence: float
    version: int

    class Config:
        from_attributes = True


class StationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    town: str | None = None
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


# ---------- Routes ----------
class RouteStopIn(BaseModel):
    station_id: str
    seq: int
    fare_from_prev: float = 0.0
    minutes_from_prev: float = 0.0


class RouteStopOut(RouteStopIn):
    class Config:
        from_attributes = True


class RouteOut(BaseModel):
    id: str
    name: str
    operator: str | None = None
    color: str | None = None
    verified: bool
    confidence: float
    version: int
    # Charged once per boarding; the stops' fare_from_prev add to it.
    board_fare: float = 0.0
    stops: list[RouteStopOut] = []

    class Config:
        from_attributes = True


class RouteCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    operator: str | None = None
    color: str | None = None
    stops: list[RouteStopIn] = Field(min_length=2)


# ---------- Planning ----------
class Point(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class PlanRequest(BaseModel):
    origin: Point
    destination: Point
    modes: list[Literal["fastest", "cheapest", "fewest"]] | None = None


class LegOut(BaseModel):
    kind: str
    from_station: str | None
    to_station: str | None
    from_name: str | None
    to_name: str | None
    route_id: str | None
    route_name: str | None
    fare: float
    minutes: float
    distance_m: float
    num_stops: int


class ItineraryOut(BaseModel):
    mode: str
    total_fare: float
    total_minutes: float
    transfers: int
    walk_distance_m: float
    legs: list[LegOut]


class PlanResponse(BaseModel):
    itineraries: dict[str, ItineraryOut]
    currency: str = "GHS"


# ---------- Contributions ----------
# The map's bounds (frontend TripMap maxBounds): a pin can't be put anywhere the app can't show.
AREA = (-1.4, 4.9, 1.0, 6.4)  # west, south, east, north


def _spot(v: Any) -> tuple[float, float] | None:
    """``[lon, lat]`` inside the app's area, else None."""
    if not isinstance(v, list | tuple) or len(v) != 2:
        return None
    if any(isinstance(x, bool) or not isinstance(x, int | float) for x in v):
        return None
    lon, lat = float(v[0]), float(v[1])
    w, s, e, n = AREA
    return (lon, lat) if w <= lon <= e and s <= lat <= n else None


class ContributionCreate(BaseModel):
    # fareboard: a station's fare board, payload {"station_id", "rows": [{"to", "fare",
    # "to_station_id"}], "effective", "read": "photo"|"typed"} (see app/fares.py).
    # place: a place's pin moved to where it really is, payload {"key", "name", "from": [lon, lat],
    # "to": [lon, lat]}; `from` is the places file's spot, `key` the place (see app/apply.py).
    kind: Literal["station", "route", "fare", "fareboard", "place"]
    target_id: str | None = None
    payload: dict[str, Any]
    note: str | None = None
    client_key: str | None = None

    @model_validator(mode="after")
    def _fareboard_shape(self):
        if self.kind != "fareboard":
            return self
        p = self.payload
        if not isinstance(p.get("station_id"), str) or not p["station_id"]:
            raise ValueError("a fare board needs the station it's at")
        rows = p.get("rows")
        if not isinstance(rows, list) or not 1 <= len(rows) <= 80:
            raise ValueError("a fare board needs 1 to 80 rows")
        for r in rows:
            fare = r.get("fare") if isinstance(r, dict) else None
            to = r.get("to") if isinstance(r, dict) else None
            if not isinstance(to, str) or not 1 <= len(to.strip()) <= 80:
                raise ValueError("each row needs where it goes")
            if isinstance(fare, bool) or not isinstance(fare, int | float) or not 0.5 <= fare <= 500:
                raise ValueError("each row needs a fare in cedis")
            if r.get("to_station_id") is not None and not isinstance(r["to_station_id"], str):
                raise ValueError("to_station_id is a station id")
        return self

    @model_validator(mode="after")
    def _place_shape(self):
        if self.kind != "place":
            return self
        p = self.payload
        key, name = p.get("key"), p.get("name")
        if not isinstance(key, str) or not 1 <= len(key) <= 200:
            raise ValueError("a pin move needs the place's key")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 160:
            raise ValueError("a pin move needs the place's name")
        was, now = _spot(p.get("from")), _spot(p.get("to"))
        if was is None or now is None:
            raise ValueError("a pin move needs where the pin was and where it goes, both on the app's map")
        moved = haversine_m(was[1], was[0], now[1], now[0])
        if moved < 3:
            raise ValueError("the pin hasn't moved")
        if moved > settings.place_fix_max_m:
            raise ValueError(f"a pin moves at most {settings.place_fix_max_m / 1000:g} km from the places file's spot")
        return self


class ContributionOut(BaseModel):
    id: str
    kind: str
    target_id: str | None
    payload: dict[str, Any]
    note: str | None
    status: str
    confidence: float
    reporter_id: str | None
    created_at: datetime
    version: int

    class Config:
        from_attributes = True


class PlaceFixOut(BaseModel):
    """Where riders say a place is: the place with this name nearest (from_lon, from_lat) in the
    app's places file is drawn at (lon, lat) instead."""

    key: str
    name: str
    from_lat: float
    from_lon: float
    lat: float
    lon: float
    version: int

    class Config:
        from_attributes = True


class VoteIn(BaseModel):
    value: Literal[-1, 1]


class ModerationDecision(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = None


# ---------- Sync ----------
class DatasetSnapshot(BaseModel):
    version: int
    generated_at: datetime
    stations: list[StationOut]
    routes: list[RouteOut]
    place_fixes: list[PlaceFixOut] = []


class ChangeSet(BaseModel):
    since: int
    version: int
    stations: list[StationOut]
    routes: list[RouteOut]
    place_fixes: list[PlaceFixOut] = []
    # Taken out of the network since `since`: drop them.
    deleted_station_ids: list[str] = []
    deleted_route_ids: list[str] = []


class PushItem(ContributionCreate):
    pass


class PushRequest(BaseModel):
    # An item this server won't take (bad, or from an app older or newer than its rules) stays a
    # plain dict and is skipped as `refused`: failing the whole push would leave a phone's outbox
    # stuck behind it for good.
    items: list[Annotated[PushItem | dict[str, Any], Field(union_mode="left_to_right")]]


class PushResult(BaseModel):
    accepted: int
    duplicates: int
    ids: list[str]
    # Items not taken: ones this server won't accept, and pin moves over this address's hourly
    # cap (settings.place_fixes_per_hour).
    refused: int = 0
