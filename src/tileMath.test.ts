import { expect, test, describe } from "bun:test"
import {
  lon2tileX,
  lat2tileY,
  clampLat,
  buildTileUrl,
  countTiles,
  collectTiles,
  expandBbox,
  type TileRegion,
} from "./tileMath"
import { expandRegion as runnerExpandRegion } from "./runner"

// A region covering roughly the Lisbon area, used across the range tests.
function lisbon(overrides: Partial<TileRegion> = {}): TileRegion {
  return {
    bbox: { north: 38.9, south: 38.6, west: -9.3, east: -9.0 },
    marginKm: 0,
    zoomMin: 0,
    zoomMax: 4,
    ...overrides,
  }
}

describe("slippy map coordinates", () => {
  test("zoom 0 is a single tile", () => {
    expect(lon2tileX(-9.1393, 0)).toBe(0)
    expect(lat2tileY(38.7223, 0)).toBe(0)
    expect(lon2tileX(151.2093, 0)).toBe(0)
    expect(lat2tileY(-33.8688, 0)).toBe(0)
  })

  test("zoom 1 splits into the expected quadrants", () => {
    // West of the prime meridian is x=0, east is x=1.
    expect(lon2tileX(-90, 1)).toBe(0)
    expect(lon2tileX(90, 1)).toBe(1)
    // Northern hemisphere is y=0, southern is y=1.
    expect(lat2tileY(45, 1)).toBe(0)
    expect(lat2tileY(-45, 1)).toBe(1)
  })

  test("known cities land on their published tiles", () => {
    expect(lon2tileX(-9.1393, 12)).toBe(1944)
    expect(lat2tileY(38.7223, 12)).toBe(1569)
    expect(lon2tileX(151.2093, 10)).toBe(942)
    expect(lat2tileY(-33.8688, 10)).toBe(614)
  })

  test("indices stay inside the grid at the extremes", () => {
    for (const z of [1, 8, 14]) {
      const max = 2 ** z - 1
      expect(lon2tileX(-180, z)).toBe(0)
      expect(lon2tileX(179.9999, z)).toBeLessThanOrEqual(max)
      expect(lat2tileY(clampLat(90), z)).toBeGreaterThanOrEqual(0)
      expect(lat2tileY(clampLat(-90), z)).toBeLessThanOrEqual(max)
    }
  })

  test("clampLat holds latitudes to the web mercator limit", () => {
    expect(clampLat(90)).toBeCloseTo(85.05112878, 6)
    expect(clampLat(-90)).toBeCloseTo(-85.05112878, 6)
    expect(clampLat(38.7223)).toBe(38.7223)
  })
})

describe("counting tiles", () => {
  test("countTiles agrees with what collectTiles actually yields", () => {
    // These two disagreeing is how an estimate silently stops matching a download.
    for (const zoomMax of [0, 4, 8]) {
      const region = lisbon({ zoomMax })
      expect(countTiles(region)).toBe(collectTiles(region).length)
    }
  })

  test("a whole-world region has 4^z tiles at each zoom", () => {
    const world: TileRegion = {
      bbox: { north: 85, south: -85, west: -180, east: 179.9999 },
      marginKm: 0,
      zoomMin: 0,
      zoomMax: 3,
    }
    // 1 + 4 + 16 + 64
    expect(countTiles(world)).toBe(85)
  })

  test("only the requested zoom range is produced", () => {
    const tiles = collectTiles(lisbon({ zoomMin: 3, zoomMax: 5 }))
    const zooms = [...new Set(tiles.map(([z]) => z))].sort((a, b) => a - b)
    expect(zooms).toEqual([3, 4, 5])
  })

  test("a single zoom level still yields tiles", () => {
    const tiles = collectTiles(lisbon({ zoomMin: 6, zoomMax: 6 }))
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.every(([z]) => z === 6)).toBe(true)
  })

  test("a sea margin never removes tiles", () => {
    // At low zoom a wider bbox can still land inside the same tiles, so the
    // guarantee is only that the count does not shrink.
    for (const zoomMax of [4, 8, 12]) {
      const tight = countTiles(lisbon({ zoomMax }))
      const padded = countTiles(lisbon({ zoomMax, marginKm: 50 }))
      expect(padded).toBeGreaterThanOrEqual(tight)
    }
  })

  test("a sea margin does add tiles once they are smaller than the margin", () => {
    // Tiles at z12 span ~0.09 degrees; a 50 km margin is ~0.45 degrees.
    const tight = countTiles(lisbon({ zoomMin: 12, zoomMax: 12 }))
    const padded = countTiles(lisbon({ zoomMin: 12, zoomMax: 12, marginKm: 50 }))
    expect(padded).toBeGreaterThan(tight)
  })

  test("every tile is inside the grid for its zoom", () => {
    for (const [z, x, y] of collectTiles(lisbon({ zoomMax: 10 }))) {
      const max = 2 ** z - 1
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(max)
      expect(y).toBeLessThanOrEqual(max)
    }
  })

  test("no tile is emitted twice", () => {
    const tiles = collectTiles(lisbon({ zoomMax: 8 }))
    expect(new Set(tiles.map((t) => t.join("/"))).size).toBe(tiles.length)
  })
})

