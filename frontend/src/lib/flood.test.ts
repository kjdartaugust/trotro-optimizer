import { describe, expect, it } from "vitest";
import {
  ago,
  checkedWords,
  clock,
  endsKey,
  ground,
  hoursFor,
  indexFeed,
  indexTiles,
  isFeed,
  judge,
  lineFor,
  rainWords,
  riskAlong,
  statusOf,
  stretches,
  usable,
  whenWords,
  type FloodFeed,
  type TileRow,
} from "./flood";
import type { LngLat } from "./shapes";

describe("FloodWatch's rule", () => {
  // Each line is a branch of `_status` in FloodWatch's backend/app/services/routes_service.py,
  // at its edge and just short of it.
  it.each([
    [60, 20, "severe"],
    [59.9, 20, "warning"],
    [60, 19.9, "warning"],
    [45, 10, "warning"],
    [44.9, 10, "watch"],
    [45, 9.9, "watch"],
    [30, 5, "watch"],
    [29.9, 5, "clear"],
    [30, 4.9, "clear"],
    [100, 0, "clear"],
    [0, 35, "warning"],
    [0, 34.9, "clear"],
    [29.9, 60, "warning"],
  ])("risk %s with %s mm of rain is %s", (risk, mm, status) => {
    expect(statusOf(risk, mm)).toBe(status);
  });
});

// A road running 2.2 km due east along 5.6°N; 0.001° of latitude is about 110 m.
const ROAD: LngLat[] = [
  [-0.2, 5.6],
  [-0.18, 5.6],
];
const north = (lon: number, m: number, risk: number): TileRow => [5.6 + m / 110_574, lon, risk];

describe("risk along a road", () => {
  it("takes the worst cell whose centre is within 400 m, as FloodWatch does for a line", () => {
    const tiles = indexTiles([north(-0.19, 395, 70), north(-0.185, 405, 90), north(-0.195, 100, 40)]);
    const p = riskAlong(ROAD, tiles);
    expect(p.worst).toBe(70); // the 90 is 5 m too far
    // ...and says where: on the road, level with that cell.
    expect(p.at![0]).toBeCloseTo(-0.19, 3);
    expect(p.at![1]).toBeCloseTo(5.6, 6);
  });

  it("measures to the road, not to its corners", () => {
    // 300 m off the middle of a single 2.2 km piece: over a kilometre from either end.
    expect(riskAlong(ROAD, indexTiles([north(-0.19, 300, 55)])).worst).toBe(55);
  });

  it("cuts the road into short pieces, each with its own risk", () => {
    const p = riskAlong(ROAD, indexTiles([north(-0.19, 0, 80)]));
    expect(p.pts.length).toBe(p.risk.length + 1);
    expect(p.pts[0]).toEqual(ROAD[0]);
    expect(p.pts[p.pts.length - 1][0]).toBeCloseTo(ROAD[1][0], 9);
    // Only the pieces within 400 m of the cell carry its risk: about 800 m of the 2.2 km.
    const risky = p.risk.filter((r) => r === 80).length / p.risk.length;
    expect(risky).toBeGreaterThan(0.33);
    expect(risky).toBeLessThan(0.4);
    expect(p.risk[0]).toBe(0);
  });

  it("knows how much of the road has been scored at all", () => {
    // Cells every ~660 m along the west half only.
    const cells = [-0.2, -0.194, -0.188].map((lon) => north(lon, 0, 10));
    const p = riskAlong(ROAD, indexTiles(cells));
    expect(p.covered).toBeGreaterThan(0.75);
    expect(p.covered).toBeLessThan(0.9);
    expect(riskAlong(ROAD, indexTiles([north(-0.19, 2000, 99)])).covered).toBe(0);
  });

  it("is nothing for no road", () => {
    expect(riskAlong([], indexTiles([north(-0.19, 0, 80)]))).toMatchObject({ worst: 0, at: null, covered: 0 });
  });

  it("marks the stretches that flood in an hour's rain", () => {
    const tiles = indexTiles([north(-0.196, 0, 50), north(-0.184, 0, 65)]);
    const p = riskAlong(ROAD, tiles);
    // 12 mm: both spots are low enough to flood (45+), each its own stretch.
    const at12 = stretches(p, 12);
    expect(at12.map((s) => s.status)).toEqual(["warning", "warning"]);
    expect(at12[0].coords[0][0]).toBeGreaterThan(-0.2);
    expect(at12[1].coords[at12[1].coords.length - 1][0]).toBeLessThan(-0.18);
    // 25 mm: the second, a known flood spot (60+), turns severe.
    expect(stretches(p, 25).map((s) => s.status)).toEqual(["warning", "severe"]);
    // 40 mm floods the road end to end, the worst spot worst.
    const at40 = stretches(p, 40);
    expect(at40.map((s) => s.status)).toEqual(["warning", "severe", "warning"]);
    expect(at40[0].coords[0]).toEqual(ROAD[0]);
    // A dry hour marks nothing.
    expect(stretches(p, 2)).toEqual([]);
  });
});

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 16, 16); // 4 pm in Accra
const HOURS = Array.from({ length: 12 }, (_, i) => new Date(T0 + (i + 1) * H).toISOString()); // 5 pm … 4 am

