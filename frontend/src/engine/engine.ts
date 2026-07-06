/**
 * Offline trotro routing engine — TypeScript port of backend/app/routing/engine.py.
 *
 * MUST stay behaviourally identical to the Python engine: same graph model (hub + board nodes),
 * same edge kinds (walk/board/alight/ride), and the same lexicographic Dijkstra over the cost
 * vector (transfers, fare, minutes) reordered per mode. See engine.test.ts for parity checks.
 */

export type Mode = "fastest" | "cheapest" | "fewest";

export interface EngineOpts {
  walkRadiusM: number;
  walkSpeedMps: number;
  boardPenaltyMin: number;
  transferPenaltyMin: number;
}

export const DEFAULT_OPTS: EngineOpts = {
  walkRadiusM: 900,
  walkSpeedMps: 1.25,
  boardPenaltyMin: 4,
  transferPenaltyMin: 3,
};

export interface StationT {
  id: string;
  name: string;
  lat: number;
  lon: number;
  town?: string | null;
}

export interface RouteStopT {
  station_id: string;
  seq: number;
  fare_from_prev: number;
  minutes_from_prev: number;
}

export interface RouteT {
  id: string;
  name: string;
  color?: string | null;
  stops: RouteStopT[];
}

interface Edge {
  to: string;
  minutes: number;
  fare: number;
  transfers: number;
  kind: "walk" | "board" | "alight" | "ride";
  routeId?: string;
  fromStation?: string;
  toStation?: string;
  distanceM: number;
}

export interface Leg {
  kind: "walk" | "ride";
  fromStation: string | null;
  toStation: string | null;
  fromName: string | null;
  toName: string | null;
  routeId: string | null;
  routeName: string | null;
  fare: number;
  minutes: number;
  distanceM: number;
  numStops: number;
}

export interface Itinerary {
  mode: Mode;
  totalFare: number;
  totalMinutes: number;
  transfers: number;
  walkDistanceM: number;
  legs: Leg[];
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlmb = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export interface Graph {
  stations: Map<string, StationT>;
  routes: Map<string, RouteT>;
  adj: Map<string, Edge[]>;
  opts: EngineOpts;
}

export function buildGraph(
  stations: StationT[],
  routes: RouteT[],
  opts: Partial<EngineOpts> = {}
): Graph {
  const o = { ...DEFAULT_OPTS, ...opts };
  const g: Graph = {
    stations: new Map(stations.map((s) => [s.id, s])),
    routes: new Map(routes.map((r) => [r.id, r])),
    adj: new Map(),
    opts: o,
  };
  const push = (from: string, e: Edge) => {
    const arr = g.adj.get(from);
    if (arr) arr.push(e);
    else g.adj.set(from, [e]);
  };
  const hub = (sid: string) => `hub:${sid}`;
  const bnode = (rid: string, seq: number) => `rs:${rid}:${seq}`;

  for (const r of routes) {
    const stops = [...r.stops].sort((a, b) => a.seq - b.seq);
    stops.forEach((st, i) => {
      const b = bnode(r.id, st.seq);
      const h = hub(st.station_id);
      push(h, {
        to: b, minutes: o.boardPenaltyMin, fare: 0, transfers: 1, kind: "board",
        routeId: r.id, fromStation: st.station_id, toStation: st.station_id, distanceM: 0,
      });
      push(b, {
        to: h, minutes: 0, fare: 0, transfers: 0, kind: "alight",
        routeId: r.id, fromStation: st.station_id, toStation: st.station_id, distanceM: 0,
      });
      if (i + 1 < stops.length) {
        const nxt = stops[i + 1];
        push(b, {
          to: bnode(r.id, nxt.seq),
          minutes: Math.max(nxt.minutes_from_prev, 0),
          fare: Math.max(nxt.fare_from_prev, 0),
          transfers: 0, kind: "ride", routeId: r.id,
          fromStation: st.station_id, toStation: nxt.station_id, distanceM: 0,
        });
      }
    });
  }

  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i], b = stations[j];
      const d = haversineM(a.lat, a.lon, b.lat, b.lon);
      if (d <= o.walkRadiusM) {
        const mins = d / o.walkSpeedMps / 60;
        for (const [x, y] of [[a, b], [b, a]] as const) {
          push(hub(x.id), {
            to: hub(y.id), minutes: mins, fare: 0, transfers: 0, kind: "walk",
            fromStation: x.id, toStation: y.id, distanceM: d,
          });
        }
      }
    }
  }
  return g;
}

type Vec = [number, number, number]; // (transfers, fare, minutes)

function orderKey(mode: Mode, tr: number, fare: number, mins: number): Vec {
  const f = Math.round(fare * 100) / 100;
  if (mode === "cheapest") return [f, mins, tr];
  if (mode === "fewest") return [tr, mins, f];
  return [mins, f, tr];
}

function keyLess(a: Vec, b: Vec): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

function nearestHubs(g: Graph, lat: number, lon: number): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const s of g.stations.values()) {
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d <= g.opts.walkRadiusM) out.push([s.id, d, d / g.opts.walkSpeedMps / 60]);
  }
  out.sort((a, b) => a[1] - b[1]);
  return out.slice(0, 8);
}

