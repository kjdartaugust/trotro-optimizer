import {
  buildGraph,
  planAll,
  type Graph,
  type Itinerary,
  type Mode,
  type RouteT,
  type StationT,
} from "@/engine/engine";
import { allRoutes, allStations } from "./db";
import type { ApiRoute, ApiStation } from "./types";

export function toEngine(stations: ApiStation[], routes: ApiRoute[]): Graph {
  const st: StationT[] = stations.map((s) => ({
    id: s.id, name: s.name, lat: s.lat, lon: s.lon, town: s.town,
  }));
  const rt: RouteT[] = routes.map((r) => ({
    id: r.id, name: r.name, color: r.color,
    stops: r.stops.map((s) => ({
      station_id: s.station_id, seq: s.seq,
      fare_from_prev: Number(s.fare_from_prev), minutes_from_prev: Number(s.minutes_from_prev),
    })),
  }));
  return buildGraph(st, rt);
}

/** Build the graph from the offline IndexedDB dataset and plan all three modes. */
export async function planOffline(
  origin: [number, number],
  dest: [number, number]
): Promise<{ graph: Graph; itineraries: Partial<Record<Mode, Itinerary>> }> {
  const [stations, routes] = await Promise.all([allStations(), allRoutes()]);
  const graph = toEngine(stations, routes);
  return { graph, itineraries: planAll(graph, origin, dest) };
}

export type { Itinerary, Mode };
