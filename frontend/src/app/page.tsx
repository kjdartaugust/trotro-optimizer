"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { devLogin, isOnline, loadToken } from "@/lib/api";
import { allStations } from "@/lib/db";
import { planOffline, type Itinerary, type Mode } from "@/lib/planner";
import { syncAll } from "@/lib/sync";
import type { ApiStation } from "@/lib/types";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const MODES: Mode[] = ["fastest", "cheapest", "fewest"];
const MODE_LABEL: Record<Mode, string> = {
  fastest: "Fastest",
  cheapest: "Cheapest",
  fewest: "Fewest changes",
};

export default function Home() {
  const [stations, setStations] = useState<ApiStation[]>([]);
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [itineraries, setItineraries] = useState<Partial<Record<Mode, Itinerary>>>({});
  const [mode, setMode] = useState<Mode>("fastest");
  const [online, setOnline] = useState(true);
  const [status, setStatus] = useState("Loading offline data…");
  const [err, setErr] = useState("");

  const refreshStations = useCallback(async () => {
    setStations(await allStations());
  }, []);

  useEffect(() => {
    setOnline(isOnline());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);

    (async () => {
      try {
        if (!loadToken() && isOnline()) await devLogin().catch(() => null);
        const res = await syncAll();
        await refreshStations();
        setStatus(
          res.downloaded
            ? `Synced dataset v${res.version} · ${(await allStations()).length} stations`
            : `Offline dataset ready (v${res.version})`
        );
      } catch {
        await refreshStations();
        setStatus("Offline — using locally stored dataset");
      }
    })();

    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refreshStations]);

  const sorted = useMemo(
    () => [...stations].sort((a, b) => a.name.localeCompare(b.name)),
    [stations]
  );

  async function plan() {
    setErr("");
    const o = stations.find((s) => s.id === origin);
    const d = stations.find((s) => s.id === dest);
    if (!o || !d) {
      setErr("Pick both a start and destination station.");
      return;
    }
    const { itineraries } = await planOffline([o.lat, o.lon], [d.lat, d.lon]);
    if (!Object.keys(itineraries).length) {
      setErr("No trotro route found between these points yet. Add one under Contribute!");
      setItineraries({});
      return;
    }
    setItineraries(itineraries);
    setMode((Object.keys(itineraries)[0] as Mode) ?? "fastest");
  }

  const active = itineraries[mode];

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          TroTro Optimizer
        </div>
        <div className="row" style={{ gap: 8, flex: "0 0 auto" }}>
          <span className={`pill ${online ? "online" : "offline"}`}>
            {online ? "● Online" : "● Offline"}
          </span>
          <Link href="/contribute" className="pill">
            + Contribute
          </Link>
        </div>
      </header>

      <div className="grid">
        <section className="card">
          <h2>Plan a trip</h2>
          <label>From</label>
          <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
            <option value="">Select start station…</option>
            {sorted.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <label>To</label>
          <select value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">Select destination…</option>
            {sorted.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <div style={{ height: 12 }} />
          <button onClick={plan} disabled={!origin || !dest}>
            Find routes
          </button>
          {err && <p className="err">{err}</p>}
          <p className="notice">{status}</p>

          {Object.keys(itineraries).length > 0 && (
            <>
              <div className="modes">
                {MODES.filter((m) => itineraries[m]).map((m) => (
                  <div
                    key={m}
                    className={`mode-tab ${m === mode ? "active" : ""}`}
                    onClick={() => setMode(m)}
                  >
                    {MODE_LABEL[m]}
                  </div>
                ))}
              </div>
              {active && <ItineraryView it={active} />}
            </>
          )}
        </section>

        <section>
          <MapView stations={stations} itinerary={active} />
          <p className="notice">
            {process.env.NEXT_PUBLIC_MAP_STYLE_URL
              ? "Vector basemap active."
              : "Schematic map (no basemap tiles) — fully offline. Set NEXT_PUBLIC_MAP_STYLE_URL for a MapLibre basemap."}
          </p>
        </section>
      </div>
    </div>
  );
}

function ItineraryView({ it }: { it: Itinerary }) {
  return (
    <div>
      <div className="itin-summary">
        <div className="stat">
          <div className="n">GHS {it.totalFare.toFixed(2)}</div>
          <div className="l">Fare</div>
        </div>
        <div className="stat">
          <div className="n">{Math.round(it.totalMinutes)}m</div>
          <div className="l">Time</div>
        </div>
        <div className="stat">
          <div className="n">{it.transfers}</div>
          <div className="l">Changes</div>
        </div>
      </div>
      {it.legs.map((leg, i) => (
        <div key={i} className={`leg ${leg.kind}`}>
          <div className="dot" />
          <div className="body">
            {leg.kind === "walk" ? (
              <>
                <div className="main">Walk {Math.round(leg.distanceM)} m</div>
                <div className="sub">
                  {leg.fromName ? `from ${leg.fromName} ` : ""}
                  {leg.toName ? `to ${leg.toName}` : "to station"} · {Math.round(leg.minutes)} min
                </div>
              </>
            ) : (
              <>
                <div className="main">
                  Trotro: {leg.routeName} <span className="fare">GHS {leg.fare.toFixed(2)}</span>
                </div>
                <div className="sub">
                  Board at {leg.fromName}, alight at {leg.toName} · {leg.numStops} stop
                  {leg.numStops === 1 ? "" : "s"} · {Math.round(leg.minutes)} min
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
