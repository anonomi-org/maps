export type Bbox = { north: number; south: number; west: number; east: number }

export type TileMap = {
  id: string
  name: string
  description: string
  createdAt: string
  discoverable: boolean
}

export type DiscoMap = {
  id: string
  name: string
  description: string
  zoomMin?: number
  zoomMax?: number
  bbox?: Bbox
}

export type DiscoFile = {
  v: 1
  generated: string
  maps: DiscoMap[]
}

// How tile fetches leave the machine. "tor" routes them through a local Tor
// HTTP tunnel; "default" on a coverage means "use the server-wide setting".
export type TileTransport = "clearnet" | "tor"
export type CoverageTransport = TileTransport | "default"

export type TileFormat = "png" | "jpg"

export type CoverageType = "preset" | "custom" | "dynamic"
export type Recurrency = "high" | "normal" | "low" | "none"
export type RunStatus = "queued" | "running" | "paused" | "pausing" | "done" | "error" | "cancelled" | "cancelling"
export type RunMode = "resume" | "update" | "reset" | "validate"
export type RetentionUnit = "hours" | "days" | "weeks" | "months" | "years"

export type LogSettings = {
  retentionValue: number
  retentionUnit: RetentionUnit
  cleanerPaused: boolean
}

export type CoverageRegion = {
  name: string
  bbox: Bbox
  marginKm: number
}

export type Coverage = {
  id: string
  mapId: string
  name: string
  type: CoverageType
  regions: CoverageRegion[]

  // Tile settings
  zoomMin: number
  zoomMax: number
  tileSource: string
  tileSubdomains: string[]
  workers: number
  maxCallsPerMinute: number
  // Omitted or "default" follows the server-wide tileTransport.
  transport?: CoverageTransport
  // What the source actually served, learned from the first validated tile.
  // Decides the file extension on disk and in map.json's tileUrl.
  tileFormat?: TileFormat

  // Schedule hint
  recurrency: Recurrency

  // Lifetime stats
  createdAt: string
  lastRunAt: string | null
  lastRunStatus: "success" | "partial" | "cancelled" | "failed" | null
  nextRunAt: string | null
  totalRuns: number
  totalFailedRuns: number
  // Consecutive failures since the last success, which drives the retry
  // backoff. Absent on rows written before retries existed; treat as 0.
  consecutiveFailures?: number

  // Tile inventory
  totalTilesExpected: number
  tilesOnDisk: number
  tilesFailed: number
  sizeBytes: number

  // Log retention override
  logRetention?: "default" | "custom"
  logRetentionValue?: number
  logRetentionUnit?: RetentionUnit
}

export type CoverageRun = {
  id: string
  coverageId: string
  status: RunStatus
  mode?: RunMode
  startedAt: string | null
  endedAt: string | null
  done: number
  skipped: number
  failed: number
  bytes: number
  total: number
  error?: string
}

export type ServerState = {
  maps: TileMap[]
  coverages: Coverage[]
  activeRuns: CoverageRun[]
  outputDir: string
  outputDirOk: boolean
  logSettings: LogSettings
  onionUrl: string
  // How many runs may hold a worker slot at once. Runs beyond this wait as "queued".
  maxConcurrentRuns: number
  // Server-wide default for tile fetches, and whether the Tor tunnel answered
  // when we last looked. torReachable is null when the transport is clearnet.
  tileTransport: TileTransport
  torReachable: boolean | null
}

export type CleanupProgress = {
  coverageId: string
  coverageName: string
  checked: number
  deleted: number
  skipped: number
  done: boolean
  error?: string
}

export type SSEEvent =
  | { type: "state"; payload: ServerState }
  | { type: "run"; payload: CoverageRun }
  | { type: "coverage"; payload: Coverage }
  | { type: "cleanup"; payload: CleanupProgress }
  // Coverage IDs of runs waiting for a worker slot, in the order they'll start.
  | { type: "queue"; payload: string[] }
