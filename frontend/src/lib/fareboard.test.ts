import { describe, expect, it } from "vitest";
import { matchDestination, reachable } from "./fareboard";
import { buildNetwork } from "./network";
import type { ApiRoute, ApiStation } from "./types";

const st = (id: string, name: string): ApiStation => ({
  id, name, town: null, lat: 5.6, lon: -0.2, verified: false, confidence: 0.5, version: 1,
});
const line = (id: string, name: string, stops: string[]): ApiRoute => ({
  id, name, operator: null, color: null, verified: false, confidence: 0.5, version: 1, board_fare: 5.5,
  stops: stops.map((station_id, seq) => ({ station_id, seq, fare_from_prev: seq ? 1 : 0, minutes_from_prev: seq ? 2 : 0 })),
});

// Madina Station's lines: one to Circle by Legon, one to Adenta; and one that comes INTO Madina.
const net = buildNetwork(
  [st("mad", "Madina Station"), st("leg", "Legon"), st("cir", "Circle Overhead"), st("ade", "Adenta Barrier"),
   st("dod", "Dodowa"), st("atm", "Atomic Junction")],
  [line("r1", "Madina → Circle", ["mad", "atm", "leg", "cir"]),
   line("r2", "Madina → Adenta", ["mad", "ade"]),
   line("r3", "Dodowa → Madina", ["dod", "ade", "mad"])],
  new Map()
);

describe("a fare board's destinations", () => {
  const reach = reachable(net, "mad");

  it("are the stops after the station on the lines through it", () => {
    expect(Object.fromEntries(reach)).toEqual({ atm: 1, leg: 1, cir: 1, ade: 1 });
  });

  it("match a stop by the name riders use for it", () => {
    expect(matchDestination(net, reach, "Circle")?.station.id).toBe("cir");
    expect(matchDestination(net, reach, "ADENTA")?.station.id).toBe("ade");
    expect(matchDestination(net, reach, "Atomic Junc.")?.station.id).toBe("atm");
  });

  it("are new when no line from the station goes there", () => {
    // Dodowa has a line to Madina, not from it: a board at Madina listing Dodowa is news.
    expect(matchDestination(net, reach, "Dodowa")).toBeNull();
    expect(matchDestination(net, reach, "Trasacco")).toBeNull();
  });
});