/** Minimal binary heap keyed by an ordering vector. */
class Heap {
  private a: { key: Vec; node: string; vec: Vec }[] = [];
  push(item: { key: Vec; node: string; vec: Vec }) {
    this.a.push(item);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keyLess(this.a[i].key, this.a[p].key)) {
        [this.a[i], this.a[p]] = [this.a[p], this.a[i]];
        i = p;
      } else break;
    }
  }
  pop() {
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let m = i;
        if (l < n && keyLess(this.a[l].key, this.a[m].key)) m = l;
        if (r < n && keyLess(this.a[r].key, this.a[m].key)) m = r;
        if (m === i) break;
        [this.a[i], this.a[m]] = [this.a[m], this.a[i]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

export function plan(
  g: Graph,
  origin: [number, number],
  dest: [number, number],
  mode: Mode = "fastest"
): Itinerary | null {
  const [olat, olon] = origin;
  const [dlat, dlon] = dest;

  const originEdges: Edge[] = nearestHubs(g, olat, olon).map(([sid, d, mins]) => ({
    to: `hub:${sid}`, minutes: mins, fare: 0, transfers: 0, kind: "walk",
    toStation: sid, distanceM: d,
  }));
  const destHubs = new Map<string, [number, number]>(
    nearestHubs(g, dlat, dlon).map(([sid, d, mins]) => [`hub:${sid}`, [d, mins]])
  );
  if (!originEdges.length || destHubs.size === 0) return null;

  const START = "ORIGIN", DEST = "DEST";
  const best = new Map<string, Vec>([[START, [0, 0, 0]]]);
  const prev = new Map<string, { from: string; edge: Edge }>();
  const heap = new Heap();
  heap.push({ key: orderKey(mode, 0, 0, 0), node: START, vec: [0, 0, 0] });

  const neighbours = (node: string): Edge[] =>
    node === START ? originEdges : g.adj.get(node) ?? [];

  while (heap.size) {
    const { node, vec } = heap.pop();
    const [tr, fare, mins] = vec;
    const cur = best.get(node);
    if (cur && keyLess(orderKey(mode, cur[0], cur[1], cur[2]), orderKey(mode, tr, fare, mins)))
      continue;

    let edges = neighbours(node);
    const dh = destHubs.get(node);
    if (dh) {
      edges = edges.concat([
        { to: DEST, minutes: dh[1], fare: 0, transfers: 0, kind: "walk", distanceM: dh[0] },
      ]);
    }
    for (const e of edges) {
      const cand: Vec = [tr + e.transfers, fare + e.fare, mins + e.minutes];
      const nkey = orderKey(mode, cand[0], cand[1], cand[2]);
      const b = best.get(e.to);
      if (!b || keyLess(nkey, orderKey(mode, b[0], b[1], b[2]))) {
        best.set(e.to, cand);
        prev.set(e.to, { from: node, edge: e });
        heap.push({ key: nkey, node: e.to, vec: cand });
      }
    }
  }

  if (!prev.has(DEST)) return null;

  const path: Edge[] = [];
  let node = DEST;
  while (node !== START) {
    const p = prev.get(node)!;
    path.push(p.edge);
    node = p.from;
  }
  path.reverse();
  return buildItinerary(g, mode, path);
}

function buildItinerary(g: Graph, mode: Mode, path: Edge[]): Itinerary {
  const legs: Leg[] = [];
  let totalFare = 0, totalMin = 0, walkDist = 0, transfers = 0;
  const sname = (sid?: string | null) => (sid && g.stations.get(sid)?.name) || null;

  let i = 0;
  while (i < path.length) {
    const e = path[i];
    if (e.kind === "walk") {
      totalMin += e.minutes;
      walkDist += e.distanceM;
      legs.push({
        kind: "walk", fromStation: e.fromStation ?? null, toStation: e.toStation ?? null,
        fromName: sname(e.fromStation), toName: sname(e.toStation),
        routeId: null, routeName: null, fare: 0, minutes: e.minutes,
        distanceM: e.distanceM, numStops: 0,
      });
      i++;
    } else if (e.kind === "board") {
      transfers++;
      const rid = e.routeId!;
      const boardStation = e.fromStation ?? null;
      let fare = 0, mins = e.minutes, lastStation = boardStation, stops = 0;
      let j = i + 1;
      while (j < path.length && path[j].kind === "ride" && path[j].routeId === rid) {
        fare += path[j].fare;
        mins += path[j].minutes;
        lastStation = path[j].toStation ?? lastStation;
        stops++;
        j++;
      }
      totalFare += fare;
      totalMin += mins;
      legs.push({
        kind: "ride", fromStation: boardStation, toStation: lastStation ?? null,
        fromName: sname(boardStation), toName: sname(lastStation),
        routeId: rid, routeName: g.routes.get(rid)?.name ?? null,
        fare: Math.round(fare * 100) / 100, minutes: mins, distanceM: 0, numStops: stops,
      });
      if (j < path.length && path[j].kind === "alight") j++;
      i = j;
    } else {
      i++;
    }
  }

  return {
    mode,
    totalFare: Math.round(totalFare * 100) / 100,
    totalMinutes: Math.round(totalMin * 10) / 10,
    transfers: Math.max(transfers - 1, 0),
    walkDistanceM: Math.round(walkDist),
    legs,
  };
}

export function planAll(
  g: Graph,
  origin: [number, number],
  dest: [number, number]
): Partial<Record<Mode, Itinerary>> {
  const out: Partial<Record<Mode, Itinerary>> = {};
  for (const mode of ["fastest", "cheapest", "fewest"] as Mode[]) {
    const it = plan(g, origin, dest, mode);
    if (it) out[mode] = it;
  }
  return out;
}
