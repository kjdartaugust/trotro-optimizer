"""Stable ids for the network's rows: uuid5 of each station's slug and each route's key.

The seed writes them to the database and the map-shape build keys its lines by them, so the two
must agree; both import them from here.
"""
from __future__ import annotations

import uuid

# Fixed for good: changing it would give every seeded row a new id.
NAMESPACE = uuid.UUID("2b3f6c1e-8d4a-5f70-9e2b-4c6d8a0f1e35")


def station_uuid(slug: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"station:{slug}"))


def route_uuid(key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"route:{key}"))
