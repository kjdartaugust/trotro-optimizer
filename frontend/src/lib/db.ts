/**
 * IndexedDB persistence for offline-first operation.
 *
 *  - `meta`         : dataset version cursor + last-sync timestamp
 *  - `stations`     : the offline station table (keyed by id)
 *  - `routes`       : the offline route table (keyed by id, stops embedded)
 *  - `outbox`       : contributions created offline, awaiting push (keyed by client_key)
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ApiRoute, ApiStation, QueuedContribution } from "./types";

interface TrotroDB extends DBSchema {
  meta: { key: string; value: unknown };
  stations: { key: string; value: ApiStation };
  routes: { key: string; value: ApiRoute };
  outbox: { key: string; value: QueuedContribution };
}

let dbp: Promise<IDBPDatabase<TrotroDB>> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB<TrotroDB>("trotro", 1, {
      upgrade(d) {
        d.createObjectStore("meta");
        d.createObjectStore("stations", { keyPath: "id" });
        d.createObjectStore("routes", { keyPath: "id" });
        d.createObjectStore("outbox", { keyPath: "client_key" });
      },
    });
  }
  return dbp;
}

export async function getVersion(): Promise<number> {
  return ((await (await db()).get("meta", "version")) as number) ?? 0;
}

export async function setVersion(v: number): Promise<void> {
  const d = await db();
  await d.put("meta", v, "version");
  await d.put("meta", Date.now(), "lastSync");
}

export async function getLastSync(): Promise<number | null> {
  return ((await (await db()).get("meta", "lastSync")) as number) ?? null;
}

export async function upsertStations(stations: ApiStation[]): Promise<void> {
  const d = await db();
  const tx = d.transaction("stations", "readwrite");
  await Promise.all(stations.map((s) => tx.store.put(s)));
  await tx.done;
}

export async function upsertRoutes(routes: ApiRoute[]): Promise<void> {
  const d = await db();
  const tx = d.transaction("routes", "readwrite");
  await Promise.all(routes.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function allStations(): Promise<ApiStation[]> {
  return (await db()).getAll("stations");
}

export async function allRoutes(): Promise<ApiRoute[]> {
  return (await db()).getAll("routes");
}

export async function hasDataset(): Promise<boolean> {
  return (await (await db()).count("stations")) > 0;
}

export async function enqueue(c: QueuedContribution): Promise<void> {
  await (await db()).put("outbox", c);
}

export async function outbox(): Promise<QueuedContribution[]> {
  return (await db()).getAll("outbox");
}

export async function clearOutbox(keys: string[]): Promise<void> {
  const d = await db();
  const tx = d.transaction("outbox", "readwrite");
  await Promise.all(keys.map((k) => tx.store.delete(k)));
  await tx.done;
}
