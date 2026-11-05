/**
 * The roads each trotro route drives, for the map: public/network/shapes.json, built by
 * backend/app/etl/osm_shapes.py, holds one encoded polyline per route id. A trip's ride is cut out
 * of its route's line between the stop you board at and the one you leave at, each placed on the
 * line the way the build placed them (`matchStops` mirrors `match_stops` there). A route without a
 * line is drawn stop to stop.
 */
export type LngLat = [number, number];

/** Where a stop sits on a line: segment, fraction along it, and how far away it is in metres. */
export interface OnLine {
  seg: number;
  t: number;
  d: number;
}

const R = 6_371_000;
const COS = Math.cos((5.6 * Math.PI) / 180); // Accra: east-west metres per degree shrink by this
// A trotro passes a stop where the line first comes this close to the best it ever gets: on a
// road it drives twice, the first time, which is the one in stop order.
const SLACK_M = 40;

const xy = ([lng, lat]: LngLat): [number, number] => [
  ((lng * Math.PI) / 180) * R * COS,
  ((lat * Math.PI) / 180) * R,
];

export function metres(a: LngLat, b: LngLat): number {
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  return Math.hypot(bx - ax, by - ay);
}

/** Google's encoded polyline, precision 5, latitude first. */
export function decode(s: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    const v: number[] = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0, res = 0, b: number;
      do {
        b = s.charCodeAt(i++) - 63;
        res |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      v.push(res & 1 ? ~(res >> 1) : res >> 1);
    }
    lat += v[0];
    lng += v[1];
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

function at(line: LngLat[], seg: number, t: number): LngLat {
  const a = line[seg], b = line[Math.min(seg + 1, line.length - 1)];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Where p lands on segment a→b: fraction along it, and metres away. */
function project(p: LngLat, a: LngLat, b: LngLat): [number, number] {
  const [px, py] = xy(p), [ax, ay] = xy(a), [bx, by] = xy(b);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return [t, Math.hypot(ax + t * dx - px, ay + t * dy - py)];
}

/** Each stop's place on the line, in stop order; a stop is never placed before the one ahead. */
export function matchStops(line: LngLat[], stops: LngLat[]): OnLine[] {
  const out: OnLine[] = [];
  let seg = 0, frac = 0;
  for (const s of stops) {
    const cand: OnLine[] = [];
    for (let k = seg; k < line.length - 1; k++) {
      let [t, d] = project(s, line[k], line[k + 1]);
      if (k === seg && t < frac) [t, d] = [frac, metres(s, at(line, k, frac))];
      cand.push({ seg: k, t, d });
    }
    if (!cand.length) {
      out.push({ seg: 0, t: 0, d: metres(s, line[0]) });
      continue;
    }
    const best = Math.min(...cand.map((c) => c.d));
    let i = cand.findIndex((c) => c.d <= best + SLACK_M);
    while (i + 1 < cand.length && cand[i + 1].d < cand[i].d) i++; // the closest point of that pass
    out.push(cand[i]);
    seg = cand[i].seg;
    frac = cand[i].t;
  }
  return out;
}

/** The line from one place on it to a later one. */
export function cut(line: LngLat[], from: OnLine, to: OnLine): LngLat[] {
  const pts = [at(line, from.seg, from.t), ...line.slice(from.seg + 1, to.seg + 1), at(line, to.seg, to.t)];
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}

let shapes: Promise<Map<string, LngLat[]>> | null = null;

/** Every route's line, by route id; empty if the file can't be had (the map then draws stop to stop). */
export function loadShapes(): Promise<Map<string, LngLat[]>> {
  shapes ??= fetch("/network/shapes.json")
    .then((r) => (r.ok ? r.json() : { routes: {} }))
    .then((doc: { routes: Record<string, string> }) => {
      const out = new Map<string, LngLat[]>();
      for (const [id, s] of Object.entries(doc.routes)) out.set(id, decode(s));
      return out;
    })
    .catch(() => {
      shapes = null; // try again next time
      return new Map<string, LngLat[]>();
    });
  return shapes;
}
