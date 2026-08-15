import { expect, test, describe, beforeAll } from "bun:test"

// validateTile lives inside runner.ts, which self-executes when run directly.
// Import it as a module (import.meta.main is false here) to test it in isolation.
let validateTile: (buf: ArrayBuffer) => { format?: string; error?: string }

beforeAll(async () => {
  const mod = await import("./runner") as any
  validateTile = mod.validateTile
})

async function fetchTile(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: { "User-Agent": "maps test" } })
  expect(res.ok, url).toBe(true)
  return res.arrayBuffer()
}

describe("tile validation", () => {
  test("accepts a real PNG tile", async () => {
    const buf = await fetchTile("https://a.tile.openstreetmap.org/2/1/1.png")
    expect(validateTile(buf)).toEqual({ format: "png" })
  }, 30_000)

  test("accepts a real JPEG tile", async () => {
    // Satellite sources serve JPEG. Rejecting it silently discarded every tile.
    const buf = await fetchTile("https://mt1.google.com/vt/lyrs=y&x=1000&y=1500&z=12")
    expect(validateTile(buf)).toEqual({ format: "jpg" })
  }, 30_000)

  test("rejects something that is neither, with a reason", () => {
    const junk = new TextEncoder().encode("x".repeat(200)).buffer
    const r = validateTile(junk)
    expect(r.error).toBe("not a PNG or JPEG")
  })

  test("rejects a truncated JPEG", async () => {
    const buf = await fetchTile("https://mt1.google.com/vt/lyrs=y&x=1000&y=1500&z=12")
    const cut = buf.slice(0, buf.byteLength - 4)
    expect(validateTile(cut).error).toContain("truncated")
  }, 30_000)

  test("rejects a tile that is not 256x256", async () => {
    // A 512px tile decodes fine but would render wrong, so the size check has
    // to survive the format change.
    const buf = await fetchTile("https://mt1.google.com/vt/lyrs=y&x=1000&y=1500&z=12")
    const b = new Uint8Array(buf.slice(0))
    // corrupt the SOF frame height
    for (let i = 2; i + 8 < b.length; i++) {
      if (b[i] === 0xff && b[i + 1] >= 0xc0 && b[i + 1] <= 0xcf &&
          b[i + 1] !== 0xc4 && b[i + 1] !== 0xc8 && b[i + 1] !== 0xcc) {
        b[i + 5] = 0x02; b[i + 6] = 0x00  // height -> 512
        break
      }
    }
    expect(validateTile(b.buffer).error).toContain("unexpected dimensions")
  }, 30_000)

  test("rejects anything too small to be a tile", () => {
    expect(validateTile(new Uint8Array(10).buffer).error).toContain("too small")
  })
})
