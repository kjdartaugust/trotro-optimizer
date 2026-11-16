import { describe, expect, it } from "vitest";
import { routeIdOf, toFeed, uuid5 } from "./floodFeed";

describe("FloodWatch's lines as this app's routes", () => {
  it("makes the ids Python's uuid5 makes", () => {
    // python -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org'))"
    expect(uuid5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("names the route FloodWatch named a line after", () => {
    // backend: route_uuid("osm-r7406251"), "Shalom → Kaneshie" in seed/accra.json.
    expect(routeIdOf("osm-7406251")).toBe("1d04736a-a4d7-5a9c-8acd-294bf151bb85");
    expect(routeIdOf("demo-1")).toBeNull();
  });
});

describe("FloodWatch's forecast, trimmed", () => {
  const at = (h: number) => `2026-11-16T${String(h).padStart(2, "0")}:00:00Z`;
  const routes = [
    {
      id: "osm-7406251",
      name: "Kaneshie – Shalom",
      from_stop: "Kaneshie",
      to_stop: "Shalom",
      baseline_risk: 66.3,
      current_status: "warning",
      active_alert: false,
      hours: [
        { at: at(17), precip_mm: 0.4, status: "clear" },
        { at: at(18), precip_mm: 12.5, status: "warning" },
      ],
    },
    {
      // A check missed this line once: it carries an hour the other has dropped, and lacks the last.
      id: "osm-7420887",
      name: "37 Lorry Park – Osu",
      from_stop: "37 Lorry Park",
      to_stop: "Osu (37 Station)",
      hours: [
        { at: at(16), precip_mm: 1, status: "clear" },
        { at: at(17), precip_mm: 2, status: "clear" },
      ],
    },
    // Added since the last rain check: no forecast yet, so nothing to judge by.
    { id: "osm-1", name: "New – Line", from_stop: "New", to_stop: "Line", hours: [] },
    // No ends to know it by.
    { id: "osm-2", name: "Nameless", from_stop: null, to_stop: null, hours: [{ at: at(17), precip_mm: 9, status: "clear" }] },
  ];
  const refresh = { id: 55, started_at: at(15), finished_at: "2026-11-16T15:33:34.976748Z", rainfall_rows: 28800, alerts_raised: 0, error: null };

  it("keeps each line's rain per hour, and how to find the line", () => {
    const feed = toFeed(routes, refresh, "2026-11-16T15:40:00.000Z");
    expect(feed.hours).toEqual(["2026-11-16T16:00:00.000Z", "2026-11-16T17:00:00.000Z", "2026-11-16T18:00:00.000Z"]);
    expect(feed.lines).toEqual([
      { id: "osm-7406251", route: "1d04736a-a4d7-5a9c-8acd-294bf151bb85", ends: ["Kaneshie", "Shalom"], mm: [null, 0.4, 12.5] },
      { id: "osm-7420887", route: routeIdOf("osm-7420887"), ends: ["37 Lorry Park", "Osu (37 Station)"], mm: [1, 2, null] },
    ]);
    expect(feed.read).toBe("2026-11-16T15:40:00.000Z");
    expect(feed.checked).toBe("2026-11-16T15:33:34.976Z");
    expect(feed.failed).toBe(false);
  });

  it("says when the last rain check failed, as FloodWatch does", () => {
    expect(toFeed(routes, { ...refresh, error: "Open-Meteo answered 429" }, null).failed).toBe(true);
    expect(toFeed(routes, { ...refresh, rainfall_rows: 0 }, null).failed).toBe(true);
    // Still running, or never ran: no time to give, and nothing known to have failed.
    expect(toFeed(routes, { ...refresh, finished_at: null }, null)).toMatchObject({ checked: null, failed: false });
    expect(toFeed(routes, null, null)).toMatchObject({ checked: null, failed: false });
  });
});
