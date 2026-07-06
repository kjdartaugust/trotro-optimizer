/**
 * Two-way offline sync:
 *   pull  — download the dataset (full on first run, deltas thereafter) into IndexedDB.
 *   flush — push queued offline contributions once connectivity returns.
 */
import { fetchChanges, fetchDataset, isOnline, pushOutbox } from "./api";
import {
  clearOutbox,
  getVersion,
  hasDataset,
  outbox,
  setVersion,
  upsertRoutes,
  upsertStations,
} from "./db";

export async function pull(): Promise<{ version: number; downloaded: boolean }> {
  if (!isOnline()) return { version: await getVersion(), downloaded: false };

  const seeded = await hasDataset();
  const since = await getVersion();
  const snap = seeded ? await fetchChanges(since) : await fetchDataset();

  if (snap.stations.length) await upsertStations(snap.stations);
  if (snap.routes.length) await upsertRoutes(snap.routes);
  await setVersion(snap.version);
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
