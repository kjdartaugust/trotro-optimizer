"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { devLogin, isOnline, loadToken } from "@/lib/api";
import { submitContribution } from "@/lib/contribute";
import { allRoutes, allStations } from "@/lib/db";
import type { ApiRoute, ApiStation } from "@/lib/types";

type Tab = "fare" | "station";

export default function Contribute() {
  const [tab, setTab] = useState<Tab>("fare");
  const [stations, setStations] = useState<ApiStation[]>([]);
  const [routes, setRoutes] = useState<ApiRoute[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      if (!loadToken() && isOnline()) await devLogin().catch(() => null);
      setStations(await allStations());
      setRoutes(await allRoutes());
    })();
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img src="/icon.svg" alt="" /> Contribute
        </div>
        <Link href="/" className="pill">
          ← Back to planner
        </Link>
      </header>

      <p className="notice">
        Corrections are queued locally and sync when you&apos;re online. Trusted reports auto-apply;
        others go to the moderation queue.
      </p>

      <div className="modes" style={{ maxWidth: 420 }}>
        <div className={`mode-tab ${tab === "fare" ? "active" : ""}`} onClick={() => setTab("fare")}>
          Report a fare
        </div>
        <div
          className={`mode-tab ${tab === "station" ? "active" : ""}`}
          onClick={() => setTab("station")}
        >
          Add a station
        </div>
      </div>

      {msg && <p className="notice" style={{ color: "var(--ok)" }}>{msg}</p>}

      {tab === "fare" ? (
        <FareForm routes={routes} onDone={setMsg} />
      ) : (
        <StationForm onDone={setMsg} />
      )}
    </div>
  );
}

function FareForm({ routes, onDone }: { routes: ApiRoute[]; onDone: (m: string) => void }) {
  const [routeId, setRouteId] = useState("");
  const [seq, setSeq] = useState("");
  const [fare, setFare] = useState("");
  const route = useMemo(() => routes.find((r) => r.id === routeId), [routes, routeId]);

  async function submit() {
    if (!routeId || seq === "" || fare === "") return;
    const res = await submitContribution("fare", routeId, {
      seq: Number(seq),
      fare: Number(fare),
    });
    onDone(res.pushed ? "Fare report submitted ✓" : "Saved offline — will sync when online ✓");
    setFare("");
  }

  return (
    <section className="card" style={{ maxWidth: 480 }}>
      <h2>Report a fare change</h2>
      <label>Route</label>
      <select value={routeId} onChange={(e) => setRouteId(e.target.value)}>
        <option value="">Select route…</option>
        {routes.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>

      <label>Segment (arriving at stop)</label>
      <select value={seq} onChange={(e) => setSeq(e.target.value)} disabled={!route}>
        <option value="">Select stop…</option>
        {route?.stops
          .filter((s) => s.seq > 0)
          .map((s) => (
            <option key={s.seq} value={s.seq}>
              Stop #{s.seq} (current GHS {Number(s.fare_from_prev).toFixed(2)})
            </option>
          ))}
      </select>

      <label>New fare (GHS)</label>
      <input
        type="number"
        step="0.5"
        min="0"
        value={fare}
        onChange={(e) => setFare(e.target.value)}
        placeholder="e.g. 3.00"
      />
      <div style={{ height: 12 }} />
      <button onClick={submit} disabled={!routeId || seq === "" || fare === ""}>
        Submit fare report
      </button>
    </section>
  );
}

function StationForm({ onDone }: { onDone: (m: string) => void }) {
  const [name, setName] = useState("");
  const [town, setTown] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition((p) => {
      setLat(p.coords.latitude.toFixed(6));
      setLon(p.coords.longitude.toFixed(6));
    });
  }

  async function submit() {
    if (!name || !lat || !lon) return;
    const res = await submitContribution("station", null, {
      name,
      town: town || null,
      lat: Number(lat),
      lon: Number(lon),
    });
    onDone(res.pushed ? "Station submitted ✓" : "Saved offline — will sync when online ✓");
    setName("");
    setTown("");
  }

  return (
    <section className="card" style={{ maxWidth: 480 }}>
      <h2>Add a trotro station</h2>
      <label>Station name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ashaiman Terminal" />
      <label>Town</label>
      <input value={town} onChange={(e) => setTown(e.target.value)} placeholder="e.g. Ashaiman" />
      <div className="row">
        <div>
          <label>Latitude</label>
          <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="5.6900" />
        </div>
        <div>
          <label>Longitude</label>
          <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-0.0300" />
        </div>
      </div>
      <div style={{ height: 8 }} />
      <button className="secondary" onClick={useMyLocation} type="button">
        📍 Use my location
      </button>
      <div style={{ height: 8 }} />
      <button onClick={submit} disabled={!name || !lat || !lon}>
        Submit station
      </button>
    </section>
  );
}
