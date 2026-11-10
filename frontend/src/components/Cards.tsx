"use client";

/**
 * What a tap on the map opens: a trotro line (its stops, times and fares), the lines on a road
 * that several share, a stop (the lines there; start or end a trip at it), a place or a dropped
 * pin, and moving a place's pin to where it really is.
 */
import { cedis, metres, minutes, plural, routeColor } from "@/lib/format";
import { moveProblem, type MorePlace } from "@/lib/morePlaces";
import { nearestStations, stopsOf, termini, type Network } from "@/lib/network";
import { metres as distance, type LngLat } from "@/lib/shapes";
import type { End } from "@/lib/trip";
import { ChevronIcon, CloseIcon, SwapIcon } from "./icons";
import { RoutePill } from "./Options";

function CardHead({ title, sub, onClose }: { title: React.ReactNode; sub?: React.ReactNode; onClose: () => void }) {
  return (
    <div className="card-head">
      <div>
        <h2>{title}</h2>
        {sub && <p className="card-sub">{sub}</p>}
      </div>
      <button type="button" className="icon-btn round" onClick={onClose} aria-label="Close">
        <CloseIcon />
      </button>
    </div>
  );
}

export function EndActions({ end, onStart, onGo }: { end: End; onStart: (e: End) => void; onGo: (e: End) => void }) {
  return (
    <div className="end-actions">
      <button type="button" className="btn primary" onClick={() => onGo(end)}>
        Go here
      </button>
      <button type="button" className="btn" onClick={() => onStart(end)}>
        Start here
      </button>
    </div>
  );
}

export function LineCard({
  net,
  id,
  onOpen,
  onStop,
  onClose,
}: {
  net: Network;
  id: string;
  onOpen: (id: string) => void;
  onStop: (id: string) => void;
  onClose: () => void;
}) {
  const route = net.route.get(id);
  if (!route) {
    return (
      <div className="card rise">
        <CardHead title="Line not found" sub="It may have been taken out of the network." onClose={onClose} />
      </div>
    );
  }
  const stops = stopsOf(net, id);
  const back = net.reverse.get(id);
  let fare = Number(route.board_fare ?? 0), mins = 0;
  const rows = route.stops.map((st, i) => {
    if (i > 0) {
      fare += Number(st.fare_from_prev);
      mins += Number(st.minutes_from_prev);
    }
    return { st: stops[i], fare, mins };
  });
  const color = routeColor(route.color);
  const ends = termini(route.name);
  return (
    <div className="card rise">
      <CardHead
        title={<RoutePill color={route.color} name={route.name} />}
        sub={
          <>
            Trotro line · {plural(stops.length, "stop")} · about {minutes(mins)} end to end ·{" "}
            {cedis(fare)} the whole way{route.verified ? "" : " (estimated)"}
          </>
        }
        onClose={onClose}
      />
      {route.operator && <p className="fine">Run by {route.operator}</p>}
      {back && ends && (
        <button type="button" className="chip" onClick={() => onOpen(back)}>
          <SwapIcon size={16} /> {ends[1]} to {ends[0]} instead
        </button>
      )}
      <ol className="line-stops" style={{ "--c": color } as React.CSSProperties}>
        {rows.map(({ st, fare, mins }, i) =>
          st ? (
            <li key={`${st.id}-${i}`}>
              <button type="button" onClick={() => onStop(st.id)}>
                <span className="ls-name">
                  {st.name}
                  {st.town && st.town !== st.name && <small>{st.town}</small>}
                </span>
                <span className="ls-meta">{i === 0 ? "Board" : `${minutes(mins)} · ${cedis(fare)}`}</span>
              </button>
            </li>
          ) : null
        )}
      </ol>
      <p className="fine">
        Times and fares from the first stop. Stops and route ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap contributors
        </a>
        .
      </p>
    </div>
  );
}

