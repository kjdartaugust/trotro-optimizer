/**
 * Finding stops and lines as you type, offline. About 1,750 stops and 550 lines: matching all of
 * them on each keystroke takes well under a millisecond.
 */
import type { Network } from "./network";
import type { ApiRoute, ApiStation } from "./types";

/** Lower case, without accents, so "kwame nkrumah" finds "Kwame Nkrumah". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Letters and digits only, each run of a doubled letter once: "Zoom lion" and "Zoomlion",
 *  "Trassaco" and "Trasacco", "Korle-Bu" and "Korle Bu" all come out the same. */
export function squash(s: string): string {
  return fold(s)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(.)\1+/gu, "$1");
}

/** 0: the name starts with the query, 1: a word in it does, 2: it's somewhere in it, 3: it is
 *  once spaces and doubled letters are set aside. */
function rank(name: string, q: string, extra = ""): number {
  const n = fold(name);
  if (n.startsWith(q)) return 0;
  if (n.split(/[\s\-/(→]+/).some((w) => w.startsWith(q))) return 1;
  if (n.includes(q) || fold(extra).includes(q)) return 2;
  const sq = squash(q);
  if (sq.length >= 3 && squash(name).includes(sq)) return 3;
  return -1;
}

/** "Name · Area", unless the area is the name. */
export function stopLabel(s: ApiStation): string {
  return s.town && fold(s.town) !== fold(s.name) ? `${s.name} · ${s.town}` : s.name;
}

export function findStops(n: Network, query: string, limit = 6): ApiStation[] {
  const q = fold(query.trim());
  if (!q) return [];
  const busy = (s: ApiStation) => n.servedBy.get(s.id)?.length ?? 0;
  return n.stations
    .map((s) => ({ s, r: rank(s.name, q, s.town ?? "") }))
    .filter((m) => m.r >= 0)
    // Best match first; among equals, the stop more trotros use.
    .sort((a, b) => a.r - b.r || busy(b.s) - busy(a.s) || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((m) => m.s);
}

/** Lines whose name ("Shalom → Kaneshie") matches, one direction of each. */
export function findLines(n: Network, query: string, limit = 4): ApiRoute[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const seen = new Set<string>();
  return n.routes
    .map((r) => ({ r, k: rank(r.name, q) }))
    .filter((m) => m.k >= 0 && m.k < 2)
    .sort((a, b) => a.k - b.k || a.r.name.localeCompare(b.r.name))
    .filter(({ r }) => {
      // "A → B" and "B → A" are one line to a rider.
      const back = n.reverse.get(r.id);
      if (seen.has(r.id) || (back && seen.has(back))) return false;
      seen.add(r.id);
      return true;
    })
    .slice(0, limit)
    .map((m) => m.r);
}
