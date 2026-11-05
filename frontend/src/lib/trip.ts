/**
 * A trip as the screens hold it: two ends (a stop, a place, a dropped pin or where you are) and the
 * options found between them. The three modes often agree; they're shown as one option then.
 */
import type { Itinerary, Mode } from "@/engine/engine";
import type { LngLat } from "./shapes";

export type Field = "from" | "to";

export interface End {
  name: string;
  detail?: string;
  at: LngLat;
  /** Set when the end is a trotro stop. */
  stop?: string;
  kind: "stop" | "place" | "pin" | "me";
}

export interface TripOption {
  modes: Mode[];
  it: Itinerary;
}

export const MODE_LABEL: Record<Mode, string> = {
  fastest: "Fastest",
  cheapest: "Cheapest",
  fewest: "Fewest changes",
};

const ORDER: Mode[] = ["fastest", "cheapest", "fewest"];

/** One option per distinct trip, labelled with every mode that picked it. */
export function options(found: Partial<Record<Mode, Itinerary>>): TripOption[] {
  const out: (TripOption & { key: string })[] = [];
  for (const mode of ORDER) {
    const it = found[mode];
    if (!it) continue;
    const key = it.legs
      .map((l) => (l.kind === "ride" ? `${l.routeId}:${l.fromStation}:${l.toStation}` : `w:${l.toStation}`))
      .join("|");
    const same = out.find((o) => o.key === key);
    if (same) same.modes.push(mode);
    else out.push({ key, modes: [mode], it });
  }
  return out.map(({ modes, it }) => ({ modes, it }));
}

export function optionLabel(modes: Mode[]): string {
  if (modes.length === ORDER.length) return "Best on every count";
  return modes.map((m, i) => (i ? MODE_LABEL[m].toLowerCase() : MODE_LABEL[m])).join(" and ");
}

// ── Shareable links: /?from=5.57100,-0.20500,Circle&to=… ──────────────────────────────────────

export function endParam(e: End): string {
  return `${e.at[1].toFixed(5)},${e.at[0].toFixed(5)},${e.name}`;
}

export function parseEnd(v: string | null): End | null {
  if (!v) return null;
  const [lat, lng, ...name] = v.split(",");
  const at: LngLat = [Number(lng), Number(lat)];
  if (!Number.isFinite(at[0]) || !Number.isFinite(at[1])) return null;
  return { name: name.join(",") || "Shared place", at, kind: "pin" };
}

// ── Recent ends and trips, on this device only ─────────────────────────────────────────────────

const RECENT = "trotro.recent";

export interface Recent {
  from: End;
  to: End;
}

export function recentTrips(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
    return Array.isArray(v) ? v.slice(0, 5) : [];
  } catch {
    return [];
  }
}

const same = (a: End, b: End) => a.name === b.name && a.at[0] === b.at[0] && a.at[1] === b.at[1];

/** Keep a trip for next time. A "Where I am" start is found afresh when it's opened again. */
export function rememberTrip(from: End, to: End): void {
  const fresh = (r: Recent) =>
    !((same(r.from, from) || (r.from.kind === "me" && from.kind === "me")) && same(r.to, to));
  const list = [{ from, to }, ...recentTrips().filter(fresh)];
  try {
    localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 5)));
  } catch {
    // Private mode or full storage: recents are a nicety.
  }
}

/** Ends of recent trips, newest first, each once ("Where I am" left out: it moves). */
export function recentEnds(): End[] {
  const out: End[] = [];
  for (const r of recentTrips()) {
    for (const e of [r.to, r.from]) if (e.kind !== "me" && !out.some((o) => same(o, e))) out.push(e);
  }
  return out.slice(0, 5);
}
