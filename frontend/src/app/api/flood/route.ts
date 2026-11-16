/**
 * GET /api/flood: FloodWatch Ghana's rain forecast for every trotro line, for flood warnings on
 * trips (lib/flood.ts). The app asks here, not FloodWatch itself, because FloodWatch's free
 * server sleeps when idle and takes about 100 seconds to wake, and a rider can't wait on that.
 *
 * This is a page Next keeps (`revalidate`): every rider gets the kept answer at once. Once it's
 * older than `revalidate`, the next ask still gets it at once and sets off a fresh one behind
 * the rider's back. A fresh one that fails (FloodWatch asleep, or down) throws, and Next then
 * keeps serving the last good answer: the asking has started FloodWatch waking, so the try after
 * succeeds. FloodWatch's own rain check asks here just after it finishes, when its server is
 * awake, so riders seldom set off a fresh one at all.
 *
 * Kept that long because FloodWatch's forecast only changes every three hours, and its hours are
 * clock times: an old answer is still right about the hours left in it. And because every ask of
 * FloodWatch wakes its server, which has a monthly allowance of waking hours: this asks at most
 * once per `revalidate`, however many riders there are.
 *
 * Nothing about the rider goes anywhere: the whole city's forecast comes down, about 40 KB, and
 * the phone works out its own trip.
 */
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { NOTHING_YET, readFloodWatch } from "@/lib/floodFeed";

// 175 minutes: just under FloodWatch's three hours between rain checks, so the ask that follows
// each check always fetches the new forecast.
export const revalidate = 10500;
// As long as a host on a free plan lets a function run.
export const maxDuration = 60;

const WAIT_MS = 50_000;
// While a deploy is building there is time to let a sleeping FloodWatch wake, so the new version
// starts with a real forecast (next.config.mjs gives the build that long).
const BUILD_WAIT_MS = 150_000;

export async function GET() {
  // Only the deployed app asks FloodWatch unbidden. A laptop, a test run or CI must not wake its
  // server, nor wait on it: there, flood warnings stay off unless FLOODWATCH_API_URL says whom to ask.
  if (!process.env.VERCEL && !process.env.FLOODWATCH_API_URL) return Response.json(NOTHING_YET);
  const building = process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
  try {
    return Response.json(await readFloodWatch(building ? BUILD_WAIT_MS : WAIT_MS));
  } catch (err) {
    if (building) return Response.json(NOTHING_YET); // FloodWatch being down must not fail a deploy
    throw err; // not an answer to keep: the last good one stays
  }
}
