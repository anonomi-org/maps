import { expect, test, describe, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// What happens to runs that were in flight when the server went down.
//
// This needs its own server because the whole behaviour is decided during
// startup, before the listener opens, so the state has to be in the database
// before the process is spawned. The shared server in server.test.ts is already
// past that point by the time any test runs.
//
// The bug being pinned: a run killed by a restart never reaches
// /api/internal/run-complete, so the retry that handler arms never happens. The
// coverage was left marked failed with nextRunAt untouched, and a coverage with
// a null nextRunAt is skipped by both scheduleNextRun and the startup re-arm
// loop, so it went dormant permanently and only a manual start revived it. Two
// live coverages were stranded that way for two days.

const PORT = 34219
const BASE = `http://localhost:${PORT}`

let stateDir: string
let proc: ReturnType<typeof Bun.spawn>

const MAP_ID = "map-1"

function coverage(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    mapId: MAP_ID,
    name,
    type: "custom",
    regions: [{ name, bbox: { north: 38.9, south: 38.6, west: -9.3, east: -9.0 }, marginKm: 0 }],
    zoomMin: 0,
    zoomMax: 2,
    tileSource: "https://tiles.example.invalid/{z}/{x}/{y}.png",
    tileSubdomains: ["a"],
    workers: 1,
    maxCallsPerMinute: 60,
    recurrency: "normal",
    createdAt: new Date(0).toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    // The condition under test. Every one of these starts with no schedule.
    nextRunAt: null,
    totalRuns: 1,
    totalFailedRuns: 0,
    totalTilesExpected: 21,
    tilesOnDisk: 0,
    tilesFailed: 0,
    sizeBytes: 0,
    ...over,
  }
}

function run(id: string, coverageId: string, status: string, startedAt: string | null) {
  return { id, coverageId, status, mode: "resume", startedAt, endedAt: null, done: 0, skipped: 0, failed: 0, bytes: 0, total: 21 }
}

function readCoverages(): Record<string, any> {
  const db = new Database(join(stateDir, "maps.db"), { readonly: true })
  const out: Record<string, any> = {}
  for (const r of db.query("SELECT data FROM coverages").all() as { data: string }[]) {
    const c = JSON.parse(r.data)
    out[c.id] = c
  }
  db.close()
  return out
}

