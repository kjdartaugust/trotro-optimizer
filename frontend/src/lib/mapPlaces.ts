/**
 * Places on the map (shops, food, clinics, schools, churches and mosques, fuel, banks...) the way
 * map apps show them: the map's icon and a name in the colour of its kind, the busiest first and
 * the rest as you zoom in. Two sources share one look: OpenStreetMap's places, in the street tiles
 * (`openmaptiles`, layer `poi`), and Overture's list (`places`, lib/overture.ts), which knows far
 * more of Accra's businesses. Both carry `class` (OpenMapTiles' kinds), `name` and `rank`.
 */
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";

/** Each kind's classes and colours. Food is red-orange, not amber: amber is the trotro lines. */
const KINDS: { classes: string[]; light: string; dark: string }[] = [
  {
    classes: ["restaurant", "fast_food", "cafe", "bar", "beer", "bakery", "ice_cream"],
    light: "#c43c0a",
    dark: "#ff9d7a",
  },
  { classes: ["hospital", "pharmacy", "doctors", "dentist", "veterinary"], light: "#c0262d", dark: "#ff8a8f" },
  { classes: ["school", "college", "library", "kindergarten"], light: "#86531c", dark: "#e3bd8e" },
  {
    classes: [
      "shop", "grocery", "clothing_store", "alcohol_shop", "gift", "furniture", "florist", "butcher",
      "hairdresser", "laundry", "jewelry", "mobile_phone", "shoes", "hardware", "electronics", "books",
      "commercial",
    ],
    light: "#1f5fbf",
    dark: "#8dbaff",
  },
  {
    classes: ["place_of_worship", "religious_christian", "religious_muslim", "religious_jewish"],
    light: "#5b5651",
    dark: "#d3cfca",
  },
  { classes: ["lodging"], light: "#a3226b", dark: "#f59acb" },
  {
    classes: ["park", "garden", "pitch", "stadium", "playground", "golf", "swimming", "zoo", "sports"],
    light: "#1d7a3e",
    dark: "#86e0a6",
  },
  { classes: ["fuel", "car", "parking", "car_repair"], light: "#0e6f68", dark: "#6fe0d4" },
  {
    classes: ["bank", "atm", "post", "town_hall", "police", "fire_station", "embassy", "office", "industry"],
    light: "#4a3fb8",
    dark: "#c4bdff",
  },
];

/** Kinds the map already shows another way: trotro stops are ours, entrances are noise. */
const LEFT_OUT = ["bus", "railway", "aerialway", "entrance", "information", "toilets", "drinking_water"];

/** Each tier's first zoom: the busiest or surest places from further out, the rest closer in. */
const TIER_ZOOM = [14.5, 15.5, 16.5];

export const PLACE_LAYERS = [
  "places-osm-1", "places-osm-2", "places-osm-3", "places-more-1", "places-more-2", "places-more-3",
];

function colour(dark: boolean): ExpressionSpecification {
  const m: unknown[] = ["match", ["get", "class"]];
  for (const k of KINDS) m.push(k.classes, dark ? k.dark : k.light);
  m.push(dark ? "#b9c0ca" : "#5f6670");
  return m as ExpressionSpecification;
}

const NAME: ExpressionSpecification = ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]];

// Kinds the map's icon set has no picture for, given the nearest one it has.
const ICON: ExpressionSpecification = [
  "match", ["get", "class"],
  "office", "suitcase",
  "kindergarten", "school",
  "atm", "bank",
  "car_repair", "car",
  "sports", "pitch",
  ["jewelry", "mobile_phone", "shoes", "hardware", "electronics", "books"], "shop",
  "place", "marker",
  ["get", "class"],
];

function look(dark: boolean) {
  return {
    layout: {
      // The map's icon for the kind, or a plain circle where it has none. `to-string`: Overture's
      // places have no subclass, and an image of null is an error that hides the icon outright.
      "icon-image": [
        "coalesce",
        ["image", ["to-string", ["get", "subclass"]]],
        ["image", ICON],
        ["image", "circle_11"],
      ] as ExpressionSpecification,
      "icon-size": 0.9,
      "text-field": NAME,
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 15, 11.5, 18, 13] as ExpressionSpecification,
      "text-anchor": "top" as const,
      "text-offset": [0, 0.75] as [number, number],
      "text-max-width": 8,
      // Crowded streets keep the icon and drop the name, as map apps do.
      "text-optional": true,
      "symbol-sort-key": ["get", "rank"] as ExpressionSpecification,
    },
    paint: {
      "text-color": colour(dark),
      "text-halo-color": dark ? "#0c0c0c" : "#ffffff",
      "text-halo-width": 1.3,
      "icon-opacity": dark ? 0.92 : 1,
    },
  };
}

const named: FilterSpecification = ["all",
  ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
  ["has", "name"],
  ["!", ["match", ["get", "class"], LEFT_OUT, true, false]],
];

function osm(id: string, minzoom: number, dark: boolean, hidden: string[]): LayerSpecification {
  return {
    id,
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom,
    filter: osmFilter(id, hidden),
    ...look(dark),
  } as LayerSpecification;
}

const OSM_RANKS: Record<string, [number, number]> = {
  "places-osm-1": [1, 7],
  "places-osm-2": [7, 20],
  "places-osm-3": [20, 1e9],
};
export const OSM_PLACE_LAYERS = Object.keys(OSM_RANKS);

/** Which of OpenStreetMap's places a layer draws: its ranks, named, minus `hidden` (names Overture
 *  has under a plainer name, lib/morePlaces.ts `hideOsm`). */
export function osmFilter(id: string, hidden: string[] = []): FilterSpecification {
  const [lo, hi] = OSM_RANKS[id];
  const f: unknown[] = ["all", named, [">=", ["get", "rank"], lo], ["<", ["get", "rank"], hi]];
  if (hidden.length) f.push(["!", ["in", ["get", "name"], ["literal", hidden]]]);
  return f as FilterSpecification;
}

/** OpenStreetMap's places, busiest first (OpenMapTiles' rank), the rest as you zoom in. */
export function osmPlaceLayers(dark: boolean, hidden: string[] = []): LayerSpecification[] {
  return OSM_PLACE_LAYERS.map((id, t) => osm(id, TIER_ZOOM[t], dark, hidden));
}

/** Overture's places (source `places`, lib/morePlaces.ts), by the tier the ETL gave each. */
export function morePlaceLayers(dark: boolean): LayerSpecification[] {
  return [1, 2, 3].map(
    (tier) =>
      ({
        id: `places-more-${tier}`,
        type: "symbol",
        source: "places",
        minzoom: TIER_ZOOM[tier - 1],
        filter: ["all", ["==", ["get", "tier"], tier], ["!", ["match", ["get", "class"], LEFT_OUT, true, false]]],
        ...look(dark),
      }) as LayerSpecification
  );
}

/** A place's name from a map feature, whichever source drew it. */
export function placeName(props: Record<string, unknown> | null | undefined): string | null {
  const n = props?.["name:latin"] ?? props?.name_en ?? props?.name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

/** Where places go: above our lines, under the street and town names, as map apps stack them. */
export function placesBefore(layers: { id: string; type: string; "source-layer"?: string }[], after: number) {
  for (let i = after + 1; i < layers.length; i++) {
    const sl = layers[i]["source-layer"];
    if (layers[i].type === "symbol" && (sl === "transportation_name" || sl === "place")) return layers[i].id;
  }
  return undefined;
}
