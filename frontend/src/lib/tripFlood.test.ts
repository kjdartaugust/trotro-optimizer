import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Itinerary, Leg } from "@/engine/engine";
import floodrisk from "@/data/floodrisk.json";
import { indexFeed, indexTiles, lineFor, riskAlong, type FloodFeed, type TileRow } from "./flood";
import { routeIdOf } from "./floodFeed";
import { buildNetwork, ridePath, routeLine } from "./network";
import { decode, type LngLat } from "./shapes";
import { rideWords, tripFlood } from "./tripFlood";
import type { ApiRoute, ApiStation } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(resolve(here, p), "utf-8"));

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 16, 16); // 4 pm in Accra
const HOURS = Array.from({ length: 12 }, (_, i) => new Date(T0 + (i + 1) * H).toISOString());
const NOW = T0 + 20 * 60_000;

// ── A street with four stops, 1.1 km apart, and a line each way ───────────────────────────────

const station = (id: string, lon: number): ApiStation => ({
  id, name: id, town: null, lat: 5.6, lon, verified: true, confidence: 1, version: 1,
});
const STOPS = [station("Abease", -0.2), station("Bawku", -0.19), station("Chorkor", -0.18), station("Dome", -0.17)];
const route = (id: string, name: string, stops: ApiStation[]): ApiRoute => ({
  id, name, operator: null, color: null, verified: true, confidence: 1, version: 1,
  stops: stops.map((s, seq) => ({ station_id: s.id, seq, fare_from_prev: 1, minutes_from_prev: 5 })),
});
const net = buildNetwork(
  STOPS,
  [route("east", "Abease → Dome", STOPS), route("west", "Dome → Abease", [...STOPS].reverse())],
  new Map()
);
const cell = (lon: number, risk: number): TileRow => [5.6, lon, risk];
// Scored from Abease to Chorkor: a low point at Abease, a known flood spot 440 m before Chorkor.
// Nothing east of Chorkor: FloodWatch hasn't scored that ground.
const tiles = indexTiles([cell(-0.2, 35), cell(-0.194, 10), cell(-0.188, 10), cell(-0.184, 70)]);

const ride = (routeId: string, from: string, to: string, numStops: number): Leg => ({
  kind: "ride", fromStation: from, toStation: to, fromName: from, toName: to,
  routeId, routeName: net.route.get(routeId)!.name, fare: 6, minutes: 5 * numStops, distanceM: 1100 * numStops, numStops,
});
const walk: Leg = {
  kind: "walk", fromStation: null, toStation: "Abease", fromName: null, toName: "Abease",
  routeId: null, routeName: null, fare: 0, minutes: 3, distanceM: 200, numStops: 0,
};
const trip = (...legs: Leg[]): Itinerary => ({
  mode: "fastest", totalFare: 6, totalMinutes: legs.reduce((m, l) => m + l.minutes, 0), transfers: 0, walkDistanceM: 0, legs,
});
// FloodWatch keeps one line for both directions and names it after one: here, the westbound.
const feed = (mm: number[], lines = true): FloodFeed => ({
  read: new Date(T0).toISOString(),
  checked: new Date(T0).toISOString(),
  failed: false,
  hours: HOURS,
  lines: lines ? [{ id: "osm-9", route: "west", ends: ["Dome", "Abease"], mm: [...mm, ...HOURS.map(() => 0)].slice(0, 12) }] : [],
});
const judge = (it: Itinerary, mm: number[], lines = true) => tripFlood(net, it, tiles, indexFeed(feed(mm, lines)), NOW);

