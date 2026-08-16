import type { Bbox } from "./types"

export function lon2tileX(lon: number, z: number): number {
  const n = 2 ** z
  return Math.floor(((lon + 180) / 360) * n)
}

export function lat2tileY(lat: number, z: number): number {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  const merc = Math.log(Math.tan(Math.PI / 4 + rad / 2))
  return Math.floor(((1 - merc / Math.PI) / 2) * n)
}

// The web mercator limit is atan(sinh(PI)) = 85.0511287798066…, and it has to be
// rounded *down*. Rounding up puts the pole a hair outside the projection, where
// lat2tileY floors to -1, an off-grid tile the range clamps hide but that any
// direct caller would hand straight to a tile server.
const MAX_MERCATOR_LAT = 85.05112877

export function clampLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
}

export function buildTileUrl(
  template: string,
  z: number,
  x: number,
  y: number,
  s?: string,
): string {
  return template
    .replace("{s}", s ?? "")
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y))
}

export type TileRegion = {
  bbox: Bbox
  marginKm: number
  zoomMin: number
  zoomMax: number
}

// A degree of latitude is ~111 km everywhere, but a degree of longitude is that
// only at the equator and shrinks by cos(lat) toward the poles. Converting the
// margin once and applying it to both axes therefore under-covers east to west
// by exactly that factor: 25 km asked for at Saint Petersburg bought 12.5 km,
// and every region came out a tall thin rectangle instead of the square the
// operator drew. Latitude and longitude get their own conversion.
//
// Anything that expands a region has to call this. The conversion used to be
// copied into four places, and the copy in isTileInCoverageList decides which
// tiles cleanup keeps, so a version that disagreed with the runner's would
// delete tiles the runner had just downloaded.
const KM_PER_DEG_LAT = 111

export function expandBbox(bbox: Bbox, marginKm: number): Bbox {
  const marginLat = (marginKm ?? 0) / KM_PER_DEG_LAT
  const south = clampLat(bbox.south - marginLat)
  const north = clampLat(bbox.north + marginLat)
  // Scale by whichever edge sits furthest from the equator, so the whole box
  // gets at least the margin asked for rather than only its middle. Taking it
  // after clampLat also bounds cos() below at cos(85.05 deg), so a region at the
  // pole widens by 11.5x rather than dividing by zero.
  const worstLat = Math.max(Math.abs(south), Math.abs(north))
  const marginLon = marginLat / Math.cos((worstLat * Math.PI) / 180)
  return {
    south,
    north,
    west: bbox.west - marginLon,
    east: bbox.east + marginLon,
  }
}

function expandRegion(region: TileRegion) {
  return expandBbox(region.bbox, region.marginKm ?? 0)
}

function tileRange(region: TileRegion, z: number) {
  const { south, north, west, east } = expandRegion(region)
  const n = 2 ** z
  const xmin = Math.max(0, Math.min(lon2tileX(west, z), lon2tileX(east, z)))
  const xmax = Math.min(n - 1, Math.max(lon2tileX(west, z), lon2tileX(east, z)))
  const ymin = Math.max(0, Math.min(lat2tileY(north, z), lat2tileY(south, z)))
  const ymax = Math.min(n - 1, Math.max(lat2tileY(north, z), lat2tileY(south, z)))
  return { xmin, xmax, ymin, ymax }
}

export function countTiles(region: TileRegion): number {
  let total = 0
  for (let z = region.zoomMin; z <= region.zoomMax; z++) {
    const { xmin, xmax, ymin, ymax } = tileRange(region, z)
    total += (xmax - xmin + 1) * (ymax - ymin + 1)
  }
  return total
}

export function iterateTiles(
  region: TileRegion,
  callback: (z: number, x: number, y: number) => void,
): void {
  for (let z = region.zoomMin; z <= region.zoomMax; z++) {
    const { xmin, xmax, ymin, ymax } = tileRange(region, z)
    for (let x = xmin; x <= xmax; x++) {
      for (let y = ymin; y <= ymax; y++) {
        callback(z, x, y)
      }
    }
  }
}

export function collectTiles(region: TileRegion): [number, number, number][] {
  const tiles: [number, number, number][] = []
  iterateTiles(region, (z, x, y) => tiles.push([z, x, y]))
  return tiles
}
