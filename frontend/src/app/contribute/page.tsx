"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import FareBoardForm from "@/components/FareBoardForm";
import { CheckIcon, LocateIcon } from "@/components/icons";
import { devLogin, isOnline, loadToken } from "@/lib/api";
import { submitContribution } from "@/lib/contribute";
import { allRoutes, allStations } from "@/lib/db";
import { cedis, routeColor } from "@/lib/format";
import { buildNetwork } from "@/lib/network";
import { fold } from "@/lib/search";
import { ensureNetwork } from "@/lib/sync";
import type { ApiRoute, ApiStation } from "@/lib/types";

type Tab = "board" | "fare" | "station";

const sent = (pushed: boolean) =>
  pushed ? "Thanks! Your report is in." : "Saved on this phone. It goes in when you're back online.";

export default function Contribute() {
  const [tab, setTab] = useState<Tab>("board");
  const [stations, setStations] = useState<ApiStation[]>([]);
  const [routes, setRoutes] = useState<ApiRoute[]>([]);
  const [first, setFirst] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const net = useMemo(() => (stations.length ? buildNetwork(stations, routes, new Map()) : null), [stations, routes]);

  useEffect(() => {
    // A link from a trip ("Paid something else?") names the route; others can name the tab.
    const p = new URLSearchParams(window.location.search);
    const route = p.get("route"), t = p.get("tab");
    setFirst(route);
    if (route) setTab("fare");
    else if (t === "board" || t === "fare" || t === "station") setTab(t);
    (async () => {
      await ensureNetwork().catch(() => null);
      setStations(await allStations());
      setRoutes(await allRoutes());
      if (!loadToken() && isOnline()) await devLogin().catch(() => null);
    })();
  }, []);

  return (
    <main className="page">
      <div className="page-inner">
        <h1>Help other riders</h1>
        <p className="lede">
          The fares here are estimates until riders like you report what they really paid. Reports
          are saved on your phone and sent when you&apos;re online; trusted ones change the app
          straight away, the rest after a check.
        </p>

        <div className="segmented" role="group" aria-label="What to report">
          <button type="button" aria-pressed={tab === "board"} onClick={() => setTab("board")}>
            A fare board
          </button>
          <button type="button" aria-pressed={tab === "fare"} onClick={() => setTab("fare")}>
            A fare
          </button>
          <button type="button" aria-pressed={tab === "station"} onClick={() => setTab("station")}>
            A missing stop
          </button>
        </div>

        {msg && (
          <p className="done rise" role="status">
            <CheckIcon /> {msg}
          </p>
        )}

        {tab === "board" ? (
          <FareBoardForm net={net} onDone={setMsg} />
        ) : tab === "fare" ? (
          <FareForm key={first ?? ""} routes={routes} stations={stations} first={first} onDone={setMsg} />
        ) : (
          <StationForm onDone={setMsg} />
        )}

        <p className="fine">
          <Link href="/">Back to planning a trip</Link>
        </p>
      </div>
    </main>
  );
}

