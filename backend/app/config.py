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

    # Reading a photo of a station's fare board. Any vision model behind an OpenAI-style
    # chat-completions API works (Gemini, OpenRouter, Groq, Mistral, OpenAI, Anthropic, a local
    # Ollama...): set its base URL, model and key on the host, never in git. Unset, riders type the
    # board in instead. VISION_FALLBACKS: optional JSON list of {"base_url", "model", "key_env"}
    # tried in order when the first fails, each reading its key from the env var `key_env` names.
    vision_base_url: str = ""
    vision_model: str = ""
    vision_api_key: str = ""
    vision_fallbacks: str = ""
    fareboard_reads_per_hour: int = 20   # per address
    fareboard_reads_per_day: int = 300   # in all, to stay inside free tiers

    cors_origins: str = "http://localhost:3000"
    # Optional regex alternative/supplement to the allowlist — handy for Vercel, whose per-deploy
    # preview URLs change (e.g. r"https://.*\.vercel\.app"). Empty disables it.
    cors_origin_regex: str = ""

    # Routing engine tuning
    walk_radius_m: float = 900.0        # max walk to/from a station or between stations
    access_radius_m: float = 3000.0     # ...to/from a trip's ends when no stop is that close
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
