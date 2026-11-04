/**
 * Two-way offline sync:
 *   pull  — download the dataset (full on first run, deltas thereafter) into IndexedDB, and drop
 *           the stations/routes the server has retired since the last pull.
 *   flush — push queued offline contributions once connectivity returns.
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

/**
 * Bumped when the network a device holds must be replaced wholesale. 2: Accra's real network
 * from OpenStreetMap replaced the 17-station demo. A device on an older generation downloads the
 * dataset afresh instead of relying on deltas (its demo rows predate retirements being sent).
 */
export const NETWORK_GENERATION = 2;

export async function pull(): Promise<{ version: number; downloaded: boolean }> {
  if (!isOnline()) return { version: await getVersion(), downloaded: false };

  if ((await getGeneration()) !== NETWORK_GENERATION) await clearNetwork();
  const seeded = await hasDataset();
  const since = await getVersion();
  const changes = seeded ? await fetchChanges(since) : null;
  const snap = changes ?? (await fetchDataset());

  if (changes) {
    await deleteRows("routes", changes.deleted_route_ids ?? []);
    await deleteRows("stations", changes.deleted_station_ids ?? []);
  }
  if (snap.stations.length) await upsertStations(snap.stations);
  if (snap.routes.length) await upsertRoutes(snap.routes);
  await setVersion(snap.version);
  await setGeneration(NETWORK_GENERATION);
  return { version: snap.version, downloaded: !seeded || snap.stations.length > 0 };
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
