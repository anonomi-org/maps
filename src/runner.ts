// Downloads or validates tiles for one coverage. The server spawns this per run,
// so a wedged network write or a crash takes the run down and not the dashboard.
// Rate limiting belongs to the server's fetch-tile proxy, not here. Every disk
// call has a timeout, and a circuit breaker gives up on sustained storage failures.


// ── Inline types ─────────────────────────────────────────────────────────────

type Bbox = { north: number; south: number; west: number; east: number }
type CoverageRegion = { name: string; bbox: Bbox; marginKm: number }
type RunMode = "resume" | "update" | "reset" | "validate"

// ── Inline tile math ──────────────────────────────────────────────────────────

function lon2tileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}

function lat2tileY(lat: number, z: number): number {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  const merc = Math.log(Math.tan(Math.PI / 4 + rad / 2))
  return Math.floor(((1 - merc / Math.PI) / 2) * n)
}

// Rounded down on purpose; see the note in tileMath.ts.
const MAX_MERCATOR_LAT = 85.05112877

function clampLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
}

function buildTileUrl(template: string, z: number, x: number, y: number, s?: string): string {
  return template
    .replace("{s}", s ?? "")
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y))
}

// Kept in step with expandBbox in tileMath.ts by a test, because this copy
// decides what gets downloaded while that one decides what gets counted and,
// through isTileInCoverageList, what cleanup keeps. See the note there for why
// longitude needs its own conversion.
export function expandRegion(region: CoverageRegion) {
  const marginLat = (region.marginKm ?? 0) / 111
  const south = clampLat(region.bbox.south - marginLat)
  const north = clampLat(region.bbox.north + marginLat)
  const worstLat = Math.max(Math.abs(south), Math.abs(north))
  const marginLon = marginLat / Math.cos((worstLat * Math.PI) / 180)
  return {
    south,
    north,
    west:  region.bbox.west - marginLon,
    east:  region.bbox.east + marginLon,
  }
}

// Yields rather than returns an array, and that is the whole point. Building the
// list first cost a measured 98.7 bytes per tile, so a global z13 coverage
// wanted 2.55 GB before its first fetch on a box with 1 GB of RAM: it would die
// without ever asking for a tile. Nothing here is retained, so a coverage of any
// size runs in constant memory and the only ceiling left is how long it takes.
//
// Order is unchanged, region by region then zoom by zoom then z/x/y, which the
// directory cache in main() depends on: it holds one column at a time and only
// works because tiles arrive grouped by {z}/{x}.
export function* generateAllTiles(
  regions: CoverageRegion[],
  zoomMin: number,
  zoomMax: number,
): Generator<[number, number, number]> {
  for (const region of regions) {
    const { south, north, west, east } = expandRegion(region)
    for (let z = zoomMin; z <= zoomMax; z++) {
      const n = 2 ** z
      const xmin = Math.max(0, Math.min(lon2tileX(west, z), lon2tileX(east, z)))
      const xmax = Math.min(n - 1, Math.max(lon2tileX(west, z), lon2tileX(east, z)))
      const ymin = Math.max(0, Math.min(lat2tileY(north, z), lat2tileY(south, z)))
      const ymax = Math.min(n - 1, Math.max(lat2tileY(north, z), lat2tileY(south, z)))
      for (let x = xmin; x <= xmax; x++)
        for (let y = ymin; y <= ymax; y++)
          yield [z, x, y]
    }
  }
}

// Counts by walking, so the total the dashboard shows costs CPU and no memory.
// keep is applied here exactly as the download pass applies it, because a total
// that counted ocean the run then skips would leave the bar stuck short.
export function countAllTiles(
  regions: CoverageRegion[],
  zoomMin: number,
  zoomMax: number,
  keep?: (z: number, x: number, y: number) => boolean,
): { total: number; kept: number } {
  let total = 0
  let kept = 0
  for (const [z, x, y] of generateAllTiles(regions, zoomMin, zoomMax)) {
    total++
    if (!keep || keep(z, x, y)) kept++
  }
  return { total, kept }
}

