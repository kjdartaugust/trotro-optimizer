/**
 * A station's fare board: the destinations its trotros go to and the fare to each. Riders send it
 * from the report page, by photo (the server reads it, see backend/app/fareboard.py) or typed in.
 * Here: shrinking the photo before it goes over mobile data, and matching each destination to a
 * stop the network's lines reach from the board's station.
 */
import type { Network } from "./network";
import { fold, squash } from "./search";
import type { ApiStation } from "./types";

export interface BoardRow {
  to: string;
  fare: number;
}

export interface ReadBoard {
  rows: BoardRow[];
  station: string | null;
  effective: string | null;
}

/** The stops after `at` on the lines through it, with how many lines go on to each. */
export function reachable(net: Network, at: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const rid of net.servedBy.get(at) ?? []) {
    const stops = net.route.get(rid)?.stops ?? [];
    const i = stops.findIndex((s) => s.station_id === at);
    const seen = new Set<string>();
    for (const s of stops.slice(i + 1)) {
      if (s.station_id === at || seen.has(s.station_id)) continue;
      seen.add(s.station_id);
      out.set(s.station_id, (out.get(s.station_id) ?? 0) + 1);
    }
  }
  return out;
}

export interface Match {
  station: ApiStation;
  /** How many lines from the board's station stop there. */
  lines: number;
}

/** The stop a board's destination means, among those its station's lines reach: the closest name,
 *  then the one more lines go to. Null: no line we know goes there (yet). */
export function matchDestination(net: Network, reach: Map<string, number>, text: string): Match | null {
  const t = fold(text.trim());
  if (t.length < 2) return null;
  const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const sq = squash(t);
  let best: { m: Match; score: number } | null = null;
  for (const [sid, lines] of reach) {
    const s = net.station.get(sid);
    if (!s) continue;
    const n = fold(s.name);
    const own = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const score =
      n === t ? 0
      : n.startsWith(t) || t.startsWith(n) ? 1
      : words.every((w) => own.some((o) => o.startsWith(w))) ? 2
      : sq.length >= 3 && squash(n).includes(sq) ? 3
      : -1;
    if (score < 0) continue;
    if (!best || score < best.score || (score === best.score && lines > best.m.lines)) {
      best = { m: { station: s, lines }, score };
    }
  }
  return best?.m ?? null;
}

/** A photo small enough for mobile data (about 1600 px across, JPEG), turned the right way up. */
export async function shrink(file: File, max = 1600): Promise<Blob> {
  try {
    const img = await decode(file);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
    img.done();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    // A browser that can't decode it here: send it as it is, the server checks it.
    return file;
  }
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const b = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: b, width: b.width, height: b.height, done: () => b.close() };
    } catch {
      // Older Safari: no options. Fall through to an <img>, which follows the photo's rotation.
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((ok, fail) => {
    img.onload = () => ok();
    img.onerror = () => fail(new Error("couldn't open the photo"));
    img.src = url;
  });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}
