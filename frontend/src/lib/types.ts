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

export interface DatasetSnapshot {
  version: number;
  generated_at: string;
  stations: ApiStation[];
  routes: ApiRoute[];
}

/** `/sync/changes`: rows newer than `since`, and the ones taken out of the network since. */
export interface ChangeSet extends DatasetSnapshot {
  since: number;
  deleted_station_ids?: string[];
  deleted_route_ids?: string[];
}

export interface QueuedContribution {
  client_key: string;
  kind: "station" | "route" | "fare" | "fareboard";
  target_id: string | null;
  payload: Record<string, unknown>;
  note?: string;
  created_at: number;
}
