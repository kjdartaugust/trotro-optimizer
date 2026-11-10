/**
 * IndexedDB persistence for offline-first operation.
 *
 *  - `meta`         : dataset version cursor + last-sync timestamp, and riders' pin moves
 *                     (`placeFixes`: few, so one entry, and no new store to upgrade into)
 *  - `stations`     : the offline station table (keyed by id)
 *  - `routes`       : the offline route table (keyed by id, stops embedded)
 *  - `outbox`       : contributions created offline, awaiting push (keyed by client_key)
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ApiPlaceFix, ApiRoute, ApiStation, QueuedContribution } from "./types";

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

/** Which network this device holds (see NETWORK_GENERATION in sync.ts). */
export async function getGeneration(): Promise<number> {
  return ((await (await db()).get("meta", "generation")) as number) ?? 1;
}

export async function setGeneration(g: number): Promise<void> {
  await (await db()).put("meta", g, "generation");
}

/** Forget the stored network (not the outbox), so the next pull downloads it whole. */
export async function clearNetwork(): Promise<void> {
  const d = await db();
  const tx = d.transaction(["stations", "routes", "meta"], "readwrite");
  await Promise.all([
    tx.objectStore("stations").clear(),
    tx.objectStore("routes").clear(),
    tx.objectStore("meta").delete("version"),
  ]);
  await tx.done;
}

export async function deleteRows(store: "stations" | "routes", ids: string[]): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
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

type Fixes = Record<string, ApiPlaceFix>;

/** Riders' pin moves this phone knows (lib/morePlaces `withFixes` draws them). */
export async function allPlaceFixes(): Promise<ApiPlaceFix[]> {
  return Object.values(((await (await db()).get("meta", "placeFixes")) as Fixes | undefined) ?? {});
}

/** Keep these pin moves: one per place (its key), the latest given. */
export async function putPlaceFixes(fixes: ApiPlaceFix[]): Promise<void> {
  if (!fixes.length) return;
  const d = await db();
  const tx = d.transaction("meta", "readwrite");
  const all = ((await tx.store.get("placeFixes")) as Fixes | undefined) ?? {};
  for (const f of fixes) all[f.key] = f;
  await tx.store.put(all, "placeFixes");
  await tx.done;
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
