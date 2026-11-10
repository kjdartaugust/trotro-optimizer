"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LineCard, LinesHere, MoveCard, PinCard, StopCard } from "@/components/Cards";
import { HistoryIcon, LocateIcon, MapTapIcon, SearchIcon, ShareIcon } from "@/components/icons";
import Options from "@/components/Options";
import SearchPanel from "@/components/SearchPanel";
import Sheet, { isDesktop, sheetHeight, type Snap } from "@/components/Sheet";
import Steps from "@/components/Steps";
import type { Drawn, TappedPlace } from "@/components/TripMap";
import TripFields from "@/components/TripFields";
import { DEFAULT_OPTS } from "@/engine/engine";
import { devLogin, isOnline, loadToken } from "@/lib/api";
import { submitContribution } from "@/lib/contribute";
import { allPlaceFixes, allRoutes, allStations, hasDataset, outbox, putPlaceFixes } from "@/lib/db";
import { cedis, metres, minutes, routeColor } from "@/lib/format";
import {
  buildNetwork,
  nearestStations,
  ridePath,
  rideSpan,
  routeLine,
  stopsOf,
  type Network,
} from "@/lib/network";
import {
  detailOf,
  loadMorePlaces,
  LOCAL_FIX,
  moveProblem,
  placeKey,
  withFixes,
  type MorePlaces,
} from "@/lib/morePlaces";
import { nameOf } from "@/lib/places";
import { planTrip, warmPlanner } from "@/lib/plan";
import { loadShapes, metres as distance, type LngLat } from "@/lib/shapes";
import { ensureNetwork, flush, pull } from "@/lib/sync";
import {
  endParam,
  options as toOptions,
  parseEnd,
  recentEnds,
  recentTrips,
  rememberTrip,
  type End,
  type Field,
  type Recent,
  type TripOption,
} from "@/lib/trip";
import type { ApiPlaceFix } from "@/lib/types";

// MapLibre touches window: client only.
const TripMap = dynamic(() => import("@/components/TripMap"), {
  ssr: false,
  loading: () => <div className="map map-placeholder" />,
});

type Panel =
  | { kind: "home" }
  | { kind: "search"; field: Field }
  | { kind: "pick"; field: Field }
  | { kind: "line"; id: string }
  | { kind: "lines"; ids: string[] }
  | { kind: "stop"; id: string }
  // `place`: a named place tapped on the map, not just a spot; `i`: one of Overture's (lib/morePlaces).
  | { kind: "pin"; at: LngLat; name: string | null; detail?: string; place?: boolean; i?: number }
  // Moving Overture's place `i` to where it really is; `to`: where the pin is now, once moved.
  | { kind: "move"; i: number; to: LngLat | null };

type Result =
  | { state: "planning" }
  | { state: "found"; options: TripOption[]; estimated: boolean }
  // `instead`: the nearest stop, to start or end the trip at when the place itself is too far.
  | { state: "none"; why: string; instead?: { field: Field; end: End } };

// The planner walks to the nearest stops up to this far when none is within 900 m.
const ACCESS_M = DEFAULT_OPTS.accessRadiusM;
// Where the map opens (TripMap's ACCRA): places are found nearest here until the map moves.
const START_VIEW: LngLat = [-0.205, 5.6];
const NO_NAMES: string[] = [];

