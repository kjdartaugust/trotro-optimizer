"use client";

/**
 * Sending a station's fare board: which station it's at, a photo of it (read on the server) or
 * the rows typed in, then a check of each row before it goes. Each destination is matched to a stop
 * the station's lines reach; one no line reaches is a trotro we don't have yet, and is sent too.
 */
import { useEffect, useMemo, useState } from "react";
import { fareboardReader, isOnline, readFareBoard, ReadError } from "@/lib/api";
import { submitContribution } from "@/lib/contribute";
import { matchDestination, reachable, shrink } from "@/lib/fareboard";
import type { Network } from "@/lib/network";
import { findStops, stopLabel } from "@/lib/search";
import type { ApiStation } from "@/lib/types";
import { CameraIcon, CloseIcon, LocateIcon, PlusIcon, StopIcon } from "./icons";

interface Row {
  key: number;
  to: string;
  fare: string;
}

let nextKey = 1;
const row = (to = "", fare = ""): Row => ({ key: nextKey++, to, fare });

const fareOk = (f: string) => {
  const n = Number(f);
  return f.trim() !== "" && Number.isFinite(n) && n >= 0.5 && n <= 500;
};

export default function FareBoardForm({ net, onDone }: { net: Network | null; onDone: (m: string) => void }) {
  const [station, setStation] = useState<ApiStation | null>(null);
  const [q, setQ] = useState("");
  const [finding, setFinding] = useState(false);
  const [reader, setReader] = useState<boolean | null>(null);
  const [reading, setReading] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [read, setRead] = useState<"photo" | "typed">("typed");
  const [effective, setEffective] = useState("");
  const [problem, setProblem] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!isOnline()) {
      setReader(false);
      return;
    }
    void fareboardReader().then(setReader);
  }, []);

  const reach = useMemo(() => (net && station ? reachable(net, station.id) : new Map<string, number>()), [net, station]);
  const found = useMemo(() => (net && !station ? findStops(net, q, 5) : []), [net, station, q]);

  function hereNow() {
    if (!net || !navigator.geolocation) return;
    setFinding(true);
    setProblem("");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setFinding(false);
        const at = [p.coords.longitude, p.coords.latitude] as const;
        const near = net.stations
          .map((s) => ({ s, m: Math.hypot((s.lon - at[0]) * 110_900, (s.lat - at[1]) * 110_574) }))
          .sort((a, b) => a.m - b.m)[0];
        if (near && near.m <= 400) setStation(near.s);
        else setProblem("No stop we know is within 400 m of you. Search for the station instead.");
      },
      () => {
        setFinding(false);
        setProblem("Couldn't get your location. Search for the station instead.");
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  async function photo(file: File | undefined) {
    if (!file) return;
    setProblem("");
    setReading(true);
    try {
      const board = await readFareBoard(await shrink(file));
      if (!board.rows.length) {
        setProblem("Couldn't find any fares in that photo. Try a closer, straighter one, or type them in.");
        return;
      }
      setRows(board.rows.map((r) => row(r.to, r.fare.toFixed(2))));
      setRead("photo");
      if (board.effective) setEffective(board.effective);
      if (!station && board.station) setQ(board.station);
    } catch (e) {
      if (e instanceof ReadError && e.status === 503) setReader(false);
      setProblem(
        e instanceof ReadError && e.message && e.status !== 503
          ? e.message
          : "Couldn't read the photo just now. Type the board in instead."
      );
    } finally {
      setReading(false);
    }
  }

  function change(key: number, part: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...part } : r)));
  }

  const ready = rows.filter((r) => r.to.trim() && fareOk(r.fare));
  const canSend = !!station && ready.length > 0 && ready.length === rows.length;

  async function send() {
    if (!station || !net || !canSend || sending) return;
    // Saved on the phone first; sending can take a while when the server is waking up.
    setSending(true);
    try {
      const res = await submitContribution("fareboard", null, {
        station_id: station.id,
        rows: ready.map((r) => ({
          to: r.to.trim(),
          fare: Math.round(Number(r.fare) * 100) / 100,
          to_station_id: matchDestination(net, reach, r.to)?.station.id ?? null,
        })),
        effective: effective || null,
        read,
      });
      onDone(
        res.pushed
          ? `Thanks! The ${station.name} board is in: ${ready.length} fares.`
          : "Saved on this phone. It goes in when you're back online."
      );
      setRows([]);
      setEffective("");
      setRead("typed");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="form-card rise">
      <h2>Send a station&apos;s fare board</h2>
      <p className="field-hint">
        Every station puts up the fare to each place its trotros go. One photo of it updates them all,
        for every rider.
      </p>

      <label className="field-label" htmlFor="board-station">
        Which station is the board at?
      </label>
      {station ? (
        <div className="picked">
          <StopIcon />
          <strong>{stopLabel(station)}</strong>
          <button type="button" className="link-btn" onClick={() => setStation(null)}>
            Change
          </button>
        </div>
      ) : (
        <>
          <input
            id="board-station"
            className="input"
            type="search"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Madina Station"
          />
          {found.length > 0 && (
            <ul className="line-list">
              {found.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setStation(s)}>
                    <StopIcon />
                    <span className="ll-name">{stopLabel(s)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={hereNow} disabled={finding || !net}>
              <LocateIcon /> {finding ? "Finding you…" : "I'm at the station"}
            </button>
          </div>
        </>
      )}

      <label className="field-label">The board</label>
      {reader !== false && (
        <label className={`photo-btn${reading ? " busy" : ""}`}>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={reading}
            onChange={(e) => {
              void photo(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <CameraIcon />
          <span>
            <strong>{reading ? "Reading the board…" : rows.length ? "Take another photo" : "Take a photo of the board"}</strong>
            <small>
              {reading
                ? "A few seconds. The first one of the day can take a minute."
                : "Read for you, then thrown away. You check every line before it's sent."}
            </small>
          </span>
        </label>
      )}
      {problem && <p className="field-problem">{problem}</p>}

      {rows.length > 0 && (
        <ul className="board-rows" aria-label="Fares on the board">
          {rows.map((r) => {
            const m = net && station && r.to.trim() ? matchDestination(net, reach, r.to) : null;
            return (
              <li key={r.key}>
                <div className="board-row">
                  <input
                    className="input"
                    value={r.to}
                    onChange={(e) => change(r.key, { to: e.target.value })}
                    placeholder="Where to"
                    aria-label="Where to"
                  />
                  <input
                    className={`input fare${r.fare && !fareOk(r.fare) ? " bad" : ""}`}
                    inputMode="decimal"
                    value={r.fare}
                    onChange={(e) => change(r.key, { fare: e.target.value })}
                    placeholder="GH₵"
                    aria-label={`Fare to ${r.to || "there"}, in cedis`}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    aria-label={`Remove ${r.to || "this row"}`}
                  >
                    <CloseIcon />
                  </button>
                </div>
                {station && r.to.trim() && (
                  <small className={m ? "board-match" : "board-match new"}>
                    {m
                      ? `${m.station.name}: ${m.lines === 1 ? "1 line" : `${m.lines} lines`} from ${station.name}`
                      : `A trotro we don't have yet. It's sent too, so it can be added.`}
                  </small>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setRows((rs) => [...rs, row()]);
          }}
        >
          <PlusIcon /> {rows.length ? "Add a place" : "Type the board in"}
        </button>
      </div>

      {rows.length > 0 && (
        <>
          <label className="field-label" htmlFor="board-date">
            Fares in force since (if the board says)
          </label>
          <input id="board-date" className="input" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={send} disabled={!canSend || sending}>
              {sending ? "Sending…" : `Send ${ready.length === 1 ? "1 fare" : `${ready.length} fares`}`}
            </button>
          </div>
          {!station && <p className="field-hint">Choose the station first.</p>}
        </>
      )}
    </section>
  );
}
