/**
 * Accra's shops, offices, schools, clinics, churches and the rest, from Overture Maps
 * (public/network/places.json, built by backend/app/etl/overture_places.py): drawn on the map and
 * found by search, offline too once it has loaded (the service worker keeps the file). OpenStreetMap
 * knows few of Accra's businesses; Overture's list comes from Meta, Microsoft and others.
 *
 * Places OpenStreetMap already shows on the map (`onOsmMap`) aren't drawn twice, but search still
 * finds them offline.
 */
import type { Place } from "./places";
import { fold, squash } from "./search";
import { metres as distance, type LngLat } from "./shapes";

export interface MorePlace {
  name: string;
  at: LngLat;
  /** What it is, for people: "Pharmacy". */
  kind: string;
  /** The map icon and colour (OpenMapTiles' kinds, lib/mapPlaces.ts). */
  cls: string;
  /** 1 shows on the map from zoom 14.5, 2 from 15.5, 3 from 16.5. */
  tier: number;
  /** The nearest trotro stop's town, within 2.5 km. */
  town: string | null;
  /** Overture's confidence, 50–100. */
  sure: number;
  onOsmMap: boolean;
  /** For matching what's typed: the name's words, folded, and squashed. */
  words: string[];
  sq: string;
}

export interface MorePlaces {
  list: MorePlace[];
  /** "Overture Maps Foundation, release 2026-10-21.0, CDLA Permissive 2.0". */
  source: string;
  /** What the map draws (source `places`): the ones OpenStreetMap's tiles don't show already. */
  geojson: GeoJSON.FeatureCollection;
}

interface Raw {
  source: string;
  kinds: [string, string][];
  towns: string[];
  places: [number, number, string, number, number, number, number, number][];
}

const WORD = /[^\p{L}\p{N}]+/u;

export function parseMorePlaces(raw: Raw): MorePlaces {
  const list: MorePlace[] = raw.places.map(([lon, lat, name, k, tier, t, sure, osm]) => ({
    name,
    at: [lon, lat],
    kind: raw.kinds[k]?.[0] ?? "Place",
    cls: raw.kinds[k]?.[1] ?? "place",
    tier,
    town: t >= 0 ? raw.towns[t] ?? null : null,
    sure,
    onOsmMap: osm === 1,
    words: fold(name).split(WORD).filter(Boolean),
    sq: squash(name),
  }));
  const features: GeoJSON.Feature[] = [];
  list.forEach((p, i) => {
    if (p.onOsmMap) return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: p.at },
      // The same properties as OpenStreetMap's places in the tiles, so one style draws both.
      properties: { i, name: p.name, class: p.cls, tier: p.tier, rank: p.tier * 100 + (100 - p.sure) },
    });
  });
  return { list, source: raw.source, geojson: { type: "FeatureCollection", features } };
}

let loading: Promise<MorePlaces | null> | null = null;

/** The places file, once per page; null while offline before it was ever cached. */
export function loadMorePlaces(): Promise<MorePlaces | null> {
  loading ??= fetch("/network/places.json")
    .then((r) => (r.ok ? (r.json() as Promise<Raw>) : null))
    .then((raw) => (raw ? parseMorePlaces(raw) : null))
    .catch(() => null)
    .then((v) => {
      if (!v) loading = null; // try again next time
      return v;
    });
  return loading;
}

/** "Pharmacy · Osu". */
export function detailOf(p: MorePlace): string {
  return [p.kind, p.town].filter(Boolean).join(" · ");
}

/** 0: every word typed starts a word of the name, or the name holds it squashed ("Zoom lion");
 *  1: some word does (only used when nothing matches fully); 2: no. As places.ts nameMatch. */
function match(p: MorePlace, words: string[], sq: string): number {
  const starts = (w: string) => p.words.some((o) => o.startsWith(w));
  if (words.length && words.every(starts)) return 0;
  if (sq.length >= 3 && p.sq.includes(sq)) return 0;
  return words.some((w) => w.length >= 3 && starts(w)) ? 1 : 2;
}

/** The places whose names match `q`, best match first, then nearest `near`; at most `limit`. */
export function findMorePlaces(more: MorePlaces, q: string, near: LngLat, limit = 15): Place[] {
  const words = fold(q).split(WORD).filter(Boolean);
  const sq = squash(q);
  if (sq.length < 2) return [];
  const full: { p: MorePlace; m: number }[] = [];
  const part: { p: MorePlace; m: number }[] = [];
  for (const p of more.list) {
    const t = match(p, words, sq);
    if (t === 2) continue;
    (t === 0 ? full : part).push({ p, m: distance(near, p.at) });
  }
  const pick = full.length ? full : part;
  return pick
    .sort((a, b) => a.m - b.m || b.p.sure - a.p.sure)
    .slice(0, limit)
    .map(({ p }) => ({ name: p.name, detail: detailOf(p), at: p.at }));
}
