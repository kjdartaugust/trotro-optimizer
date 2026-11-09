import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, plan, planAll, type Itinerary, type RouteT, type StationT } from "./engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(__dirname, "../../../backend");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(BACKEND, path), "utf-8"));

// The 17-station demo network: small enough to reason about by hand.
const seed = readJson("seed/demo.json");

function accraGraph() {
  const stations: StationT[] = seed.stations.map((s: any) => ({
    id: s.slug, name: s.name, lat: s.lat, lon: s.lon, town: s.town,
  }));
  const routes: RouteT[] = seed.routes.map((r: any, i: number) => ({
    id: `r${i}`, name: r.name,
    stops: r.stops.map((st: any, j: number) => ({
      station_id: st.slug, seq: j, fare_from_prev: st.fare ?? 0, minutes_from_prev: st.min ?? 0,
    })),
  }));
  const byId = Object.fromEntries(seed.stations.map((s: any) => [s.slug, s]));
  return { g: buildGraph(stations, routes), S: byId };
}

describe("offline routing engine", () => {
  it("plans a direct single-leg route", () => {
    const { g, S } = accraGraph();
    const it = plan(g, [S.circle.lat, S.circle.lon], [S.kaneshie.lat, S.kaneshie.lon], "cheapest");
    expect(it).not.toBeNull();
    const rides = it!.legs.filter((l) => l.kind === "ride");
    expect(rides.length).toBe(1);
    expect(it!.transfers).toBe(0);
    expect(it!.totalFare).toBeGreaterThan(0);
  });

  it("plans a multi-leg trip requiring a transfer (Circle -> Adenta)", () => {
    const { g, S } = accraGraph();
    const it = plan(g, [S.circle.lat, S.circle.lon], [S.adenta.lat, S.adenta.lon], "fastest");
    expect(it).not.toBeNull();
    const rides = it!.legs.filter((l) => l.kind === "ride");
    expect(rides.length).toBeGreaterThanOrEqual(2);
    expect(it!.transfers).toBeGreaterThanOrEqual(1);
  });

  it("cheapest fare never exceeds fastest fare", () => {
    const { g, S } = accraGraph();
    const res = planAll(g, [S.circle.lat, S.circle.lon], [S.madina.lat, S.madina.lon]);
    expect(Object.keys(res).sort()).toEqual(["cheapest", "fastest", "fewest"]);
    expect(res.cheapest!.totalFare).toBeLessThanOrEqual(res.fastest!.totalFare + 1e-6);
  });

  it("returns null when origin is nowhere near a station", () => {
    const { g, S } = accraGraph();
    const it = plan(g, [4.0, -2.0], [S.circle.lat, S.circle.lon], "fastest");
    expect(it).toBeNull();
  });
});

describe("boarding fare and walking", () => {
  // Five stops 500 m apart in a line, one route through them: board fare 5, then 1 per segment.
  const lat = (k: number) => 5.6 + k * 0.0045;
  const ids = ["a", "b", "c", "d", "e"];
  const stations: StationT[] = ids.map((id, k) => ({ id, name: id.toUpperCase(), lat: lat(k), lon: -0.2 }));
  const routes: RouteT[] = [{
    id: "r", name: "A → E", board_fare: 5,
    stops: ids.map((id, k) => ({
      station_id: id, seq: k, fare_from_prev: k ? 1 : 0, minutes_from_prev: k ? 2 : 0,
    })),
  }];
  const g = buildGraph(stations, routes);
  const A: [number, number] = [lat(0), -0.2];
  const E: [number, number] = [lat(4), -0.2];

  it("is paid once per boarding, on top of the segments ridden", () => {
    const fast = plan(g, A, E, "fastest")!;
    const rides = fast.legs.filter((l) => l.kind === "ride");
    expect(rides.map((l) => [l.fromStation, l.toStation, l.fare])).toEqual([["a", "e", 9]]);
    expect(fast.totalFare).toBe(9);
  });

  it("walks further to the nearest stop when none is within 900 m, up to 3 km", () => {
    const start: [number, number] = [5.6 - 0.0135, -0.2]; // ~1.5 km south of stop A
    const it = plan(g, start, E, "fastest")!;
    expect(it).not.toBeNull();
    expect(it.legs[0]).toMatchObject({ kind: "walk", toStation: "a" });
    expect(it.legs[0].distanceM).toBeGreaterThan(1400);
    expect(it.legs[0].distanceM).toBeLessThan(1600);
    expect(plan(g, [5.6 - 0.04, -0.2], E, "fastest")).toBeNull(); // ~4.4 km away: too far
  });

  it("walks to a trotro, never stop to stop: cheapest rides b -> d rather than walking 2 km", () => {
    const cheap = plan(g, A, E, "cheapest")!;
    expect(cheap.legs.map((l) => l.kind)).toEqual(["walk", "ride", "walk"]);
    expect(cheap.legs.find((l) => l.kind === "ride")).toMatchObject({ fromStation: "b", toStation: "d" });
    expect(cheap.totalFare).toBe(7);
  });
});

describe("parity with the Python engine on the real network", () => {
  // backend/tests/fixtures/parity.json: the Python engine's answers (python -m tests.parity).
  const bundle = readJson("seed/accra.json");
  const fixture = readJson("tests/fixtures/parity.json");
  const g = buildGraph(
    bundle.stations.map((s: any) => ({ id: s.slug, name: s.name, lat: s.lat, lon: s.lon, town: s.town })),
    bundle.routes.map((r: any) => ({
      id: r.key, name: r.name, color: r.color, board_fare: r.board_fare ?? 0,
      stops: r.stops.map((st: any, i: number) => ({
        station_id: st.slug, seq: i, fare_from_prev: st.fare, minutes_from_prev: st.min,
      })),
    }))
  );
  const summary = (it: Itinerary) => ({
    fare: it.totalFare,
    minutes: it.totalMinutes,
    transfers: it.transfers,
    walk_m: it.walkDistanceM,
    legs: it.legs.map((l) => [l.kind, l.fromStation, l.toStation, l.routeId, l.numStops]),
  });

  it("was made from this network", () => {
    expect(fixture.osm_base).toBe(bundle.meta.osm_base);
  });

  it("gives the same trips as the Python engine", () => {
    for (const trip of fixture.trips) {
      const got = planAll(g, trip.from, trip.to);
      expect(Object.keys(got).sort()).toEqual(Object.keys(trip.plans).sort());
      for (const [mode, want] of Object.entries<any>(trip.plans)) {
        const have = summary(got[mode as keyof typeof got]!);
        expect(have.legs, `${JSON.stringify(trip.from)} -> ${JSON.stringify(trip.to)} ${mode}`)
          .toEqual(want.legs);
        expect(have.fare).toBeCloseTo(want.fare, 2);
        expect(Math.abs(have.minutes - want.minutes)).toBeLessThanOrEqual(0.06);
        expect(have.transfers).toBe(want.transfers);
        expect(Math.abs(have.walk_m - want.walk_m)).toBeLessThanOrEqual(1);
      }
    }
  }, 60_000);
});
