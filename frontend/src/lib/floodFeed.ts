/**
 * FloodWatch's forecast, trimmed for the app (server side: app/api/flood/route.ts).
 *
 * FloodWatch's GET /routes is every line with twelve hours of rain and a status each, ~260 KB.
 * A trip needs each line's rain per hour and a way to tell which of this app's routes it is:
 * ~40 KB. The statuses are left behind on purpose: the app judges each ride's own stretch of
 * road (lib/flood.ts), not the whole line.
 */
import { createHash } from "node:crypto";
import { request as plain } from "node:http";
import { request as secure } from "node:https";
import type { FloodFeed, FloodLine } from "./flood";

/** FloodWatch's API: its /routes and /internal/refresh are public, no key. */
export const FLOODWATCH_API = "https://floodwatch-backend-dlni.onrender.com/api/v1";

// The network's id namespace: backend/app/ids.py NAMESPACE. Fixed for good there, so fixed here.
const NAMESPACE = "2b3f6c1e-8d4a-5f70-9e2b-4c6d8a0f1e35";

/** Python's uuid.uuid5: SHA-1 of the namespace's bytes and the name, stamped version 5. */
export function uuid5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const b = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * This app's id for the route FloodWatch named a line after. FloodWatch's "osm-7406251" is OSM
 * relation 7406251, the lower-numbered of the line's two directions; here that relation is the
 * route "osm-r7406251" (backend/app/ids.py `route_uuid`).
 */
export function routeIdOf(floodwatchId: string): string | null {
  const m = /^osm-(\d+)$/.exec(floodwatchId);
  return m ? uuid5(NAMESPACE, `route:osm-r${m[1]}`) : null;
}

interface FwHour {
  at: string;
  precip_mm: number;
}

interface FwRoute {
  id: string;
  from_stop: string | null;
  to_stop: string | null;
  hours?: FwHour[];
}

interface FwRefresh {
  finished_at: string | null;
  rainfall_rows: number | null;
  error: string | null;
}

const iso = (s: string) => new Date(s).toISOString();

/**
 * @param routes  FloodWatch's GET /routes
 * @param refresh its GET /internal/refresh (the latest rain check), or null if that couldn't be had
 * @param read    when FloodWatch answered
 */
export function toFeed(routes: FwRoute[], refresh: FwRefresh | null, read: string | null): FloodFeed {
  // Every line carries the same hours unless a check missed some: the union, in order.
  const stamps = new Set<string>();
  for (const r of routes) for (const h of r.hours ?? []) stamps.add(iso(h.at));
  const hours = [...stamps].sort();
  const col = new Map(hours.map((h, i) => [h, i]));
  const lines: FloodLine[] = [];
  for (const r of routes) {
    if (!r.hours?.length || !r.from_stop || !r.to_stop) continue; // no forecast yet, or no ends to know it by
    const mm: (number | null)[] = hours.map(() => null);
    for (const h of r.hours) mm[col.get(iso(h.at))!] = h.precip_mm;
    lines.push({ id: r.id, route: routeIdOf(r.id), ends: [r.from_stop, r.to_stop], mm });
  }
  const done = refresh?.finished_at ? iso(refresh.finished_at) : null;
  return {
    read,
    checked: done,
    failed: !!refresh && !!done && (!!refresh.error || !refresh.rainfall_rows),
    hours,
    lines,
  };
}

/** What there is before FloodWatch has ever answered: a forecast with no hours, which warns of nothing. */
export const NOTHING_YET: FloodFeed = { read: null, checked: null, failed: false, hours: [], lines: [] };

/**
 * One GET, given `ms` in all. Node's own client, on purpose: Next wraps `fetch` in a cache of its
 * own, and this answer's keeping is decided in one place only (app/api/flood/route.ts).
 */
function getJson(url: string, ms: number): Promise<{ body: unknown; date: string | null }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? secure : plain)(
      url,
      { headers: { accept: "application/json", "user-agent": "trotro-optimizer (flood warnings on trips)" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(new Error(`${url} answered ${res.statusCode}`));
          return;
        }
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("error", done);
        res.on("end", () => {
          try {
            done(null, { body: JSON.parse(Buffer.concat(parts).toString("utf8")), date: res.headers.date ?? null });
          } catch (e) {
            done(e as Error);
          }
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error(`${url} took over ${ms} ms`)), ms);
    function done(err: Error | null, value?: { body: unknown; date: string | null }) {
      clearTimeout(timer);
      if (err || !value) reject(err ?? new Error("no answer"));
      else resolve(value);
    }
    req.on("error", done);
    req.end();
  });
}

/** Ask FloodWatch for its forecast, giving it `ms` to answer (its free server can be asleep). */
export async function readFloodWatch(ms: number): Promise<FloodFeed> {
  const api = process.env.FLOODWATCH_API_URL || FLOODWATCH_API;
  // The latest rain check only says how fresh the forecast is: never fail over it.
  const [routes, refresh] = await Promise.all([
    getJson(`${api}/routes`, ms),
    getJson(`${api}/internal/refresh`, ms).catch(() => null),
  ]);
  if (!Array.isArray(routes.body)) throw new Error("FloodWatch's /routes wasn't a list");
  const said = routes.date && Number.isFinite(Date.parse(routes.date)) ? new Date(routes.date) : new Date();
  return toFeed(routes.body as FwRoute[], (refresh?.body as FwRefresh | undefined) ?? null, said.toISOString());
}
