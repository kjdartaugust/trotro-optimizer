"use client";

/**
 * Choosing one end of a trip: a stop (found offline, as you type), any place the trotros reach
 * (Overture's list on this device, offline too, and OpenStreetMap's through Photon, online), where
 * you are, or a spot on the map. Lines match too, and open their card. Places come nearest first,
 * from where the rider is or else from where the map is looking, with how far each is when we
 * know where the rider is.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { findMorePlaces, type MorePlaces } from "@/lib/morePlaces";
import type { Network } from "@/lib/network";
import { rankPlaces, searchPlaces, SHOWN, type Place } from "@/lib/places";
import { findLines, findStops } from "@/lib/search";
import { metres as distance, type LngLat } from "@/lib/shapes";
import type { End, Field } from "@/lib/trip";
import { metres, routeColor } from "@/lib/format";
import { BackIcon, BusIcon, CloseIcon, HistoryIcon, LocateIcon, MapTapIcon, PinIcon, StopIcon } from "./icons";

type Option =
  | { kind: "me" }
  | { kind: "map" }
  | { kind: "end"; end: End; recent?: boolean }
  | { kind: "line"; id: string; name: string; color: string };

export default function SearchPanel({
  field,
  net,
  more,
  recent,
  online,
  near,
  me,
  onPick,
  onLocate,
  onMap,
  onLine,
  onBack,
}: {
  field: Field;
  net: Network | null;
  /** Overture's places on this device (lib/morePlaces.ts), once loaded. */
  more: MorePlaces | null;
  recent: End[];
  online: boolean;
  /** Places nearest this first: where the rider is, or else where the map is looking. */
  near: LngLat;
  /** Where the rider is, when we know: each result says how far it is. */
  me: LngLat | null;
  onPick: (e: End) => void;
  onLocate: () => void;
  onMap: () => void;
  onLine: (id: string) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const [photon, setPhoton] = useState<Place[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const term = q.trim();
  // Read when a search starts, not a reason to search again: the map moves under the sheet.
  const nearby = useRef({ near, area: net?.area ?? null });
  nearby.current = { near, area: net?.area ?? null };

  useEffect(() => {
    // After the sheet has risen, or iOS scrolls the page to the field.
    const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (term.length < 3 || !online) {
      setPhoton([]);
      setStatus("idle");
      return;
    }
    const ctl = new AbortController();
    setStatus("loading");
    // A pause in typing: one request per thought, not per keystroke.
    const t = setTimeout(() => {
      searchPlaces(term, nearby.current, ctl.signal)
        .then((found) => {
          setPhoton(found);
          setStatus("idle");
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setStatus("error");
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [term, online]);

  // Overture's places answer at once, offline too; Photon's join them when they come.
  const local = useMemo(
    () => (more && term.length >= 3 ? findMorePlaces(more, term, nearby.current.near) : []),
    [more, term]
  );
  const places = useMemo(
    () => (photon.length ? rankPlaces([...local, ...photon], term, nearby.current.near) : local).slice(0, SHOWN),
    [local, photon, term]
  );
  const stops = net ? findStops(net, term) : [];
  const lines = net ? findLines(net, term) : [];
  const groups: { title: string | null; options: Option[] }[] = term
    ? [
        {
          title: "Trotro stops",
          options: stops.map((s) => ({
            kind: "end" as const,
            end: { name: s.name, detail: s.town ?? undefined, at: [s.lon, s.lat], stop: s.id, kind: "stop" as const },
          })),
        },
        {
          title: "Places",
          options: places.map((p) => ({
            kind: "end" as const,
            end: { name: p.name, detail: p.detail, at: p.at, kind: "place" as const },
          })),
        },
        {
          title: "Trotro lines",
          options: lines.map((r) => ({ kind: "line" as const, id: r.id, name: r.name, color: routeColor(r.color) })),
        },
        // Not every place has a name on the map yet: any spot can still be a trip's end.
        { title: "Can't find it?", options: [{ kind: "map" as const }] },
      ]
    : [
        { title: null, options: [{ kind: "me" }, { kind: "map" }] },
        { title: "Recent", options: recent.map((end) => ({ kind: "end" as const, end, recent: true })) },
        {
          title: "Busy stops",
          options: (net?.busiest ?? []).slice(0, 6).map((s) => ({
            kind: "end" as const,
            end: { name: s.name, detail: s.town ?? undefined, at: [s.lon, s.lat], stop: s.id, kind: "stop" as const },
          })),
        },
      ];
  const flat = groups.flatMap((g) => g.options);

  useEffect(() => setActive(0), [term, places.length]);

  function choose(o: Option) {
    if (o.kind === "me") onLocate();
    else if (o.kind === "map") onMap();
    else if (o.kind === "line") onLine(o.id);
    else onPick(o.end);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "Escape") {
      if (q) setQ("");
      else onBack();
    }
  }

  let index = -1;
  return (
    <div className="search-panel">
      <div className="search-row">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <label className="search-field">
          <input
            ref={input}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            placeholder={field === "from" ? "Where from? A stop or place" : "Where to? A stop or place"}
            aria-label={field === "from" ? "Where from" : "Where to"}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="search-results"
            aria-activedescendant={flat.length ? `opt-${active}` : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          {q && (
            <button type="button" className="icon-btn" onClick={() => setQ("")} aria-label="Clear">
              <CloseIcon />
            </button>
          )}
        </label>
      </div>

      <ul id="search-results" className="results" role="listbox">
        {!net && <li className="results-note">Getting the stops ready…</li>}
        {groups.map((g) => (
          <Fragment key={g.title ?? "first"}>
            {g.title === "Can't find it?" && net && !stops.length && !places.length && !lines.length && status !== "loading" && (
              <li className="results-note">Nothing called that yet. Try another spelling.</li>
            )}
            {g.title && g.options.length > 0 && (
              <li className="results-group" role="presentation">
                {g.title}
              </li>
            )}
            {g.options.map((o) => {
              const i = ++index;
              return (
                <li key={key(o)} id={`opt-${i}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    className={i === active ? "active" : undefined}
                    onClick={() => choose(o)}
                    onMouseEnter={() => setActive(i)}
                  >
                    {row(o, field, me)}
                  </button>
                </li>
              );
            })}
            {g.title === "Places" && term.length >= 3 && status === "loading" && places.length === 0 && (
              <li className="results-note">Searching places…</li>
            )}
            {g.title === "Places" && term.length >= 3 && !online && !places.length && (
              <li className="results-note">
                {more ? "More places need the internet. Stops work offline." : "Places need the internet. Stops work offline."}
              </li>
            )}
            {g.title === "Places" && status === "error" && (
              <li className="results-note">Place search isn&apos;t answering. Try a stop, or pick on the map.</li>
            )}
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

function key(o: Option): string {
  if (o.kind === "end") return `${o.recent ? "r" : "e"}:${o.end.name}:${o.end.at.join(",")}`;
  if (o.kind === "line") return `l:${o.id}`;
  return o.kind;
}

function row(o: Option, field: Field, me: LngLat | null): ReactNode {
  const body = (icon: ReactNode, title: string, sub?: string, tone?: string) => (
    <>
      <span className={`result-icon ${tone ?? ""}`}>{icon}</span>
      <span className="result-text">
        <strong>{title}</strong>
        {sub && <small>{sub}</small>}
      </span>
    </>
  );
  if (o.kind === "me") return body(<LocateIcon />, "Where I am", field === "from" ? "Start from here" : "Go here", "accent");
  if (o.kind === "map") return body(<MapTapIcon />, "Choose on the map", "Tap the spot");
  if (o.kind === "line") {
    return body(<span className="line-dot" style={{ background: o.color }} />, o.name, "Trotro line");
  }
  const e = o.end;
  const icon = o.recent ? <HistoryIcon /> : e.kind === "stop" ? <StopIcon /> : e.kind === "place" ? <PinIcon /> : <BusIcon />;
  const what = e.kind === "stop" ? (e.detail ? `Trotro stop · ${e.detail}` : "Trotro stop") : e.detail;
  // How far, the way a map app says it, when we know where the rider is.
  const away = me ? metres(distance(me, e.at)) : null;
  const sub = [away, what].filter(Boolean).join(" · ");
  return body(icon, e.name, sub || undefined);
}
