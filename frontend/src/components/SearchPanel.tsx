"use client";

/**
 * Choosing one end of a trip: a stop (found offline, as you type), any place in Ghana (online),
 * where you are, or a spot on the map. Lines match too, and open their card.
 */
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Network } from "@/lib/network";
import { searchPlaces, type Place } from "@/lib/places";
import { findLines, findStops } from "@/lib/search";
import type { End, Field } from "@/lib/trip";
import { routeColor } from "@/lib/format";
import { BackIcon, BusIcon, CloseIcon, HistoryIcon, LocateIcon, MapTapIcon, PinIcon, StopIcon } from "./icons";

type Option =
  | { kind: "me" }
  | { kind: "map" }
  | { kind: "end"; end: End; recent?: boolean }
  | { kind: "line"; id: string; name: string; color: string };

export default function SearchPanel({
  field,
  net,
  recent,
  online,
  onPick,
  onLocate,
  onMap,
  onLine,
  onBack,
}: {
  field: Field;
  net: Network | null;
  recent: End[];
  online: boolean;
  onPick: (e: End) => void;
  onLocate: () => void;
  onMap: () => void;
  onLine: (id: string) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const term = q.trim();

  useEffect(() => {
    // After the sheet has risen, or iOS scrolls the page to the field.
    const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (term.length < 3 || !online) {
      setPlaces([]);
      setStatus("idle");
      return;
    }
    const ctl = new AbortController();
    setStatus("loading");
    // A pause in typing: one request per thought, not per keystroke.
    const t = setTimeout(() => {
      searchPlaces(term, ctl.signal)
        .then((found) => {
          setPlaces(found);
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
                    {row(o, field)}
                  </button>
                </li>
              );
            })}
            {g.title === "Places" && term.length >= 3 && status === "loading" && places.length === 0 && (
              <li className="results-note">Searching places…</li>
            )}
            {g.title === "Places" && term.length >= 3 && !online && (
              <li className="results-note">Places need the internet. Stops work offline.</li>
            )}
            {g.title === "Places" && status === "error" && (
              <li className="results-note">Place search isn&apos;t answering. Try a stop, or pick on the map.</li>
            )}
          </Fragment>
        ))}
        {net && term && flat.length === 0 && status !== "loading" && (
          <li className="results-note">Nothing called that yet. Try another spelling, or pick on the map.</li>
        )}
      </ul>
    </div>
  );
}

function key(o: Option): string {
  if (o.kind === "end") return `${o.recent ? "r" : "e"}:${o.end.name}:${o.end.at.join(",")}`;
  if (o.kind === "line") return `l:${o.id}`;
  return o.kind;
}

function row(o: Option, field: Field): ReactNode {
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
  const sub = e.kind === "stop" ? (e.detail ? `Trotro stop · ${e.detail}` : "Trotro stop") : e.detail;
  return body(icon, e.name, sub);
}