export function LinesHere({
  net,
  ids,
  onOpen,
  onClose,
}: {
  net: Network;
  ids: string[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  // Both directions of a line are one line to a rider: list each once.
  const seen = new Set<string>();
  const routes = ids
    .flatMap((id) => net.route.get(id) ?? [])
    .filter((r) => {
      const back = net.reverse.get(r.id);
      if (seen.has(r.id) || (back && seen.has(back))) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="card rise">
      <CardHead
        title={routes.length === 1 ? "1 trotro line here" : `${routes.length} trotro lines here`}
        sub="Tap one to see its stops, times and fares."
        onClose={onClose}
      />
      <ul className="line-list">
        {routes.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r.id)}>
              <span className="line-dot" style={{ background: routeColor(r.color) }} />
              <span className="ll-name">{r.name}</span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StopCard({
  net,
  id,
  onLine,
  onStart,
  onGo,
  onClose,
}: {
  net: Network;
  id: string;
  onLine: (id: string) => void;
  onStart: (e: End) => void;
  onGo: (e: End) => void;
  onClose: () => void;
}) {
  const s = net.station.get(id);
  if (!s) return null;
  const end: End = { name: s.name, detail: s.town ?? undefined, at: [s.lon, s.lat], stop: s.id, kind: "stop" };
  const lines = (net.servedBy.get(id) ?? []).flatMap((rid) => net.route.get(rid) ?? []);
  return (
    <div className="card rise">
      <CardHead title={s.name} sub={s.town ? `Trotro stop · ${s.town}` : "Trotro stop"} onClose={onClose} />
      <EndActions end={end} onStart={onStart} onGo={onGo} />
      <h3 className="card-h3">{lines.length === 1 ? "1 trotro line stops here" : `${lines.length} trotro lines stop here`}</h3>
      <ul className="line-list">
        {lines.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onLine(r.id)}>
              <span className="line-dot" style={{ background: routeColor(r.color) }} />
              <span className="ll-name">{r.name}</span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PinCard({
  net,
  at,
  name,
  detail,
  place,
  fixed,
  onMove,
  onStart,
  onGo,
  onClose,
}: {
  net: Network;
  at: LngLat;
  name: string | null;
  /** What and where a tapped place is: "Pharmacy · Osu". */
  detail?: string;
  /** A named place tapped on the map, not a spot. */
  place?: boolean;
  /** Riders moved it here. */
  fixed?: boolean;
  /** Offered for the places we draw: move its pin to where it really is. */
  onMove?: () => void;
  onStart: (e: End) => void;
  onGo: (e: End) => void;
  onClose: () => void;
}) {
  const end: End = { name: name ?? "Dropped pin", detail, at, kind: place ? "place" : "pin" };
  const nearest = nearestStations(net, at, Infinity)[0];
  const stop = nearest ? `Nearest trotro stop: ${nearest.s.name}, ${metres(nearest.m)} away` : "No trotro stops yet";
  return (
    <div className="card rise">
      <CardHead
        title={name ?? "Dropped pin"}
        sub={
          detail ? (
            <>
              {detail}
              <br />
              {stop}
            </>
          ) : (
            stop
          )
        }
        onClose={onClose}
      />
      <EndActions end={end} onStart={onStart} onGo={onGo} />
      {onMove && (
        <p className="card-foot">
          {fixed && "A rider put it here. "}
          <button type="button" className="link-btn" onClick={onMove}>
            Wrong spot? Move it
          </button>
        </p>
      )}
    </div>
  );
}

/** Moving a place's pin to where it really is: drag the pin or tap the map, then save. */
export function MoveCard({
  place,
  to,
  saving,
  onSave,
  onCancel,
}: {
  place: MorePlace;
  /** Where the pin is now, once moved; null until then. */
  to: LngLat | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const problem = to ? moveProblem(place, to) : null;
  // Short enough that Save shows with the sheet down and the map, where the pin is, in view.
  const status = !to
    ? "Drag the pin onto its building, or tap the map where it really is."
    : (problem ?? `${metres(distance(place.at, to))} from where it was. Save it, or move it again.`);
  return (
    <div className="card rise">
      <CardHead title={`Move ${place.name}`} sub={<span role="status">{status}</span>} onClose={onCancel} />
      <div className="end-actions">
        <button type="button" className="btn primary" disabled={!to || !!problem || saving} onClick={onSave}>
          {saving ? "Saving…" : "Save this spot"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="fine">Everyone sees the new spot. Anyone can move it again if it&apos;s still wrong.</p>
    </div>
  );
}
