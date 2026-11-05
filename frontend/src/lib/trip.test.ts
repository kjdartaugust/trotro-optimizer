import { describe, expect, it } from "vitest";
import type { Itinerary, Leg, Mode } from "@/engine/engine";
import { endParam, optionLabel, options, parseEnd, type End } from "./trip";

function ride(routeId: string, from: string, to: string): Leg {
  return {
    kind: "ride", fromStation: from, toStation: to, fromName: from, toName: to,
    routeId, routeName: routeId, fare: 6, minutes: 10, distanceM: 0, numStops: 3,
  };
}

function trip(mode: Mode, legs: Leg[], minutes: number): Itinerary {
  return { mode, totalFare: 6 * legs.length, totalMinutes: minutes, transfers: legs.length - 1, walkDistanceM: 0, legs };
}

describe("trip options", () => {
  it("shows a trip the modes agree on once, labelled with each of them", () => {
    const direct = [ride("r1", "a", "b")];
    const found = options({
      fastest: trip("fastest", [ride("r2", "a", "c"), ride("r3", "c", "b")], 30),
      cheapest: trip("cheapest", direct, 40),
      fewest: trip("fewest", direct, 40),
    });
    expect(found.map((o) => o.modes)).toEqual([["fastest"], ["cheapest", "fewest"]]);
    expect(optionLabel(found[1].modes)).toBe("Cheapest and fewest changes");
  });

  it("says so when one trip is best on every count", () => {
    const direct = [ride("r1", "a", "b")];
    const found = options({
      fastest: trip("fastest", direct, 20),
      cheapest: trip("cheapest", direct, 20),
      fewest: trip("fewest", direct, 20),
    });
    expect(found).toHaveLength(1);
    expect(optionLabel(found[0].modes)).toBe("Best on every count");
  });

  it("round-trips a trip's end through its link", () => {
    const end: End = { name: "Accra Mall, Spintex", at: [-0.17321, 5.62188], kind: "place" };
    const back = parseEnd(endParam(end))!;
    expect(back.name).toBe("Accra Mall, Spintex");
    expect(back.at).toEqual([-0.17321, 5.62188]);
    expect(parseEnd("not,a,place")).toBeNull();
    expect(parseEnd(null)).toBeNull();
  });
});
