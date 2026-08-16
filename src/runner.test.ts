import { expect, test, describe } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { main, isTileFile, generateAllTiles, countAllTiles } from "./runner"

// The runner is spawned as its own process, so a module-evaluation error in it
// is invisible to typecheck, to the build, and to any test that only imports it.
// One was shipped exactly that way: a const used by main() sat below the
// top-level await, so every run died in the temporal dead zone. These spawn it
// for real.

function runnerArgs(outputDir: string, overrides: Record<string, unknown> = {}) {
  return {
    coverageId: "c", runId: "test", mode: "validate", mapId: "m",
    regions: [{ name: "x", bbox: { north: 38.8, south: 38.7, west: -9.2, east: -9.1 }, marginKm: 0 }],
    zoomMin: 0, zoomMax: 2,
    tileSource: "https://example.invalid/{z}/{x}/{y}.png",
    tileSubdomains: ["a"], workers: 1, maxCallsPerMinute: 60,
    outputDir,
    // Unreachable on purpose: these tests are about the runner starting and
    // exiting cleanly, not about the server.
    progressUrl: "http://127.0.0.1:1/progress",
    completeUrl: "http://127.0.0.1:1/complete",
    controlUrl: "http://127.0.0.1:1/control",
    fetchTileUrl: "http://127.0.0.1:1/fetch",
    internalToken: "x",
    ...overrides,
  }
}

