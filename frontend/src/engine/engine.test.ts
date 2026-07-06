import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, plan, planAll, type RouteT, type StationT } from "./engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(
  readFileSync(resolve(__dirname, "../../../seed/accra.json"), "utf-8")
);

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
