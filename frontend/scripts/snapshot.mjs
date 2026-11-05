// Save the live network as the app's first-run download, public/network/dataset.json.
//
// A first visit reads it from Vercel's CDN in a second or two instead of waiting for the API,
// which sleeps on Render's free tier and can take a minute to wake; the app then asks the API
// only for what changed since this snapshot's version. Run it after the network is rebuilt
// (a new NETWORK_GENERATION in src/lib/sync.ts), once the API serves the new network.
//
//   npm run snapshot                              # from the production API
//   API=http://localhost:8000 npm run snapshot    # from a local one
import { writeFileSync } from "node:fs";

const API = process.env.API ?? "https://trotro-api-gblb.onrender.com";
const OUT = new URL("../public/network/dataset.json", import.meta.url);

const res = await fetch(`${API}/sync/dataset`, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`${API}/sync/dataset answered ${res.status}`);
const snap = await res.json();

// One row per line keeps a refresh reviewable as a diff.
const rows = (xs) => xs.map((x) => JSON.stringify(x)).join(",\n");
const { stations, routes, ...head } = snap;
writeFileSync(
  OUT,
  `${JSON.stringify(head).slice(0, -1)},"stations":[\n${rows(stations)}\n],"routes":[\n${rows(routes)}\n]}\n`
);
console.log(`saved v${snap.version}: ${stations.length} stations, ${routes.length} routes -> ${OUT.pathname}`);
