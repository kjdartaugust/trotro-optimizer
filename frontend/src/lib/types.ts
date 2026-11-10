export interface ApiStation {
  id: string;
  name: string;
  town: string | null;
  lat: number;
  lon: number;
  verified: boolean;
  confidence: number;
  version: number;
}

export interface ApiRouteStop {
  station_id: string;
  seq: number;
  fare_from_prev: number;
  minutes_from_prev: number;
}

export interface ApiRoute {
  id: string;
  name: string;
  operator: string | null;
  color: string | null;
  verified: boolean;
  confidence: number;
  version: number;
  /** Charged once per boarding (absent from servers older than the OSM network: 0). */
  board_fare?: number;
  stops: ApiRouteStop[];
}

/** Where riders say a place is (a "place" contribution; the API's `place_fixes`): the place of
 *  this name nearest (from_lon, from_lat) in public/network/places.json shows at (lon, lat). */
export interface ApiPlaceFix {
  key: string;
  name: string;
  from_lat: number;
  from_lon: number;
  lat: number;
  lon: number;
  /** The server's sync version; LOCAL_FIX (lib/morePlaces) while it waits on this phone. */
  version: number;
}

export interface DatasetSnapshot {
  version: number;
  generated_at: string;
  stations: ApiStation[];
  routes: ApiRoute[];
  /** Riders' pin moves (absent from older servers and snapshots). */
  place_fixes?: ApiPlaceFix[];
}

/** `/sync/changes`: rows newer than `since`, and the ones taken out of the network since. */
export interface ChangeSet extends DatasetSnapshot {
  since: number;
  deleted_station_ids?: string[];
  deleted_route_ids?: string[];
}

export interface QueuedContribution {
  client_key: string;
  kind: "station" | "route" | "fare" | "fareboard" | "place";
  target_id: string | null;
  payload: Record<string, unknown>;
  note?: string;
  created_at: number;
}
