/**
 * What flood warnings are judged from, as the page holds it: FloodWatch's risk cells (shipped with
 * the app) and its rain forecast (from /api/flood, kept on the phone). Nothing waits on either:
 * trips plan first, and warnings appear when both are in.
 */
import { useEffect, useMemo, useState } from "react";
import { getFlood, putFlood } from "./db";
import {
  indexFeed,
  indexTiles,
  isFeed,
  usable,
  type FeedIndex,
  type FloodFeed,
  type TileRow,
  type Tiles,
} from "./flood";

let cells: Promise<Tiles | null> | null = null;

/** FloodWatch's risk cells. A chunk of the app, so the service worker keeps it for offline. */
export function loadTiles(): Promise<Tiles | null> {
  cells ??= import("@/data/floodrisk.json")
    .then((m) => indexTiles(m.default.tiles as TileRow[], m.default.within_m))
    .catch(() => {
      cells = null; // try again next time
      return null;
    });
  return cells;
}

async function fetchFeed(): Promise<FloodFeed | null> {
  try {
    const res = await fetch("/api/flood", { cache: "no-store" });
    if (!res.ok) return null; // FloodWatch is asleep: asking has started it waking
    const v: unknown = await res.json();
    return isFeed(v) ? v : null;
  } catch {
    return null;
  }
}

const when = (f: FloodFeed | null) => Date.parse(f?.checked ?? f?.read ?? "") || 0;

// FloodWatch checks the rain every three hours: a forecast older than this has a newer one due.
const DUE_MS = 200 * 60_000;
// Its server takes about 100 s to wake. The first ask wakes it; the second, after this, gets
// /api/flood fetching behind our back; the third collects what that fetched.
const AGAIN_MS = [110_000, 25_000];
// While the app stays open.
const EVERY_MS = 30 * 60_000;
const TICK_MS = 5 * 60_000;

/**
 * `feed` is null until there's a forecast worth judging by (lib/flood `usable`). `now` moves on
 * every few minutes, so a trip left on screen is judged against the hours still to come.
 */
export function useFlood(): { tiles: Tiles | null; feed: FeedIndex | null; now: number } {
  const [tiles, setTiles] = useState<Tiles | null>(null);
  const [feed, setFeed] = useState<FloodFeed | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Whichever is newer wins: the phone's copy can't undo a fresh answer, nor a stale answer the phone's.
    const take = (f: FloodFeed | null) => {
      if (live && f) setFeed((cur) => (when(f) >= when(cur) ? f : cur));
    };
    void loadTiles().then((t) => live && setTiles(t));
    void getFlood().then(take).catch(() => undefined);

    async function refresh(again: number[]) {
      if (!live || navigator.onLine === false) return;
      const f = await fetchFeed();
      if (!live) return;
      take(f);
      if (f) void putFlood(f).catch(() => undefined);
      setNow(Date.now());
      const current = usable(f, Date.now()) && Date.now() - when(f) < DUE_MS;
      if (!current && again.length) {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(again.slice(1)), again[0]);
      }
    }
    const start = () => void refresh(AGAIN_MS);
    start();
    const every = setInterval(start, EVERY_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    window.addEventListener("online", start);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(every);
      clearInterval(tick);
      window.removeEventListener("online", start);
    };
  }, []);

  const ix = useMemo(() => (usable(feed, now) ? indexFeed(feed) : null), [feed, now]);
  // The same object until one of them changes: what's worked out from it (each option's outlook,
  // what the map draws) is then only worked out again when there's something new.
  return useMemo(() => ({ tiles, feed: ix, now }), [tiles, ix, now]);
}
