/** How the app writes money, time and distance: the way a rider would say them. */

export const cedis = (n: number) => `GH₵${n.toFixed(2)}`;

export function minutes(m: number): string {
  const r = Math.max(1, Math.round(m));
  if (r < 60) return `${r} min`;
  const h = Math.floor(r / 60), rest = r % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function metres(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** For tight spaces: "47 min", "1h 33m". */
export function minutesShort(m: number): string {
  const r = Math.max(1, Math.round(m));
  return r < 60 ? `${r} min` : `${Math.floor(r / 60)}h ${String(r % 60).padStart(2, "0")}m`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Black or white text, whichever reads better on a route's colour. */
export function inkOn(hex: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast against white vs. against near-black (#111).
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.0555) ? "#fff" : "#111";
}

/** A route's colour, or the app's when it has none. */
export const routeColor = (c: string | null | undefined) => c || "#f08c00";
