import { Database } from "bun:sqlite"
import { existsSync, readFileSync, renameSync } from "fs"
import { join } from "path"
import type { TileMap, Coverage, CoverageRun } from "./types"

// Matches STATE_DIR in server.ts; see the note there.
const STATE_DIR = process.env.STATE_DIR ?? join(import.meta.dir, "..")
const DB_PATH = process.env.DB_PATH ?? join(STATE_DIR, "maps.db")

// The database used to be called maps-manager.db. Opening the new name against
// an install that still has the old one would silently create an empty database
// and present it as a server with no maps, when the data is right there, under a
// name nothing looks for any more. So move it, WAL and shm alongside: those are
// derived from the base name, and leaving them behind strands committed pages
// that have not been checkpointed yet.
function migrateLegacyDatabase(): void {
  const legacy = join(STATE_DIR, "maps-manager.db")
  if (existsSync(DB_PATH) || !existsSync(legacy)) return
  for (const suffix of ["", "-wal", "-shm"]) {
    if (!existsSync(legacy + suffix)) continue
    try {
      renameSync(legacy + suffix, DB_PATH + suffix)
    } catch (e) {
      console.warn(`  could not rename ${legacy + suffix}: ${e}`)
    }
  }
  console.log("  migrated maps-manager.db to maps.db")
}

migrateLegacyDatabase()

// Records are small and few (one map, a handful of coverages, capped run history),
// and every read is "load it all into memory at startup". A JSON blob per row keeps
// the shape identical to the types and saves writing a migration for every field.
const db = new Database(DB_PATH, { create: true })
db.run("PRAGMA journal_mode = WAL")
db.run("PRAGMA foreign_keys = ON")

export function initSchema(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS maps (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS coverages (
      id     TEXT PRIMARY KEY,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      data   TEXT NOT NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_coverages_map_id ON coverages(map_id)`)
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      coverage_id TEXT NOT NULL REFERENCES coverages(id) ON DELETE CASCADE,
      started_at  TEXT,
      data        TEXT NOT NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_coverage_id ON runs(coverage_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC)`)

  importLegacyJson()
}

// Earlier versions kept state in maps.json / coverages.json / runs.json next to the
// source. Pull those in once, the first time we start against an empty database.
function importLegacyJson(): void {
  const alreadyHasData = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM maps`).get()
  if ((alreadyHasData?.n ?? 0) > 0) return

  function readJson<T>(name: string): T[] | null {
    const path = join(STATE_DIR, name)
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      return Array.isArray(parsed) ? parsed : null
    } catch {
      console.warn(`  could not parse ${name}, skipping import`)
      return null
    }
  }

  const maps = readJson<TileMap>("maps.json")
  if (!maps?.length) return

  const coverages = readJson<Coverage>("coverages.json") ?? []
  const runs = readJson<CoverageRun>("runs.json") ?? []

  const mapIds = new Set(maps.map((m) => m.id))
  const keptCoverages = coverages.filter((c) => mapIds.has(c.mapId))
  const coverageIds = new Set(keptCoverages.map((c) => c.id))
  const keptRuns = runs.filter((r) => coverageIds.has(r.coverageId))

  db.transaction(() => {
    for (const map of maps) saveMapSync(map)
    for (const cov of keptCoverages) saveCoverageSync(cov)
    for (const run of keptRuns) saveRunSync(run)
  })()

  const droppedCoverages = coverages.length - keptCoverages.length
  const droppedRuns = runs.length - keptRuns.length
  console.log(`  imported ${maps.length} map(s), ${keptCoverages.length} coverage(s), ${keptRuns.length} run(s) from JSON`)
  if (droppedCoverages || droppedRuns) {
    console.log(`  skipped ${droppedCoverages} orphaned coverage(s) and ${droppedRuns} orphaned run(s)`)
  }
}

// ---- Maps ----------------------------------------------------------------

function saveMapSync(map: TileMap): void {
  db.query(`
    INSERT INTO maps (id, data) VALUES (?, ?)
    ON CONFLICT (id) DO UPDATE SET data = excluded.data
  `).run(map.id, JSON.stringify(map))
}

export function dbLoadMaps(): TileMap[] {
  return db
    .query<{ data: string }, []>(`SELECT data FROM maps`)
    .all()
    .map((r) => JSON.parse(r.data) as TileMap)
}

export function dbSaveMap(map: TileMap): void {
  saveMapSync(map)
}

export function dbDeleteMap(id: string): void {
  db.query(`DELETE FROM maps WHERE id = ?`).run(id)
}

// ---- Coverages -----------------------------------------------------------

function saveCoverageSync(cov: Coverage): void {
  db.query(`
    INSERT INTO coverages (id, map_id, data) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET data = excluded.data, map_id = excluded.map_id
  `).run(cov.id, cov.mapId, JSON.stringify(cov))
}

export function dbLoadCoverages(): Coverage[] {
  return db
    .query<{ data: string }, []>(`SELECT data FROM coverages`)
    .all()
    .map((r) => JSON.parse(r.data) as Coverage)
}

export function dbSaveCoverage(cov: Coverage): void {
  saveCoverageSync(cov)
}

export function dbDeleteCoverage(id: string): void {
  db.query(`DELETE FROM coverages WHERE id = ?`).run(id)
}

// Returns the IDs that were deleted, so callers can clean up runs and log files.
export function dbDeleteCoveragesByMapId(mapId: string): string[] {
  const rows = db
    .query<{ id: string }, [string]>(`DELETE FROM coverages WHERE map_id = ? RETURNING id`)
    .all(mapId)
  return rows.map((r) => r.id)
}

// ---- Runs ----------------------------------------------------------------

function saveRunSync(run: CoverageRun): void {
  db.query(`
    INSERT INTO runs (id, coverage_id, started_at, data) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      data       = excluded.data,
      started_at = excluded.started_at
  `).run(run.id, run.coverageId, run.startedAt ?? null, JSON.stringify(run))
}

export function dbLoadRuns(): CoverageRun[] {
  return db
    .query<{ data: string }, []>(`SELECT data FROM runs ORDER BY started_at DESC`)
    .all()
    .map((r) => JSON.parse(r.data) as CoverageRun)
}

export function dbSaveRun(run: CoverageRun): void {
  saveRunSync(run)
}

export function dbDeleteRunsByCoverageId(coverageId: string): string[] {
  const rows = db
    .query<{ id: string }, [string]>(`DELETE FROM runs WHERE coverage_id = ? RETURNING id`)
    .all(coverageId)
  return rows.map((r) => r.id)
}

export function dbDeleteRunsByMapId(mapId: string): string[] {
  const rows = db
    .query<{ id: string }, [string]>(`
      DELETE FROM runs
      WHERE coverage_id IN (SELECT id FROM coverages WHERE map_id = ?)
      RETURNING id
    `)
    .all(mapId)
  return rows.map((r) => r.id)
}

export function dbGetRunData(runId: string): CoverageRun | null {
  const row = db.query<{ data: string }, [string]>(`SELECT data FROM runs WHERE id = ?`).get(runId)
  return row ? (JSON.parse(row.data) as CoverageRun) : null
}

// Keep the 50 most recent runs per coverage.
export function dbCapRuns(): void {
  db.run(`
    DELETE FROM runs
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY coverage_id ORDER BY started_at DESC
        ) AS rn
        FROM runs
      )
      WHERE rn > 50
    )
  `)
}

export function dbClose(): void {
  db.close()
}