async function spawnRunner(args: Record<string, unknown>) {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "runner.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  proc.stdin.write(JSON.stringify(args))
  proc.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("runner process", () => {
  test("evaluates its module and exits cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"))
    try {
      const { stderr, exitCode } = await spawnRunner(runnerArgs(dir))
      expect(stderr).not.toContain("ReferenceError")
      expect(stderr).not.toContain("before initialization")
      expect(stderr).not.toContain("is not defined")
      expect(exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("starts in download mode too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"))
    try {
      const { stderr, exitCode } = await spawnRunner(runnerArgs(dir, { mode: "resume", transport: "tor" }))
      expect(stderr).not.toContain("ReferenceError")
      expect(stderr).not.toContain("before initialization")
      expect(exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// A satellite source serves JPEG, so a real corpus can be entirely .jpg. Both
// corpus walkers matched only .png, so a validate run over such a corpus
// reported zero tiles and recorded that as a success — which is how a live
// coverage ended up claiming tilesOnDisk: 0 with 1701 tiles on disk.
describe("corpus walking", () => {
  test("isTileFile accepts every format the downloader writes", () => {
    expect(isTileFile("0.png")).toBe(true)
    expect(isTileFile("0.jpg")).toBe(true)
    expect(isTileFile("map.json")).toBe(false)
    expect(isTileFile("0.png.tmp")).toBe(false)
  })

  test("validate counts a jpg corpus and ignores non-tiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-walk-"))
    try {
      for (const [z, x, y] of [["0", "0", "0"], ["1", "0", "1"], ["1", "1", "0"]]) {
        mkdirSync(join(dir, "m", z, x), { recursive: true })
        writeFileSync(join(dir, "m", z, x, `${y}.jpg`), Buffer.alloc(64, 1))
      }
      // One png and one non-tile, so the count proves it takes both formats
      // and still skips everything else.
      mkdirSync(join(dir, "m", "2", "0"), { recursive: true })
      writeFileSync(join(dir, "m", "2", "0", "0.png"), Buffer.alloc(64, 1))
      writeFileSync(join(dir, "m", "2", "0", "notes.txt"), "x")

      const a = runnerArgs(dir)
      const res = (await main(
        a.coverageId, a.runId, "validate", a.mapId, a.regions as never, a.zoomMin, a.zoomMax,
        a.tileSource, a.tileSubdomains, a.workers, a.maxCallsPerMinute, dir,
        a.progressUrl, a.completeUrl, a.controlUrl, a.internalToken, a.fetchTileUrl,
      )) as { status: string; tilesOnDisk?: number; sizeBytes?: number }

      expect(res.status).toBe("done")
      expect(res.tilesOnDisk).toBe(4)
      expect(res.sizeBytes).toBe(256)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// Resume decides "already have it" from a cached readdir of the {z}/{x} column
// rather than a stat per tile. That is a speed change, but it rewrites the
// lookup, and getting the filename match wrong would turn a skip into a
// re-download of the entire corpus, silently at that, because a re-download
// still succeeds. These pin the contract: every tile already on disk is
// skipped, in either extension, without a single fetch leaving the runner.
describe("resume skips what is already on disk", () => {
  function capture() {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    let fetches = 0
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/control") return Response.json({ command: "none" })
        if (path === "/fetch") { fetches++; return Response.json({ error: "should not be reached" }, { status: 500 }) }
        posts.push({ path, body: (await req.json().catch(() => ({}))) as Record<string, unknown> })
        return Response.json({ ok: true })
      },
    })
    return { srv, posts, base: `http://127.0.0.1:${srv.port}`, fetchCount: () => fetches }
  }

  // A superset of whatever the run asks for: the land mask only ever removes
  // tiles from the box, so covering the whole box needs no guess about which
  // tiles survive it.
  function seedBox(dir: string, zMax: number, fmtFor: (z: number) => string) {
    for (let z = 0; z <= zMax; z++) {
      const n = 2 ** z
      for (let x = 0; x < n; x++) {
        mkdirSync(join(dir, "m", String(z), String(x)), { recursive: true })
        for (let y = 0; y < n; y++) {
          writeFileSync(join(dir, "m", String(z), String(x), `${y}.${fmtFor(z)}`), Buffer.alloc(64, 1))
        }
      }
    }
  }

  function runResume(outputDir: string, base: string) {
    return main(
      "c", "test-run", "resume", "m",
      [{ name: "x", bbox: { north: 38.8, south: 38.7, west: -9.2, east: -9.1 }, marginKm: 0 }] as never,
      0, 2,
      "https://example.invalid/{z}/{x}/{y}.png", ["a"], 1, 60,
      outputDir,
      `${base}/progress`, `${base}/complete`, `${base}/control`,
      "tok", `${base}/fetch`,
    )
  }

  // Mixed on purpose: the corpus is .jpg, but tiles written before the source
  // changed format are .png, and both have to count as present.
  test("finds both extensions and fetches nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-resume-"))
    const { srv, posts, base, fetchCount } = capture()
    try {
      seedBox(dir, 2, (z) => (z < 2 ? "png" : "jpg"))
      await runResume(dir, base)

      const complete = posts.filter((p) => p.path === "/complete").pop()
      expect(complete).toBeDefined()
      expect(complete!.body.status).toBe("done")
      expect(complete!.body.skipped).toBe(complete!.body.total)
      expect(complete!.body.skipped).toBeGreaterThan(0)
      expect(complete!.body.done).toBe(0)
      expect(complete!.body.failed).toBe(0)
      expect(fetchCount()).toBe(0)
    } finally {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // The complement: an empty corpus must still reach the network for every
  // tile, so the check above cannot be passing by skipping everything blindly.
  test("an empty corpus still fetches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-resume-empty-"))
    const { srv, posts, base, fetchCount } = capture()
    try {
      await runResume(dir, base)

      const complete = posts.filter((p) => p.path === "/complete").pop()
      expect(complete!.body.skipped).toBe(0)
      expect(fetchCount()).toBeGreaterThan(0)
    } finally {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// The disk had a circuit breaker and the network had none. A source refusing
// every request did not stop the run: it walked the entire tile list spending
// three attempts on each, so the answer to a rate limit was more traffic, and
// the coverage ended up recorded as wholly failed rather than as blocked.
describe("a rate-limiting source stops the run", () => {
  function capture(status: number, retryAfter?: string) {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    let fetches = 0
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/control") return Response.json({ command: "none" })
        if (path === "/fetch") {
          fetches++
          const headers: Record<string, string> = {}
          if (retryAfter) headers["Retry-After"] = retryAfter
          return Response.json({ error: `tile server ${status}`, retryAfterMs: 0 }, { status, headers })
        }
        posts.push({ path, body: (await req.json().catch(() => ({}))) as Record<string, unknown> })
        return Response.json({ ok: true })
      },
    })
    return { srv, posts, base: `http://127.0.0.1:${srv.port}`, fetchCount: () => fetches }
  }

  // Zoom 0-7 so the tile list is far longer than the breaker's threshold; if
  // the breaker never fires the run walks all of it.
  function runResume(outputDir: string, base: string) {
    return main(
      "c", "test-run", "resume", "m",
      [{ name: "x", bbox: { north: 60, south: -30, west: -120, east: 120 }, marginKm: 0 }] as never,
      0, 7,
      "https://example.invalid/{z}/{x}/{y}.jpg", ["a"], 4, 600,
      outputDir,
      `${base}/progress`, `${base}/complete`, `${base}/control`,
      "tok", `${base}/fetch`,
    )
  }

  test("a sustained 429 trips the breaker instead of running to the end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-429-"))
    // retryAfterMs: 0 in the body, so the test is not waiting out real backoffs.
    const { srv, posts, base, fetchCount } = capture(429)
    try {
      const res = (await runResume(dir, base)) as { status: string }

      expect(res.status).toBe("error")
      const complete = posts.filter((p) => p.path === "/complete").pop()
      expect(complete!.body.status).toBe("error")
      expect(String(complete!.body.error)).toContain("rate limiting")

      // The breaker is 20 consecutive rejections and each tile is attempted at
      // most 3 times, so a run that stops has made far fewer requests than the
      // thousands of tiles it was given.
      expect(fetchCount()).toBeLessThan(200)
      expect(Number(complete!.body.total)).toBeGreaterThan(1000)
    } finally {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  // A 404 means the tile is not there and never will be, so retrying it is
  // pure waste. It used to arrive as a 502 and be attempted three times.
  test("a 404 is not retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-404-"))
    const { srv, base, fetchCount } = capture(404)
    try {
      await main(
        "c", "test-run", "resume", "m",
        [{ name: "x", bbox: { north: 38.8, south: 38.7, west: -9.2, east: -9.1 }, marginKm: 0 }] as never,
        0, 2,
        "https://example.invalid/{z}/{x}/{y}.jpg", ["a"], 1, 600,
        dir, `${base}/progress`, `${base}/complete`, `${base}/control`, "tok", `${base}/fetch`,
      )
      // Three tiles survive the land mask for this box, one request each.
      expect(fetchCount()).toBe(3)
    } finally {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

// The server reads tilesOnDisk and sizeBytes off the run-complete body, but
// nothing ever put them there: validate computed its count, returned it from
// main(), and the entry point discarded the return value. Both sides looked
// right in isolation and the wire between them was never connected, so these
// assert the posted body rather than the return value.
describe("validate reports its result to the server", () => {
  function capture() {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/control") return Response.json({ command: "none" })
        posts.push({ path, body: (await req.json().catch(() => ({}))) as Record<string, unknown> })
        return Response.json({ ok: true })
      },
    })
    return { srv, posts, base: `http://127.0.0.1:${srv.port}` }
  }

  function run(outputDir: string, base: string) {
    return main(
      "c", "test-run", "validate", "m",
      [{ name: "x", bbox: { north: 38.8, south: 38.7, west: -9.2, east: -9.1 }, marginKm: 0 }] as never,
      0, 2,
      "https://example.invalid/{z}/{x}/{y}.png", ["a"], 1, 60,
      outputDir,
      `${base}/progress`, `${base}/complete`, `${base}/control`,
      "tok", `${base}/fetch`,
    )
  }

  test("a finished walk posts tilesOnDisk and sizeBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-report-"))
    const { srv, posts, base } = capture()
    try {
      for (const [z, x, y] of [["0", "0", "0"], ["1", "0", "1"], ["1", "1", "0"], ["2", "3", "3"]]) {
        mkdirSync(join(dir, "m", z, x), { recursive: true })
        writeFileSync(join(dir, "m", z, x, `${y}.jpg`), Buffer.alloc(64, 1))
      }
      await run(dir, base)

      const complete = posts.filter((p) => p.path === "/complete").pop()
      expect(complete).toBeDefined()
      expect(complete!.body.status).toBe("done")
      expect(complete!.body.tilesOnDisk).toBe(4)
      expect(complete!.body.sizeBytes).toBe(256)
    } finally {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("an unreachable storage root is an error, not a zero-tile success", async () => {
    const { srv, posts, base } = capture()
    try {
      await run("/nonexistent-storage-root-for-test", base)

      const complete = posts.filter((p) => p.path === "/complete").pop()
      expect(complete).toBeDefined()
      // The old behaviour reported "done" here, which the server then stored as
      // a successful run — and with the fix above would have overwritten a real
      // tile count with zero.
      expect(complete!.body.status).toBe("error")
      expect(String(complete!.body.error)).toContain("Output directory not accessible")
      expect(complete!.body.tilesOnDisk).toBeUndefined()
    } finally {
      srv.stop(true)
    }
  }, 30_000)

  test("a reachable root with no map folder is a genuine zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-empty-"))
    const { srv, posts, base } = capture()
    try {
      await run(dir, base)

      const complete = posts.filter((p) => p.path === "/complete").pop()
      expect(complete!.body.status).toBe("done")
      expect(complete!.body.tilesOnDisk).toBe(0)
    } finally {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("walking a coverage's tiles", () => {
  const iberia = [{ name: "iberia", bbox: { north: 43.8, south: 36, west: -9.3, east: 4.3 }, marginKm: 5 }]

  // What collectAllTiles used to do, kept here as the reference the generator
  // has to match. Order is not cosmetic: the directory cache in main() holds one
  // {z}/{x} column at a time and only works because tiles arrive grouped that way.
  function referenceOrder(regions: typeof iberia, zoomMin: number, zoomMax: number) {
    const out: string[] = []
    for (const r of regions) {
      const d = (r.marginKm ?? 0) / 111
      const south = r.bbox.south - d, north = r.bbox.north + d
      const lonD = d / Math.cos((Math.max(Math.abs(south), Math.abs(north)) * Math.PI) / 180)
      const west = r.bbox.west - lonD, east = r.bbox.east + lonD
      for (let z = zoomMin; z <= zoomMax; z++) {
        const n = 2 ** z
        const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n)
        const ty = (lat: number) => {
          const rad = (lat * Math.PI) / 180
          return Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2) * n)
        }
        const xmin = Math.max(0, Math.min(tx(west), tx(east)))
        const xmax = Math.min(n - 1, Math.max(tx(west), tx(east)))
        const ymin = Math.max(0, Math.min(ty(north), ty(south)))
        const ymax = Math.min(n - 1, Math.max(ty(north), ty(south)))
        for (let x = xmin; x <= xmax; x++) for (let y = ymin; y <= ymax; y++) out.push(`${z}/${x}/${y}`)
      }
    }
    return out
  }

  test("yields exactly the sequence the materialised list used to", () => {
    const got = [...generateAllTiles(iberia, 0, 8)].map(([z, x, y]) => `${z}/${x}/${y}`)
    expect(got).toEqual(referenceOrder(iberia, 0, 8))
  })

  test("tiles arrive grouped by column, which the directory cache depends on", () => {
    // One {z}/{x} column must be finished before the next begins, or the cache
    // evicts and re-reads a directory per tile and the resume speedup is lost.
    const seen = new Set<string>()
    let current = ""
    for (const [z, x] of generateAllTiles(iberia, 6, 9)) {
      const col = `${z}/${x}`
      if (col === current) continue
      expect(seen.has(col)).toBe(false)
      seen.add(col)
      current = col
    }
  })

  test("countAllTiles agrees with what the walk yields, filter and all", () => {
    // These disagreeing is how a progress bar sticks short of the end forever.
    const everyThird = (z: number, x: number, y: number) => (x + y) % 3 === 0
    const counted = countAllTiles(iberia, 0, 8, everyThird)
    const walked = [...generateAllTiles(iberia, 0, 8)]
    expect(counted.total).toBe(walked.length)
    expect(counted.kept).toBe(walked.filter(([z, x, y]) => everyThird(z, x, y)).length)
  })

  test("with no filter, kept and total are the same", () => {
    const c = countAllTiles(iberia, 0, 6)
    expect(c.kept).toBe(c.total)
  })

  test("a multi-million tile coverage walks in constant memory", () => {
    // The reason this is a generator. The array it replaced measured 98.7 bytes
    // per tile, so this same walk needed ~400 MB, and a global z13 coverage
    // wanted 2.55 GB on a box with 1 GB of RAM: dead before the first fetch.
    const world = [{ name: "world", bbox: { north: 85, south: -85, west: -180, east: 180 }, marginKm: 0 }]
    const before = process.memoryUsage().rss
    let n = 0
    for (const _t of generateAllTiles(world, 11, 11)) n++
    const after = process.memoryUsage().rss
    expect(n).toBeGreaterThan(4_000_000)
    expect(after - before).toBeLessThan(50 * 1024 * 1024)
  }, 60_000)
})
