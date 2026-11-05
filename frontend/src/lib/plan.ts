/**
 * Ask for a trip. The planning runs in a worker (plan.worker.ts) so the page never stalls; where
 * workers aren't available, or one fails, it runs here instead, with the same answer.
 */
import type { Itinerary, Mode } from "@/engine/engine";

export interface Plan {
  itineraries: Partial<Record<Mode, Itinerary>>;
  estimated: boolean;
}

type Reply = { id: number; ok: boolean; error?: string } & Partial<Plan>;

let worker: Worker | null | undefined;
let next = 0;
const waiting = new Map<number, (r: Reply) => void>();

function planner(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./plan.worker.ts", import.meta.url));
    worker.onmessage = (e: MessageEvent<Reply>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => {
      for (const done of waiting.values()) done({ id: -1, ok: false, error: "planner stopped" });
      waiting.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function ask(msg: object): Promise<Reply> | null {
  const w = planner();
  if (!w) return null;
  const id = ++next;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ ...msg, id });
  });
}

/** Get the graph built before the first search, so it answers at once. */
export function warmPlanner(): void {
  void ask({ kind: "warm" });
}

export async function planTrip(origin: [number, number], dest: [number, number]): Promise<Plan> {
  const reply = await ask({ kind: "plan", origin, dest });
  if (reply?.ok && reply.itineraries) {
    return { itineraries: reply.itineraries, estimated: reply.estimated ?? false };
  }
  const { planOffline } = await import("./planner");
  const { itineraries, estimated } = await planOffline(origin, dest);
  return { itineraries, estimated };
}
