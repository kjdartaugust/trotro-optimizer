import { describe, expect, it } from "vitest";
import { buildNetwork } from "./network";
import { nameMatch, rankPlaces, toPlace, type Place } from "./places";
import { findStops, squash } from "./search";
import type { LngLat } from "./shapes";

// Three real Zoomlions in Accra (OpenStreetMap, via Photon), as a rider searching "Zoomlion" sees them.
const teshie: Place = { name: "Zoomlion", detail: "Malik-Aloway Link, Teshie Nungua Estates", at: [-0.1152, 5.61308] };
const hq: Place = { name: "Zoomlion Ghana Limited Headquarters", detail: "Adjetey Adjei Sueley Street, Nmai Dzorm", at: [-0.11336, 5.67195] };
const busStop: Place = { name: "Zoomlion Bus Stop", detail: "University Farm Road, Nmai Dzorm", at: [-0.11344, 5.67352] };

describe("place search, ranked like a map app", () => {
  it("puts the nearest first among equally good matches", () => {
    const onUniversityFarmRoad: LngLat = [-0.1135, 5.674];
    const got = rankPlaces([teshie, hq, busStop], "Zoomlion", onUniversityFarmRoad);
    expect(got.map((p) => p.name)).toEqual(["Zoomlion Bus Stop", "Zoomlion Ghana Limited Headquarters", "Zoomlion"]);
  });

  it("ranks from wherever the rider (or the map) is, not from one fixed spot", () => {
    const nearTeshie: LngLat = [-0.11, 5.61];
    expect(rankPlaces([hq, busStop, teshie], "Zoomlion", nearTeshie)[0].name).toBe("Zoomlion");
  });

  it("keeps a better name match above a nearer weaker one", () => {
    const market: Place = { name: "Market Street", detail: "Madina", at: [-0.1700, 5.6800] };
    const madinaMarket: Place = { name: "Madina Market", detail: "Madina", at: [-0.1650, 5.6820] };
    const got = rankPlaces([market, madinaMarket], "Madina Market", [-0.17, 5.68]);
    expect(got[0].name).toBe("Madina Market");
  });

  it("shows a place once, not once per car park and bus stop", () => {
    const mall: Place = { name: "Accra Mall", detail: "Tetteh Quarshie", at: [-0.17431, 5.62249] };
    const again: Place = { ...mall, at: [-0.17402, 5.62251] };
    expect(rankPlaces([mall, again], "Accra Mall", [-0.2, 5.6])).toHaveLength(1);
  });
});

describe("matching what riders type", () => {
  it("doesn't mind spaces, hyphens or doubled letters", () => {
    expect(nameMatch("Zoomlion Ghana Limited", "Zoom lion")).toBe(0);
    expect(nameMatch("Trasacco Valley", "Trassaco")).toBe(0);
    expect(nameMatch("Korle-Bu Teaching Hospital", "korle bu")).toBe(0);
    expect(squash("Zoom lion")).toBe(squash("Zoomlion"));
  });

  it("ranks address-only matches last", () => {
    expect(nameMatch("Madina Market", "Madina Market")).toBe(0);
    expect(nameMatch("Market Street", "Madina Market")).toBe(1);
    expect(nameMatch("First National Bank", "Achimota Mall")).toBe(2);
  });

  it("finds a stop spelt another way, offline", () => {
    const net = buildNetwork(
      [{ id: "t", name: "Trasacco", town: "East Legon", lat: 5.645, lon: -0.1177, verified: false, confidence: 0.6, version: 1 }],
      [],
      new Map()
    );
    expect(findStops(net, "Trassaco").map((s) => s.name)).toEqual(["Trasacco"]);
    expect(findStops(net, "xyz")).toEqual([]);
  });
});

describe("what a place says under its name", () => {
  it("gives the street and the area", () => {
    const p = toPlace({
      geometry: { coordinates: [-0.11344, 5.67352] },
      properties: { name: "Zoomlion Bus Stop", street: "University Farm Road", district: "Nmai Dzorm" },
    });
    expect(p.detail).toBe("University Farm Road, Nmai Dzorm");
  });

  it("leaves the street out when it's the place's own name", () => {
    const p = toPlace({
      geometry: { coordinates: [-0.17, 5.65] },
      properties: { name: "Legon Road", street: "Legon Road", district: "Legon" },
    });
    expect(p.detail).toBe("Legon");
  });
});
