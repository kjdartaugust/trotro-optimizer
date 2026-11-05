/**
 * Trip planning off the main thread. Building the graph and three searches over ~1,750 stops
 * take a few hundred milliseconds on a cheap phone: here, the map and the sheet keep moving
 * meanwhile. The worker reads the same IndexedDB tables as the page.
 */
import { planOffline, warmUp } from "./planner";

type Ask = { id: number; kind: "plan"; origin: [number, number]; dest: [number, number] } | { id: number; kind: "warm" };

// This file runs as a worker, but the project's types are the page's (lib "dom").
const ctx = self as unknown as {
  postMessage(m: unknown): void;
  addEventListener(type: "message", fn: (e: MessageEvent<Ask>) => void): void;
};

ctx.addEventListener("message", async (e) => {
  const ask = e.data;
  try {
    if (ask.kind === "warm") {
      await warmUp();
      ctx.postMessage({ id: ask.id, ok: true });
      return;
    }
    const { itineraries, estimated } = await planOffline(ask.origin, ask.dest);
    ctx.postMessage({ id: ask.id, ok: true, itineraries, estimated });
  } catch (err) {
    ctx.postMessage({ id: ask.id, ok: false, error: String(err) });
  }
});