describe("a trip's flood outlook", () => {
  it("judges each ride on the stretch it covers", () => {
    // 12 mm in the hour ending 6 pm, over the whole line.
    const rain = [0, 12];
    // Abease to Bawku only meets the low point: allow extra time.
    const first = judge(trip(walk, ride("east", "Abease", "Bawku", 1)), rain);
    expect(first.status).toBe("watch");
    expect(first.legs[0]).toBeNull(); // the walk
    expect(first.legs[1]).toMatchObject({ status: "watch", risk: 35, mm: 12, at: T0 + 2 * H, near: "Abease", line: "osm-9" });
    // Bawku to Chorkor meets the flood spot.
    const second = judge(trip(ride("east", "Bawku", "Chorkor", 1)), rain);
    expect(second.legs[0]).toMatchObject({ status: "warning", risk: 70, near: "Chorkor" });
    // The whole line, and the same line the other way: the worst of it.
    expect(judge(trip(ride("east", "Abease", "Dome", 3)), rain).status).toBe("warning");
    expect(judge(trip(ride("west", "Dome", "Abease", 3)), rain).status).toBe("warning");
    // Heavier rain turns the flood spot severe; the low point stays a watch, as FloodWatch has it.
    expect(judge(trip(ride("east", "Bawku", "Chorkor", 1)), [0, 25]).status).toBe("severe");
    expect(judge(trip(ride("east", "Abease", "Bawku", 1)), [0, 25]).status).toBe("watch");
  });

  it("is the worst of its rides", () => {
    const it = trip(walk, ride("east", "Abease", "Bawku", 1), ride("east", "Bawku", "Chorkor", 1));
    const found = judge(it, [0, 25]);
    expect(found.legs.map((l) => l?.status ?? null)).toEqual([null, "watch", "severe"]);
    expect(found.status).toBe("severe");
    expect(found.judged).toBe(true);
  });

  it("marks where on the ride the water is", () => {
    const parts = judge(trip(ride("east", "Abease", "Chorkor", 2)), [0, 12]).legs[0]!.parts;
    // The low point by Abease (watch), then the flood spot before Chorkor (warning): not the dry middle.
    expect(parts.map((p) => p.status)).toEqual(["watch", "warning"]);
    expect(parts[0].coords[0]).toEqual([-0.2, 5.6]);
    expect(parts[0].coords[parts[0].coords.length - 1][0]).toBeLessThan(-0.195);
    expect(parts[1].coords[0][0]).toBeGreaterThan(-0.189);
    // ...which reaches 400 m up the road: to within a piece of Chorkor itself.
    const end = parts[1].coords[parts[1].coords.length - 1][0];
    expect(end).toBeGreaterThan(-0.181);
    expect(end).toBeLessThanOrEqual(-0.18);
  });

  it("says nothing of rain that falls after the trip", () => {
    const later = judge(trip(ride("east", "Bawku", "Chorkor", 1)), [0, 0, 0, 0, 0, 30]);
    expect(later.status).toBe("clear");
    expect(later.judged).toBe(true);
    expect(later.legs[0]).toMatchObject({ status: "clear", near: null, parts: [] });
  });

  it("doesn't call unscored ground clear", () => {
    // Chorkor to Dome runs off the scored area. Dry: clear, but not something to promise.
    const dry = judge(trip(ride("east", "Chorkor", "Dome", 1)), [0, 3]);
    expect(dry.status).toBe("clear");
    expect(dry.judged).toBe(false);
    // Rain heavy enough floods any road, scored or not: that much can be said.
    const flood = judge(trip(ride("east", "Chorkor", "Dome", 1)), [0, 40]);
    expect(flood.status).toBe("warning");
    expect(flood.judged).toBe(false);
  });

  it("can't judge a ride FloodWatch has no forecast for", () => {
    const none = judge(trip(walk, ride("east", "Bawku", "Chorkor", 1)), [0, 40], false);
    expect(none).toEqual({ status: "clear", legs: [null, null], judged: false });
    // ...nor a trip with no ride in it.
    expect(judge(trip(walk), [0, 40]).judged).toBe(false);
  });
});

