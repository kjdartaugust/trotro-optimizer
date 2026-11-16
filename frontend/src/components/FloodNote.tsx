"use client";

/**
 * What FloodWatch expects on the open trip, in a rider's words: the rain, then which trotro
 * meets water and where; or, when every ride could be judged and none floods, one quiet line
 * saying so. Said with how fresh the forecast is, and a way through to FloodWatch itself.
 */
import type { Itinerary } from "@/engine/engine";
import {
  checkedWords,
  FLOOD_TEXT,
  FLOODWATCH_SITE,
  rainWords,
  RANK,
  whenWords,
  type FloodFeed,
} from "@/lib/flood";
import { termini, type Network } from "@/lib/network";
import { rideWords, type TripFlood } from "@/lib/tripFlood";
import { CheckIcon, FloodIcon } from "./icons";

export default function FloodNote({
  flood,
  it,
  net,
  feed,
  now,
}: {
  flood: TripFlood;
  it: Itinerary;
  net: Network;
  feed: FloodFeed;
  now: number;
}) {
  const checked = checkedWords(feed, now);
  if (flood.status === "clear") {
    // Clear only counts when every ride was judged: otherwise it's silence, not a promise.
    if (!flood.judged) return null;
    return (
      <p className="flood-clear">
        <CheckIcon size={15} />
        <span>
          No flooding expected on this trip in the next few hours.{" "}
          <a href={FLOODWATCH_SITE} target="_blank" rel="noreferrer">
            FloodWatch
          </a>
          {checked && `, ${checked}`}
        </span>
      </p>
    );
  }
  const rides = it.legs.flatMap((leg, i) => {
    const f = flood.legs[i];
    return f && f.status !== "clear" ? [{ leg, f }] : [];
  });
  // The worst ride's rain opens the notice; the first of them, where two are as bad.
  const worst = rides.reduce((a, b) => (RANK[b.f.status] > RANK[a.f.status] ? b : a));
  const text = FLOOD_TEXT[flood.status];
  return (
    <aside className={`flood-note flood-${flood.status}`} role="status">
      <span className="flood-note-icon" aria-hidden="true">
        <FloodIcon size={20} />
      </span>
      <div className="flood-note-body">
        <strong>{text.title}</strong>
        <p>{rainWords(worst.f, now)}.</p>
        {rides.map(({ leg, f }, i) => (
          <p key={i}>
            {rideWords(
              f,
              termini(net.route.get(leg.routeId ?? "")?.name ?? "")?.[1],
              f.at === worst.f.at ? null : whenWords(f.at, now)
            )}
          </p>
        ))}
        <p>{text.advice}</p>
        <p className="flood-source">
          <a href={`${FLOODWATCH_SITE}/?route=${encodeURIComponent(worst.f.line)}`} target="_blank" rel="noreferrer">
            See this line on FloodWatch
          </a>
          {checked && ` · ${checked}`}
        </p>
      </div>
    </aside>
  );
}
