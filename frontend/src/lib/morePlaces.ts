/**
 * Accra's shops, offices, schools, clinics, churches and the rest, from Overture Maps
 * (public/network/places.json, built by backend/app/etl/overture_places.py): drawn on the map and
 * found by search, offline too once it has loaded (the service worker keeps the file). OpenStreetMap
 * knows few of Accra's businesses; Overture's list comes from Meta, Microsoft and others.
 *
 * One place in both lists shows once on the map, under the plainer name: OpenStreetMap's when the
 * names are the same (`onOsmMap`: not drawn again, still searched offline), Overture's when OSM's
 * is the same and more ("Zoomlion Ghana Limited" / "... Headquarters", `hideOsm`).
 *
 * A place riders have moved (a pin on the wrong spot, dragged onto its building) shows where they
 * put it, on the map and in search: `withFixes`, with the moves from /sync (lib/db placeFixes).
 */
import type { Place } from "./places";
import { fold, squash } from "./search";
import { metres as distance, type LngLat } from "./shapes";
import type { ApiPlaceFix } from "./types";

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
  /** From Overture's address, when it names a road or building: "University Farm Rd". */
  street: string | null;
  /** Overture's confidence, 50–100. */
  sure: number;
  onOsmMap: boolean;
  /** Where the places file has it. `at` is where riders moved it, if they have (`fixed`). */
  origin: LngLat;
  fixed: boolean;
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
  /** OpenStreetMap places the map leaves out, by name: Overture has them under a plainer one. */
  hideOsm: string[];
}

interface Raw {
  source: string;
  kinds: [string, string][];
  towns: string[];
  streets?: string[];
  hide_osm?: string[];
  places: [number, number, string, number, number, number, number, number, number?][];
}

const WORD = /[^\p{L}\p{N}]+/u;

export function parseMorePlaces(raw: Raw): MorePlaces {
  const list: MorePlace[] = raw.places.map(([lon, lat, name, k, tier, t, sure, osm, st = -1]) => ({
    name,
    at: [lon, lat],
    kind: raw.kinds[k]?.[0] ?? "Place",
    cls: raw.kinds[k]?.[1] ?? "place",
    tier,
    town: t >= 0 ? raw.towns[t] ?? null : null,
    street: st >= 0 ? raw.streets?.[st] ?? null : null,
    sure,
    onOsmMap: osm === 1,
    origin: [lon, lat],
    fixed: false,
    words: fold(name).split(WORD).filter(Boolean),
    sq: squash(name),
  }));
  return { list, source: raw.source, geojson: drawable(list), hideOsm: raw.hide_osm ?? [] };
}

/** What the map draws: the places OpenStreetMap's tiles don't show already, where they are. */
function drawable(list: MorePlace[]): GeoJSON.FeatureCollection {
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
  return { type: "FeatureCollection", features };
}

/** A move made on this phone, not yet back from the server: newer than any the server has sent. */
export const LOCAL_FIX = Number.MAX_SAFE_INTEGER;
/** How far a rebuilt places file may shift a place before a rider's move no longer finds it. */
const FIX_REACH_M = 500;
/** A pin moves at least this far, at most this far from the places file's spot, and stays on the
 *  map (the same rules as the API's: backend/app/schemas.py, settings.place_fix_max_m). */
export const MIN_MOVE_M = 3;
export const MAX_MOVE_M = 3000;
const AREA = { w: -1.4, s: 4.9, e: 1.0, n: 6.4 };

/** The place a move is about, for the server: its squashed name at the places file's spot. */
export function placeKey(p: MorePlace): string {
  return `${p.sq}@${p.origin[0].toFixed(5)},${p.origin[1].toFixed(5)}`;
}

/** Why a pin can't go `to` (null: it can), from where the places file has the place. */
export function moveProblem(p: MorePlace, to: LngLat): string | null {
  const [lon, lat] = to;
  if (!(lon >= AREA.w && lon <= AREA.e && lat >= AREA.s && lat <= AREA.n)) return "That's off the map.";
  if (distance(p.at, to) < MIN_MOVE_M) return "Drag the pin, or tap where it really is.";
  if (distance(p.origin, to) > MAX_MOVE_M) return "That's over 3 km from where we had it: is it the same place?";
  return null;
}

/** The places as riders have fixed them: each move puts the place of its name nearest where the
 *  places file had it (within 500 m) at the move's spot; the newest move of a place wins. Works
 *  from the file's spots, so applying the moves again changes nothing. */
export function withFixes(more: MorePlaces, fixes: ApiPlaceFix[]): MorePlaces {
  const byName = new Map<string, number[]>();
  more.list.forEach((p, i) => {
    const same = byName.get(p.sq);
    if (same) same.push(i);
    else byName.set(p.sq, [i]);
  });
  const moved = new Map<number, ApiPlaceFix>();
  for (const f of fixes) {
    const from: LngLat = [f.from_lon, f.from_lat];
    let best = -1;
    let bestM = FIX_REACH_M;
    for (const i of byName.get(squash(f.name)) ?? []) {
      const m = distance(from, more.list[i].origin);
      if (m <= bestM) [best, bestM] = [i, m];
    }
    if (best >= 0 && (moved.get(best)?.version ?? -1) < f.version) moved.set(best, f);
  }
  if (!moved.size && !more.list.some((p) => p.fixed)) return more;
  const list = more.list.map((p, i): MorePlace => {
    const f = moved.get(i);
    if (f) return { ...p, at: [f.lon, f.lat], fixed: true };
    return p.fixed ? { ...p, at: p.origin, fixed: false } : p;
  });
  return { ...more, list, geojson: drawable(list) };
}

let loading: Promise<MorePlaces | null> | null = null;

/** The places file, once per page; null while offline before it was ever cached. */
export function loadMorePlaces(): Promise<MorePlaces | null> {
  loading ??= fetch(`/network/places.json?v=${process.env.NEXT_PUBLIC_PLACES_VERSION ?? ""}`)
    .then((r) => (r.ok ? (r.json() as Promise<Raw>) : null))
    .then((raw) => (raw ? parseMorePlaces(raw) : null))
    .catch(() => null)
    .then((v) => {
      if (!v) loading = null; // try again next time
      return v;
    });
  return loading;
}

/** Where it is, the way map apps write it: "University Farm Rd, Nmai Dzorm", or what it is and
 *  where when there's no street: "Pharmacy · Osu". `withKind` puts what it is first either way
 *  (the place's card: "Utility · University Farm Rd, Nmai Dzorm"). */
export function detailOf(p: MorePlace, withKind = false): string {
  // The town after the street, unless the "street" is the town itself ("Kasoa", not "Kasoa, Kasoa").
  const where = p.street
    ? [p.street, p.town].filter((x, i, all) => x && all.findIndex((y) => fold(y ?? "") === fold(x)) === i).join(", ")
    : null;
  if (where) return withKind ? `${p.kind} · ${where}` : where;
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
