"use client";

/**
 * Type-to-search station picker. The network has ~1,750 stations, too many for a <select> on a
 * phone, and a name can belong to several stations, so each suggestion shows its area too.
 */
import { useMemo, useRef, useState } from "react";
import type { ApiStation } from "@/lib/types";

const MAX_SUGGESTIONS = 8;

/** Lower case, without accents, so "kwame nkrumah" finds "Kwame Nkrumah". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function label(s: ApiStation): string {
  return s.town && fold(s.town) !== fold(s.name) ? `${s.name} · ${s.town}` : s.name;
}

/** 0: the name starts with the query, 1: a word in it does, 2: it's somewhere in the name or area. */
function rank(s: ApiStation, q: string): number {
  const name = fold(s.name);
  if (name.startsWith(q)) return 0;
  if (name.split(/[\s\-/(]+/).some((w) => w.startsWith(q))) return 1;
  if (name.includes(q) || fold(s.town ?? "").includes(q)) return 2;
  return -1;
}

export default function StationPicker({
  label: fieldLabel,
  placeholder,
  stations,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  stations: ApiStation[];
  value: string;
  onChange: (id: string) => void;
}) {
  const selected = useMemo(() => stations.find((s) => s.id === value), [stations, value]);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shown = open ? text : selected ? label(selected) : text;

  const matches = useMemo(() => {
    const q = fold(text.trim());
    if (!q) return [];
    return stations
      .map((s) => ({ s, r: rank(s, q) }))
      .filter((m) => m.r >= 0)
      .sort((a, b) => a.r - b.r || a.s.name.length - b.s.name.length || a.s.name.localeCompare(b.s.name))
      .slice(0, MAX_SUGGESTIONS)
      .map((m) => m.s);
  }, [stations, text]);

  function pick(s: ApiStation) {
    onChange(s.id);
    setText(label(s));
    setOpen(false);
  }

  return (
    <div className="picker">
      <label>{fieldLabel}</label>
      <input
        type="search"
        value={shown}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setText(selected ? "" : text);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          // Let a tap on a suggestion land before the list closes.
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          if (value) onChange("");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && matches[active]) {
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul className="suggest" role="listbox">
          {matches.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              <span className="name">{s.name}</span>
              {s.town && fold(s.town) !== fold(s.name) && <span className="town">{s.town}</span>}
            </li>
          ))}
        </ul>
      )}
      {open && text.trim() && matches.length === 0 && (
        <p className="notice">No station by that name yet.</p>
      )}
    </div>
  );
}
