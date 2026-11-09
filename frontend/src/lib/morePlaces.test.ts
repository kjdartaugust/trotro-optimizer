import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { morePlaceLayers, osmPlaceLayers, PLACE_LAYERS, placeName, placesBefore } from "./mapPlaces";
import { detailOf, findMorePlaces, parseMorePlaces } from "./morePlaces";
import { rankPlaces, type Place } from "./places";
import type { LngLat } from "./shapes";

// The shape app/etl/overture_places.py writes: [lon, lat, name, kind, tier, town, confidence, on OSM's map].
const raw = {
  source: "Overture Maps Foundation, release 2026-10-21.0, CDLA Permissive 2.0",
  kinds: [["Utility", "office"], ["Pharmacy", "pharmacy"], ["Church", "religious_christian"]] as [string, string][],
  towns: ["Nmai Dzorm", "Osu"],
  places: [
    [-0.11304, 5.67345, "Zoomlion Ghana Limited", 0, 2, 0, 91, 0],
    [-0.18251, 5.5571, "QP Pharmacy Osu", 1, 3, 1, 70, 1],
    [-0.1149, 5.6721, "Zion Chapel", 2, 3, -1, 55, 0],
    [-0.14771, 5.62723, "Zoomlion Logistics", 0, 3, 1, 63, 0],
  ] as [number, number, string, number, number, number, number, number][],
};
const onUniversityFarmRoad: LngLat = [-0.1135, 5.674];

describe("Overture's places on this device", () => {
  const more = parseMorePlaces(raw);

  it("reads each place's kind, town and how sure Overture is", () => {
    const z = more.list[0];
    expect(z).toMatchObject({ name: "Zoomlion Ghana Limited", kind: "Utility", cls: "office", tier: 2, town: "Nmai Dzorm", sure: 91 });
    expect(detailOf(z)).toBe("Utility · Nmai Dzorm");
    expect(detailOf(more.list[2])).toBe("Church");
  });

  it("draws only the places OpenStreetMap's tiles don't already show", () => {
    const names = more.geojson.features.map((f) => f.properties?.name);
    expect(names).toEqual(["Zoomlion Ghana Limited", "Zion Chapel", "Zoomlion Logistics"]);
    // The properties the map's style reads for both sources: class, name, rank, tier.
    expect(more.geojson.features[0].properties).toMatchObject({ i: 0, class: "office", tier: 2, rank: 209 });
  });

  it("finds a place by name, nearest first, with spaces and doubled letters ignored", () => {
    expect(findMorePlaces(more, "Zoomlion", onUniversityFarmRoad).map((p) => p.name)).toEqual([
      "Zoomlion Ghana Limited",
      "Zoomlion Logistics",
    ]);
    expect(findMorePlaces(more, "zoom lion ghana", onUniversityFarmRoad)[0].name).toBe("Zoomlion Ghana Limited");
    expect(findMorePlaces(more, "Zomlion", onUniversityFarmRoad)[0].name).toBe("Zoomlion Ghana Limited");
  });

  it("still finds the places OpenStreetMap shows, for search offline", () => {
    expect(findMorePlaces(more, "QP pharmacy", onUniversityFarmRoad)[0]).toMatchObject({ name: "QP Pharmacy Osu", detail: "Pharmacy · Osu" });
  });

  it("falls back to places matching some of the words only when none matches all", () => {
    expect(findMorePlaces(more, "Zion Temple", onUniversityFarmRoad).map((p) => p.name)).toEqual(["Zion Chapel"]);
    expect(findMorePlaces(more, "x", onUniversityFarmRoad)).toEqual([]);
  });

  it("merges with OpenStreetMap's answers: the same place in the same spot appears once", () => {
    const photon: Place = { name: "Zoomlion Ghana Limited", detail: "University Farm Road, Nmai Dzorm", at: [-0.11336, 5.67195] };
    const got = rankPlaces([...findMorePlaces(more, "Zoomlion", onUniversityFarmRoad), photon], "Zoomlion", onUniversityFarmRoad);
    expect(got.filter((p) => p.name === "Zoomlion Ghana Limited")).toHaveLength(1);
  });
});

describe("the shipped places file", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = JSON.parse(readFileSync(join(here, "../../public/network/places.json"), "utf8"));
  const more = parseMorePlaces(file);

  it("has Accra's businesses, credited to Overture", () => {
    expect(more.list.length).toBeGreaterThan(10_000);
    expect(more.source).toMatch(/^Overture Maps Foundation, release \d{4}-\d{2}-\d{2}/);
  });

  it("has the Zoomlion head office Google shows on University Farm Road", () => {
    const [z] = findMorePlaces(more, "Zoomlion Ghana Limited", onUniversityFarmRoad);
    expect(z.name).toBe("Zoomlion Ghana Limited");
    expect(Math.abs(z.at[0] - -0.113)).toBeLessThan(0.002);
    expect(Math.abs(z.at[1] - 5.673)).toBeLessThan(0.002);
  });

  it("gives every place a kind, a tier the map knows, and a point near Accra", () => {
    const odd = more.list.filter(
      (p) => !p.kind || ![1, 2, 3].includes(p.tier) || p.at[0] < -0.6 || p.at[0] > 0.2 || p.at[1] < 5.4 || p.at[1] > 6.1
    );
    expect(odd).toEqual([]);
  });
});

describe("places on the map", () => {
  it("goes above our lines and under the street names (positron) or town names (dark)", () => {
    const positron = [
      { id: "roads", type: "line" },
      { id: "water_name_point_label", type: "symbol", "source-layer": "water_name" },
      { id: "highway-name-path", type: "symbol", "source-layer": "transportation_name" },
      { id: "label_town", type: "symbol", "source-layer": "place" },
    ];
    expect(placesBefore(positron, 0)).toBe("highway-name-path");
    const dark = [
      { id: "highway_name_other", type: "symbol", "source-layer": "transportation_name" },
      { id: "bridges", type: "line" },
      { id: "place_other", type: "symbol", "source-layer": "place" },
    ];
    expect(placesBefore(dark, 1)).toBe("place_other");
    expect(placesBefore([{ id: "roads", type: "line" }], 0)).toBeUndefined();
  });

  it("has one layer per tier for each source, all of them tappable", () => {
    const ids = [...osmPlaceLayers(false), ...morePlaceLayers(true)].map((l) => l.id);
    expect(ids).toEqual(PLACE_LAYERS);
    expect(osmPlaceLayers(false).map((l) => l.minzoom)).toEqual([14.5, 15.5, 16.5]);
  });

  it("reads a place's name from either source", () => {
    expect(placeName({ "name:latin": "Accra Mall", name: "Accra Mall" })).toBe("Accra Mall");
    expect(placeName({ name: " Zoomlion Ghana Limited " })).toBe("Zoomlion Ghana Limited");
    expect(placeName({ class: "shop" })).toBeNull();
  });
});
