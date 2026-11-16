/**
 * Will this ride flood? Judged the way FloodWatch Ghana (the sister app) judges a trotro line, on
 * just the stretch of road the ride covers.
 *
 * FloodWatch scores Accra in cells about 460 m across, 0 to 100: how badly a spot floods in heavy
 * rain. Every three hours it also stores each trotro line's forecast rain, hour by hour. It calls
 * a line's risk the worst cell whose centre is within 400 m of the line, and blends that with an
 * hour's rain into clear / watch / warning / severe (`statusOf` is its rule). Nearly every line
 * crosses a bad cell somewhere, so judged whole they all warn together in heavy rain. A rider is
 * only on a stretch: the same rule on that stretch tells a ride through a flood spot from one
 * that stays on high ground, on the same line.
 *
 * The cells ship with the app (data/floodrisk.json, from backend/app/etl/flood_tiles.py). The
 * rain comes through /api/flood (lib/floodFeed.ts) and is kept on the phone (lib/floodData.ts),
 * so the last forecast still warns offline for as long as its hours run. Nothing here knows the
 * network: lib/tripFlood.ts puts a trip's rides through it.
 */
import type { LngLat } from "./shapes";

export type FloodStatus = "clear" | "watch" | "warning" | "severe";

export const RANK: Record<FloodStatus, number> = { clear: 0, watch: 1, warning: 2, severe: 3 };

export const worse = (a: FloodStatus, b: FloodStatus): FloodStatus => (RANK[b] > RANK[a] ? b : a);

/**
 * FloodWatch's rule, kept word for word with `_status` in its
 * backend/app/services/routes_service.py: a stretch's risk (0..100) and an hour's rain (mm).
 * Change one and the two apps tell a rider different things about the same road.
 */
export function statusOf(risk: number, mm: number): FloodStatus {
  if (risk >= 60 && mm >= 20) return "severe";
  if (risk >= 45 && mm >= 10) return "warning";
  if (risk >= 30 && mm >= 5) return "watch";
  if (mm >= 35) return "warning"; // extreme rain floods even lower-risk roads
  return "clear";
}

// ── The risk cells ─────────────────────────────────────────────────────────────────────────────

/** A cell: its centre, and how badly it floods (0..100). */
export type TileRow = [lat: number, lon: number, risk: number];

export interface Tiles {
  /** Cells by the ~550 m square their centre is in: a spot's neighbours are in the nine around it. */
  buckets: Map<number, TileRow[]>;
  /** A cell counts for a road its centre is within this many metres of (FloodWatch's 400). */
  within: number;
}

// Wider than both reaches below plus half a step, so nine squares always hold every cell in reach.
const BUCKET_DEG = 0.005;
const square = (deg: number) => Math.floor(deg / BUCKET_DEG);
const bucket = (y: number, x: number) => y * 100_000 + x + 50_000;

export function indexTiles(rows: TileRow[], within = 400): Tiles {
  const buckets = new Map<number, TileRow[]>();
  for (const t of rows) {
    const k = bucket(square(t[0]), square(t[1]));
    const list = buckets.get(k);
    if (list) list.push(t);
    else buckets.set(k, [t]);
  }
  return { buckets, within };
}

function around(tiles: Tiles, [lon, lat]: LngLat): TileRow[] {
  const out: TileRow[] = [];
  const y = square(lat), x = square(lon);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = tiles.buckets.get(bucket(y + dy, x + dx));
      if (list) out.push(...list);
    }
  }
  return out;
}

const M_LAT = 110_574; // metres in a degree of latitude here
const M_LON = 111_320; // ...and of longitude, at the equator

/** Metres from a cell's centre to the piece of road a→b. */
function toPiece(t: TileRow, a: LngLat, b: LngLat): number {
  const k = Math.cos((t[0] * Math.PI) / 180) * M_LON;
  const ax = (a[0] - t[1]) * k, ay = (a[1] - t[0]) * M_LAT;
  const bx = (b[0] - t[1]) * k, by = (b[1] - t[0]) * M_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const f = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + f * dx, ay + f * dy);
}

function metres(a: LngLat, b: LngLat): number {
  const k = Math.cos((a[1] * Math.PI) / 180) * M_LON;
  return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * M_LAT);
}

// A road is judged in pieces this long: short enough to say where on it the low ground is.
const STEP_M = 40;
// A spot inside the scored area is never further than this from its cell's centre (a cell's
// corners are ~461 m out): beyond it, FloodWatch hasn't scored the ground at all.
const COVER_M = 470;

