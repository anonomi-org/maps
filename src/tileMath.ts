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

function expandRegion(region: TileRegion) {
  const marginDeg = (region.marginKm ?? 0) / 111
  return {
    south: clampLat(region.bbox.south - marginDeg),
    north: clampLat(region.bbox.north + marginDeg),
    west: region.bbox.west - marginDeg,
    east: region.bbox.east + marginDeg,
  }
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
