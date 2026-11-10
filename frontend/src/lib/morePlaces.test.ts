import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { morePlaceLayers, osmFilter, osmPlaceLayers, PLACE_LAYERS, placeName, placesBefore } from "./mapPlaces";
import { detailOf, findMorePlaces, LOCAL_FIX, moveProblem, parseMorePlaces, placeKey, withFixes } from "./morePlaces";
import { rankPlaces, type Place } from "./places";
import type { LngLat } from "./shapes";
import type { ApiPlaceFix } from "./types";

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

  it("says where a place is by its street when Overture has one, as map apps do", () => {
    const withStreet = parseMorePlaces({
      ...raw,
      streets: ["University Farm Rd", "Osu"],
      hide_osm: ["Zoomlion Ghana Limited Headquarters"],
      places: [
        [-0.11304, 5.67345, "Zoomlion Ghana Limited", 0, 2, 0, 91, 0, 0],
        [-0.18251, 5.5571, "QP Pharmacy Osu", 1, 3, 1, 70, 1, 1],
      ],
    });
    const [z, qp] = withStreet.list;
    expect(detailOf(z)).toBe("University Farm Rd, Nmai Dzorm");
    expect(detailOf(z, true)).toBe("Utility · University Farm Rd, Nmai Dzorm");
    expect(detailOf(qp)).toBe("Osu"); // the "street" is the town: said once
    expect(withStreet.hideOsm).toEqual(["Zoomlion Ghana Limited Headquarters"]);
  });
});

describe("riders moving a place's pin", () => {
  const more = parseMorePlaces(raw);
  const zoomlion = more.list[0]; // on University Farm Rd, where Overture's listing sat
  const building: LngLat = [-0.11337, 5.67193];
  const fix = (over: Partial<ApiPlaceFix> = {}): ApiPlaceFix => ({
    key: placeKey(zoomlion),
    name: "Zoomlion Ghana Limited",
    from_lon: -0.11304,
    from_lat: 5.67345,
    lon: building[0],
    lat: building[1],
    version: 7,
    ...over,
  });

  it("names the place for the server by its name and the places file's spot", () => {
    expect(placeKey(zoomlion)).toBe("zomlionghanalimited@-0.11304,5.67345");
  });

  it("puts a moved place where riders put it, on the map and in search", () => {
    const fixed = withFixes(more, [fix()]);
    expect(fixed.list[0]).toMatchObject({ at: building, origin: [-0.11304, 5.67345], fixed: true });
    const drawn = fixed.geojson.features.find((f) => f.properties?.name === "Zoomlion Ghana Limited");
    expect(drawn?.geometry).toEqual({ type: "Point", coordinates: building });
    expect(drawn?.properties?.i).toBe(0);
    expect(findMorePlaces(fixed, "Zoomlion Ghana", onUniversityFarmRoad)[0].at).toEqual(building);
    // The rest stay put, in the same order: the map's features point into the list.
    expect(fixed.list.slice(1)).toEqual(more.list.slice(1));
  });

  it("finds the place when a newer places file shifted it a little, never another place", () => {
    expect(withFixes(more, [fix({ from_lon: -0.1132, from_lat: 5.6736 })]).list[0].at).toEqual(building); // 24 m
    expect(withFixes(more, [fix({ from_lon: -0.12, from_lat: 5.68 })]).list[0].fixed).toBe(false); // 1 km
    const other = withFixes(more, [fix({ name: "Zoomlion Logistics" })]);
    expect(other.list.some((p) => p.fixed)).toBe(false);
  });

  it("shows the newest move of a place, this phone's own until the server sends it back", () => {
    const older = fix({ lon: -0.1135, lat: 5.6721, version: 3 });
    expect(withFixes(more, [fix(), older]).list[0].at).toEqual(building);
    const mine = fix({ lon: -0.1136, lat: 5.6722, version: LOCAL_FIX });
    expect(withFixes(more, [fix(), mine]).list[0].at).toEqual([-0.1136, 5.6722]);
  });

  it("applies the moves from the file's spots: again changes nothing, none puts it back", () => {
    const once = withFixes(more, [fix()]);
    expect(withFixes(once, [fix()])).toEqual(once);
    expect(withFixes(once, []).list[0]).toEqual(more.list[0]);
    expect(withFixes(more, [])).toBe(more); // nothing to do: no new list, no redraw
  });

  it("moves a pin only on the map and within its neighbourhood, as the server allows", () => {
    expect(moveProblem(zoomlion, building)).toBeNull();
    expect(moveProblem(zoomlion, [-0.11304, 5.67346])).toMatch(/Drag the pin/); // 1 m: not moved
    expect(moveProblem(zoomlion, [-0.11304, 5.71])).toMatch(/over 3 km/);
    expect(moveProblem(zoomlion, [2.35, 48.85])).toMatch(/off the map/);
    // Measured from the file's spot, not from an earlier move: the server's rule too.
    const moved = withFixes(more, [fix({ lon: -0.11304, lat: 5.69845 })]).list[0]; // 2.8 km north
    expect(moveProblem(moved, [-0.11304, 5.70345])).toMatch(/over 3 km/); // 0.6 km on, 3.3 km in all
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

  it("has the Zoomlion head office Google shows on University Farm Road, once, on its building", () => {
    const [z] = findMorePlaces(more, "Zoomlion Ghana Limited", onUniversityFarmRoad);
    expect(z).toMatchObject({ name: "Zoomlion Ghana Limited", detail: "University Farm Rd, Nmai Dzorm" });
    // Where OpenStreetMap puts the building, not on the road where Overture's listing sat.
    expect(z.at).toEqual([-0.11337, 5.67193]);
    // OpenStreetMap's "... Headquarters" building, 171 m away, is the same place: not drawn twice.
    expect(more.hideOsm).toContain("Zoomlion Ghana Limited Headquarters");
    // And search shows one of the two, the name that was typed (Photon's answer as it comes).
    const photon: Place = {
      name: "Zoomlion Ghana Limited Headquarters",
      detail: "Adjetey Adjei Sueley Street, Nmai Dzorm",
      at: [-0.11336, 5.67195],
    };
    const got = rankPlaces([z, photon], "Zoomlion Ghana Limited", [-0.205, 5.6]);
    expect(got.map((p) => p.name)).toEqual(["Zoomlion Ghana Limited"]);
    expect(got[0].at).toEqual([-0.11337, 5.67193]);
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

  it("leaves out OpenStreetMap's copy of a place Overture names more plainly", () => {
    expect(JSON.stringify(osmFilter("places-osm-2"))).not.toContain("literal");
    const f = JSON.stringify(osmFilter("places-osm-2", ["Zoomlion Ghana Limited Headquarters"]));
    expect(f).toContain('["!",["in",["get","name"],["literal",["Zoomlion Ghana Limited Headquarters"]]]]');
    expect(f).toContain('[">=",["get","rank"],7]');
  });

  it("reads a place's name from either source", () => {
    expect(placeName({ "name:latin": "Accra Mall", name: "Accra Mall" })).toBe("Accra Mall");
    expect(placeName({ name: " Zoomlion Ghana Limited " })).toBe("Zoomlion Ghana Limited");
    expect(placeName({ class: "shop" })).toBeNull();
  });
});
