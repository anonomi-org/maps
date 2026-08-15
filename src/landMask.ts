import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

// Derived from land.json, which ships with the code, so this is a build cache,
// not user state, and deliberately does NOT follow STATE_DIR. Putting it there
// would make every fresh deployment re-download Natural Earth on first boot.
const CACHE_PATH = join(import.meta.dir, "..", "land-mask.bin")
const GEOJSON_PATH = join(import.meta.dir, "..", "land.json")
const GEOJSON_URLS = [
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson",
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json",
]

// 0.25° grid: 1440 cols × 720 rows = 1,036,800 cells → 129,600 bytes as a bit array
const RES = 0.25
const COLS = 1440
const ROWS = 720
const BYTES = Math.ceil((COLS * ROWS) / 8)

let mask: Uint8Array | null = null

function cellIdx(lat: number, lon: number): number {
  const c = Math.min(COLS - 1, Math.max(0, Math.floor((lon + 180) / RES)))
  const r = Math.min(ROWS - 1, Math.max(0, Math.floor((90 - lat) / RES)))
  return r * COLS + c
}

function setBit(i: number) {
  mask![i >> 3] |= 1 << (i & 7)
}

function getBit(i: number): boolean {
  return !!(mask![i >> 3] & (1 << (i & 7)))
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

type Feature = {
  bbox: [number, number, number, number] // west south east north
  polygons: { outer: number[][]; holes: number[][][] }[]
}

type GeoJSONInput = { features: { geometry: { type: string; coordinates: unknown } }[] }

function parseGeoJSON(geojson: GeoJSONInput): Feature[] {
  const out: Feature[] = []
  for (const f of geojson.features) {
    const geom = f.geometry
    const polyCoords: number[][][][] =
      geom.type === "Polygon"
        ? [geom.coordinates as number[][][]]
        : geom.type === "MultiPolygon"
          ? (geom.coordinates as number[][][][])
          : []
    if (!polyCoords.length) continue

    const polygons = polyCoords.map((rings) => ({ outer: rings[0], holes: rings.slice(1) }))

    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const p of polygons) {
      for (const [lon, lat] of p.outer) {
        if (lon < w) w = lon
        if (lon > e) e = lon
        if (lat < s) s = lat
        if (lat > n) n = lat
      }
    }
    out.push({ bbox: [w, s, e, n], polygons })
  }
  return out
}

function rasterize(features: Feature[]) {
  mask = new Uint8Array(BYTES)
  for (let r = 0; r < ROWS; r++) {
    const lat = 90 - (r + 0.5) * RES
    for (let c = 0; c < COLS; c++) {
      const lon = -180 + (c + 0.5) * RES
      const bit = r * COLS + c
      outer: for (const f of features) {
        const [fw, fs, fe, fn] = f.bbox
        if (lon < fw || lon > fe || lat < fs || lat > fn) continue
        for (const p of f.polygons) {
          if (!pointInRing(lon, lat, p.outer)) continue
          if (p.holes.some((h) => pointInRing(lon, lat, h))) continue
          setBit(bit)
          break outer
        }
      }
    }
  }
}

export function maskReady(): boolean {
  return mask !== null
}

export function isLand(lat: number, lon: number): boolean {
  if (!mask) return true
  return getBit(cellIdx(lat, lon))
}

// A tile is "land" if its center or any corner falls on a land cell.
// Conservative: coastal tiles are always included.
export function tileIsLand(z: number, x: number, y: number): boolean {
  if (!mask) return true
  const n = 2 ** z
  const west = (x / n) * 360 - 180
  const east = ((x + 1) / n) * 360 - 180
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
  const midLat = (north + south) / 2
  const midLon = (west + east) / 2
  return (
    isLand(midLat, midLon) ||
    isLand(north, west) ||
    isLand(north, east) ||
    isLand(south, west) ||
    isLand(south, east)
  )
}

// Cache-only load, for callers that must not reach the network. The runner uses
// this: one process per run, so a cache miss there would mean re-downloading
// Natural Earth on every single run. Returns false if there is no cache, and
// tileIsLand then treats everything as land, which keeps tiles rather than
// silently skipping them.
export function loadCachedLandMask(): boolean {
  if (mask) return true
  if (!existsSync(CACHE_PATH)) return false
  const buf = readFileSync(CACHE_PATH)
  mask = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  return true
}

export async function initLandMask(): Promise<void> {
  if (loadCachedLandMask()) {
    console.log("  land mask: loaded from cache")
    return
  }

  console.log("  land mask: downloading Natural Earth 1:110m…")
  let geojson: GeoJSONInput

  if (existsSync(GEOJSON_PATH)) {
    geojson = JSON.parse(readFileSync(GEOJSON_PATH, "utf8")) as GeoJSONInput
  } else {
    let fetched: GeoJSONInput | null = null
    for (const url of GEOJSON_URLS) {
      const res = await fetch(url, { headers: { "User-Agent": "maps/1.0" } })
      if (res.ok) {
        fetched = (await res.json()) as GeoJSONInput
        writeFileSync(GEOJSON_PATH, JSON.stringify(fetched))
        break
      }
      console.warn(`  land mask: ${url} → HTTP ${res.status}`)
    }
    if (!fetched) throw new Error("Failed to fetch land data from all sources")
    geojson = fetched
  }

  console.log("  land mask: rasterizing (0.25° grid)…")
  const t0 = Date.now()
  const features = parseGeoJSON(geojson)
  rasterize(features)
  console.log(`  land mask: done in ${((Date.now() - t0) / 1000).toFixed(1)}s, caching…`)
  writeFileSync(CACHE_PATH, Buffer.from(mask!.buffer))
  console.log("  land mask: cached to land-mask.bin")
}