export interface Profile {
  /** The road, cut into pieces of at most STEP_M: piece i runs pts[i] → pts[i + 1]. */
  pts: LngLat[];
  /** Each piece's risk: the worst cell whose centre is within reach; 0 where there is none. */
  risk: number[];
  /** The road's worst risk (FloodWatch's "baseline" for it), and where the road comes closest to
   *  the cell that gives it. */
  worst: number;
  at: LngLat | null;
  /** How much of the road FloodWatch has scored, 0..1. */
  covered: number;
}

/** A road's flood risk along its length. */
export function riskAlong(path: LngLat[], tiles: Tiles): Profile {
  const pts: LngLat[] = path.length ? [path[0]] : [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const n = Math.max(1, Math.ceil(metres(a, b) / STEP_M));
    for (let k = 1; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const risk: number[] = [];
  let worst = 0, at: LngLat | null = null, atM = Infinity, scored = 0, total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let r = 0, rM = Infinity, near = false;
    for (const t of around(tiles, mid)) {
      const d = toPiece(t, a, b);
      if (d <= COVER_M) near = true;
      if (d <= tiles.within && (t[2] > r || (t[2] === r && d < rM))) [r, rM] = [t[2], d];
    }
    risk.push(r);
    const len = metres(a, b);
    total += len;
    if (near) scored += len;
    // A cell reaches 400 m up and down the road: of the pieces it reaches, the nearest is "where".
    if (r > worst || (r === worst && r > 0 && rM < atM)) [worst, at, atM] = [r, mid, rM];
  }
  return { pts, risk, worst, at, covered: total ? scored / total : 0 };
}

/** The parts of a road that flood in an hour with this much rain, each with how badly. */
export function stretches(p: Profile, mm: number): { status: FloodStatus; coords: LngLat[] }[] {
  const out: { status: FloodStatus; coords: LngLat[] }[] = [];
  let open: { status: FloodStatus; coords: LngLat[] } | null = null;
  p.risk.forEach((r, i) => {
    const status = statusOf(r, mm);
    if (status === "clear") {
      open = null;
      return;
    }
    if (open && open.status === status) open.coords.push(p.pts[i + 1]);
    else out.push((open = { status, coords: [p.pts[i], p.pts[i + 1]] }));
  });
  return out;
}

// ── The rain: FloodWatch's forecast for each line ──────────────────────────────────────────────

export interface FloodLine {
  /** FloodWatch's id for the line ("osm-7406251"), for a link to it there. */
  id: string;
  /** This app's id of the route FloodWatch named the line after (one of its two directions). */
  route: string | null;
  /** The line's two ends, as FloodWatch names them. */
  ends: [string, string];
  /** Rain in each of the feed's `hours`, in mm; null where FloodWatch has none for that hour. */
  mm: (number | null)[];
}

/** What /api/flood answers: FloodWatch's forecast, trimmed to what a trip needs. */
export interface FloodFeed {
  /** When FloodWatch said this. */
  read: string | null;
  /** When FloodWatch last checked the rain, and whether that check failed. */
  checked: string | null;
  failed: boolean;
  /** The forecast hours, each the hour ENDING then (ISO, UTC). */
  hours: string[];
  lines: FloodLine[];
}

export function isFeed(v: unknown): v is FloodFeed {
  const f = v as FloodFeed | null;
  return !!f && Array.isArray(f.hours) && Array.isArray(f.lines);
}

const HOUR = 3_600_000;
// FloodWatch checks the rain every three hours. A last check older than this means its checks
// have stopped: its forecast is then too old to warn or to reassure by.
const MAX_CHECK_AGE = 12 * HOUR;

/** Whether this forecast can still be judged by: it has hours to come, from a recent enough check. */
export function usable(feed: FloodFeed | null | undefined, now: number): feed is FloodFeed {
  if (!feed || !feed.hours.length || !feed.lines.length) return false;
  if (Date.parse(feed.hours[feed.hours.length - 1]) <= now) return false;
  const seen = Date.parse(feed.checked ?? feed.read ?? "");
  return Number.isFinite(seen) && now - seen <= MAX_CHECK_AGE;
}

/** "Mayera/Adusa" and "Mayera / Adusa" are one end; the two ends in either order are one line. */
export function endsKey(a: string, b: string): string {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .split("/")
      .map((p) => p.trim().replace(/\s+/g, " "))
      .join("/");
  return [fold(a), fold(b)].sort().join("|");
}

export interface FeedIndex {
  feed: FloodFeed;
  /** When each of the feed's hours ends, in ms. */
  ends: number[];
  byRoute: Map<string, FloodLine>;
  byEnds: Map<string, FloodLine>;
}

export function indexFeed(feed: FloodFeed): FeedIndex {
  const byRoute = new Map<string, FloodLine>();
  const byEnds = new Map<string, FloodLine>();
  for (const l of feed.lines) {
    if (l.route) byRoute.set(l.route, l);
    byEnds.set(endsKey(l.ends[0], l.ends[1]), l);
  }
  return { feed, ends: feed.hours.map((h) => Date.parse(h)), byRoute, byEnds };
}

/**
 * A route's line in FloodWatch, which keeps one line for both directions and names it after one
 * of them. By OSM id first (this route's, or the other direction's), which holds when a name is
 * edited on one side only; else by the two ends' names.
 */
export function lineFor(
  ix: FeedIndex,
  route: { id: string; name: string },
  reverseId?: string
): FloodLine | null {
  const byId = ix.byRoute.get(route.id) ?? (reverseId ? ix.byRoute.get(reverseId) : undefined);
  if (byId) return byId;
  const ends = route.name.split("→").map((p) => p.trim());
  return (ends.length === 2 && ix.byEnds.get(endsKey(ends[0], ends[1]))) || null;
}

export interface Hour {
  /** When the hour ends, ms. */
  at: number;
  mm: number;
}

/**
 * The forecast hours a trip leaving now can meet: from the hour running now to the one it ends
 * in, and never fewer than the two hours from now (nobody leaves the second they look, and water
 * stays on the road after the rain).
 */
export function hoursFor(ix: FeedIndex, line: FloodLine, now: number, minutes: number): Hour[] {
  const until = now + Math.max(2 * HOUR, minutes * 60_000 + HOUR);
  const out: Hour[] = [];
  ix.ends.forEach((at, i) => {
    const mm = line.mm[i];
    if (mm == null || !(at > now) || at - HOUR >= until) return;
    out.push({ at, mm });
  });
  return out;
}

export interface Judged {
  status: FloodStatus;
  /** The first hour that reaches it (the wettest hour when clear): when it ends, and its rain. */
  at: number;
  mm: number;
}

/** A stretch of road with this risk, through these hours: how bad it gets, and when. */
export function judge(risk: number, hours: Hour[]): Judged | null {
  let best: Judged | null = null;
  for (const h of hours) {
    const status = statusOf(risk, h.mm);
    const better = !best || RANK[status] > RANK[best.status] || (status === "clear" && best.status === "clear" && h.mm > best.mm);
    if (better) best = { status, at: h.at, mm: h.mm };
  }
  return best;
}

// ── Saying it: in FloodWatch's words, so the two apps read as one ─────────────────────────────

export type Flooding = Exclude<FloodStatus, "clear">;

/** FloodWatch itself: `/?route=<its id for a line>` opens that line there. */
export const FLOODWATCH_SITE = "https://floodwatch-ghana-ten.vercel.app";

export const FLOOD_TEXT: Record<Flooding, { flag: string; title: string; advice: string }> = {
  watch: { flag: "Flood watch", title: "Minor flooding possible", advice: "Allow extra time." },
  warning: { flag: "Flooding likely", title: "Flooding likely at low points", advice: "Expect delays." },
  severe: { flag: "Severe flooding", title: "Severe flooding expected", advice: "Avoid the peak if you can." },
};

/** FloodWatch's colours for a line's status. */
export const FLOOD_COLOR: Record<Flooding, string> = {
  watch: "#e0a400",
  warning: "#f76707",
  severe: "#e03131",
};

/** "3 pm", in Accra's time (GMT all year). */
export function clock(at: number): string {
  return new Date(at)
    .toLocaleTimeString("en-GB", { hour: "numeric", hour12: true, timeZone: "Africa/Accra" })
    .replace(/\s/g, " ");
}

/** When a forecast hour (the one ending at `at`) is: "now" while it's running, else "around 5 pm". */
export function whenWords(at: number, now: number): string {
  return at - HOUR <= now ? "now" : `around ${clock(at)}`;
}

/** "Heavy rain around 5 pm (14 mm)". */
export function rainWords(h: { at: number; mm: number }, now: number): string {
  const kind = h.mm >= 10 ? "Heavy rain" : h.mm >= 2 ? "Rain" : "Light rain";
  return `${kind} ${whenWords(h.at, now)} (${Math.round(h.mm)} mm)`;
}

/** What the ground on a stretch is like, as FloodWatch describes a line's. */
export function ground(risk: number): string | null {
  if (risk >= 60) return "a known flood spot";
  if (risk >= 45) return "low ground";
  if (risk >= 30) return "a low point";
  return null;
}

/** "12 min ago", "3 h ago", "yesterday". */
export function ago(iso: string, now: number): string {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return h < 48 ? "yesterday" : `${Math.round(h / 24)} days ago`;
}

/** How fresh the forecast is, said the way FloodWatch says it. */
export function checkedWords(feed: FloodFeed, now: number): string | null {
  if (!feed.checked) return null;
  return feed.failed ? `last rain check failed ${ago(feed.checked, now)}` : `rain checked ${ago(feed.checked, now)}`;
}
