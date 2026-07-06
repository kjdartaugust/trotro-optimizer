import type { DatasetSnapshot, QueuedContribution } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

let token: string | null = null;

export function setToken(t: string | null) {
  token = t;
  if (typeof window !== "undefined") {
    if (t) localStorage.setItem("trotro_token", t);
    else localStorage.removeItem("trotro_token");
  }
}

export function loadToken(): string | null {
  if (token) return token;
  if (typeof window !== "undefined") token = localStorage.getItem("trotro_token");
  return token;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const t = loadToken();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Dev-only helper to obtain a token without a Supabase project. */
export async function devLogin(sub = "demo-commuter", role = "user"): Promise<string> {
  const r = await req<{ access_token: string }>(
    `/auth/token?sub=${encodeURIComponent(sub)}&role=${role}`,
    { method: "POST" }
  );
  setToken(r.access_token);
  return r.access_token;
}

export async function fetchDataset(): Promise<DatasetSnapshot> {
  return req<DatasetSnapshot>("/sync/dataset");
}

export async function fetchChanges(since: number): Promise<DatasetSnapshot> {
  return req<DatasetSnapshot>(`/sync/changes?since=${since}`);
}

export async function pushOutbox(items: QueuedContribution[]) {
  return req<{ accepted: number; duplicates: number; ids: string[] }>("/sync/push", {
    method: "POST",
    body: JSON.stringify({
      items: items.map((i) => ({
        kind: i.kind,
        target_id: i.target_id,
        payload: i.payload,
        note: i.note ?? null,
        client_key: i.client_key,
      })),
    }),
  });
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}