function FareForm({
  routes,
  stations,
  first,
  onDone,
}: {
  routes: ApiRoute[];
  stations: ApiStation[];
  first: string | null;
  onDone: (m: string) => void;
}) {
  const [routeId, setRouteId] = useState(first ?? "");
  const [q, setQ] = useState("");
  const [seq, setSeq] = useState("");
  const [fare, setFare] = useState("");
  const route = useMemo(() => routes.find((r) => r.id === routeId), [routes, routeId]);
  const stationName = useMemo(() => new Map(stations.map((s) => [s.id, s.name])), [stations]);
  const stops = useMemo(() => (route ? [...route.stops].sort((a, b) => a.seq - b.seq) : []), [route]);
  // ~550 routes: search them by name rather than scroll a list.
  const matches = useMemo(() => {
    const t = fold(q.trim());
    if (!t) return [];
    return routes
      .filter((r) => fold(r.name).includes(t))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [routes, q]);

  async function submit() {
    if (!routeId || seq === "" || fare === "") return;
    const res = await submitContribution("fare", routeId, { seq: Number(seq), fare: Number(fare) });
    onDone(sent(res.pushed));
    setFare("");
  }

  return (
    <section className="form-card rise">
      <h2>Report a fare</h2>
      <p className="field-hint">For one stretch of a trotro line: from one stop to the next.</p>

      <label className="field-label" htmlFor="route-q">
        Which trotro line?
      </label>
      {route ? (
        <div className="picked">
          <span className="line-dot" style={{ background: routeColor(route.color) }} />
          <strong>{route.name}</strong>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setRouteId("");
              setSeq("");
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <input
            id="route-q"
            className="input"
            type="search"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type where it goes, e.g. Madina"
          />
          {matches.length > 0 && (
            <ul className="line-list">
              {matches.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setRouteId(r.id)}>
                    <span className="line-dot" style={{ background: routeColor(r.color) }} />
                    <span className="ll-name">{r.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <label className="field-label" htmlFor="seq">
        Between which stops?
      </label>
      <select id="seq" className="select" value={seq} onChange={(e) => setSeq(e.target.value)} disabled={!route}>
        <option value="">{route ? "Choose a stretch…" : "Choose the line first"}</option>
        {stops.slice(1).map((s, i) => (
          <option key={s.seq} value={s.seq}>
            {stationName.get(stops[i].station_id) ?? "Stop"} to {stationName.get(s.station_id) ?? `stop ${s.seq}`} (now{" "}
            {cedis(Number(s.fare_from_prev))})
          </option>
        ))}
      </select>

      <label className="field-label" htmlFor="fare">
        What you paid for that stretch (GH₵)
      </label>
      <input
        id="fare"
        className="input"
        type="number"
        inputMode="decimal"
        step="0.5"
        min="0"
        value={fare}
        onChange={(e) => setFare(e.target.value)}
        placeholder="e.g. 3.00"
      />
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={submit} disabled={!routeId || seq === "" || fare === ""}>
          Send the fare
        </button>
      </div>
    </section>
  );
}

function StationForm({ onDone }: { onDone: (m: string) => void }) {
  const [name, setName] = useState("");
  const [town, setTown] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [finding, setFinding] = useState(false);

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setFinding(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setFinding(false);
        setLat(p.coords.latitude.toFixed(6));
        setLon(p.coords.longitude.toFixed(6));
      },
      () => setFinding(false),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  async function submit() {
    if (!name || !lat || !lon) return;
    const res = await submitContribution("station", null, {
      name,
      town: town || null,
      lat: Number(lat),
      lon: Number(lon),
    });
    onDone(sent(res.pushed));
    setName("");
    setTown("");
  }

  return (
    <section className="form-card rise">
      <h2>Add a missing stop</h2>
      <p className="field-hint">Easiest while you&apos;re standing at it: use your location.</p>
      <label className="field-label" htmlFor="st-name">
        What do people call it?
      </label>
      <input
        id="st-name"
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Ashaiman Terminal"
      />
      <label className="field-label" htmlFor="st-town">
        Area
      </label>
      <input
        id="st-town"
        className="input"
        value={town}
        onChange={(e) => setTown(e.target.value)}
        placeholder="e.g. Ashaiman"
      />
      <div className="form-actions">
        <button type="button" className="btn" onClick={useMyLocation} disabled={finding}>
          <LocateIcon /> {finding ? "Finding you…" : lat ? "Location set. Again?" : "Use my location"}
        </button>
      </div>
      <div className="form-row">
        <div>
          <label className="field-label" htmlFor="st-lat">
            Latitude
          </label>
          <input id="st-lat" className="input" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="5.6900" />
        </div>
        <div>
          <label className="field-label" htmlFor="st-lon">
            Longitude
          </label>
          <input id="st-lon" className="input" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-0.0300" />
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={submit} disabled={!name || !lat || !lon}>
          Send the stop
        </button>
      </div>
    </section>
  );
}
