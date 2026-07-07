from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import contributions, meta, moderation, routes, stations, sync

app = FastAPI(
    title="TroTro Optimizer API",
    version="0.1.0",
    description=(
        "Crowdsourced, offline-first trotro route & fare optimizer for Ghana. "
        "Multi-leg routing, community contributions with trust/moderation, and offline sync."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list or ["*"],
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (meta, stations, routes, contributions, moderation, sync):
    app.include_router(r.router)


@app.get("/", include_in_schema=False)
async def root():
    return {"service": "trotro-optimizer", "docs": "/docs", "openapi": "/openapi.json"}
