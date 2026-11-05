/**
 * Two-way offline sync:
 *   ensureNetwork — make sure this device holds a network. The first time, that's the snapshot
 *                   shipped with the app (public/network/dataset.json, `npm run snapshot`), read
 *                   from the CDN in a second or two: the API can take a minute to wake.
 *   pull          — catch up with the API: rows newer than the cursor, and the stations/routes it
 *                   has retired since, into IndexedDB.
 *   flush         — push queued offline contributions once connectivity returns.
 */
import { fetchChanges, fetchDataset, isOnline, pushOutbox } from "./api";
import {
  clearNetwork,
  clearOutbox,
  deleteRows,
  getGeneration,
  getVersion,
  hasDataset,
  outbox,
  setGeneration,
  setVersion,
  upsertRoutes,
  upsertStations,
} from "./db";
import type { DatasetSnapshot } from "./types";

/**
 * Bumped when the network a device holds must be replaced wholesale. 2: Accra's real network
 * from OpenStreetMap replaced the 17-station demo. A device on an older generation downloads the
 * dataset afresh instead of relying on deltas (its demo rows predate retirements being sent).
 * Bumping it also means refreshing the snapshot (`npm run snapshot`).
 */
export const NETWORK_GENERATION = 2;

const SNAPSHOT = "/network/dataset.json";

async function fetchSnapshot(): Promise<DatasetSnapshot> {
  const res = await fetch(SNAPSHOT);
  if (!res.ok) throw new Error(`${SNAPSHOT} answered ${res.status}`);
  return (await res.json()) as DatasetSnapshot;
}

async function store(snap: DatasetSnapshot): Promise<void> {
  if (snap.stations.length) await upsertStations(snap.stations);
  if (snap.routes.length) await upsertRoutes(snap.routes);
  await setVersion(snap.version);
  await setGeneration(NETWORK_GENERATION);
}

/** Returns whether the network had to be downloaded just now. */
export async function ensureNetwork(): Promise<{ version: number; downloaded: boolean }> {
  if ((await getGeneration()) !== NETWORK_GENERATION) await clearNetwork();
  if (await hasDataset()) return { version: await getVersion(), downloaded: false };
  const snap = await fetchSnapshot().catch(() => fetchDataset());
  await store(snap);
  return { version: snap.version, downloaded: true };
}

/** Returns whether anything changed. */
export async function pull(): Promise<{ version: number; changed: boolean }> {
  if (!isOnline()) return { version: await getVersion(), changed: false };
  const { downloaded } = await ensureNetwork();
  const since = await getVersion();
  const changes = await fetchChanges(since);
  const gone = [...(changes.deleted_route_ids ?? []), ...(changes.deleted_station_ids ?? [])];
  const changed = changes.stations.length + changes.routes.length + gone.length > 0;
  if (changed) {
    await deleteRows("routes", changes.deleted_route_ids ?? []);
    await deleteRows("stations", changes.deleted_station_ids ?? []);
    await store(changes);
  } else if (changes.version !== since) {
    await setVersion(changes.version);
  }
  return { version: changes.version, changed: changed || downloaded };
}

export async function flush(): Promise<{ pushed: number }> {
  if (!isOnline()) return { pushed: 0 };
  const items = await outbox();
  if (!items.length) return { pushed: 0 };
  const res = await pushOutbox(items);
  await clearOutbox(items.map((i) => i.client_key));
  return { pushed: res.accepted + res.duplicates };
}

/** Convenience: pull dataset then flush the outbox. */
export async function syncAll() {
  const p = await pull();
  const f = await flush();
  return { ...p, ...f };
}
