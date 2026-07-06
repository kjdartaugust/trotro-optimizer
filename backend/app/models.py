"""SQLAlchemy ORM models. Mirrors migrations/0001_init.sql.

The spatial columns (PostGIS `geometry`) are added in the SQL migration; the ORM keeps plain
lat/lon floats so the in-app routing engine and the offline TS engine stay in perfect parity
without needing PostGIS on the client.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    # Monotonic per-row version used as the sync cursor.
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    email: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    trust_score: Mapped[float] = mapped_column(Float, nullable=False, default=20.0)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="user")  # user|moderator|admin


class Station(Base, TimestampMixin):
    __tablename__ = "stations"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    town: Mapped[str | None] = mapped_column(String(120), nullable=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    h3: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.3)
    created_by: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id"), nullable=True)

    stops: Mapped[list[RouteStop]] = relationship(back_populates="station")


class Route(Base, TimestampMixin):
    __tablename__ = "routes"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    operator: Mapped[str | None] = mapped_column(String(120), nullable=True)
    color: Mapped[str | None] = mapped_column(String(9), nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.3)
    created_by: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id"), nullable=True)

    stops: Mapped[list[RouteStop]] = relationship(
        back_populates="route", order_by="RouteStop.seq", cascade="all, delete-orphan"
    )


class RouteStop(Base, TimestampMixin):
    """One ordered stop on a route. The edge from the previous stop carries fare + time."""

    __tablename__ = "route_stops"
    __table_args__ = (UniqueConstraint("route_id", "seq", name="uq_route_seq"),)

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    route_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("routes.id", ondelete="CASCADE"))
    station_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("stations.id"))
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    # Cost of the segment from the previous stop to this one.
    fare_from_prev: Mapped[float] = mapped_column(Numeric(6, 2), nullable=False, default=0)
    minutes_from_prev: Mapped[float] = mapped_column(Float, nullable=False, default=0)

    route: Mapped[Route] = relationship(back_populates="stops")
    station: Mapped[Station] = relationship(back_populates="stops")


class Contribution(Base, TimestampMixin):
    """A crowdsourced submission: new/edited station, route, or fare report."""

    __tablename__ = "contributions"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # station|route|fare
    target_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False), nullable=True)  # existing record edited
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending|approved|rejected
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    reporter_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id"), nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id"), nullable=True)
    # Client-supplied idempotency key so offline pushes don't double-apply.
    client_key: Mapped[str | None] = mapped_column(String(80), unique=True, nullable=True)


class Vote(Base, TimestampMixin):
    __tablename__ = "votes"
    __table_args__ = (UniqueConstraint("contribution_id", "user_id", name="uq_one_vote"),)

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    contribution_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("contributions.id", ondelete="CASCADE")
    )
    user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("users.id"))
    value: Mapped[int] = mapped_column(Integer, nullable=False)  # +1 confirm / -1 dispute
