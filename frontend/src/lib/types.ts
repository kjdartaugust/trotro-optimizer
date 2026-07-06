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
  stops: ApiRouteStop[];
}

export interface DatasetSnapshot {
  version: number;
  generated_at: string;
  stations: ApiStation[];
  routes: ApiRoute[];
}

export interface QueuedContribution {
  client_key: string;
  kind: "station" | "route" | "fare";
  target_id: string | null;
  payload: Record<string, unknown>;
  note?: string;
  created_at: number;
}