// ── Tile validation ────────────────────────────────────────────────────────────

type TileFormat = "png" | "jpg"
type TileCheck = { format: TileFormat } | { error: string }

// A tile on disk carries the extension of whatever the source served, so
// anything walking the corpus has to accept every format validateTile admits.
// Matching only .png counted an all-JPEG corpus as zero tiles, and reported
// that as a successful validate.
export function isTileFile(name: string): boolean {
  return name.endsWith(".png") || name.endsWith(".jpg")
}

// Accepts PNG and JPEG. Satellite sources serve JPEG, and rejecting it was
// silently discarding every tile: a 200 with a valid 256x256 image counted as a
// failure with no reason recorded anywhere.
export function validateTile(buf: ArrayBuffer): TileCheck {
  const b = new Uint8Array(buf)
  if (b.length < 67) return { error: `too small (${b.length} bytes)` }

  const isPng =
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  const isJpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

  if (isPng) {
    const view = new DataView(buf)
    const w = view.getUint32(16, false), h = view.getUint32(20, false)
    if (w !== 256 || h !== 256) return { error: `unexpected dimensions ${w}x${h}` }
    const end = b.length
    if (b[end - 8] !== 0x49 || b[end - 7] !== 0x45 || b[end - 6] !== 0x4e || b[end - 5] !== 0x44)
      return { error: "truncated (missing IEND)" }
    return { format: "png" }
  }

  if (isJpg) {
    // Dimensions live in a SOFn marker, so walk the segment chain to find one.
    let i = 2
    let dims: { w: number; h: number } | null = null
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      if (marker === 0xd9) break
      const len = (b[i + 2] << 8) | b[i + 3]
      // SOF0-SOF15 carry the frame header; C4/C8/CC are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        dims = { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] }
        break
      }
      i += 2 + len
    }
    if (!dims) return { error: "JPEG with no frame header" }
    if (dims.w !== 256 || dims.h !== 256) return { error: `unexpected dimensions ${dims.w}x${dims.h}` }
    if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return { error: "truncated (missing EOI)" }
    return { format: "jpg" }
  }

  return { error: "not a PNG or JPEG" }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}

type RunControl = { command: "pause" | "cancel" | "none" }

