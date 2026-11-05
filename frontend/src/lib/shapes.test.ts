import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cut, decode, matchStops, metres, type LngLat } from "./shapes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "../../public/network");
const readJson = (name: string) => JSON.parse(readFileSync(resolve(PUBLIC, name), "utf-8"));

describe("route lines", () => {
  it("decodes Google's polyline example", () => {
    const pts = decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  // An L: 1 km east along a street, then 1 km north.
  const L: LngLat[] = [
    [-0.2, 5.6],
    [-0.191, 5.6],
    [-0.191, 5.609],
  ];

  it("places stops on the line in order, and cuts the stretch between two", () => {
    const stops: LngLat[] = [
      [-0.2, 5.6001], // the start, a little off the road
      [-0.195, 5.5999], // halfway along the first street
      [-0.191, 5.605], // halfway up the second
    ];
    const placed = matchStops(L, stops);
    expect(placed.map((p) => p.seg)).toEqual([0, 0, 1]);
    expect(placed.every((p) => p.d < 20)).toBe(true);
    const ride = cut(L, placed[1], placed[2]);
    // From the stop on the first street, round the corner, up to the stop on the second.
    expect(ride).toHaveLength(3);
    expect(ride[1]).toEqual(L[1]);
    expect(metres(ride[0], [-0.195, 5.6])).toBeLessThan(1);
  });

  it("never places a stop behind the one before it", () => {
    // Out along a road and back the same way: a stop near the start comes after the far end.
    const outAndBack: LngLat[] = [
      [-0.2, 5.6],
      [-0.19, 5.6],
      [-0.2, 5.6001],
    ];
    const placed = matchStops(outAndBack, [
      [-0.199, 5.6],
      [-0.19, 5.6],
      [-0.199, 5.6001],
    ]);
    expect(placed[2].seg).toBe(1);
    for (let i = 1; i < placed.length; i++) {
      const a = placed[i - 1], b = placed[i];
      expect(b.seg > a.seg || (b.seg === a.seg && b.t >= a.t)).toBe(true);
    }
  });
});

describe("the shipped route lines", () => {
  const shapes: Record<string, string> = readJson("shapes.json").routes;
  const data = readJson("dataset.json");
  const station = new Map<string, { lon: number; lat: number }>(
    data.stations.map((s: { id: string; lon: number; lat: number }) => [s.id, s])
  );

  it("belong to routes in the shipped network, and stay in Greater Accra", () => {
    const ids = new Set(data.routes.map((r: { id: string }) => r.id));
    const keys = Object.keys(shapes);
    expect(keys.length).toBeGreaterThan(500);
    for (const id of keys) {
      expect(ids.has(id)).toBe(true);
      const line = decode(shapes[id]);
      expect(line.length).toBeGreaterThan(1);
      for (const [lng, lat] of line) {
        expect(lng).toBeGreaterThan(-0.8);
        expect(lng).toBeLessThan(0.4);
        expect(lat).toBeGreaterThan(5.3);
        expect(lat).toBeLessThan(6.1);
      }
    }
  });

  it("pass close by their own stops", () => {
    let far = 0, all = 0;
    for (const r of data.routes as { id: string; stops: { station_id: string; seq: number }[] }[]) {
      if (!shapes[r.id]) continue;
      const stops = [...r.stops]
        .sort((a, b) => a.seq - b.seq)
        .map((s) => station.get(s.station_id)!)
        .map((s): LngLat => [s.lon, s.lat]);
      const placed = matchStops(decode(shapes[r.id]), stops);
      far += placed.filter((p) => p.d > 250).length;
      all += placed.length;
    }
    // The build drops a line with more than a tenth of its stops this far off; most are close.
    expect(far / all).toBeLessThan(0.02);
  });
});
