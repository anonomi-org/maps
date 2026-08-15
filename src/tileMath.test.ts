import { expect, test, describe } from "bun:test"
import {
  lon2tileX,
  lat2tileY,
  clampLat,
  buildTileUrl,
  countTiles,
  collectTiles,
  type TileRegion,
} from "./tileMath"

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
