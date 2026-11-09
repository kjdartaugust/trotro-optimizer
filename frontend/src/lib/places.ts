/**
 * Place search: any street, market, school, office or neighbourhood, not just trotro stops. Photon
 * (photon.komoot.io) is OpenStreetMap data with search-as-you-type, free and key-free. Online only:
 * stops are searched offline (lib/search.ts).
 *
 * Results are kept to the area the trotro network covers (a place in Ho can't be reached by an
 * Accra trotro), and ranked the way a map app does: places whose name matches what was typed
 * first, then the nearest to the rider, or to where the map is looking when we don't know where
 * the rider is.
 */
import { fold, squash } from "./search";
import { metres as distance, type LngLat } from "./shapes";

export interface Place {
  name: string;
  /** Street and area, e.g. "University Farm Road, Nmai Dzorm". Empty when unknown. */
  detail: string;
  at: LngLat;
}

/** [west, south, east, north]. */
export type Bounds = [number, number, number, number];

export interface Nearby {
  /** Rank by distance from here: where the rider is, or else where the map is looking. */
  near: LngLat;
  /** Only places in here: the network's area. Null: anywhere in Ghana. */
  area: Bounds | null;
}

const PHOTON = "https://photon.komoot.io";
const GHANA: Bounds = [-3.3, 4.5, 1.3, 11.2];
export const SHOWN = 6;

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

export function toPlace(f: PhotonFeature): Place {
  const p = f.properties;
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || "Unnamed place";
  const area = p.district ?? p.locality ?? p.city ?? p.county ?? p.state;
  // The street helps tell two places of the same name apart, unless it's the place's own name.
  const street = p.street && fold(p.street) !== fold(name) ? p.street : undefined;
  return {
    name,
    detail: [street, area].filter((x, i, all) => x && all.indexOf(x) === i).join(", "),
    at: f.geometry.coordinates,
  };
}

/** 0: every word typed starts a word of the name (or the name holds it, spaces and doubled letters
 *  aside: "Zoom lion", "Trassaco"); 1: some word does; 2: matched on its address only. */
export function nameMatch(name: string, q: string): number {
  const words = fold(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const own = fold(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const starts = (w: string) => own.some((o) => o.startsWith(w));
  if (words.length && words.every(starts)) return 0;
  const sq = squash(q);
  if (sq.length >= 3 && squash(name).includes(sq)) return 0;
  if (words.some(starts)) return 1;
  return 2;
}

// Two results with the same name closer than this are one place: "Accra Mall", its car park and
// its bus stop are one place to a person.
const SAME_PLACE_M = 300;

/** Best match first; among equals, the nearest. The same name in the same spot appears once. */
export function rankPlaces(found: Place[], q: string, near: LngLat): Place[] {
  const kept: Place[] = [];
  for (const p of found) {
    const name = fold(p.name);
    if (!kept.some((k) => fold(k.name) === name && distance(k.at, p.at) < SAME_PLACE_M)) kept.push(p);
  }
  return kept
    .map((p, i) => ({ p, i, tier: nameMatch(p.name, q), m: distance(near, p.at) }))
    .sort((a, b) => a.tier - b.tier || a.m - b.m || a.i - b.i)
    .map(({ p }) => p);
}

async function photon(q: string, { near, area }: Nearby, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({
    q,
    limit: "15",
    lang: "en",
    lat: near[1].toFixed(4),
    lon: near[0].toFixed(4),
    bbox: (area ?? GHANA).map((v) => v.toFixed(3)).join(","),
  });
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`place search answered ${res.status}`);
  const { features } = (await res.json()) as { features: PhotonFeature[] };
  return features.map(toPlace);
}

/** Places matching `q`, best first. */
export async function searchPlaces(q: string, nearby: Nearby, signal?: AbortSignal): Promise<Place[]> {
  let found = await photon(q, nearby, signal);
  // "Zoom lion" for "Zoomlion": names are spelt with and without spaces.
  const joined = q.replace(/[\s\-']+/g, "");
  if (!found.length && joined !== q && joined.length >= 3) found = await photon(joined, nearby, signal);
  return rankPlaces(found, q, nearby.near).slice(0, SHOWN);
}

/** A name for a spot someone tapped ("Near Kotobabi Market"), or null when there's none. */
export async function nameOf(at: LngLat): Promise<string | null> {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${at[0]}&lat=${at[1]}&lang=en`);
    if (!res.ok) return null;
    const { features } = (await res.json()) as { features: PhotonFeature[] };
    return features[0] ? `Near ${toPlace(features[0]).name}` : null;
  } catch {
    return null;
  }
}
