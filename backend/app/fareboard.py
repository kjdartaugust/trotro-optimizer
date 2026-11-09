"""Reading a photo of a station's fare board into rows: where each trotro goes, and its fare.

Every GPRTU station puts up its own list of destinations and fares, and changes it when fares
change. A rider photographs it; a vision model reads it; the rider checks the rows and sends them
as a ``fareboard`` contribution (applied by ``fares.apply_fareboard``). The photo is read and
dropped, never stored.

Any model behind an OpenAI-style chat-completions API can read it: the base URL, model and key
come from settings (``VISION_*``), never from code, and fallbacks are tried in order. No model
set: ``NotConfigured``, and the app asks the rider to type the board in.
"""
from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass, field
from datetime import date

import httpx

from .config import settings

MAX_PHOTO_BYTES = 6 * 1024 * 1024
MAX_ROWS = 80

PROMPT = """This is a photo of a trotro (minibus) fare board at a lorry station in Ghana. It lists
destinations and the fare to each, in Ghana cedis (GH₵, GHS, ¢ or C).

Return JSON only, no other text, in exactly this shape:
{"station": "<the station's name if the board shows it, else null>",
 "effective": "<the date the fares took effect as YYYY-MM-DD if shown, else null>",
 "rows": [{"to": "<destination as written>", "fare": <fare as a number>}]}

Rules:
- One row per destination. If a row names several destinations with one fare, give each its own row.
- If the board shows an old and a new fare, use the new one.
- Leave out phone numbers, plate numbers, union names and anything that isn't a destination with a fare.
- If you can't read the board, return {"station": null, "effective": null, "rows": []}."""


class NotConfigured(Exception):
    """No vision model is set up on this server."""


class Unreadable(Exception):
    """No model could read the photo."""


@dataclass
class Provider:
    base_url: str
    model: str
    api_key: str


@dataclass
class Board:
    rows: list[dict] = field(default_factory=list)  # {"to": str, "fare": float}
    station: str | None = None
    effective: str | None = None


def providers() -> list[Provider]:
    """The models to try, in order: the main one, then VISION_FALLBACKS."""
    out = []
    if settings.vision_base_url and settings.vision_model:
        out.append(Provider(settings.vision_base_url, settings.vision_model, settings.vision_api_key))
    if settings.vision_fallbacks.strip():
        try:
            extra = json.loads(settings.vision_fallbacks)
        except ValueError:
            extra = []
        for p in extra if isinstance(extra, list) else []:
            if isinstance(p, dict) and p.get("base_url") and p.get("model"):
                out.append(Provider(str(p["base_url"]), str(p["model"]), os.environ.get(str(p.get("key_env", "")), "")))
    return out


def sniff(photo: bytes) -> str | None:
    """The photo's type from its first bytes (not from what the upload claims), or None."""
    if photo[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if photo[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if photo[:4] == b"RIFF" and photo[8:12] == b"WEBP":
        return "image/webp"
    return None


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.I)
_NUMBER = re.compile(r"\d+(?:[.,]\d{1,2})?")


def _fare(v) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int | float):
        f = float(v)
    else:
        m = _NUMBER.search(str(v))
        if not m:
            return None
        f = float(m.group().replace(",", "."))
    # A trotro fare in cedis; anything else is a misread (a phone number, a year...).
    return round(f, 2) if 0.5 <= f <= 500 else None


def parse_reply(text: str) -> Board:
    """The model's answer as a Board: the JSON object in it, checked row by row."""
    t = _FENCE.sub("", text.strip())
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the reply")
    data = json.loads(t[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("the reply isn't an object")
    rows, seen = [], set()
    for r in data.get("rows") or []:
        if not isinstance(r, dict):
            continue
        to = " ".join(str(r.get("to") or "").split())[:80]
        fare = _fare(r.get("fare"))
        if len(to) < 2 or fare is None or to.lower() in seen:
            continue
        seen.add(to.lower())
        rows.append({"to": to, "fare": fare})
        if len(rows) >= MAX_ROWS:
            break
    station = " ".join(str(data.get("station") or "").split())[:120] or None
    effective = None
    if isinstance(data.get("effective"), str):
        try:
            effective = date.fromisoformat(data["effective"].strip()).isoformat()
        except ValueError:
            effective = None
    return Board(rows=rows, station=station, effective=effective)


async def _ask(client: httpx.AsyncClient, p: Provider, photo: bytes, mime: str) -> Board:
    url = p.base_url.rstrip("/") + "/chat/completions"
    image = f"data:{mime};base64,{base64.b64encode(photo).decode()}"
    body = {
        "model": p.model,
        "temperature": 0,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": image}},
                ],
            }
        ],
    }
    headers = {"Authorization": f"Bearer {p.api_key}"} if p.api_key else {}
    res = await client.post(url, json=body, headers=headers, timeout=60)
    res.raise_for_status()
    content = res.json()["choices"][0]["message"]["content"]
    if isinstance(content, list):  # some providers answer in parts
        content = "".join(c.get("text", "") for c in content if isinstance(c, dict))
    return parse_reply(content or "")


async def read_board(photo: bytes, client: httpx.AsyncClient | None = None) -> Board:
    """Read a fare board photo with the first model that manages it."""
    ps = providers()
    if not ps:
        raise NotConfigured()
    mime = sniff(photo)
    if mime is None:
        raise Unreadable("not a JPEG, PNG or WebP photo")
    own = client is None
    client = client or httpx.AsyncClient()
    try:
        for p in ps:
            try:
                return await _ask(client, p, photo, mime)
            except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError):
                # This one failed (down, over its free quota, an answer we can't use): next one.
                continue
    finally:
        if own:
            await client.aclose()
    raise Unreadable("no model could read the photo")
