"use client";

/**
 * The map: OpenFreeMap streets (light or dark, as the phone is set), every trotro line along the
 * roads it drives, the stops once you're close enough to tell them apart, and the open trip or line
 * in its own colours. Taps go to a stop, else to the lines under the finger, else to the spot.
 * Tiles need the internet; everything drawn on them comes from the offline tables.
 */
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LayerSpecification,
  type Map as MLMap,
  type Marker,
  type PaddingOptions,
} from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { LngLat } from "@/lib/shapes";
import type { ApiStation } from "@/lib/types";

const STYLE = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const ACCRA: LngLat = [-0.205, 5.6];
const DARK = "(prefers-color-scheme: dark)";
const scheme = () => (window.matchMedia(DARK).matches ? "dark" : "light");

export interface Drawn {
  /** Ride legs and an open line: drawn in their route's colour, on a casing. */
  rides: { color: string; coords: LngLat[] }[];
  /** Walking legs: dotted. */
  walks: LngLat[][];
  /** Where you get on and off, or an open line's stops. */
  points: { at: LngLat; color: string; major?: boolean }[];
}

const NONE: Drawn = { rides: [], walks: [], points: [] };

const byZoom = (...stops: number[]) =>
  ["interpolate", ["linear"], ["zoom"], ...stops] as ExpressionSpecification;
const ROUND = { "line-cap": "round", "line-join": "round" } as const;

function palette(dark: boolean) {
  return {
    net: dark ? "#ffb340" : "#ec7c00",
    // The same, a quarter strength over the map, as a solid colour: with a trip open, roads that
    // twenty lines share stay as faint as the rest instead of adding up.
    netQuiet: dark ? "#49361a" : "#f1d5b4",
    casing: dark ? "#0c0c0c" : "#ffffff",
    walk: dark ? "#c5ccd6" : "#4b5563",
    stop: dark ? "#1a1c20" : "#ffffff",
    stopRing: dark ? "#9aa3b0" : "#5b6472",
    label: dark ? "#e8eaee" : "#2a2f36",
    halo: dark ? "#0c0c0c" : "#ffffff",
  };
}

/** The network's colour: faint lines that build up where many share a road, or all quiet. */
function netPaint(dark: boolean, quiet: boolean) {
  const c = palette(dark);
  return quiet
    ? { "line-color": c.netQuiet, "line-opacity": 1 }
    : { "line-color": c.net, "line-opacity": byZoom(9, 0.35, 13, 0.45, 16, 0.55) };
}

// Lines first, under the place names; stops, points and their names on top of everything.
function lineLayers(dark: boolean, quiet: boolean): LayerSpecification[] {
  const c = palette(dark);
  return [
    {
      // Hundreds of lines share the main roads: drawn faint, the busy corridors build up.
      id: "net",
      type: "line",
      source: "net",
      layout: ROUND,
      paint: { ...netPaint(dark, quiet), "line-width": byZoom(9, 0.7, 12, 1.4, 14, 2.4, 17, 5) },
    },
    {
      // Invisible and wide, so a thumb can land on a line.
      id: "net-hit",
      type: "line",
      source: "net",
      paint: { "line-color": "#000", "line-opacity": 0, "line-width": 16 },
    },
    {
      id: "walk",
      type: "line",
      source: "walk",
      layout: ROUND,
      paint: {
        "line-color": c.walk,
        "line-width": byZoom(10, 3, 15, 5),
        "line-dasharray": [0.1, 1.8],
      },
    },
    {
      id: "ride-glow",
      type: "line",
      source: "ride",
      layout: ROUND,
      paint: {
        "line-color": ["get", "color"],
        "line-width": byZoom(10, 10, 15, 22),
        "line-blur": 8,
        "line-opacity": dark ? 0.5 : 0.32,
      },
    },
    {
      id: "ride-casing",
      type: "line",
      source: "ride",
      layout: ROUND,
      paint: { "line-color": c.casing, "line-width": byZoom(10, 6, 14, 10, 17, 15) },
    },
    {
      id: "ride",
      type: "line",
      source: "ride",
      layout: ROUND,
      paint: { "line-color": ["get", "color"], "line-width": byZoom(10, 3.5, 14, 6.5, 17, 10) },
    },
  ];
}