async function postProgress(
  progressUrl: string,
  internalToken: string,
  data: { runId: string; done: number; skipped: number; failed: number; bytes: number; total: number; status?: string; tileFormat?: string },
): Promise<void> {
  try {
    await fetch(progressUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${internalToken}` },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* non-fatal */ }
}

async function getRunControl(controlUrl: string, runId: string, internalToken: string): Promise<RunControl> {
  try {
    const res = await fetch(`${controlUrl}?runId=${runId}`, {
      headers: { Authorization: `Bearer ${internalToken}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) return (await res.json()) as RunControl
  } catch { /* default to none */ }
  return { command: "none" }
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function main(
  coverageId: string,
  runId: string,
  mode: RunMode,
  mapId: string,
  regions: CoverageRegion[],
  zoomMin: number,
  zoomMax: number,
  tileSource: string,
  tileSubdomains: string[],
  workers: number,
  maxCallsPerMinute: number,
  outputDir: string,
  progressUrl: string,
  completeUrl: string,
  controlUrl: string,
  internalToken: string,
  fetchTileUrl: string,
  // "tor" routes fetches through the server's Tor tunnel. The server enforces
  // it; this is only what gets asked for.
  transport: "clearnet" | "tor" = "clearnet",
) {
  const { stat, readdir, access, mkdir, writeFile } = await import("node:fs/promises")
  const { join, dirname } = await import("node:path")

  const progress = { runId, done: 0, skipped: 0, failed: 0, bytes: 0, total: 0, status: "running" as string }

  // Discovered from the first tile that validates, then reported at the end so
  // the server can advertise the matching extension in map.json.
  let detectedFormat: TileFormat | null = null
  const tilePath = (z: number, x: number, y: number, fmt: TileFormat) =>
    join(outputDir, mapId, String(z), String(x), `${y}.${fmt}`)

  // `extra` carries the fields the server reads but `progress` does not hold.
  // The server has always looked for tilesOnDisk and sizeBytes on this body;
  // nothing ever put them there, so a validate returned its count into the
  // void and the coverage stayed at zero however many tiles were on disk.
  const finish = async (status: string, error?: string, extra?: Record<string, unknown>) => {
    progress.status = status
    await fetch(completeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${internalToken}` },
      body: JSON.stringify({ ...progress, error, tileFormat: detectedFormat ?? undefined, ...extra }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {})
  }

  // ── Output directory check ───────────────────────────────────────────────────

  // Every mode, validate included. Validate used to skip this and then treat an
  // unreachable storage root as "done, 0 tiles" — indistinguishable from an
  // empty corpus, and now that the count is actually transmitted it would
  // overwrite a real total with zero and mark the coverage healthy.
  const storageOk = await withTimeout(access(outputDir).then(() => true).catch(() => false), 10_000, false)
  if (!storageOk) {
    await finish("error", `Output directory not accessible: ${outputDir}`)
    return { status: "error" }
  }

  await postProgress(progressUrl, internalToken, { ...progress, status: "running" })

  let lastControlPoll = Date.now()
  let pauseSignaled = false
  let cancelSignaled = false

  async function pollControl() {
    if (Date.now() - lastControlPoll < 2_000) return
    lastControlPoll = Date.now()
    const ctrl = await getRunControl(controlUrl, runId, internalToken)
    if (ctrl.command === "cancel") cancelSignaled = true
    if (ctrl.command === "pause")  pauseSignaled = true
  }

  let lastProgressPost = Date.now()
  async function maybePostProgress() {
    if (Date.now() - lastProgressPost >= 5_000) {
      lastProgressPost = Date.now()
      await postProgress(progressUrl, internalToken, progress)
    }
  }

  // ── Validate mode ─────────────────────────────────────────────────────────────

  if (mode === "validate") {
    // The storage root is already known reachable by here, so a missing map
    // folder is the one case that genuinely means zero: a corpus nobody has
    // downloaded yet, not a fault.
    const mapDir = join(outputDir, mapId)
    if (!(await withTimeout(access(mapDir).then(() => true).catch(() => false), 10_000, false))) {
      await postProgress(progressUrl, internalToken, { ...progress, status: "done" })
      await finish("done", undefined, { tilesOnDisk: 0, sizeBytes: 0 })
      return { status: "done", tilesOnDisk: 0, sizeBytes: 0 }
    }

    let lastBroadcast = Date.now()
    async function walkDir(dir: string): Promise<void> {
      const entries = await withTimeout(readdir(dir, { withFileTypes: true }).catch(() => []), 10_000, [])
      for (const entry of entries) {
        if (cancelSignaled || pauseSignaled) return
        await pollControl()
        if (cancelSignaled || pauseSignaled) return
        const fullPath = join(dir, entry.name as string)
        if ((entry as { isDirectory(): boolean }).isDirectory()) { await walkDir(fullPath); continue }
        if (!isTileFile(entry.name as string)) continue
        progress.done++
        const s = await withTimeout(stat(fullPath).catch(() => null), 5_000, null)
        if (s) progress.bytes += (s as { size: number }).size
        else progress.failed++
        if (Date.now() - lastBroadcast >= 300) { lastBroadcast = Date.now(); await postProgress(progressUrl, internalToken, progress) }
      }
    }

    await walkDir(mapDir)
    const finalStatus = cancelSignaled ? "cancelled" : pauseSignaled ? "paused" : "done"
    await postProgress(progressUrl, internalToken, { ...progress, status: finalStatus })
    // A cancelled or paused walk stopped partway, so its count is a floor, not
    // a total. Only send it when the walk actually finished, or an interrupted
    // validate would write a low number over a correct one.
    await finish(
      finalStatus,
      undefined,
      finalStatus === "done" ? { tilesOnDisk: progress.done, sizeBytes: progress.bytes } : undefined,
    )
    return { status: finalStatus, tilesOnDisk: progress.done, sizeBytes: progress.bytes }
  }

  // ── Download / update / reset mode ───────────────────────────────────────────

  // Skip ocean. The dashboard's estimate has always applied the land mask; the
  // runner never did, so it fetched every tile in the bounding rectangle and the
  // two numbers disagreed. For a whole-world corpus that is ~60% of the download
  // spent on blank blue squares.
  //
  // Cache-only: a missing cache leaves tileIsLand returning true for everything,
  // so the failure mode is downloading too much, never too little.
  const { loadCachedLandMask, tileIsLand } = await import("./landMask")
  const masked = loadCachedLandMask()
  const keep = masked ? (z: number, x: number, y: number) => tileIsLand(z, x, y) : undefined
  // One pass to count, a second to download. Two walks of pure arithmetic cost
  // far less than holding the list, and holding it is what a large coverage
  // cannot afford.
  const counted = countAllTiles(regions, zoomMin, zoomMax, keep)
  if (masked) {
    console.log(`land mask: ${counted.kept} of ${counted.total} tiles are land, skipping ${counted.total - counted.kept} ocean`)
  } else {
    console.warn("land mask: no cache found, downloading the full bounding box including ocean")
  }
  progress.total = counted.kept
  await postProgress(progressUrl, internalToken, progress)

  // Workers pull from one generator. next() runs to completion before any other
  // worker can call it, since these are async tasks on a single thread rather
  // than real threads, so no two workers can be handed the same tile.
  const tiles = generateAllTiles(regions, zoomMin, zoomMax)
  function nextTile(): [number, number, number] | null {
    for (;;) {
      const r = tiles.next()
      if (r.done) return null
      if (!keep || keep(r.value[0], r.value[1], r.value[2])) return r.value
    }
  }
  let consecutiveDiskErrors = 0
  // Directories this run has already created, shared across workers.
  const createdDirs = new Set<string>()

  // Existence is checked one directory at a time, not one tile at a time.
  // A per-tile stat cost up to two mount round-trips (.png, then .jpg) before
  // any network call, so a resume over an already-complete corpus spent all of
  // its time confirming what it already had: 188 present tiles took 549s on the
  // live NAS, and re-checking the whole corpus at that rate is days, not hours.
  // Tiles arrive in z/x/y order, so one readdir of {z}/{x} answers for the
  // whole column.
  //
  // Bounded, because a global corpus has thousands of columns. Workers only
  // ever straddle a boundary or two, and an eviction costs a re-read rather
  // than a wrong answer.
  const DIR_CACHE_MAX = 8
  const dirCache = new Map<string, Promise<Set<string>>>()
  function listTileDir(dir: string): Promise<Set<string>> {
    const hit = dirCache.get(dir)
    if (hit) return hit
    // A directory that does not exist yet is the normal case on a first
    // download, so a failed readdir means "nothing here", not a fault. Sharing
    // the pending promise keeps concurrent workers to one read per column.
    const pending = withTimeout(readdir(dir).catch(() => [] as string[]), 10_000, [] as string[])
      .then((names) => new Set(names))
    dirCache.set(dir, pending)
    // Insertion order is eviction order.
    if (dirCache.size > DIR_CACHE_MAX) dirCache.delete(dirCache.keys().next().value as string)
    return pending
  }
  const reportedRejects = new Set<string>()
  const DISK_CIRCUIT_BREAKER = 10
  // The disk had a breaker and the network had none, so a source that started
  // refusing every request did not stop the run: it walked the whole tile list,
  // spent three attempts on each, and recorded the entire coverage as failed.
  // Rate-limit rejections are counted separately from ordinary fetch failures
  // because they are the case that gets worse the longer it is ignored.
  const FETCH_CIRCUIT_BREAKER = 20
  let consecutiveRateLimits = 0
  const subs = tileSubdomains ?? ["a", "b", "c"]

  // Slept in slices so a pause or cancel is still noticed during a long
  // backoff, rather than the run sitting deaf for the length of a Retry-After.
  async function backoffSleep(ms: number) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (cancelSignaled || pauseSignaled) return
      await new Promise<void>((r) => setTimeout(r, Math.min(2_000, until - Date.now())))
      await pollControl()
    }
  }

  async function worker() {
    while (true) {
      await pollControl()
      if (cancelSignaled) break

      // Pausing means exiting. Tiles already on disk are the resume point, so
      // there is nothing to hold in memory and no reason to keep a slot warm.
      if (pauseSignaled) break

      if (consecutiveDiskErrors >= DISK_CIRCUIT_BREAKER) {
        cancelSignaled = true
        await finish("error", `Output directory unavailable: ${consecutiveDiskErrors} consecutive write failures`)
        return
      }

      if (consecutiveRateLimits >= FETCH_CIRCUIT_BREAKER) {
        cancelSignaled = true
        await finish("error", `Tile source is rate limiting: ${consecutiveRateLimits} consecutive rejections, stopping`)
        return
      }

      const tile = nextTile()
      if (tile === null) break

      const [z, x, y] = tile

      // A tile written on an earlier run may carry either extension, so both
      // are checked. Looking for only one makes resume re-download everything
      // the moment the source's format changes. Against the cached listing both
      // lookups are free, so there is no cheaper order to guess at.
      const tileDir = join(outputDir, mapId, String(z), String(x))
      const names = await listTileDir(tileDir)
      const existingFormat: TileFormat | null =
        names.has(`${y}.jpg`) ? "jpg" : names.has(`${y}.png`) ? "png" : null

      if (mode === "resume" && existingFormat !== null) {
        progress.skipped++
        consecutiveDiskErrors = 0
        await maybePostProgress()
        continue
      }

      // Fetch via maps throttle proxy: proxy handles rate limiting + upstream fetch
      const tileUrl = buildTileUrl(tileSource, z, x, y, subs[Math.floor(Math.random() * subs.length)])
      // Only `update` needs the mtime, and only for a tile that exists. readdir
      // does not carry mtime, so this is the one case that still pays for a
      // stat: one, against the extension now known to be on disk.
      const fileStat = mode === "update" && existingFormat
        ? await withTimeout(stat(tilePath(z, x, y, existingFormat)).catch(() => null), 5_000, null)
        : null
      const ifModifiedSince = fileStat ? (fileStat as { mtime: Date }).mtime.toUTCString() : undefined

      let buf: ArrayBuffer | null = null
      let skipped304 = false
      let fetchError: string | null = null
      let rateLimited = false

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body: Record<string, unknown> = { tileUrl, maxCallsPerMinute, transport }
          if (ifModifiedSince) body.ifModifiedSince = ifModifiedSince

          const res = await fetch(fetchTileUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${internalToken}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000), // includes throttle wait + download time
          })

          if (res.status === 204) { skipped304 = true; break }
          if (res.ok) { buf = await res.arrayBuffer(); break }
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string; retryAfterMs?: number }
          fetchError = err.error
          if (res.status === 429 || res.status === 503) rateLimited = true
          if (res.status < 500 && res.status !== 429) break // 4xx non-rate-limit: don't retry
          // Wait as long as we were told to. The proxy has already parked the
          // shared bucket for the same interval, so retrying sooner only burns
          // this request's 60s timeout sitting in the queue.
          if (attempt < 2) await backoffSleep(err.retryAfterMs ?? 1_000 * (attempt + 1))
        } catch (e) {
          fetchError = e instanceof Error ? e.message : String(e)
          if (attempt < 2) await backoffSleep(1_000 * (attempt + 1))
        }
        if (cancelSignaled || pauseSignaled) break
      }

      // Only a clean run of successes clears it, so an intermittent 429 among
      // otherwise healthy traffic never trips the breaker.
      if (rateLimited && buf === null && !skipped304) consecutiveRateLimits++
      else if (buf !== null || skipped304) consecutiveRateLimits = 0

      if (skipped304) {
        progress.skipped++
        consecutiveDiskErrors = 0
      } else if (buf !== null) {
        const check = validateTile(buf)
        if ("error" in check) {
          progress.failed++
          // Say why. This used to increment a counter and discard the reason,
          // so a source serving a format we reject looked like a network fault.
          if (!reportedRejects.has(check.error)) {
            reportedRejects.add(check.error)
            console.warn(`Rejected ${z}/${x}/${y}: ${check.error} (further identical rejects not logged)`)
          }
        } else {
          if (!detectedFormat) {
            detectedFormat = check.format
            console.log(`tile format: ${check.format}`)
            // Tell the server straight away. Waiting for run-complete meant
            // map.json advertised the wrong extension for the whole first run:
            // the client asks for .png, the corpus is .jpg, every tile 404s.
            await postProgress(progressUrl, internalToken, { ...progress, tileFormat: check.format })
          }
          // Extension is decided by what actually came back, so a source that
          // switches format cannot silently write mislabelled files.
          const filePath = tilePath(z, x, y, check.format)
          const dir = dirname(filePath)
          try {
            // One directory holds up to 4096 tiles, so calling mkdir per tile
            // is up to 4096 redundant round trips against the same path. That
            // is merely wasteful locally and genuinely slow over a network filesystem.
            if (!createdDirs.has(dir)) {
              await withTimeout(mkdir(dir, { recursive: true }), 10_000, undefined)
              createdDirs.add(dir)
            }
            await withTimeout(writeFile(filePath, Buffer.from(buf)), 30_000, undefined)
            // Overlapping regions can queue the same tile twice, and the
            // listing for this column was read before the write. Without this
            // the second visit would not see the file and would fetch it again.
            names.add(`${y}.${check.format}`)
            progress.done++
            progress.bytes += buf.byteLength
            consecutiveDiskErrors = 0
          } catch {
            // The directory may have gone away underneath us; forget it so the
            // next tile recreates it rather than failing forever.
            createdDirs.delete(dir)
            consecutiveDiskErrors++
            progress.failed++
          }
        }
      } else {
        progress.failed++
        if (fetchError) console.warn(`Fetch failed ${z}/${x}/${y}: ${fetchError}`)
      }

      await maybePostProgress()
    }
  }

  await Promise.all(Array.from({ length: workers ?? 4 }, () => worker()))

  if (progress.status !== "error") {
    const finalStatus = cancelSignaled ? "cancelled" : pauseSignaled ? "paused" : "done"
    await postProgress(progressUrl, internalToken, { ...progress, status: finalStatus })
    await finish(finalStatus)
    return { status: finalStatus }
  }

  return { status: progress.status }
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Must stay LAST. The top-level await below suspends module evaluation, so any
// const declared after it would still be in its temporal dead zone when main()
// runs. Keeping this at the bottom means every declaration is initialised first.

if (typeof Bun !== "undefined" && import.meta.main) {
  const raw = await Bun.stdin.text()
  const args = JSON.parse(raw)
  const { coverageId, runId, mode, mapId, regions, zoomMin, zoomMax,
          tileSource, tileSubdomains, workers, maxCallsPerMinute,
          outputDir, progressUrl, completeUrl, controlUrl, internalToken, fetchTileUrl,
          transport } = args
  await main(coverageId, runId, mode, mapId, regions, zoomMin, zoomMax,
             tileSource, tileSubdomains, workers, maxCallsPerMinute,
             outputDir, progressUrl, completeUrl, controlUrl, internalToken, fetchTileUrl,
             transport)
  process.exit(0)
}
