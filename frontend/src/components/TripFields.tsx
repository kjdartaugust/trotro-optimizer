"use client";

import type { End, Field } from "@/lib/trip";
import { CloseIcon, SwapIcon } from "./icons";

/** The trip's two ends, each a tap away from changing, and a swap between them. */
export default function TripFields({
  from,
  to,
  onEdit,
  onSwap,
  onClear,
}: {
  from: End | null;
  to: End | null;
  onEdit: (f: Field) => void;
  onSwap: () => void;
  onClear: () => void;
}) {
  return (
    <div className="trip-fields">
      <div className="trip-ends">
        <button type="button" className={`trip-end ${from ? "" : "empty"}`} onClick={() => onEdit("from")}>
          <span className="end-mark from" aria-hidden="true" />
          <span className="end-text">
            <small>From</small>
            <strong>{from ? from.name : "Choose a start"}</strong>
          </span>
        </button>
        <span className="trip-rail" aria-hidden="true" />
        <button type="button" className={`trip-end ${to ? "" : "empty"}`} onClick={() => onEdit("to")}>
          <span className="end-mark to" aria-hidden="true" />
          <span className="end-text">
            <small>To</small>
            <strong>{to ? to.name : "Where to?"}</strong>
          </span>
        </button>
      </div>
      <div className="trip-tools">
        <button type="button" className="icon-btn round" onClick={onClear} aria-label="Clear the trip">
          <CloseIcon />
        </button>
        <button
          type="button"
          className="icon-btn round"
          onClick={onSwap}
          disabled={!from && !to}
          aria-label="Swap start and destination"
        >
          <SwapIcon />
        </button>
      </div>
    </div>
  );
}