function pointLayers(dark: boolean): LayerSpecification[] {
  const c = palette(dark);
  return [
    {
      id: "stops",
      type: "circle",
      source: "stops",
      minzoom: 12.5,
      paint: {
        "circle-radius": byZoom(12.5, 1.6, 14, 3, 17, 6),
        "circle-color": c.stop,
        "circle-stroke-color": c.stopRing,
        "circle-stroke-width": byZoom(12.5, 0.8, 15, 1.5),
        "circle-opacity": byZoom(12.5, 0, 13, 1),
        "circle-stroke-opacity": byZoom(12.5, 0, 13, 1),
      },
    },
    {
      id: "stops-label",
      type: "symbol",
      source: "stops",
      minzoom: 15,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": byZoom(15, 11, 18, 13),
        "text-offset": [0, 0.9],
        "text-anchor": "top",
        "text-max-width": 8,
        "text-optional": true,
      },
      paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.4 },
    },
    {
      id: "points",
      type: "circle",
      source: "points",
      paint: {
        // Zoom has to lead the expression: the size per zoom, then major or not at each.
        "circle-radius": byZoom(
          10, ["case", ["get", "major"], 5, 2.5] as unknown as number,
          15, ["case", ["get", "major"], 8, 4.5] as unknown as number
        ),
        "circle-color": c.stop,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": ["case", ["get", "major"], 3, 2],
      },
    },
  ];
}

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features,
});
const line = (coords: LngLat[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: coords },
  properties: props,
});

function marker(kind: "from" | "to" | "me"): HTMLElement {
  const el = document.createElement("div");
  el.className = `marker marker-${kind}`;
  el.innerHTML =
    kind === "me"
      ? '<span class="marker-pulse"></span><span class="marker-dot"></span>'
      : kind === "from"
        ? '<span class="marker-dot"></span>'
        : '<svg viewBox="0 0 28 36" aria-hidden="true"><path d="M14 35s11-10.2 11-20A11 11 0 0 0 3 15c0 9.8 11 20 11 20z"/><circle cx="14" cy="14.5" r="4.2"/></svg>';
  return el;
}

