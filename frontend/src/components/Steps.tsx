"use client";

/**
 * Step by step, the way you'd tell a friend: walk here, take the trotro to Nungua, get off at GBC
 * Second after 9 stops. Each ride in its trotro's colour; tap it to see the stops on the way.
 */
import Link from "next/link";
import type { Leg } from "@/engine/engine";
import { cedis, metres, minutes, plural, routeColor } from "@/lib/format";
import { rideSpan, stopsOf, termini, type Network } from "@/lib/network";
import type { End, TripOption } from "@/lib/trip";
import { ChevronIcon, WalkIcon } from "./icons";
import { RoutePill } from "./Options";

export default function Steps({
  option,
  net,
  from,
  to,
  estimated,
  onLine,
}: {
  option: TripOption;
  net: Network;
  from: End;
  to: End;
  estimated: boolean;
  onLine: (id: string) => void;
}) {
  const it = option.it;
  // A walk of a few metres is the trip starting or ending right at a stop: nothing to do.
  const legs = it.legs.filter((l) => l.kind === "ride" || l.distanceM >= 25);
  return (
    <div className="steps-wrap">
      <ol className="steps">
        <li className="step place">
          <span className="step-mark from" aria-hidden="true" />
          <div className="step-body">
            <strong>{from.name}</strong>
            <small>Start</small>
          </div>
        </li>
        {legs.map((leg, i) =>
          leg.kind === "walk" ? (
            <WalkStep key={i} leg={leg} last={i === legs.length - 1} to={to} />
          ) : (
            <RideStep key={i} leg={leg} net={net} estimated={estimated} onLine={onLine} />
          )
        )}
        <li className="step place">
          <span className="step-mark to" aria-hidden="true" />
          <div className="step-body">
            <strong>{to.name}</strong>
            <small>
              Arrive after about {minutes(it.totalMinutes)} · {cedis(it.totalFare)} in all
            </small>
          </div>
        </li>
      </ol>
      {estimated && (
        <p className="fine">
          Fares and times are estimates until riders report real ones: the lowest trotro fare
          when you board, plus a little per km. <Link href="/contribute">Report a fare</Link>
        </p>
      )}
    </div>
  );
}

function WalkStep({ leg, last, to }: { leg: Leg; last: boolean; to: End }) {
  return (
    <li className="step walk">
      <span className="step-icon" aria-hidden="true">
        <WalkIcon size={16} />
      </span>
      <div className="step-body">
        <p>
          Walk {metres(leg.distanceM)} to <b>{last ? to.name : leg.toName ?? "the stop"}</b>
        </p>
        <small>About {minutes(leg.minutes)}</small>
      </div>
    </li>
  );
}

function RideStep({
  leg,
  net,
  estimated,
  onLine,
}: {
  leg: Leg;
  net: Network;
  estimated: boolean;
  onLine: (id: string) => void;
}) {
  const route = net.route.get(leg.routeId ?? "");
  const color = routeColor(route?.color);
  const name = route?.name ?? leg.routeName ?? "Trotro";
  // Riders know a trotro by where it's going: that's what the mate calls out.
  const towards = termini(name)?.[1];
  const span = route ? rideSpan(net, route.id, leg.fromStation, leg.toStation, leg.numStops) : null;
  const between = span && route ? stopsOf(net, route.id).slice(span[0] + 1, span[1]) : [];
  return (
    <li className="step ride" style={{ "--c": color } as React.CSSProperties}>
      <div className="step-body">
        <p className="ride-title">
          <b>{towards ? `Trotro to ${towards}` : "Trotro"}</b>
          {route && (
            <button type="button" className="pill-btn" onClick={() => onLine(route.id)} aria-label={`See the ${name} line`}>
              <RoutePill color={route.color} name={name} />
              <ChevronIcon size={14} />
            </button>
          )}
        </p>
        <p>
          Board at <b>{leg.fromName}</b>
        </p>
        {between.length > 0 ? (
          <details className="ride-stops">
            <summary>
              {plural(leg.numStops, "stop")} · {minutes(leg.minutes)}
            </summary>
            <ol>
              {between.map((s, i) => (
                <li key={`${s.id}-${i}`}>{s.name}</li>
              ))}
            </ol>
          </details>
        ) : (
          <small>
            {plural(leg.numStops, "stop")} · {minutes(leg.minutes)}
          </small>
        )}
        <p>
          Get off at <b>{leg.toName}</b>
        </p>
        <p className="ride-fare">
          <strong>{cedis(leg.fare)}</strong>
          {estimated && !route?.verified && <span className="tag">estimate</span>}
          {route && (
            <Link href={`/contribute?route=${encodeURIComponent(route.id)}`} className="quiet-link">
              Paid something else?
            </Link>
          )}
        </p>
      </div>
    </li>
  );
}