function feedOf(mm: (number | null)[], over: Partial<FloodFeed> = {}): FloodFeed {
  return {
    read: new Date(T0).toISOString(),
    checked: new Date(T0 - 20 * 60_000).toISOString(),
    failed: false,
    hours: HOURS,
    lines: [{ id: "osm-1", route: "route-b", ends: ["Mayera / Adusa", "Achimota"], mm }],
    ...over,
  };
}

describe("FloodWatch's forecast", () => {
  const dry = HOURS.map(() => 0);

  it("is worth judging by while it has hours to come, from a recent check", () => {
    const now = T0 + 20 * 60_000;
    expect(usable(feedOf(dry), now)).toBe(true);
    expect(usable(null, now)).toBe(false);
    expect(usable(feedOf(dry, { lines: [] }), now)).toBe(false);
    // Its last hour has passed.
    expect(usable(feedOf(dry), T0 + 12 * H)).toBe(false);
    // FloodWatch's checks have stopped: 13 hours since the last one.
    expect(usable(feedOf(dry, { checked: new Date(now - 13 * H).toISOString() }), now)).toBe(false);
    // No record of a check: go by when FloodWatch answered.
    expect(usable(feedOf(dry, { checked: null }), now)).toBe(true);
    expect(usable(feedOf(dry, { checked: null, read: null }), now)).toBe(false);
  });

  it("is told from other answers", () => {
    expect(isFeed(feedOf(dry))).toBe(true);
    expect(isFeed({ waking: true })).toBe(false);
    expect(isFeed(null)).toBe(false);
  });

  it("knows a line by its two ends, either way round, however the slash is spaced", () => {
    expect(endsKey("Achimota", "Mayera/Adusa")).toBe(endsKey("Mayera / Adusa", "achimota"));
    expect(endsKey("Circle", "Madina")).not.toBe(endsKey("Circle", "Madina Zongo"));
  });

  it("finds a route's line by OSM id, by the other direction's, then by its ends", () => {
    const ix = indexFeed(feedOf(dry));
    const line = ix.feed.lines[0];
    expect(lineFor(ix, { id: "route-b", name: "Something Else → Entirely" })).toBe(line);
    expect(lineFor(ix, { id: "route-a", name: "Renamed → Since" }, "route-b")).toBe(line);
    expect(lineFor(ix, { id: "route-c", name: "Achimota → Mayera/Adusa" })).toBe(line);
    expect(lineFor(ix, { id: "route-c", name: "Achimota → Pokuase" })).toBeNull();
    expect(lineFor(ix, { id: "route-c", name: "Trotro 19: Abeka Lapaz - Kotokuo" })).toBeNull();
  });

  it("takes the hours a trip leaving now can meet", () => {
    const mm = HOURS.map((_, i) => i + 1); // 1 mm in the hour ending 5 pm, 2 by 6 pm…
    const ix = indexFeed(feedOf(mm));
    const line = ix.feed.lines[0];
    const now = T0 + 20 * 60_000; // 4:20 pm
    // A half-hour trip: the hour running now and the two after (nobody leaves at once).
    expect(hoursFor(ix, line, now, 30).map((h) => h.mm)).toEqual([1, 2, 3]);
    // A two-and-a-half-hour trip ends at 6:50 pm, and an hour's margin reaches into the 7-to-8 hour.
    expect(hoursFor(ix, line, now, 150).map((h) => h.mm)).toEqual([1, 2, 3, 4]);
    // An hour that has ended is gone; one FloodWatch has no rain for is skipped.
    expect(hoursFor(ix, line, T0 + H + 1, 30).map((h) => h.mm)).toEqual([2, 3, 4]);
    const gap = indexFeed(feedOf([1, null, 3, ...mm.slice(3)]));
    expect(hoursFor(gap, gap.feed.lines[0], now, 30).map((h) => h.mm)).toEqual([1, 3]);
  });

  it("judges a stretch by its worst hour, and says when that starts", () => {
    const hours = [
      { at: T0 + H, mm: 6 },
      { at: T0 + 2 * H, mm: 22 },
      { at: T0 + 3 * H, mm: 30 },
    ];
    expect(judge(65, hours)).toEqual({ status: "severe", at: T0 + 2 * H, mm: 22 });
    expect(judge(50, hours)).toEqual({ status: "warning", at: T0 + 2 * H, mm: 22 });
    expect(judge(35, hours)).toEqual({ status: "watch", at: T0 + H, mm: 6 });
    // High ground stays clear: the wettest hour is still what there is to say.
    expect(judge(10, hours)).toEqual({ status: "clear", at: T0 + 3 * H, mm: 30 });
    expect(judge(65, [])).toBeNull();
  });
});