describe("a ride's flood, in words", () => {
  it("says what the ground is like and the stop it's near", () => {
    expect(rideWords({ risk: 72, near: "Circle" }, "Madina", null)).toBe(
      "The trotro to Madina passes a known flood spot near Circle."
    );
    expect(rideWords({ risk: 50, near: "Shangrila" }, "Ayikuma", "around 6 pm")).toBe(
      "The trotro to Ayikuma passes low ground near Shangrila, around 6 pm."
    );
    expect(rideWords({ risk: 33, near: null }, undefined, null)).toBe("The trotro passes a low point.");
  });

  it("says so when it's the rain alone", () => {
    expect(rideWords({ risk: 12, near: null }, "Dome", null)).toBe(
      "The trotro to Dome: rain this heavy floods roads that are usually fine."
    );
  });
});

// ── Accra's real network, against FloodWatch's own numbers ────────────────────────────────────

describe("on the real network", () => {
  const dataset = json("../../public/network/dataset.json");
  const shapes = new Map<string, LngLat[]>(
    Object.entries(json("../../public/network/shapes.json").routes as Record<string, string>).map(([id, s]) => [id, decode(s)])
  );
  const real = buildNetwork(dataset.stations, dataset.routes, shapes);
  const cells = indexTiles(floodrisk.tiles as TileRow[], floodrisk.within_m);
  // FloodWatch's lines and its own score for each, saved with the cells (backend/app/etl/flood_tiles.py).
  const fw: { id: string; ends: [string, string]; baseline: number }[] = json(
    "../../../backend/tests/fixtures/floodwatch_lines.json"
  ).lines;
  const ix = indexFeed({
    read: null, checked: null, failed: false, hours: [],
    lines: fw.map((l) => ({ id: l.id, route: routeIdOf(l.id), ends: l.ends, mm: [] })),
  });
  const baseline = new Map(fw.map((l) => [l.id, l.baseline]));
  const matched = real.routes.flatMap((r) => {
    const line = lineFor(ix, r, real.reverse.get(r.id));
    return line ? [{ r, line }] : [];
  });

  it("finds FloodWatch's line for nearly every route", () => {
    expect(real.routes.length).toBeGreaterThan(500);
    expect(matched.length / real.routes.length).toBeGreaterThan(0.98);
    // Half by their own OSM id (FloodWatch names a line after its lower-numbered direction).
    expect(real.routes.filter((r) => ix.byRoute.has(r.id)).length / real.routes.length).toBeGreaterThan(0.45);
  });

  it("scores a whole line as FloodWatch scores it", () => {
    // Where the two differ it's the road, not the sum: FloodWatch keeps one direction's road for
    // both, and this app draws each direction's own, cut to its first and last stop.
    let same = 0, off = 0;
    for (const { r, line } of matched) {
      const d = Math.abs(riskAlong(routeLine(real, r.id), cells).worst - baseline.get(line.id)!);
      if (d < 0.05) same++;
      else if (d > 5) off++;
    }
    expect(same / matched.length).toBeGreaterThan(0.8);
    expect(off / matched.length).toBeLessThan(0.12);
  });

  it("tells a ride over high ground from its line's flood spot", () => {
    // Every route's first third and last third, as rides. A stretch can't be worse than its line.
    let rides = 0, lower = 0, spared = 0;
    for (const { r } of matched) {
      const whole = riskAlong(routeLine(real, r.id), cells).worst;
      const n = r.stops.length - 1;
      const third = Math.max(1, Math.floor(n / 3));
      for (const [i, j] of [[0, third], [n - third, n]]) {
        const part = riskAlong(ridePath(real, r.id, i, j), cells).worst;
        expect(part).toBeLessThanOrEqual(whole + 1e-9);
        rides++;
        if (part < whole - 0.05) lower++;
        if (whole >= 60 && part < 45) spared++; // the line is "severe" in a downpour; this ride isn't even a warning
      }
    }
    expect(rides).toBeGreaterThan(1000);
    // That's the point of judging the stretch: most rides are better off than their line as a whole.
    expect(lower / rides).toBeGreaterThan(0.4);
    expect(spared).toBeGreaterThan(50);
  });
});