export default function TripMap({
  network,
  stops,
  drawn,
  from,
  to,
  me,
  fit,
  focus,
  padding,
  picking,
  onTap,
  onStop,
  onLines,
}: {
  /** Every route's line, by id. */
  network: { id: string; coords: LngLat[] }[];
  stops: ApiStation[];
  /** The open trip or line; null for the plain network. */
  drawn: Drawn | null;
  from: LngLat | null;
  to: LngLat | null;
  me: LngLat | null;
  /** Frame these points whenever `seq` changes. */
  fit: { coords: LngLat[]; seq: number } | null;
  /** Fly here whenever `seq` changes. */
  focus: { at: LngLat; zoom?: number; seq: number } | null;
  /** Room the sheet or panel takes, so what's framed isn't hidden under it. */
  padding: PaddingOptions;
  /** Choosing a trip's end on the map: every tap is a spot. */
  picking: boolean;
  onTap: (at: LngLat) => void;
  onStop: (id: string) => void;
  onLines: (ids: string[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef<Partial<Record<"from" | "to" | "me", Marker>>>({});
  const data = useRef({ network, stops, drawn });
  data.current = { network, stops, drawn };
  const handlers = useRef({ onTap, onStop, onLines, picking });
  handlers.current = { onTap, onStop, onLines, picking };
  const pad = useRef(padding);
  pad.current = padding;

  // (Re)add our sources and layers: on load, and after a light/dark switch wipes them.
  function dress(m: MLMap) {
    const dark = scheme() === "dark";
    const layers = m.getStyle().layers;
    const lastShape = layers.map((l) => l.type !== "symbol").lastIndexOf(true);
    const firstLabel = layers[lastShape + 1]?.id;
    const sources: Record<string, GeoJSON.FeatureCollection> = {
      net: netData(data.current.network),
      stops: stopData(data.current.stops),
      ...drawnData(data.current.drawn),
    };
    for (const [id, d] of Object.entries(sources)) {
      if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: d });
    }
    for (const l of lineLayers(dark, !!data.current.drawn)) if (!m.getLayer(l.id)) m.addLayer(l, firstLabel);
    for (const l of pointLayers(dark)) if (!m.getLayer(l.id)) m.addLayer(l);
  }

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 900px)").matches;
    const m = new maplibregl.Map({
      container: box.current!,
      style: STYLE[scheme()],
      center: ACCRA,
      zoom: desktop ? 11.6 : 10.9,
      minZoom: 8,
      maxBounds: [
        [-1.4, 4.9],
        [1.0, 6.4],
      ],
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.current = m;
    m.touchZoomRotate.disableRotation();
    // The sheet or panel covers part of the map: flying and framing aim at the rest. Set on the
    // map, not on each move: MapLibre adds a move's padding to the map's, so mixing the two
    // left no room to frame a trip after flying to one of its ends.
    m.setPadding(pad.current);
    // The tiles carry their own credit (OpenFreeMap, OpenMapTiles, OpenStreetMap); the trotro
    // lines and stops are OpenStreetMap's too. Full text on desktop, behind "i" on phones.
    m.addControl(
      new maplibregl.AttributionControl({
        compact: !desktop,
        customAttribution:
          'Trotro routes <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>',
      }),
      desktop ? "bottom-right" : "top-right"
    );
    if (desktop) m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    m.on("style.load", () => dress(m));
    m.on("load", () => {
      // Compact credits start open until the first drag; start them folded.
      const credits = box.current?.querySelector(".maplibregl-ctrl-attrib");
      credits?.classList.remove("maplibregl-compact-show");
      credits?.removeAttribute("open");
    });

    m.on("click", (e) => {
      const h = handlers.current;
      const at: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (h.picking) {
        h.onTap(at);
        return;
      }
      const { x, y } = e.point;
      const near = (r: number): [maplibregl.PointLike, maplibregl.PointLike] => [
        [x - r, y - r],
        [x + r, y + r],
      ];
      if (m.getLayer("stops") && m.getZoom() >= 13) {
        const hit = m.queryRenderedFeatures(near(12), { layers: ["stops"] });
        if (hit.length) {
          const closest = hit
            .map((f) => {
              const p = m.project((f.geometry as GeoJSON.Point).coordinates as [number, number]);
              return { id: String(f.properties?.id), d: Math.hypot(p.x - x, p.y - y) };
            })
            .sort((a, b) => a.d - b.d)[0];
          h.onStop(closest.id);
          return;
        }
      }
      if (m.getLayer("net-hit")) {
        const hit = m.queryRenderedFeatures(near(7), { layers: ["net-hit"] });
        if (hit.length) {
          h.onLines([...new Set(hit.map((f) => String(f.properties?.id)))]);
          return;
        }
      }
      h.onTap(at);
    });
    for (const layer of ["stops", "net-hit"]) {
      m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
    }

    const dark = window.matchMedia(DARK);
    const restyle = () => m.setStyle(STYLE[scheme()]);
    dark.addEventListener("change", restyle);
    return () => {
      dark.removeEventListener("change", restyle);
      m.remove();
      map.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    (map.current?.getSource("net") as GeoJSONSource | undefined)?.setData(netData(network));
  }, [network]);

  useEffect(() => {
    (map.current?.getSource("stops") as GeoJSONSource | undefined)?.setData(stopData(stops));
  }, [stops]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const [id, d] of Object.entries(drawnData(drawn))) {
      (m.getSource(id) as GeoJSONSource | undefined)?.setData(d);
    }
    // The network steps back while a trip or a line is open, and so do the other stops.
    if (m.getLayer("net")) {
      for (const [k, v] of Object.entries(netPaint(scheme() === "dark", !!drawn))) m.setPaintProperty("net", k, v);
    }
    if (m.getLayer("stops")) {
      const show = drawn ? byZoom(12.5, 0, 13, 0.45) : byZoom(12.5, 0, 13, 1);
      m.setPaintProperty("stops", "circle-opacity", show);
      m.setPaintProperty("stops", "circle-stroke-opacity", show);
    }
  }, [drawn]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const [kind, at] of [["from", from], ["to", to], ["me", me]] as const) {
      const mk = markers.current[kind];
      if (!at) {
        mk?.remove();
        delete markers.current[kind];
      } else if (mk) {
        mk.setLngLat(at);
      } else {
        markers.current[kind] = new maplibregl.Marker({
          element: marker(kind),
          anchor: kind === "to" ? "bottom" : "center",
        })
          .setLngLat(at)
          .addTo(m);
      }
    }
  }, [from?.[0], from?.[1], to?.[0], to?.[1], me?.[0], me?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const padKey = [padding.top, padding.right, padding.bottom, padding.left].join(",");
  useEffect(() => {
    map.current?.setPadding(padding);
  }, [padKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    m.flyTo({
      center: focus.at,
      zoom: focus.zoom ?? Math.max(m.getZoom(), 14),
      essential: true,
      duration: 900,
    });
  }, [focus?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current;
    if (!m || !fit || !fit.coords.length) return;
    const bounds = new maplibregl.LngLatBounds(fit.coords[0], fit.coords[0]);
    for (const c of fit.coords) bounds.extend(c);
    // On top of the map's own padding: a little room round the trip.
    m.fitBounds(bounds, { padding: 36, maxZoom: 15.5, duration: 900 });
  }, [fit?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="map">
      <div ref={box} className="map-canvas" />
    </div>
  );
}

function netData(network: { id: string; coords: LngLat[] }[]) {
  return fc(network.filter((l) => l.coords.length > 1).map((l) => line(l.coords, { id: l.id })));
}

function stopData(stops: ApiStation[]) {
  return fc(
    stops.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.id, name: s.name },
    }))
  );
}

function drawnData(d: Drawn | null) {
  const { rides, walks, points } = d ?? NONE;
  return {
    ride: fc(rides.filter((r) => r.coords.length > 1).map((r) => line(r.coords, { color: r.color }))),
    walk: fc(walks.filter((w) => w.length > 1).map((w) => line(w))),
    points: fc(
      points.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: p.at },
        properties: { color: p.color, major: !!p.major },
      }))
    ),
  };
}
