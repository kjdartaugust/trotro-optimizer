from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://trotro:trotro@localhost:5432/trotro"
    database_url_sync: str = "postgresql+psycopg://trotro:trotro@localhost:5432/trotro"
    redis_url: str = "redis://localhost:6379/0"

    supabase_jwt_secret: str = "super-secret-dev-jwt-signing-key-change-me"
    jwt_algorithm: str = "HS256"
    dev_auth: bool = True

    auto_approve_threshold: float = 0.75
    default_trust_score: int = 20
    fare_report_halflife_days: int = 30

    cors_origins: str = "http://localhost:3000"
    # Optional regex alternative/supplement to the allowlist — handy for Vercel, whose per-deploy
    # preview URLs change (e.g. r"https://.*\.vercel\.app"). Empty disables it.
    cors_origin_regex: str = ""

    # Routing engine tuning
    walk_radius_m: float = 900.0        # max walk to/from a station or between stations
    walk_speed_mps: float = 1.25        # ~4.5 km/h
    board_penalty_min: float = 4.0      # average wait to board a trotro
    transfer_penalty_min: float = 3.0   # friction of changing vehicles

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
