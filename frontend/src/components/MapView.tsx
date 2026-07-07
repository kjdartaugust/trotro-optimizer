"use client";

/**
 * MapLibre map. Works fully offline: with no NEXT_PUBLIC_MAP_STYLE_URL it renders a blank
 * canvas style (no network tiles) and draws stations + the active itinerary as GeoJSON layers.
 * Point NEXT_PUBLIC_MAP_STYLE_URL at a local vector-tile style for a full offline basemap.
 */
import maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { ApiStation } from "@/lib/types";
import type { Itinerary } from "@/engine/engine";

const STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL;

// No `glyphs` key: the style has no text/symbol layers, and setting glyphs to `undefined`
// makes MapLibre's style validator throw ("glyphs: string expected, undefined found").
const BLANK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#101a33" } }],
};

export default function MapView({
  stations,
  itinerary,
}: {
  stations: ApiStation[];
  itinerary?: Itinerary | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const byId = useRef<Map<string, ApiStation>>(new Map());

  useEffect(() => {
    byId.current = new Map(stations.map((s) => [s.id, s]));
  }, [stations]);

  useEffect(() => {
    if (!ref.current || map.current) return;
    const m = new maplibregl.Map({
      container: ref.current,
      style: (STYLE_URL as unknown as maplibregl.StyleSpecification) || BLANK_STYLE,
      center: [-0.19, 5.6],
      zoom: 10.5,
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.current = m;
    m.on("load", () => draw());
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (map.current?.isStyleLoaded()) draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, itinerary]);

  function draw() {
    const m = map.current;
    if (!m) return;

    const stationsFc = {
      type: "FeatureCollection",
      features: stations.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { name: s.name },
      })),
    };
    setGeoJson(m, "stations", stationsFc);
    if (!m.getLayer("stations-c")) {
      m.addLayer({
        id: "stations-c", type: "circle", source: "stations",
        paint: { "circle-radius": 4, "circle-color": "#6fffe9", "circle-stroke-color": "#0b132b", "circle-stroke-width": 1 },
      });
    }

    // Active itinerary path (ride + walk legs) as a line between consecutive stations.
    const coords: [number, number][] = [];
    if (itinerary) {
      for (const leg of itinerary.legs) {
        const from = leg.fromStation ? byId.current.get(leg.fromStation) : undefined;
        const to = leg.toStation ? byId.current.get(leg.toStation) : undefined;
        if (from) coords.push([from.lon, from.lat]);
        if (to) coords.push([to.lon, to.lat]);
      }
    }
    const pathFc = {
      type: "FeatureCollection",
      features: coords.length
        ? [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} }]
        : [],
    };
    setGeoJson(m, "path", pathFc);
    if (!m.getLayer("path-l")) {
      m.addLayer({
        id: "path-l", type: "line", source: "path",
        paint: { "line-color": "#f4a261", "line-width": 4 },
      });
    }
    if (coords.length) {
      const b = coords.reduce(
        (acc, c) => acc.extend(c as maplibregl.LngLatLike),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      m.fitBounds(b, { padding: 60, maxZoom: 13, duration: 400 });
    }
  }

  return <div className="map" ref={ref} />;
}

function setGeoJson(m: maplibregl.Map, id: string, data: unknown) {
  const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data as GeoJSON.FeatureCollection);
  else m.addSource(id, { type: "geojson", data: data as GeoJSON.FeatureCollection });
}
