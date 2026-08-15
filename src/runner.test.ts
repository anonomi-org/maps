import { expect, test, describe } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { main, isTileFile } from "./runner"

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
