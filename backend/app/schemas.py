from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


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
class ContributionCreate(BaseModel):
    kind: Literal["station", "route", "fare"]
    target_id: str | None = None
    payload: dict[str, Any]
    note: str | None = None
    client_key: str | None = None


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


class ChangeSet(BaseModel):
    since: int
    version: int
    stations: list[StationOut]
    routes: list[RouteOut]
    deleted_station_ids: list[str] = []
    deleted_route_ids: list[str] = []


class PushItem(ContributionCreate):
    pass


class PushRequest(BaseModel):
    items: list[PushItem]


class PushResult(BaseModel):
    accepted: int
    duplicates: int
    ids: list[str]
