import {
  buildGraph,
  planAll,
  type Graph,
  type Itinerary,
  type Mode,
  type RouteT,
  type StationT,
} from "@/engine/engine";
import { allRoutes, allStations, getGeneration, getVersion } from "./db";
import type { ApiRoute, ApiStation } from "./types";

export function toEngine(stations: ApiStation[], routes: ApiRoute[]): Graph {
  const st: StationT[] = stations.map((s) => ({
    id: s.id, name: s.name, lat: s.lat, lon: s.lon, town: s.town,
  }));
  const rt: RouteT[] = routes.map((r) => ({
    id: r.id, name: r.name, color: r.color, board_fare: Number(r.board_fare ?? 0),
    stops: r.stops.map((s) => ({
      station_id: s.station_id, seq: s.seq,
      fare_from_prev: Number(s.fare_from_prev), minutes_from_prev: Number(s.minutes_from_prev),
    })),
  }));
  return buildGraph(st, rt);
}

// The whole network is ~1,750 stations: build its graph once per dataset version, not per search.
let cached: { key: string; graph: Graph; unconfirmed: Set<string> } | null = null;

async function network() {
  const key = `${await getGeneration()}:${await getVersion()}`;
  if (!cached || cached.key !== key) {
    const [stations, routes] = await Promise.all([allStations(), allRoutes()]);
    cached = {
      key,
      graph: toEngine(stations, routes),
      unconfirmed: new Set(routes.filter((r) => !r.verified).map((r) => r.id)),
    };
  }
  return cached;
}

/** Build the graph ahead of the first search. */
export async function warmUp(): Promise<void> {
  await network();
}

/** Plan all three modes against the offline IndexedDB dataset. `estimated` says whether any ride
 *  uses a route whose fares and times riders haven't confirmed yet. */
export async function planOffline(
  origin: [number, number],
  dest: [number, number]
): Promise<{
  graph: Graph;
  itineraries: Partial<Record<Mode, Itinerary>>;
  estimated: boolean;
}> {
  const { graph, unconfirmed } = await network();
  const itineraries = planAll(graph, origin, dest);
  const estimated = Object.values(itineraries).some((it) =>
    it!.legs.some((l) => l.kind === "ride" && l.routeId !== null && unconfirmed.has(l.routeId))
  );
  return { graph, itineraries, estimated };
}

export type { Itinerary, Mode };
