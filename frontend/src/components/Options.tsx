"use client";

/** The trip's options side by side: time, fare and changes at a glance; tap one to follow it. */
import { Fragment } from "react";
import type { Network } from "@/lib/network";
import { cedis, inkOn, minutes, minutesShort, plural, routeColor } from "@/lib/format";
import { optionLabel, type TripOption } from "@/lib/trip";
import { WalkIcon } from "./icons";

export default function Options({
  options,
  chosen,
  net,
  onChoose,
}: {
  options: TripOption[];
  chosen: number;
  net: Network;
  onChoose: (i: number) => void;
}) {
  return (
    <div className={`options n${options.length}`} role="tablist" aria-label="Ways to go">
      {options.map((o, i) => (
        <button
          key={o.modes.join("-")}
          type="button"
          role="tab"
          aria-selected={i === chosen}
          className={`option ${i === chosen ? "chosen" : ""}`}
          onClick={() => onChoose(i)}
        >
          <span className="option-label">{optionLabel(o.modes)}</span>
          <span className="option-time">
            {options.length === 3 ? minutesShort(o.it.totalMinutes) : minutes(o.it.totalMinutes)}
          </span>
          <span className="option-fare">{cedis(o.it.totalFare)}</span>
          <span className="option-meta">
            {o.it.transfers ? plural(o.it.transfers, "change") : "No changes"}
          </span>
          {options.length < 3 && <Strip option={o} net={net} />}
        </button>
      ))}
    </div>
  );
}

/** The trip in one line: walk, trotro, walk, trotro… */
export function Strip({ option, net }: { option: TripOption; net: Network }) {
  const legs = option.it.legs.filter((l) => l.kind === "ride" || l.distanceM >= 25);
  return (
    <span className="strip" aria-hidden="true">
      {legs.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="strip-sep">›</span>}
          {l.kind === "walk" ? (
            <span className="strip-walk">
              <WalkIcon size={14} />
              {Math.max(1, Math.round(l.minutes))}
            </span>
          ) : (
            <RoutePill color={net.route.get(l.routeId ?? "")?.color} name={l.routeName ?? "Trotro"} />
          )}
        </Fragment>
      ))}
    </span>
  );
}

export function RoutePill({ color, name }: { color?: string | null; name: string }) {
  const bg = routeColor(color);
  return (
    <span className="pill" style={{ background: bg, color: inkOn(bg) }} title={name}>
      {name}
    </span>
  );
}
