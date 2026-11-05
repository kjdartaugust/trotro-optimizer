/**
 * Place search: any street, market, school or neighbourhood, not just trotro stops. Photon
 * (photon.komoot.io) is OpenStreetMap data with search-as-you-type, free and key-free; it's biased
 * towards Accra and kept inside Ghana. Online only: stops are searched offline (lib/search.ts).
 */
import type { LngLat } from "./shapes";

export interface Place {
  name: string;
  /** The area it's in, e.g. "Okaikoi South". Empty when unknown. */
  detail: string;
  at: LngLat;
}

const PHOTON = "https://photon.komoot.io";
const NEAR_ACCRA = "lat=5.6&lon=-0.2";
const GHANA = "bbox=-3.3,4.5,1.3,11.2";

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

function toPlace(f: PhotonFeature): Place {
  const p = f.properties;
  return {
    name: p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || "Unnamed place",
    detail: [p.district ?? p.locality, p.city].filter(Boolean).join(", ") || p.county || p.state || "",
    at: f.geometry.coordinates,
  };
}

/** Places matching `q`, best first; the same name nearby appears once. */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(
    `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=8&lang=en&${NEAR_ACCRA}&${GHANA}`,
    { signal }
  );
  if (!res.ok) throw new Error(`place search answered ${res.status}`);
  const { features } = (await res.json()) as { features: PhotonFeature[] };
  const seen = new Set<string>();
  return features
    .map(toPlace)
    .filter((p) => {
      // "Accra Mall", its car park and its bus stop are one place to a person.
      const key = `${p.name}|${p.at[0].toFixed(2)}|${p.at[1].toFixed(2)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

/** A name for a spot someone tapped ("Near Kotobabi Market"), or null when there's none. */
export async function nameOf(at: LngLat): Promise<string | null> {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${at[0]}&lat=${at[1]}&lang=en`);
    if (!res.ok) return null;
    const { features } = (await res.json()) as { features: PhotonFeature[] };
    return features[0] ? `Near ${toPlace(features[0]).name}` : null;
  } catch {
    return null;
  }
}
