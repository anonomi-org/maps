import { expect, test, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The database was renamed from maps-manager.db to maps.db. Opening the new name
// against an install that still has the old one would create an empty database
// and show a server with no maps, with the data still on disk under a name nothing
// looks for. These boot db.ts in a child process, because the migration runs at
// import time against STATE_DIR as it was when the module first loaded.

function seedLegacyDb(dir: string) {
  const db = new Database(join(dir, "maps-manager.db"), { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run(`CREATE TABLE maps (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE coverages (id TEXT PRIMARY KEY, map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE runs (id TEXT PRIMARY KEY, coverage_id TEXT NOT NULL REFERENCES coverages(id) ON DELETE CASCADE, started_at TEXT, data TEXT NOT NULL)`)
  db.query(`INSERT INTO maps (id, data) VALUES (?, ?)`).run(
    "legacy01-abc123",
    JSON.stringify({ id: "legacy01-abc123", name: "Carried over", createdAt: "2026-01-01T00:00:00.000Z" }),
  )
  db.close()
}

/** Load db.ts in a child with STATE_DIR set, and report what it can see. */
function loadDbIn(dir: string): { names: string[]; error?: string } {
  const proc = Bun.spawnSync(
    ["bun", "-e", `
      const { initSchema, dbLoadMaps } = await import(${JSON.stringify(join(import.meta.dir, "db.ts"))})
      initSchema()
      console.log(JSON.stringify(dbLoadMaps().map((m) => m.name)))
    `],
    { env: { ...process.env, STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" },
  )
  const out = proc.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? ""
  try {
    return { names: JSON.parse(out) }
  } catch {
    return { names: [], error: `${out}\n${proc.stderr.toString()}` }
  }
}

describe("database rename", () => {
  test("an existing maps-manager.db is carried over, data intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "maps-migrate-"))
    try {
      seedLegacyDb(dir)
      expect(existsSync(join(dir, "maps-manager.db"))).toBe(true)

      const { names, error } = loadDbIn(dir)
      expect(error ?? "").toBe("")
      // The point of the whole exercise: the map is still there afterwards.
      expect(names).toEqual(["Carried over"])
      expect(existsSync(join(dir, "maps.db"))).toBe(true)
      expect(existsSync(join(dir, "maps-manager.db"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test("a maps.db already in place is left alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "maps-migrate-"))
    try {
      seedLegacyDb(dir)
      // Both names present: the new one wins and the old is not allowed to
      // overwrite it, or a stale copy would silently replace live data.
      const current = new Database(join(dir, "maps.db"), { create: true })
      current.run(`CREATE TABLE maps (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
      current.query(`INSERT INTO maps (id, data) VALUES (?, ?)`).run(
        "current1-def456",
        JSON.stringify({ id: "current1-def456", name: "Already current", createdAt: "2026-02-02T00:00:00.000Z" }),
      )
      current.close()

      const { names, error } = loadDbIn(dir)
      expect(error ?? "").toBe("")
      expect(names).toEqual(["Already current"])
      expect(existsSync(join(dir, "maps-manager.db"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test("a fresh install with neither file just starts empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "maps-migrate-"))
    try {
      const { names, error } = loadDbIn(dir)
      expect(error ?? "").toBe("")
      expect(names).toEqual([])
      expect(existsSync(join(dir, "maps.db"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
