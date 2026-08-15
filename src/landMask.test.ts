import { expect, test, describe, beforeAll } from "bun:test"
import { initLandMask, loadCachedLandMask, tileIsLand, isLand } from "./landMask"
import { collectTiles } from "./tileMath"

// The mask decides what gets downloaded, so a wrong answer here is either a
// hole in the map or days of wasted bandwidth.

const WORLD = { north: 85, south: -85, west: -180, east: 179.999 }

let haveMask = false
// land-mask.bin is derived data and deliberately not committed, so a clean
// checkout has no cache and every assertion below would fail for a reason that
// has nothing to do with the mask being wrong. Build it once if it is missing:
// the first run fetches Natural Earth, later runs read the cache.
beforeAll(async () => {
  haveMask = loadCachedLandMask()
  if (haveMask) return
  await initLandMask()
  haveMask = loadCachedLandMask()
}, 180_000)

describe("land mask", () => {
  test("the cache loads", () => {
    // Everything below is meaningless without it, and the runner depends on
    // this exact cache-only path.
    expect(haveMask).toBe(true)
  })

  test("low zooms are kept whole, so parent-tile fallback always has a base", () => {
    // A missing tile makes the Android client fall back to the parent zoom. That
    // only works if the parents exist. z0 and z1 must never be skipped.
    expect(tileIsLand(0, 0, 0)).toBe(true)
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        expect(tileIsLand(1, x, y), `z1 ${x}/${y}`).toBe(true)
      }
    }
  })

  test("known land is land", () => {
    for (const [name, lat, lon] of [
      ["London", 51.507, -0.128], ["Madrid", 40.416, -3.703],
      ["Dar es Salaam", -6.79, 39.21], ["Kansas", 38.5, -98.0],
      ["Siberia", 62.0, 95.0],
    ] as [string, number, number][]) {
      expect(isLand(lat, lon), name).toBe(true)
    }
  })

  test("open ocean is not land", () => {
    for (const [name, lat, lon] of [
      ["mid Pacific", 0, -140], ["mid Atlantic", 30, -40],
      ["Southern Ocean", -55, 100],
    ] as [string, number, number][]) {
      expect(isLand(lat, lon), name).toBe(false)
    }
  })

  test("coastal tiles are kept, not dropped", () => {
    // tileIsLand samples the centre and four corners, so a tile that is mostly
    // sea but touches a coast still counts. Losing these would eat coastlines,
    // which is where most map detail people care about lives.
    const lisbonCoast = collectTiles({
      bbox: { north: 38.8, south: 38.6, west: -9.5, east: -9.3 },
      marginKm: 0, zoomMin: 10, zoomMax: 10,
    })
    expect(lisbonCoast.some(([z, x, y]) => tileIsLand(z, x, y))).toBe(true)
  })

  test("it actually removes a large share of a world corpus", () => {
    const tiles = collectTiles({ ...{ bbox: WORLD, marginKm: 0 }, zoomMin: 0, zoomMax: 8 })
    const land = tiles.filter(([z, x, y]) => tileIsLand(z, x, y)).length
    const kept = land / tiles.length
    // Land is ~40% of tile space; anything near 100% means the mask silently
    // stopped working and we are back to downloading the ocean.
    expect(kept).toBeGreaterThan(0.3)
    expect(kept).toBeLessThan(0.6)
  })
})
