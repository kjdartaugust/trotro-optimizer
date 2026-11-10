import { enqueue } from "./db";
import { flush } from "./sync";
import type { QueuedContribution } from "./types";

function clientKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Queue a contribution to the local outbox (works offline) and attempt an immediate flush.
 * Returns whether it was pushed to the server now or is waiting for connectivity, and whether
 * the server refused something it was sent (`refused`).
 */
export async function submitContribution(
  kind: QueuedContribution["kind"],
  target_id: string | null,
  payload: Record<string, unknown>,
  note?: string
): Promise<{ queued: true; pushed: boolean; refused: boolean }> {
  await enqueue({
    client_key: clientKey(),
    kind,
    target_id,
    payload,
    note,
    created_at: Date.now(),
  });
  let pushed = false;
  let refused = false;
  try {
    const res = await flush();
    pushed = res.pushed > 0;
    refused = res.refused > 0;
  } catch {
    pushed = false;
  }
  return { queued: true, pushed, refused };
}
