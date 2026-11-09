/**
 * The network as the screens show it: the lookups the map and the cards need, built once per
 * sync from the offline tables. Routing doesn't use this; the engine builds its own graph.
 */
import { cut, matchStops, type LngLat, type OnLine } from "./shapes";
import type { ApiRoute, ApiStation } from "./types";

export interface Network {
  stations: ApiStation[];
  station: Map<string, ApiStation>;
  routes: ApiRoute[];
  route: Map<string, ApiRoute>;
  /** The routes that stop at each station. */
  servedBy: Map<string, string[]>;
  /** The same line the other way, where that's mapped. */
  reverse: Map<string, string>;
  /** The stations the most routes stop at, busiest first, one per name. */
  busiest: ApiStation[];
  /** Each route's line along its roads (most routes have one). */
  shapes: Map<string, LngLat[]>;
  placed: Map<string, OnLine[]>;
  /** The area the stops cover and ~10 km around: [west, south, east, north]. Place search keeps
   *  to it, since a place outside can't be reached by trotro. */
  area: [number, number, number, number] | null;
}

/** About 10 km of latitude or longitude, near the equator. */
const MARGIN = 0.09;

function areaOf(stations: ApiStation[]): Network["area"] {
  if (!stations.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const st of stations) {
    w = Math.min(w, st.lon);
    e = Math.max(e, st.lon);
    s = Math.min(s, st.lat);
    n = Math.max(n, st.lat);
  }
  return [w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN];
}

/** "Shalom → Kaneshie" → ["Shalom", "Kaneshie"]. */
export function termini(name: string): [string, string] | null {
  const parts = name.split("→").map((p) => p.trim());
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

export function buildNetwork(
  stations: ApiStation[],
  routes: ApiRoute[],
  shapes: Map<string, LngLat[]>
): Network {
  const station = new Map(stations.map((s) => [s.id, s]));
  const sorted = routes
    .map((r) => ({ ...r, stops: [...r.stops].sort((a, b) => a.seq - b.seq) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const servedBy = new Map<string, string[]>();
  const byEnds = new Map<string, string[]>();
  for (const r of sorted) {
    for (const sid of new Set(r.stops.map((s) => s.station_id))) {
      const list = servedBy.get(sid);
      if (list) list.push(r.id);
      else servedBy.set(sid, [r.id]);
    }
    const ends = termini(r.name);
    if (ends) {
      const key = ends.join("|").toLowerCase();
      byEnds.set(key, [...(byEnds.get(key) ?? []), r.id]);
    }
  }
  const reverse = new Map<string, string>();
  for (const r of sorted) {
    const ends = termini(r.name);
    const back = ends && byEnds.get(`${ends[1]}|${ends[0]}`.toLowerCase());
    if (back?.length) reverse.set(r.id, back[0]);
  }
  const seen = new Set<string>();
  const busiest = [...servedBy.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([sid]) => station.get(sid))
    .filter((s): s is ApiStation => {
      if (!s || seen.has(s.name.toLowerCase())) return false;
      seen.add(s.name.toLowerCase());
      return true;
    })
    .slice(0, 8);
  return {
    stations,
    station,
    routes: sorted,
    route: new Map(sorted.map((r) => [r.id, r])),
    servedBy,
    reverse,
    busiest,
    shapes,
    placed: new Map(),
    area: areaOf(stations),
  };
}

const lngLat = (s: ApiStation): LngLat => [s.lon, s.lat];

/** A route's stops in order, as stations. */
export function stopsOf(n: Network, routeId: string): ApiStation[] {
  return (n.route.get(routeId)?.stops ?? []).flatMap((s) => n.station.get(s.station_id) ?? []);
}

/** A route's line on the map: along its roads, or stop to stop. */
export function routeLine(n: Network, routeId: string): LngLat[] {
  return n.shapes.get(routeId) ?? stopsOf(n, routeId).map(lngLat);
}

/** Where a ride gets on and off, as indexes into its route's stops. */
export function rideSpan(
  n: Network,
  routeId: string,
  from: string | null,
  to: string | null,
  numStops: number
): [number, number] | null {
  const stops = n.route.get(routeId)?.stops ?? [];
  for (let i = 0; i + numStops < stops.length; i++) {
    if (stops[i].station_id === from && stops[i + numStops].station_id === to) return [i, i + numStops];
  }
  return null;
}

/** The stretch of road a ride covers, from stop index i to j of its route. */
export function ridePath(n: Network, routeId: string, i: number, j: number): LngLat[] {
  const stops = stopsOf(n, routeId);
  const line = n.shapes.get(routeId);
  if (!line || line.length < 2 || stops.length !== n.route.get(routeId)?.stops.length) {
    return stops.slice(i, j + 1).map(lngLat);
  }
  let placed = n.placed.get(routeId);
  if (!placed) {
    placed = matchStops(line, stops.map(lngLat));
    n.placed.set(routeId, placed);
  }
  return cut(line, placed[i], placed[j]);
}

/** The stations within `within` metres of a point, nearest first. */
export function nearestStations(n: Network, at: LngLat, within: number, limit = 1) {
  const out: { s: ApiStation; m: number }[] = [];
  const cos = Math.cos((at[1] * Math.PI) / 180);
  for (const s of n.stations) {
    const dx = (s.lon - at[0]) * cos * 111_320;
    const dy = (s.lat - at[1]) * 110_574;
    const m = Math.hypot(dx, dy);
    if (m <= within) out.push({ s, m });
  }
  return out.sort((a, b) => a.m - b.m).slice(0, limit);
}