export default function Home() {
  const [net, setNet] = useState<Network | null>(null);
  const [load, setLoad] = useState<"opening" | "first" | "ready" | "error">("opening");
  const [online, setOnline] = useState(true);
  const [from, setFrom] = useState<End | null>(null);
  const [to, setTo] = useState<End | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [chosen, setChosen] = useState(0);
  const [panel, setPanel] = useState<Panel>({ kind: "home" });
  const [snap, setSnap] = useState<Snap>("peek");
  const [me, setMe] = useState<LngLat | null>(null);
  const [locating, setLocating] = useState(false);
  const [fit, setFit] = useState<{ coords: LngLat[]; seq: number } | null>(null);
  const [focus, setFocus] = useState<{ at: LngLat; zoom?: number; seq: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [more, setMore] = useState<MorePlaces | null>(null);
  const [saving, setSaving] = useState(false);
  const ends = useRef({ from, to });
  ends.current = { from, to };
  const ticket = useRef(0);
  const linked = useRef(false);
  const view = useRef<LngLat>(START_VIEW);

  const frame = (coords: LngLat[]) => setFit((f) => ({ coords, seq: (f?.seq ?? 0) + 1 }));

  const refresh = useCallback(async () => {
    const [stations, routes, shapes] = await Promise.all([allStations(), allRoutes(), loadShapes()]);
    setNet(buildNetwork(stations, routes, shapes));
  }, []);

  const open = useCallback(async () => {
    setLoad((await hasDataset()) ? "opening" : "first");
    try {
      // Fast: this device's copy, or on a first visit the snapshot from the CDN.
      await ensureNetwork();
      await refresh();
      setLoad("ready");
      warmPlanner();
    } catch {
      setLoad("error");
      return;
    }
    // The shops, offices and the rest for the map and search: after the trotros, never before,
    // where riders have put them.
    void loadMorePlaces().then(async (m) => {
      if (m) setMore(withFixes(m, await allPlaceFixes().catch(() => [])));
    });
    // Then catch up with the API, which can take a minute to wake: nothing waits on it.
    try {
      const { changed, fixed } = await pull();
      if (changed) await refresh();
      if (fixed) {
        const fixes = await allPlaceFixes();
        setMore((m) => m && withFixes(m, fixes));
      }
      if ((await outbox()).length) {
        if (!loadToken()) await devLogin().catch(() => null);
        await flush();
      }
    } catch {
      // Offline, or the API is asleep: the network on this device is enough to plan.
    }
  }, [refresh]);

  useEffect(() => {
    setOnline(isOnline());
    setRecent(recentTrips());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    void open();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Choosing the ends ────────────────────────────────────────────────────────────────────────

  const locate = useCallback((field: Field) => {
    if (!("geolocation" in navigator)) {
      setToast("This browser can't share its location.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const at: LngLat = [pos.coords.longitude, pos.coords.latitude];
        setMe(at);
        choose(field, { name: "Where I am", at, kind: "me" });
      },
      () => {
        setLocating(false);
        setToast("Couldn't get your location. Search a stop or place instead.");
        setPanel({ kind: "search", field });
        setSnap("full");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(field: Field, e: End) {
    if (field === "from") setFrom(e);
    else setTo(e);
    const other = field === "from" ? ends.current.to : ends.current.from;
    if (other) {
      setPanel({ kind: "home" });
      setSnap("half");
      return;
    }
    if (field === "from") {
      edit("to");
      return;
    }
    // A destination first: start from where you are if the phone already lets us know, else ask.
    setPanel({ kind: "home" });
    setSnap("half");
    const ask = () => edit("from");
    if (!navigator.permissions?.query) return ask();
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((p) => (p.state === "granted" ? locate("from") : ask()))
      .catch(ask);
  }

  function edit(field: Field) {
    setPanel({ kind: "search", field });
    setSnap("full");
    sense();
  }

  // If the phone already lets us know where the rider is, find out quietly (never ask from here),
  // so places come nearest them first, with how far each is.
  function sense() {
    if (me || !("geolocation" in navigator) || !navigator.permissions?.query) return;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((p) => {
        if (p.state !== "granted") return;
        navigator.geolocation.getCurrentPosition(
          (pos) => setMe([pos.coords.longitude, pos.coords.latitude]),
          () => undefined,
          { maximumAge: 120_000, timeout: 8_000 }
        );
      })
      .catch(() => undefined);
  }

  function pickOnMap(field: Field) {
    setPanel({ kind: "pick", field });
    setSnap("peek");
  }

  function swap() {
    setFrom(to);
    setTo(from);
  }

  function clearTrip() {
    setFrom(null);
    setTo(null);
    setResult(null);
    setPanel({ kind: "home" });
    setSnap("peek");
  }

  function openRecent(r: Recent) {
    setTo(r.to);
    if (r.from.kind === "me") {
      setFrom(null);
      locate("from");
    } else {
      setFrom(r.from);
    }
    setPanel({ kind: "home" });
    setSnap("half");
  }

  // ── Map taps ─────────────────────────────────────────────────────────────────────────────────

  const openLine = useCallback(
    (id: string) => {
      setPanel({ kind: "line", id });
      setSnap("half");
      if (net) frame(routeLine(net, id));
    },
    [net]
  );

  function tapped(at: LngLat, place?: TappedPlace) {
    // A place on the map has its name already; a bare spot is named by asking Photon.
    const known = place?.i !== undefined ? more?.list[place.i] : undefined;
    const detail = known ? detailOf(known, true) : undefined;
    if (panel.kind === "pick") {
      const field = panel.field;
      if (place) {
        choose(field, { name: place.name, detail, at, kind: "place" });
        return;
      }
      choose(field, { name: "Pin on the map", at, kind: "pin" });
      void nameOf(at).then((name) => {
        if (!name) return;
        const named = (e: End | null) => (e && e.at === at ? { ...e, name } : e);
        if (field === "from") setFrom(named);
        else setTo(named);
      });
      return;
    }
    setSnap("peek");
    if (place) {
      setPanel({ kind: "pin", at, name: place.name, detail, place: true, i: place.i });
      return;
    }
    setPanel({ kind: "pin", at, name: null });
    void nameOf(at).then((name) =>
      setPanel((p) => (p.kind === "pin" && p.at === at ? { ...p, name } : p))
    );
  }

  function tappedStop(id: string) {
    setPanel({ kind: "stop", id });
    setSnap("half");
    // Bring it into the part of the map the sheet leaves showing.
    const s = net?.station.get(id);
    if (s) setFocus((f) => ({ at: [s.lon, s.lat], seq: (f?.seq ?? 0) + 1 }));
  }

  function tappedLines(ids: string[]) {
    if (ids.length === 1) {
      openLine(ids[0]);
      return;
    }
    setPanel({ kind: "lines", ids });
    setSnap("half");
  }

  function closeCard() {
    setPanel({ kind: "home" });
    setSnap(from && to ? "half" : "peek");
  }

  // ── Moving a place on the wrong spot ─────────────────────────────────────────────────────────

  function placeCard(i: number, at?: LngLat) {
    const p = more?.list[i];
    if (p) setPanel({ kind: "pin", at: at ?? p.at, name: p.name, detail: detailOf(p, true), place: true, i });
  }

  function startMove(i: number) {
    const p = more?.list[i];
    if (!p) return;
    setPanel({ kind: "move", i, to: null });
    setSnap("peek");
    // Close enough to see the buildings.
    setFocus((f) => ({ at: p.at, zoom: 17.5, seq: (f?.seq ?? 0) + 1 }));
  }

  async function saveMove(i: number, dropped: LngLat) {
    const p = more?.list[i];
    // To the 10 cm: more is noise from the finger.
    const to: LngLat = [Math.round(dropped[0] * 1e6) / 1e6, Math.round(dropped[1] * 1e6) / 1e6];
    if (!p || moveProblem(p, to) || saving) return;
    setSaving(true);
    try {
      // On this phone at once, offline too; for everyone once the server has it.
      const fix: ApiPlaceFix = {
        key: placeKey(p),
        name: p.name,
        from_lon: p.origin[0],
        from_lat: p.origin[1],
        lon: to[0],
        lat: to[1],
        version: LOCAL_FIX,
      };
      await putPlaceFixes([fix]);
      const fixes = await allPlaceFixes();
      setMore((m) => m && withFixes(m, fixes));
      // A trip to or from it goes to the new spot too.
      const follow = (e: End | null) => (e && e.name === p.name && distance(e.at, p.at) < 5 ? { ...e, at: to } : e);
      setFrom(follow);
      setTo(follow);
      const res = await submitContribution("place", null, { key: fix.key, name: p.name, from: p.origin, to });
      setToast(
        res.refused
          ? "Lots of pins moved from here this hour: others will see this one later. Try again in a while."
          : res.pushed
            ? `Moved. Everyone now sees ${p.name} here.`
            : "Saved on this phone. Everyone sees it once you're online."
      );
      placeCard(i, to);
    } catch {
      setToast("Couldn't save that spot. Try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Planning ─────────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!net || !from || !to) {
      setResult(null);
      return;
    }
    const mine = ++ticket.current;
    setResult({ state: "planning" });
    const far = ([["from", from], ["to", to]] as const).find(([, e]) => !nearestStations(net, e.at, ACCESS_M).length);
    if (far) {
      const [field, e] = far;
      const near = nearestStations(net, e.at, Infinity)[0];
      setResult(
        near
          ? {
              state: "none",
              why:
                `The nearest trotro stop we know is ${near.s.name}, ${metres(near.m)} from ${e.name}: too far to walk. ` +
                (field === "from" ? "Get a taxi there and start from it." : "Ride there, then get a taxi."),
              instead: {
                field,
                end: { name: near.s.name, detail: near.s.town ?? undefined, at: [near.s.lon, near.s.lat], stop: near.s.id, kind: "stop" },
              },
            }
          : { state: "none", why: "There are no trotro stops on this phone yet." }
      );
      return;
    }
    planTrip([from.at[1], from.at[0]], [to.at[1], to.at[0]])
      .then(({ itineraries, estimated }) => {
        if (mine !== ticket.current) return;
        const found = toOptions(itineraries);
        if (!found.length) {
          const m = distance(from.at, to.at);
          setResult({
            state: "none",
            why:
              m <= 1500
                ? `These are ${metres(m)} apart: about ${minutes(m / 75)} on foot.`
                : "No trotro route found between these yet.",
          });
          return;
        }
        setResult({ state: "found", options: found, estimated });
        setChosen(0);
        rememberTrip(from, to);
        setRecent(recentTrips());
      })
      .catch(() => {
        if (mine === ticket.current) setResult({ state: "none", why: "Couldn't plan this trip. Try again." });
      });
  }, [net, from, to]);

  const option = result?.state === "found" ? result.options[chosen] : null;

  const drawn = useMemo<Drawn | null>(() => {
    if (!net) return null;
    if (panel.kind === "line") return lineDrawn(net, panel.id);
    if (panel.kind === "lines") {
      // The lines on the road that was tapped, each in its colour: where they all go.
      return {
        rides: panel.ids.map((id) => ({ color: routeColor(net.route.get(id)?.color), coords: routeLine(net, id) })),
        walks: [],
        points: [],
      };
    }
    if (panel.kind === "stop" || panel.kind === "pin") {
      const s = panel.kind === "stop" ? net.station.get(panel.id) : null;
      const at: LngLat | null = panel.kind === "pin" ? panel.at : s ? [s.lon, s.lat] : null;
      return at ? { rides: [], walks: [], points: [{ at, color: routeColor(null), major: true }] } : null;
    }
    if (option && from && to) return tripDrawn(net, option, from, to);
    return null;
  }, [net, panel, option, from, to]);

  // Frame each trip as it's found or another option is chosen.
  useEffect(() => {
    if (drawn && option && panel.kind === "home") {
      frame([...drawn.rides.flatMap((r) => r.coords), ...drawn.walks.flat()]);
    }
  }, [option]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fly to a lone end while the other is still to come.
  useEffect(() => {
    const lone = from && !to ? from : to && !from ? to : null;
    if (lone) setFocus((f) => ({ at: lone.at, zoom: 14.5, seq: (f?.seq ?? 0) + 1 }));
  }, [from, to]);

  // ── Links: every trip and line has one, to send on WhatsApp or open again ──────────────────

  useEffect(() => {
    if (!net || linked.current) return;
    linked.current = true;
    const p = new URLSearchParams(window.location.search);
    const line = p.get("line");
    if (line && net.route.has(line)) {
      openLine(line);
      return;
    }
    const f = parseEnd(p.get("from")), t = parseEnd(p.get("to"));
    if (f) setFrom(f);
    if (t) setTo(t);
    if (f && t) setSnap("half");
  }, [net, openLine]);

  useEffect(() => {
    if (!linked.current) return;
    const p = new URLSearchParams();
    if (panel.kind === "line") p.set("line", panel.id);
    else {
      if (from) p.set("from", endParam(from));
      if (to) p.set("to", endParam(to));
    }
    const q = p.toString();
    window.history.replaceState(null, "", q ? `/?${q}` : "/");
  }, [from, to, panel]);

  async function share() {
    if (!option || !from || !to) return;
    const text = `${from.name} to ${to.name} by trotro: about ${minutes(option.it.totalMinutes)}, ${cedis(option.it.totalFare)}.`;
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: "TroTro trip", text, url });
      } catch {
        // Closing the share sheet isn't an error worth showing.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setToast("Link copied");
    } catch {
      setToast("Couldn't copy the link.");
    }
  }

  // ── Layout ───────────────────────────────────────────────────────────────────────────────────

  // Keep what's framed clear of the sheet (phone) or the panel (desktop).
  const padding = isDesktop()
    ? { top: 96, left: 456, right: 48, bottom: 40 }
    : { top: 80, left: 20, right: 20, bottom: sheetHeight("half") + 8 };

  const network = useMemo(
    () => (net ? net.routes.map((r) => ({ id: r.id, coords: routeLine(net, r.id) })) : []),
    [net]
  );

  const straight = from && to ? distance(from.at, to.at) : Infinity;

  return (
    <main className="mapview">
      <TripMap
        network={network}
        stops={net?.stations ?? []}
        places={more?.geojson ?? null}
        hiddenOsm={more?.hideOsm ?? NO_NAMES}
        drawn={drawn}
        from={from?.at ?? null}
        to={to?.at ?? null}
        me={me}
        fit={fit}
        focus={focus}
        padding={padding}
        picking={panel.kind === "pick"}
        moving={panel.kind === "move" ? (panel.to ?? more?.list[panel.i]?.at ?? null) : null}
        onTap={tapped}
        onStop={tappedStop}
        onLines={tappedLines}
        onMoved={(c) => (view.current = c)}
        onMovePin={(at) => setPanel((p) => (p.kind === "move" ? { ...p, to: at } : p))}
      />
      {panel.kind === "pick" && (
        <div className="map-hint" role="status">
          <MapTapIcon /> Tap where you want to {panel.field === "from" ? "start" : "go"}
        </div>
      )}
      {panel.kind === "move" && (
        <div className="map-hint" role="status">
          <MapTapIcon /> Drag the pin, or tap where it really is
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      <Sheet snap={snap} onSnap={setSnap} label="Plan a trotro trip">
        {load !== "ready" ? (
          <Opening state={load} onRetry={open} />
        ) : panel.kind === "search" ? (
          <SearchPanel
            key={panel.field}
            field={panel.field}
            net={net}
            more={more}
            recent={recentEnds()}
            online={online}
            near={me ?? view.current}
            me={me}
            onPick={(e) => choose(panel.field, e)}
            onLocate={() => locate(panel.field)}
            onMap={() => pickOnMap(panel.field)}
            onLine={openLine}
            onBack={closeCard}
          />
        ) : panel.kind === "pick" ? (
          <div className="pick-bar rise">
            <span className="result-icon accent">
              <MapTapIcon />
            </span>
            <p>
              <strong>Tap the map</strong> where you want to {panel.field === "from" ? "start" : "go"}.
            </p>
            <button type="button" className="btn" onClick={() => edit(panel.field)}>
              Cancel
            </button>
          </div>
        ) : panel.kind === "line" && net ? (
          <LineCard net={net} id={panel.id} onOpen={openLine} onStop={tappedStop} onClose={closeCard} />
        ) : panel.kind === "lines" && net ? (
          <LinesHere net={net} ids={panel.ids} onOpen={openLine} onClose={closeCard} />
        ) : panel.kind === "stop" && net ? (
          <StopCard
            net={net}
            id={panel.id}
            onLine={openLine}
            onStart={(e) => choose("from", e)}
            onGo={(e) => choose("to", e)}
            onClose={closeCard}
          />
        ) : panel.kind === "move" && more?.list[panel.i] ? (
          <MoveCard
            place={more.list[panel.i]}
            to={panel.to}
            saving={saving}
            onSave={() => panel.to && void saveMove(panel.i, panel.to)}
            onCancel={() => placeCard(panel.i)}
          />
        ) : panel.kind === "pin" && net ? (
          <PinCard
            net={net}
            at={panel.at}
            name={panel.name}
            detail={panel.detail}
            place={panel.place}
            fixed={panel.i !== undefined && !!more?.list[panel.i]?.fixed}
            onMove={panel.i !== undefined && more?.list[panel.i] ? () => startMove(panel.i!) : undefined}
            onStart={(e) => choose("from", e)}
            onGo={(e) => choose("to", e)}
            onClose={closeCard}
          />
        ) : !from && !to ? (
          <Welcome
            net={net}
            recent={recent}
            locating={locating}
            onSearch={() => edit("to")}
            onGo={(e) => choose("to", e)}
            onLocate={() => locate("from")}
            onRecent={openRecent}
          />
        ) : (
          <div className="trip">
            <TripFields from={from} to={to} onEdit={edit} onSwap={swap} onClear={clearTrip} />
            {result?.state === "planning" && <Planning />}
            {result?.state === "none" && (
              <div className="note rise">
                <p>{result.why}</p>
                {result.instead && (
                  <div className="note-actions">
                    <button type="button" className="chip chip-accent" onClick={() => choose(result.instead!.field, result.instead!.end)}>
                      {result.instead.field === "from" ? "Start" : "End"} at {result.instead.end.name}
                    </button>
                    <Link href="/contribute?tab=board" className="quiet-link">
                      Know a trotro closer? Tell us
                    </Link>
                  </div>
                )}
              </div>
            )}
            {result?.state === "found" && net && from && to && option && (
              <div className="rise">
                {straight <= 1000 && (
                  <p className="note">
                    It&apos;s only {metres(straight)} as the crow flies: about {minutes(straight / 75)} on foot.
                  </p>
                )}
                <Options options={result.options} chosen={chosen} net={net} onChoose={setChosen} />
                <div className="trip-actions">
                  <button type="button" className="chip" onClick={share}>
                    <ShareIcon size={16} /> Share this trip
                  </button>
                </div>
                <Steps
                  option={option}
                  net={net}
                  from={from}
                  to={to}
                  estimated={result.estimated}
                  onLine={openLine}
                />
              </div>
            )}
          </div>
        )}
      </Sheet>
    </main>
  );
}

function Opening({ state, onRetry }: { state: "opening" | "first" | "error"; onRetry: () => void }) {
  if (state === "error") {
    return (
      <div className="opening rise">
        <h1 className="sheet-title">Couldn&apos;t get the routes</h1>
        <p>
          The first time, TroTro downloads Accra&apos;s trotro network, about 300 KB. Check your
          connection and try again.
        </p>
        <button type="button" className="btn primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="opening">
      <div className="loader" aria-hidden="true">
        <span />
      </div>
      <h1 className="sheet-title">{state === "first" ? "Getting Accra's trotros ready" : "Opening the map"}</h1>
      {state === "first" && (
        <p>547 lines and 1,753 stops, downloaded once. After that, trips plan even with no connection.</p>
      )}
    </div>
  );
}

function Planning() {
  return (
    <div className="planning" aria-label="Finding trips">
      <div className="options n3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="option skeleton" />
        ))}
      </div>
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
    </div>
  );
}

function Welcome({
  net,
  recent,
  locating,
  onSearch,
  onGo,
  onLocate,
  onRecent,
}: {
  net: Network | null;
  recent: Recent[];
  locating: boolean;
  onSearch: () => void;
  onGo: (e: End) => void;
  onLocate: () => void;
  onRecent: (r: Recent) => void;
}) {
  return (
    <div className="welcome">
      <h1 className="sheet-title">Where to?</h1>
      <button type="button" className="search-button" onClick={onSearch}>
        <SearchIcon />
        <span>Search a stop or any place</span>
      </button>
      <div className="chips" role="group" aria-label="Quick picks">
        <button type="button" className="chip chip-accent" onClick={onLocate} disabled={locating}>
          <LocateIcon size={16} />
          {locating ? "Finding you…" : "From where I am"}
        </button>
        {(net?.busiest ?? []).slice(0, 6).map((s) => (
          <button
            key={s.id}
            type="button"
            className="chip"
            onClick={() => onGo({ name: s.name, detail: s.town ?? undefined, at: [s.lon, s.lat], stop: s.id, kind: "stop" })}
          >
            {s.name}
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <section className="sheet-section">
          <h2 className="section-title">Recent trips</h2>
          <ul className="recent">
            {recent.map((r) => (
              <li key={`${r.from.name}>${r.to.name}`}>
                <button type="button" onClick={() => onRecent(r)}>
                  <span className="result-icon">
                    <HistoryIcon />
                  </span>
                  <span className="result-text">
                    <strong>{r.to.name}</strong>
                    <small>From {r.from.name}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {net && (
        <p className="fine">
          {net.routes.length} trotro lines and {net.stations.length.toLocaleString("en-GB")} stops across Accra.
          Trips plan on your phone, even offline. Tap any line on the map to see its stops and fares.
          Stops and routes ©{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>
          . <Link href="/contribute">Report a fare or a stop</Link>
        </p>
      )}
    </div>
  );
}

/** A trip on the map: rides along their roads in their colours, walks dotted, stops marked. */
function tripDrawn(net: Network, o: TripOption, from: End, to: End): Drawn {
  const out: Drawn = { rides: [], walks: [], points: [] };
  const at = (sid: string | null): LngLat | null => {
    const s = sid ? net.station.get(sid) : undefined;
    return s ? [s.lon, s.lat] : null;
  };
  const legs = o.it.legs;
  legs.forEach((l, i) => {
    if (l.kind === "walk") {
      const a = i === 0 ? from.at : at(l.fromStation);
      const b = i === legs.length - 1 ? to.at : at(l.toStation);
      if (a && b && l.distanceM >= 5) out.walks.push([a, b]);
      return;
    }
    const route = net.route.get(l.routeId ?? "");
    const color = routeColor(route?.color);
    const span = route ? rideSpan(net, route.id, l.fromStation, l.toStation, l.numStops) : null;
    const coords = span && route ? ridePath(net, route.id, span[0], span[1]) : [at(l.fromStation), at(l.toStation)].filter((p): p is LngLat => !!p);
    out.rides.push({ color, coords });
    for (const sid of [l.fromStation, l.toStation]) {
      const p = at(sid);
      if (p) out.points.push({ at: p, color, major: true });
    }
  });
  return out;
}

/** An open line: its road in its colour, and every stop on it. */
function lineDrawn(net: Network, id: string): Drawn | null {
  const route = net.route.get(id);
  if (!route) return null;
  const color = routeColor(route.color);
  return {
    rides: [{ color, coords: routeLine(net, id) }],
    walks: [],
    points: stopsOf(net, id).map((s, i, all) => ({
      at: [s.lon, s.lat] as LngLat,
      color,
      major: i === 0 || i === all.length - 1,
    })),
  };
}
