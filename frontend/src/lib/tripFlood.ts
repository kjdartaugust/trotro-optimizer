/**
 * A trip's flood outlook: each ride's own stretch of road, judged by FloodWatch's rule
 * (lib/flood.ts) against its forecast for that ride's line. Walks aren't judged: FloodWatch
 * scores the roads trotros drive.
 */
import type { Itinerary } from "@/engine/engine";
import {
  ground,
  hoursFor,
  judge,
  lineFor,
  riskAlong,
  stretches,
  worse,
  type FeedIndex,
  type FloodStatus,
  type Profile,
  type Tiles,
} from "./flood";
import { ridePath, rideSpan, stopsOf, type Network } from "./network";
import type { LngLat } from "./shapes";

export interface RideFlood {
  status: FloodStatus;
  /** The first hour that gets this bad (the wettest, when clear): when it ends, and its rain in mm. */
  at: number;
  mm: number;
  /** The stretch's worst ground, 0..100, and the stop on the ride nearest to it. */
  risk: number;
  near: string | null;
  /** FloodWatch's id for the line, for a link to it there. */
  line: string;
  /** The parts of the ride's road that flood in that hour, for the map. */
  parts: { status: FloodStatus; coords: LngLat[] }[];
}

export interface TripFlood {
  /** The worst of its rides. */
  status: FloodStatus;
  /** One per leg of the trip: null for a walk, and for a ride that can't be judged. */
  legs: (RideFlood | null)[];
  /** Every ride was judged, on roads FloodWatch has mostly scored: only then does "clear" mean
   *  no flooding is expected, rather than nobody knows. */
  judged: boolean;
}

/**
 * "The trotro to Madina passes a known flood spot near Circle." With `when`, the hour is said
 * too: for a ride whose rain comes at a different hour from the one a notice opens with.
 */
export function rideWords(f: Pick<RideFlood, "risk" | "near">, towards: string | undefined, when: string | null): string {
  const trotro = towards ? `The trotro to ${towards}` : "The trotro";
  const low = ground(f.risk);
  const time = when ? `, ${when}` : "";
  // No low ground on the ride, and still a warning: rain heavy enough to flood any road.
  if (!low) return `${trotro}: rain this heavy floods roads that are usually fine${time}.`;
  return `${trotro} passes ${low}${f.near ? ` near ${f.near}` : ""}${time}.`;
}

// A ride's road is the same until the network or the cells change: work its risk out once.
const kept = new WeakMap<Tiles, WeakMap<Network, Map<string, Profile>>>();

function profileOf(net: Network, tiles: Tiles, routeId: string, [i, j]: [number, number]): Profile {
  let byNet = kept.get(tiles);
  if (!byNet) kept.set(tiles, (byNet = new WeakMap()));
  let rides = byNet.get(net);
  if (!rides) byNet.set(net, (rides = new Map()));
  const key = `${routeId}:${i}:${j}`;
  let p = rides.get(key);
  if (!p) rides.set(key, (p = riskAlong(ridePath(net, routeId, i, j), tiles)));
  return p;
}

/** The stop on the ride nearest a spot: riders know a place by its stop. */
function nearestStop(net: Network, routeId: string, [i, j]: [number, number], at: LngLat | null): string | null {
  if (!at) return null;
  let best: string | null = null, d = Infinity;
  for (const s of stopsOf(net, routeId).slice(i, j + 1)) {
    const m = Math.hypot((s.lon - at[0]) * Math.cos((at[1] * Math.PI) / 180), s.lat - at[1]);
    if (m < d) [best, d] = [s.name, m];
  }
  return best;
}

// Below this share of a ride's road scored, a "clear" is a guess.
const ENOUGH = 0.5;

export function tripFlood(net: Network, it: Itinerary, tiles: Tiles, ix: FeedIndex, now: number): TripFlood {
  let status: FloodStatus = "clear";
  let judged = it.legs.some((l) => l.kind === "ride");
  const legs: (RideFlood | null)[] = [];
  for (const leg of it.legs) {
    if (leg.kind !== "ride") {
      legs.push(null);
      continue;
    }
    const route = net.route.get(leg.routeId ?? "");
    const span = route ? rideSpan(net, route.id, leg.fromStation, leg.toStation, leg.numStops) : null;
    const line = route ? lineFor(ix, route, net.reverse.get(route.id)) : null;
    const profile = route && span ? profileOf(net, tiles, route.id, span) : null;
    const found = profile && line ? judge(profile.worst, hoursFor(ix, line, now, it.totalMinutes)) : null;
    if (!route || !span || !line || !profile || !found) {
      judged = false;
      legs.push(null);
      continue;
    }
    if (profile.covered < ENOUGH) judged = false;
    status = worse(status, found.status);
    const flooding = found.status !== "clear";
    legs.push({
      status: found.status,
      at: found.at,
      mm: found.mm,
      risk: profile.worst,
      near: flooding ? nearestStop(net, route.id, span, profile.at) : null,
      line: line.id,
      parts: flooding ? stretches(profile, found.mm) : [],
    });
  }
  return { status, legs, judged };
}
