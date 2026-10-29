import { geoMercator, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, Geometry, MultiLineString } from "geojson";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countiesTopo from "us-atlas/counties-10m.json" with { type: "json" };
import { STATE_FIPS, type County } from "./counties";

/**
 * County shapes from the Census Bureau's cartographic boundary files (public domain), as packaged by us-atlas.
 * Read on the server only; the browser receives finished SVG paths.
 */
type CountyProps = { name: string };
const topo = countiesTopo as unknown as Topology<{
  counties: GeometryCollection<CountyProps>;
  states: GeometryCollection<CountyProps>;
}>;

const allCounties = feature(topo, topo.objects.counties) as FeatureCollection<Geometry, CountyProps>;

export function countiesOf(state: string): County[] {
  const fips = STATE_FIPS[state.toUpperCase()];
  if (!fips) return [];
  return allCounties.features
    .filter((f) => String(f.id).startsWith(fips))
    .map((f) => ({ fips: String(f.id), name: f.properties.name }));
}

export interface CountyShape {
  fips: string;
  name: string;
  d: string;
}

export interface StateMap {
  width: number;
  height: number;
  counties: CountyShape[];
  outline: string;
}

/** SVG paths for one state's counties, fitted to the given box. */
export function stateMap(state: string, width = 560, height = 440): StateMap | null {
  const fips = STATE_FIPS[state.toUpperCase()];
  if (!fips) return null;
  const features = allCounties.features.filter((f) => String(f.id).startsWith(fips)) as Feature<
    Geometry,
    CountyProps
  >[];
  if (features.length === 0) return null;
  const fc: FeatureCollection<Geometry, CountyProps> = { type: "FeatureCollection", features };
  const projection = geoMercator().fitSize([width, height], fc);
  const path = geoPath(projection);
  const outlineGeom = mesh(
    topo,
    topo.objects.counties,
    (a, b) => a === b && String(a.id).startsWith(fips),
  ) as MultiLineString;
  return {
    width,
    height,
    counties: features.map((f) => ({ fips: String(f.id), name: f.properties.name, d: path(f) ?? "" })),
    outline: path(outlineGeom) ?? "",
  };
}