async function waitForServer(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/auth/status`, { signal: AbortSignal.timeout(500) })
      // The listener only opens after startup recovery has finished, so an
      // answer here means every write under test is already committed.
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("server did not start in time")
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "maps-recovery-"))
  mkdirSync(join(stateDir, "tiles"), { recursive: true })
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ outputDir: join(stateDir, "tiles"), internalSecret: "test-secret", maxConcurrentRuns: 1 }),
  )

  const db = new Database(join(stateDir, "maps.db"))
  db.run(`CREATE TABLE IF NOT EXISTS maps (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS coverages (id TEXT PRIMARY KEY, map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, coverage_id TEXT NOT NULL REFERENCES coverages(id) ON DELETE CASCADE, started_at TEXT, data TEXT NOT NULL)`)
  db.run(`INSERT INTO maps (id, data) VALUES (?, ?)`, [
    MAP_ID,
    JSON.stringify({ id: MAP_ID, name: "recovery map", description: "", createdAt: new Date(0).toISOString(), discoverable: false }),
  ])

  const covs = [
    coverage("cov-running", "was running"),
    coverage("cov-queued", "was queued"),
    coverage("cov-paused", "was paused"),
    coverage("cov-norecur", "no recurrency", { recurrency: "none" }),
    coverage("cov-scheduled", "already scheduled", { nextRunAt: "2099-01-01T00:00:00.000Z" }),
  ]
  for (const c of covs) {
    db.run(`INSERT INTO coverages (id, map_id, data) VALUES (?, ?, ?)`, [c.id, MAP_ID, JSON.stringify(c)])
  }

  const started = new Date(Date.now() - 60_000).toISOString()
  const runs = [
    run("run-running", "cov-running", "running", started),
    run("run-queued", "cov-queued", "queued", null),
    run("run-paused", "cov-paused", "paused", started),
    run("run-norecur", "cov-norecur", "running", started),
    run("run-scheduled", "cov-scheduled", "running", started),
  ]
  for (const r of runs) {
    db.run(`INSERT INTO runs (id, coverage_id, started_at, data) VALUES (?, ?, ?, ?)`, [r.id, r.coverageId, r.startedAt, JSON.stringify(r)])
  }
  db.close()

  proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, STATE_DIR: stateDir, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const drain = async (s: unknown) => {
    if (!s || typeof s === "number") return
    for await (const chunk of s as AsyncIterable<Uint8Array>) {
      if (process.env.SERVER_LOG) process.stderr.write(new TextDecoder().decode(chunk))
    }
  }
  drain(proc.stdout); drain(proc.stderr)
  await waitForServer()
}, 200_000)

afterAll(() => {
  try { proc?.kill() } catch { /* already gone */ }
  try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe("runs interrupted by a server restart", () => {
  test("a run that was running re-arms its coverage instead of stranding it", () => {
    const c = readCoverages()["cov-running"]
    expect(c.lastRunStatus).toBe("failed")
    // The actual regression: this used to stay null and the coverage never ran
    // again without someone noticing and starting it by hand.
    expect(c.nextRunAt).not.toBeNull()
    expect(c.consecutiveFailures).toBe(1)
    // computeRetryAt(1) is five minutes out, so it lands in the future and the
    // re-arm loop schedules it rather than starting a run during this test.
    const delay = new Date(c.nextRunAt).getTime() - Date.now()
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(5 * 60_000 + 30_000)
  })

  test("a queued run is revived without being counted as a failure", () => {
    const c = readCoverages()["cov-queued"]
    // It never executed, so blaming the coverage for it would burn retry budget
    // and mislabel a coverage that has not actually failed at anything.
    expect(c.lastRunStatus).toBeNull()
    expect(c.consecutiveFailures ?? 0).toBe(0)
    // But the operator did ask for this work, so it must not be dropped.
    expect(c.nextRunAt).not.toBeNull()
    expect(new Date(c.nextRunAt).getTime()).toBeGreaterThan(Date.now())
  })

  test("a paused run stays paused rather than restarting itself", () => {
    // Pause is deliberate. Re-arming it would argue with the operator the same
    // way re-arming a cancelled run would.
    expect(readCoverages()["cov-paused"].nextRunAt).toBeNull()
  })

  test("recurrency none is still never scheduled", () => {
    expect(readCoverages()["cov-norecur"].nextRunAt).toBeNull()
  })

  test("the retry slot replaces a distant schedule, matching run-complete", () => {
    // This coverage was already scheduled far in the future when its run died.
    // The retry wins, because that is what the run-complete failure path does
    // for an ordinary failure (it assigns nextRunAt unconditionally), and a run
    // that just failed should be retried in minutes rather than waiting out a
    // periodic interval. Recovery has to agree with that path or the same
    // failure would mean two different things depending on how it was noticed.
    const c = readCoverages()["cov-scheduled"]
    expect(c.nextRunAt).not.toBe("2099-01-01T00:00:00.000Z")
    const delay = new Date(c.nextRunAt).getTime() - Date.now()
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(5 * 60_000 + 30_000)
  })

  test("every interrupted run is marked, not left claiming to be running", () => {
    const db = new Database(join(stateDir, "maps.db"), { readonly: true })
    const rows = (db.query("SELECT data FROM runs").all() as { data: string }[]).map((r) => JSON.parse(r.data))
    db.close()
    expect(rows.every((r) => r.status !== "running" && r.status !== "queued" && r.status !== "paused")).toBe(true)
  })
})