describe("margin expansion", () => {
  // How many km a longitude span actually covers on the ground at a latitude.
  function ewKm(lonDelta: number, lat: number): number {
    return lonDelta * 111 * Math.cos((lat * Math.PI) / 180)
  }

  // Small boxes around real hot-zone candidates, spanning the useful range of
  // latitudes. Saint Petersburg is the case that motivated the fix.
  const CITIES = [
    { name: "Singapore", lat: 1.35 },
    { name: "Lisbon", lat: 38.72 },
    { name: "London", lat: 51.51 },
    { name: "Moscow", lat: 55.75 },
    { name: "Saint Petersburg", lat: 59.94 },
  ]

  function box(lat: number, lon = 0) {
    return { north: lat + 0.05, south: lat - 0.05, west: lon - 0.05, east: lon + 0.05 }
  }

  test("a margin delivers its km east to west, not just north to south", () => {
    // The old conversion applied the equator's 111 km/deg to longitude too, so
    // this bought marginKm * cos(lat) and every northern city came out narrow.
    for (const city of CITIES) {
      const b = box(city.lat)
      const e = expandBbox(b, 25)
      const worstLat = Math.max(Math.abs(e.north), Math.abs(e.south))
      expect(ewKm(e.east - b.east, worstLat)).toBeGreaterThanOrEqual(24.9)
      expect(ewKm(b.west - e.west, worstLat)).toBeGreaterThanOrEqual(24.9)
      // North to south was always right, and must stay right.
      expect((e.north - b.north) * 111).toBeCloseTo(25, 1)
    }
  })

  test("the equator is left alone, so this is a fix and not a blanket widening", () => {
    const b = box(0)
    const e = expandBbox(b, 25)
    // Not exactly equal: the scale comes from the box's furthest edge rather
    // than its middle, so a box straddling the equator overshoots by 0.3 m.
    // What matters is that it is not the cos(lat)-sized widening seen up north.
    const ratio = (e.east - b.east) / (e.north - b.north)
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(1.0001)
  })

  test("higher latitude widens more", () => {
    const widths = CITIES.map((c) => {
      const b = box(c.lat)
      return expandBbox(b, 25).east - b.east
    })
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeGreaterThan(widths[i - 1]!)
    }
  })

  test("a region at the pole widens by a bounded amount instead of dividing by zero", () => {
    const e = expandBbox({ north: 89.9, south: 89.8, west: -1, east: 1 }, 25)
    expect(Number.isFinite(e.east)).toBe(true)
    expect(Number.isFinite(e.west)).toBe(true)
    // clampLat holds the latitude at 85.05 deg, where 1/cos is ~11.5.
    expect(e.east - 1).toBeLessThan(25 / 111 * 12)
  })

  test("a zero margin changes nothing", () => {
    const b = box(51.51, -0.13)
    expect(expandBbox(b, 0)).toEqual({ north: b.north, south: b.south, west: b.west, east: b.east })
  })

  test("the runner expands regions exactly as tileMath does", () => {
    // These are separate copies on purpose, and the runner's decides what is
    // downloaded while tileMath's decides what cleanup keeps. Drift between them
    // deletes freshly downloaded tiles, so it is pinned here rather than trusted.
    for (const city of CITIES) {
      for (const marginKm of [0, 5, 25, 50]) {
        const bbox = box(city.lat, 10)
        expect(runnerExpandRegion({ name: city.name, bbox, marginKm })).toEqual(
          expandBbox(bbox, marginKm),
        )
      }
    }
  })
})

describe("tile urls", () => {
  test("placeholders are filled in", () => {
    expect(buildTileUrl("https://{s}.tile.example.com/{z}/{x}/{y}.png", 4, 7, 6, "a"))
      .toBe("https://a.tile.example.com/4/7/6.png")
  })

  test("a template without a subdomain slot is left alone", () => {
    expect(buildTileUrl("https://tiles.example.com/{z}/{x}/{y}.png", 2, 1, 1))
      .toBe("https://tiles.example.com/2/1/1.png")
  })
})