describe("saying it", () => {
  const now = T0 + 20 * 60_000;

  it("tells the time as Accra does", () => {
    expect(clock(T0 + H)).toBe("5 pm");
    expect(clock(Date.UTC(2026, 10, 16, 9))).toBe("9 am");
    // Midnight and noon are 12, whatever the browser's own clock words would make of them.
    expect(clock(Date.UTC(2026, 10, 16, 0))).toBe("12 am");
    expect(clock(Date.UTC(2026, 10, 16, 12))).toBe("12 pm");
  });

  it("says now for the hour that is running", () => {
    expect(whenWords(T0 + H, now)).toBe("now");
    expect(whenWords(T0 + 2 * H, now)).toBe("around 6 pm");
  });

  it("puts rain in a rider's words", () => {
    expect(rainWords({ at: T0 + 2 * H, mm: 14.4 }, now)).toBe("Heavy rain around 6 pm (14 mm)");
    expect(rainWords({ at: T0 + H, mm: 6 }, now)).toBe("Rain now (6 mm)");
    expect(rainWords({ at: T0 + 3 * H, mm: 1.2 }, now)).toBe("Light rain around 7 pm (1 mm)");
  });

  it("describes the ground by how badly it floods", () => {
    expect(ground(72)).toBe("a known flood spot");
    expect(ground(50)).toBe("low ground");
    expect(ground(31)).toBe("a low point");
    expect(ground(12)).toBeNull();
  });

  it("says how fresh the forecast is", () => {
    expect(ago(new Date(now - 60_000).toISOString(), now)).toBe("just now");
    expect(ago(new Date(now - 40 * 60_000).toISOString(), now)).toBe("40 min ago");
    expect(ago(new Date(now - 3 * H).toISOString(), now)).toBe("3 h ago");
    expect(ago(new Date(now - 30 * H).toISOString(), now)).toBe("yesterday");
    expect(checkedWords(feedOf([]), now)).toBe("rain checked 40 min ago");
    expect(checkedWords(feedOf([], { failed: true }), now)).toBe("last rain check failed 40 min ago");
    expect(checkedWords(feedOf([], { checked: null }), now)).toBeNull();
  });
});
