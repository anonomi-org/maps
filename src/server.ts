import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync, chmodSync } from "fs"
import { createHash, timingSafeEqual } from "crypto"
import { lookup as dnsLookup } from "dns/promises"
import { stat, rm, readdir, unlink, access, mkdir, writeFile } from "fs/promises"
import { join, dirname, isAbsolute } from "path"
import type { Bbox, CleanupProgress, Coverage, CoverageRun, CoverageTransport, TileFormat, DiscoFile, DiscoMap, LogSettings, Recurrency, RetentionUnit, RunMode, ServerState, SSEEvent, TileMap, TileTransport } from "./types"
import { countTiles, iterateTiles, buildTileUrl, lon2tileX, lat2tileY, clampLat } from "./tileMath"
import { validateTile, isTileFile } from "./runner"
import { initLandMask, tileIsLand, isLand, maskReady } from "./landMask"
import {
  initSchema,
  dbLoadMaps, dbSaveMap, dbDeleteMap,
  dbLoadCoverages, dbSaveCoverage, dbDeleteCoverage, dbDeleteCoveragesByMapId,
  dbLoadRuns, dbSaveRun, dbDeleteRunsByCoverageId, dbDeleteRunsByMapId,
  dbCapRuns,
} from "./db"

// ---- Rate limiter (token bucket) ----

// One bucket per upstream tile service, shared by every run and every subdomain
// hitting it. Runners never fetch tiles themselves. They go through
// /api/internal/fetch-tile, so this stays the single place that decides how hard
// we hit a provider.
const serviceRateLimiters = new Map<string, RateLimiter>()

function getServiceLimiter(service: string, maxCallsPerMinute: number): RateLimiter {
  const existing = serviceRateLimiters.get(service)
  if (existing) return existing
  const limiter = new RateLimiter(maxCallsPerMinute)
  serviceRateLimiters.set(service, limiter)
  return limiter
}

// A rate limit belongs to the upstream SERVICE, not to a DNS name. Keying it on
// the hostname meant a {s} template with three subdomains got three independent
// buckets and ran at three times the configured rate, the kind of overrun that
// gets an arrangement with a tile provider withdrawn. Every hostname a coverage
// can produce therefore maps back to one key: its tileSource template.
function hostsForCoverage(c: Coverage): string[] {
  if (!c.tileSource) return []
  const subs = c.tileSubdomains?.length ? c.tileSubdomains : ["a", "b", "c"]
  const urls = c.tileSource.includes("{s}")
    ? subs.map((sub) => c.tileSource.replace("{s}", sub))
    : [c.tileSource]
  const hosts: string[] = []
  for (const u of urls) {
    try { hosts.push(new URL(u).hostname) } catch { /* skip malformed */ }
  }
  return hosts
}

// hostname -> service key, so the proxy can resolve a concrete URL back to the
// configured source it came from without trusting anything the caller sent.
function hostServiceMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of coverages) {
    for (const host of hostsForCoverage(c)) map.set(host, c.tileSource)
  }
  return map
}

function configuredTileHosts(): Set<string> {
  return new Set(hostServiceMap().keys())
}

// ---- Outbound destination guard ----

// The set of hosts the tile proxy will fetch is built from coverage config, and
// coverage config is written by whoever is logged in. So "only configured hosts"
// bounds nothing on its own. Point a coverage at 127.0.0.1 and the proxy will
// happily read back whatever answers. What actually bounds it is refusing to
// talk to addresses that are not on the public internet.
//
// Residual risk worth naming: the name is resolved here and resolved again by
// fetch, so a hostile DNS server could answer differently the second time
// (rebinding). Closing that needs pinning the connection to the address checked,
// which Bun's fetch does not expose.
function isBlockedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0 || a === 10 || a === 127) return true            // this-network, private, loopback
  if (a === 172 && b >= 16 && b <= 31) return true             // private
  if (a === 192 && b === 168) return true                      // private
  if (a === 169 && b === 254) return true                      // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true            // CGNAT
  if (a === 192 && b === 0) return true                        // IETF protocol assignments
  if (a >= 224) return true                                    // multicast + reserved
  return false
}

function isBlockedIP(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0] // strip any zone id
  if (!addr.includes(":")) return isBlockedIPv4(addr)
  if (addr === "::" || addr === "::1") return true
  // ::ffff:a.b.c.d and friends carry a v4 address; judge it as v4.
  const tail = addr.slice(addr.lastIndexOf(":") + 1)
  if (tail.includes(".")) return isBlockedIPv4(tail)
  if (/^f[cd]/.test(addr)) return true                         // unique local
  if (/^fe[89ab]/.test(addr)) return true                      // link-local
  return false
}

// Resolution is on the hot path (one tile fetch per call), so remember the
// verdict for a short while rather than asking the resolver 40,000 times.
const hostVerdictCache = new Map<string, { blocked: string | null; at: number }>()
const HOST_VERDICT_TTL_MS = 5 * 60 * 1000

// Every hostname a tileSource template can expand to, checked at save time so a
// coverage that could never legally download is refused with a reason rather
// than saved and left silently failing. This does rule out pointing a coverage
// at a tile server on your own LAN; that is deliberate, because the whole point of the
// check is that "a host the server can reach" is not a safe category.
async function blockedTileSource(tileSource: string, subdomains?: string[]): Promise<string | null> {
  const hosts = hostsForCoverage({ tileSource, tileSubdomains: subdomains } as Coverage)
  if (hosts.length === 0) return "tile source is not a valid URL"
  for (const host of hosts) {
    const blocked = await blockedDestination(host)
    if (blocked) return blocked
  }
  return null
}

/** Returns an error message if the host must not be fetched, or null if it is fine. */
async function blockedDestination(hostname: string): Promise<string | null> {
  const cached = hostVerdictCache.get(hostname)
  if (cached && Date.now() - cached.at < HOST_VERDICT_TTL_MS) return cached.blocked

  let verdict: string | null = null
  // A bare IP literal never reaches the resolver, so check it directly.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    verdict = isBlockedIP(hostname.replace(/^\[|\]$/g, ""))
      ? `refusing to fetch a non-public address: ${hostname}`
      : null
  } else {
    try {
      const addrs = await dnsLookup(hostname, { all: true, verbatim: true })
      const bad = addrs.find((a) => isBlockedIP(a.address))
      if (bad) verdict = `refusing to fetch a non-public address: ${hostname} resolves to ${bad.address}`
    } catch {
      // A name that does not resolve cannot be reached, so it is not a target
      // worth blocking, and refusing it here would mean a DNS blip stopped a
      // coverage being saved. The fetch fails on its own, with its own reason.
      verdict = null
    }
  }

  hostVerdictCache.set(hostname, { blocked: verdict, at: Date.now() })
  return verdict
}

// Two coverages can target the same service with different limits. Give the
// shared bucket the strictest rate among the runs currently using it, so
// nobody's configured ceiling is quietly raised by someone else's.
function refreshHostLimits() {
  const strictest = new Map<string, number>()
  for (const run of activeRuns.values()) {
    if (run.status !== "running" && run.status !== "queued") continue
    const coverage = coverages.find((c) => c.id === run.coverageId)
    if (!coverage?.tileSource) continue
    const rate = coverage.maxCallsPerMinute ?? 60
    const current = strictest.get(coverage.tileSource)
    if (current === undefined || rate < current) strictest.set(coverage.tileSource, rate)
  }
  for (const [service, rate] of strictest) {
    getServiceLimiter(service, rate).setRate(rate)
  }
}

class RateLimiter {
  private tokens: number
  private lastRefill: number
  private ratePerMs: number
  private maxTokens: number

  constructor(maxCallsPerMinute: number) {
    this.ratePerMs = maxCallsPerMinute / 60_000
    this.maxTokens = Math.max(1, Math.ceil(maxCallsPerMinute / 10))
    this.tokens = this.maxTokens
    this.lastRefill = Date.now()
  }

  setRate(maxCallsPerMinute: number) {
    const ratePerMs = maxCallsPerMinute / 60_000
    if (ratePerMs === this.ratePerMs) return
    this.ratePerMs = ratePerMs
    this.maxTokens = Math.max(1, Math.ceil(maxCallsPerMinute / 10))
    this.tokens = Math.min(this.tokens, this.maxTokens)
  }

  async wait() {
    while (true) {
      const now = Date.now()
      this.tokens = Math.min(this.maxTokens, this.tokens + (now - this.lastRefill) * this.ratePerMs)
      this.lastRefill = now
      if (this.tokens >= 1) { this.tokens -= 1; return }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.ceil((1 - this.tokens) / this.ratePerMs)),
      )
    }
  }
}

// ---- Config ----

// Everything the server writes lives under STATE_DIR. Keeping it off the source
// tree means a deploy that syncs with --delete cannot eat the database, and a
// test can point it somewhere disposable.
const STATE_DIR = process.env.STATE_DIR ?? join(import.meta.dir, "..")

const CONFIG_PATH = join(STATE_DIR, "config.json")
const AUTH_PATH = join(STATE_DIR, "auth.json")
const LOGS_DIR = join(STATE_DIR, "logs")
const DIST_DIR = join(import.meta.dir, "..", "dist")
const PORT = Number(process.env.PORT ?? 3001)

// Loopback by default. The dashboard is a single-admin tool reached over an SSH
// tunnel, and binding every interface put a login form on the LAN whose only
// protection was whatever firewall happened to sit in front of it. Set
// BIND_HOST=0.0.0.0 to go back to listening everywhere.
const BIND_HOST = process.env.BIND_HOST ?? "127.0.0.1"
const SERVE_STATIC = existsSync(join(DIST_DIR, "index.html"))

mkdirSync(LOGS_DIR, { recursive: true })

// ---- Auth data ----

type AuthData = { username: string; passwordHash: string }
let authData: AuthData | null = null
try {
  const raw = readFileSync(AUTH_PATH, "utf8")
  // Tighten what is already on disk, not just what we write. auth.json is only
  // rewritten when the password changes, so an install that first wrote it
  // before the 0600 handling existed would otherwise keep a loose file forever.
  // Do it whether or not the parse below succeeds, since a corrupt auth.json
  // still holds the hash.
  try { chmodSync(AUTH_PATH, 0o600) } catch { /* best effort */ }
  authData = JSON.parse(raw)
} catch {}

// The server listens on every interface, and an unclaimed instance has no
// password to check against, so whoever reaches the port first would own it
// permanently, operator or not. Claiming it therefore takes a code that only
// someone who can read the server's own output has: the console on first run,
// or `journalctl -u maps` under systemd. Held in memory only, so a
// restart issues a fresh one and a code cannot outlive the window it opens.
const SETUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no I/O/0/1

function generateSetupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  // 32 divides 256, so the modulo below is unbiased.
  const chars = [...bytes].map((b) => SETUP_CODE_ALPHABET[b % SETUP_CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`
}

let setupCode: string | null = authData === null ? generateSetupCode() : null

const MIN_PASSWORD_LENGTH = 8

// auth.json holds the password hash, so it has no business being world-readable.
// writeFileSync's mode only applies when it creates the file, so an install that
// already wrote it at 0644 needs the explicit chmod to be brought down.
function writeAuthFile() {
  writeFileSync(AUTH_PATH, JSON.stringify(authData), { mode: 0o600 })
  try { chmodSync(AUTH_PATH, 0o600) } catch { /* best effort */ }
}

let outputDir = ""
let onionUrl = ""
let internalSecret = ""
let maxConcurrentRuns = 2
let tileTransport: TileTransport = "clearnet"
let torProxyUrl = "http://127.0.0.1:9080"
let torReachable: boolean | null = null
let logSettings: LogSettings = { retentionValue: 30, retentionUnit: "days", cleanerPaused: false }

// config.json holds internalSecret, so it gets the same treatment as auth.json:
// 0600 on write, and an explicit chmod because writeFileSync's mode only applies
// when it creates the file.
function writeConfigFile(config: unknown) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
  try { chmodSync(CONFIG_PATH, 0o600) } catch { /* best effort */ }
}

try {
  const raw = readFileSync(CONFIG_PATH, "utf8")
  // Tighten on load, not just on write. An install created before this was here
  // has a 0644 config sitting on disk, and nothing else would bring it down until
  // someone happened to change a setting. Do it whether or not the parse below
  // succeeds, since a corrupt config still holds whatever secret was in it.
  try { chmodSync(CONFIG_PATH, 0o600) } catch { /* best effort */ }
  const config = JSON.parse(raw)
  outputDir = config.outputDir ?? ""
  onionUrl = config.onionUrl ?? ""
  internalSecret = config.internalSecret ?? ""
  maxConcurrentRuns = Math.max(1, config.maxConcurrentRuns ?? 2)
  tileTransport = config.tileTransport === "tor" ? "tor" : "clearnet"
  torProxyUrl = config.torProxyUrl ?? torProxyUrl
  if (config.logRetention) {
    logSettings = {
      retentionValue: config.logRetention.value ?? 30,
      retentionUnit: config.logRetention.unit ?? "days",
      cleanerPaused: config.logRetention.cleanerPaused ?? false,
    }
  }
} catch {
  console.warn("⚠ config.json not found. Create one from config.example.json and restart.")
}

// Runners authenticate back to us with this. A generated one is fine for a single
// session but leaves in-flight runs unable to report in after a restart.
if (!internalSecret) {
  internalSecret = crypto.randomUUID() + "-" + crypto.randomUUID()
  console.warn("  ⚠ no internalSecret in config.json, using a temporary one. Set it for production.")
}

const INTERNAL_BASE_URL = process.env.INTERNAL_BASE_URL ?? `http://localhost:${PORT}`
const RUNNER_PATH = join(import.meta.dir, "runner.ts")

// ---- Tile transport ----

// Which regions a server covers is a fingerprint of that server. Fetching the
// corpus over clearnet ties it to the operator's egress IP, so a hidden service
// can be matched to whoever downloaded exactly those tiles. Routing fetches
// through Tor is what breaks that link.
//
// Bun's fetch rejects socks5://, so this is Tor's HTTPTunnelPort (an HTTP
// CONNECT proxy), not its SOCKS port.
function effectiveTransport(coverage: Coverage): TileTransport {
  const chosen: CoverageTransport = coverage.transport ?? "default"
  return chosen === "default" ? tileTransport : chosen
}

// Over Tor a distinctive User-Agent hands back most of what the circuit hides.
const CLEARNET_UA = "maps/1.0 (tile downloader)"
const TOR_UA = "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0"

async function probeTorProxy(): Promise<boolean> {
  try {
    const res = await fetch("https://check.torproject.org/api/ip", {
      proxy: torProxyUrl,
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { IsTor?: boolean }
    // A reachable proxy that is not actually Tor is worse than none at all,
    // because it would look like it is working.
    return body.IsTor === true
  } catch {
    return false
  }
}

// ---- Process tracking ----

// runId → child process, so we can kill it on cancel
const activeProcesses = new Map<string, ReturnType<typeof Bun.spawn>>()
// coverageId → pending scheduled run
const scheduledTimers = new Map<string, { cancel: () => void }>()
// Runs waiting for a worker slot, oldest first
const runQueue: string[] = []

async function spawnCoverageRun(coverage: Coverage, runId: string, mode: RunMode): Promise<void> {
  const args = {
    coverageId: coverage.id,
    runId,
    mode,
    mapId: coverage.mapId,
    regions: coverage.regions,
    zoomMin: coverage.zoomMin,
    zoomMax: coverage.zoomMax,
    tileSource: coverage.tileSource,
    tileSubdomains: coverage.tileSubdomains ?? ["a", "b", "c"],
    workers: coverage.workers ?? 4,
    maxCallsPerMinute: coverage.maxCallsPerMinute ?? 60,
    transport: effectiveTransport(coverage),
    outputDir,
    progressUrl: `${INTERNAL_BASE_URL}/api/internal/progress`,
    completeUrl: `${INTERNAL_BASE_URL}/api/internal/run-complete`,
    controlUrl: `${INTERNAL_BASE_URL}/api/internal/run-control`,
    fetchTileUrl: `${INTERNAL_BASE_URL}/api/internal/fetch-tile`,
    internalToken: internalSecret,
  }

  const logPath = join(LOGS_DIR, `${runId}.log`)
  const logFile = Bun.file(logPath)
  const logWriter = logFile.writer()

  const proc = Bun.spawn(["bun", "run", RUNNER_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })

  activeProcesses.set(runId, proc)
  refreshHostLimits()

  // Write args to stdin then close it
  proc.stdin.write(JSON.stringify(args))
  proc.stdin.end()

  // Pipe stdout + stderr to log file
  async function pipeStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      logWriter.write(value)
      logWriter.flush()
    }
  }
  Promise.all([pipeStream(proc.stdout), pipeStream(proc.stderr)]).finally(() => {
    logWriter.end()
    activeProcesses.delete(runId)
    // The process is gone, so whatever it was holding is free now. This is the
    // reliable slot release, since a runner that crashes never posts run-complete.
    releaseSlotAndStartNext()
  })
}

// ---- Run slots ----

// A run holds a slot from the moment it spawns until its process exits. Anything
// started beyond the cap waits in runQueue rather than spawning, which is what
// keeps concurrent network writes bounded.
function slotsInUse(): number {
  return activeProcesses.size
}

function broadcastQueue() {
  const waiting = runQueue
    .map((runId) => activeRuns.get(runId)?.coverageId)
    .filter((id): id is string => id !== undefined)
  broadcast({ type: "queue", payload: waiting })
}

function releaseSlotAndStartNext() {
  while (slotsInUse() < maxConcurrentRuns && runQueue.length > 0) {
    const runId = runQueue.shift()!
    const run = activeRuns.get(runId)
    if (!run || run.status !== "queued") continue

    const coverage = coverages.find((c) => c.id === run.coverageId)
    if (!coverage) {
      activeRuns.delete(runId)
      continue
    }

    spawnCoverageRun(coverage, runId, run.mode ?? "resume").catch(async (e) => {
      run.status = "error"
      run.error = e instanceof Error ? e.message : String(e)
      run.endedAt = new Date().toISOString()
      activeRuns.delete(runId)
      dbSaveRun(run)
      broadcastRun(run, true)
    })
  }
  refreshHostLimits()
  broadcastQueue()
}

function killCoverageRun(runId: string) {
  const proc = activeProcesses.get(runId)
  if (proc) {
    try { proc.kill() } catch { /* already dead */ }
    activeProcesses.delete(runId)
  }
}

// Cancelling has two shapes. A live run gets signalled and finishes on its own
// when its process exits. A run with no process (queued, or paused, which exits
// its runner by design) has nothing to wait for, so it has to be finalised
// here. Missing that second case strands the run in activeRuns forever, and
// since a coverage refuses to start while it has an active run, the coverage
// becomes permanently unstartable with no way out from the UI.
function cancelRun(runId: string, reason?: string): boolean {
  const run = activeRuns.get(runId)
  if (!run) return false

  const queueIndex = runQueue.indexOf(runId)
  if (queueIndex !== -1) runQueue.splice(queueIndex, 1)

  if (!activeProcesses.has(runId)) {
    run.status = "cancelled"
    run.endedAt = new Date().toISOString()
    if (!run.startedAt) run.startedAt = run.endedAt
    if (reason) run.error = reason
    activeRuns.delete(runId)
    dbSaveRun(run)
    broadcastRun(run, true)
    broadcastQueue()
    return true
  }

  run.status = "cancelling"
  if (reason) run.error = reason
  dbSaveRun(run)
  broadcastRun(run, true)
  killCoverageRun(runId)
  return true
}


// ---- Persistence helpers ----

function saveLogSettings() {
  try {
    const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {}
    existing.logRetention = {
      value: logSettings.retentionValue,
      unit: logSettings.retentionUnit,
      cleanerPaused: logSettings.cleanerPaused,
    }
    writeConfigFile(existing)
  } catch { /* ignore */ }
}

function retentionToMs(value: number, unit: RetentionUnit): number {
  switch (unit) {
    case "hours":  return value * 60 * 60 * 1000
    case "days":   return value * 24 * 60 * 60 * 1000
    case "weeks":  return value * 7 * 24 * 60 * 60 * 1000
    case "months": return value * 30 * 24 * 60 * 60 * 1000
    case "years":  return value * 365 * 24 * 60 * 60 * 1000
  }
}

// In-memory state (loaded from DB on startup)
let maps: TileMap[] = []
let coverages: Coverage[] = []
let allRuns: CoverageRun[] = []
const activeRuns = new Map<string, CoverageRun>()

async function writeDiscoFile(): Promise<void> {
  if (!outputDir) return
  try { await access(outputDir) } catch { return }

  const discoMaps: DiscoMap[] = maps
    .filter((m) => m.discoverable)
    .map((m) => {
      const mapCoverages = coverages.filter((c) => c.mapId === m.id)
      if (mapCoverages.length === 0) {
        return { id: m.id, name: m.name, description: m.description }
      }
      const zoomMin = Math.min(...mapCoverages.map((c) => c.zoomMin))
      const zoomMax = Math.max(...mapCoverages.map((c) => c.zoomMax))
      let north = -Infinity, south = Infinity, west = Infinity, east = -Infinity
      for (const cov of mapCoverages) {
        for (const region of cov.regions) {
          north = Math.max(north, region.bbox.north)
          south = Math.min(south, region.bbox.south)
          west  = Math.min(west,  region.bbox.west)
          east  = Math.max(east,  region.bbox.east)
        }
      }
      return { id: m.id, name: m.name, description: m.description, zoomMin, zoomMax, bbox: { north, south, west, east } }
    })

  const discoFile: DiscoFile = { v: 1, generated: new Date().toISOString(), maps: discoMaps }
  try {
    await writeFile(join(outputDir, "disco.json"), JSON.stringify(discoFile, null, 2))
  } catch { /* network storage may be temporarily unavailable */ }
}

async function writeMapFile(map: TileMap): Promise<void> {
  if (!outputDir) return
  const mapCoverages = coverages.filter((c) => c.mapId === map.id)
  let zoomMin: number | undefined, zoomMax: number | undefined
  let north = -Infinity, south = Infinity, west = Infinity, east = -Infinity
  let hasBbox = false
  for (const cov of mapCoverages) {
    zoomMin = zoomMin === undefined ? cov.zoomMin : Math.min(zoomMin, cov.zoomMin)
    zoomMax = zoomMax === undefined ? cov.zoomMax : Math.max(zoomMax, cov.zoomMax)
    for (const r of cov.regions) {
      hasBbox = true
      north = Math.max(north, r.bbox.north)
      south = Math.min(south, r.bbox.south)
      west  = Math.min(west,  r.bbox.west)
      east  = Math.max(east,  r.bbox.east)
    }
  }
  const data: Record<string, unknown> = {
    v: 1,
    id: map.id,
    name: map.name,
    description: map.description,
    generated: new Date().toISOString(),
  }
  // The client uses tileUrl verbatim, so the extension here is what it will
  // request. Take it from the coverages rather than assuming png.
  const formats = new Set(
    coverages.filter((c) => c.mapId === map.id).map((c) => c.tileFormat ?? "png"),
  )
  if (formats.size > 1) {
    console.warn(`  ⚠ map ${map.id} mixes tile formats (${[...formats].join(", ")}); advertising png`)
  }
  const ext = formats.size === 1 ? [...formats][0] : "png"
  if (onionUrl) data.tileUrl = `${onionUrl}/${map.id}/{z}/{x}/{y}.${ext}`
  if (zoomMin !== undefined) data.zoomMin = zoomMin
  if (zoomMax !== undefined) data.zoomMax = zoomMax
  if (hasBbox) data.bbox = { north, south, west, east }
  try {
    const mapDir = join(outputDir, map.id)
    await mkdir(mapDir, { recursive: true })
    await writeFile(join(mapDir, "map.json"), JSON.stringify(data, null, 2))
  } catch { /* network storage may be temporarily unavailable */ }
}

// ---- SSE ----

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const enc = new TextEncoder()

function broadcast(event: SSEEvent) {
  const chunk = enc.encode(`data: ${JSON.stringify(event)}\n\n`)
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(chunk) } catch { sseClients.delete(ctrl) }
  }
}

async function checkOutputDir(): Promise<boolean> {
  if (!outputDir) return false
  try {
    await Promise.race([
      stat(outputDir),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ])
    return true
  } catch {
    return false
  }
}

async function getServerState(): Promise<ServerState> {
  return {
    maps,
    coverages,
    activeRuns: [...activeRuns.values()],
    outputDir,
    outputDirOk: await checkOutputDir(),
    logSettings: { ...logSettings },
    onionUrl,
    maxConcurrentRuns,
    tileTransport,
    torReachable,
  }
}


// Fetch one real tile from a source to learn what it serves. Doing this when a
// coverage is saved turns a whole class of silent failure into an immediate
// error: pointing at a JPEG source previously downloaded and discarded every
// tile, reporting thousands of failures with no reason attached.
async function probeTileFormat(
  tileSource: string,
  subdomains: string[],
  bbox: Bbox,
  zoom: number,
  transport: TileTransport,
  maxCallsPerMinute: number,
): Promise<{ format: TileFormat } | { error: string }> {
  const z = Math.max(0, Math.min(zoom, 12))
  const lat = clampLat((bbox.north + bbox.south) / 2)
  const lon = (bbox.west + bbox.east) / 2
  const url = buildTileUrl(tileSource, z, lon2tileX(lon, z), lat2tileY(lat, z), subdomains[0] ?? "a")

  let host: string
  try { host = new URL(url).hostname } catch { return { error: "tile source is not a valid URL" } }

  // Saving a coverage makes the server fetch a URL the caller chose, so this is
  // the same outbound primitive as the tile proxy and needs the same guard.
  const blocked = await blockedDestination(host)
  if (blocked) return { error: blocked }

  try {
    // Use the coverage's own rate, not a default, because creating the bucket at a
    // higher rate here would raise the ceiling for every later fetch too.
    await getServiceLimiter(tileSource, maxCallsPerMinute).wait()
    const res = await fetch(url, {
      headers: { "User-Agent": transport === "tor" ? TOR_UA : CLEARNET_UA },
      ...(transport === "tor" ? { proxy: torProxyUrl } : {}),
      signal: AbortSignal.timeout(transport === "tor" ? 45_000 : 20_000),
    })
    if (!res.ok) return { error: `${host} returned HTTP ${res.status}` }
    const check = validateTile(await res.arrayBuffer())
    if ("error" in check) return { error: `${host} served something unusable: ${check.error}` }
    return { format: check.format }
  } catch (e) {
    return { error: `could not reach ${host}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ---- Coverage input bounds ----

// The API took these numbers on trust. zoomMax alone is enough to kill a run
// before it starts: the runner materialises every tile id in one array, so
// zoom 30 over a single degree asks for ~10^12 entries and the process dies
// with nothing recorded about why. The dashboard offers sane values; nothing
// made the API insist on them.
const MAX_ZOOM = 20
const MAX_WORKERS = 32
const MAX_CALLS_PER_MINUTE = 600

function inRange(v: unknown, lo: number, hi: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi
}

function validateCoverageShape(c: {
  regions?: unknown
  zoomMin?: unknown
  zoomMax?: unknown
  workers?: unknown
  maxCallsPerMinute?: unknown
}): string | null {
  if (!Number.isInteger(c.zoomMin) || !inRange(c.zoomMin, 0, MAX_ZOOM))
    return `zoomMin must be an integer between 0 and ${MAX_ZOOM}`
  if (!Number.isInteger(c.zoomMax) || !inRange(c.zoomMax, 0, MAX_ZOOM))
    return `zoomMax must be an integer between 0 and ${MAX_ZOOM}`
  if ((c.zoomMin as number) > (c.zoomMax as number)) return "zoomMin cannot be greater than zoomMax"
  if (c.workers != null && (!Number.isInteger(c.workers) || !inRange(c.workers, 1, MAX_WORKERS)))
    return `workers must be an integer between 1 and ${MAX_WORKERS}`
  if (c.maxCallsPerMinute != null && !inRange(c.maxCallsPerMinute, 1, MAX_CALLS_PER_MINUTE))
    return `maxCallsPerMinute must be between 1 and ${MAX_CALLS_PER_MINUTE}`

  if (!Array.isArray(c.regions) || c.regions.length === 0) return "at least one region is required"
  for (const r of c.regions as { bbox?: Bbox; marginKm?: unknown }[]) {
    const b = r?.bbox
    if (!b) return "every region needs a bbox"
    if (!inRange(b.north, -90, 90) || !inRange(b.south, -90, 90))
      return "region latitudes must be between -90 and 90"
    if (!inRange(b.west, -180, 180) || !inRange(b.east, -180, 180))
      return "region longitudes must be between -180 and 180"
    if (b.north <= b.south) return "region north must be greater than south"
    if (r.marginKm != null && !inRange(r.marginKm, 0, 1000))
      return "region marginKm must be between 0 and 1000"
  }
  return null
}

// A map advertises exactly one tile extension in map.json, so its coverages have
// to agree. Mixing them leaves half the corpus unreachable to the client.
function conflictingFormat(mapId: string, exceptCoverageId: string | null, format: TileFormat): TileFormat | null {
  for (const c of coverages) {
    if (c.mapId !== mapId || c.id === exceptCoverageId) continue
    if (c.tileFormat && c.tileFormat !== format) return c.tileFormat
  }
  return null
}

// ---- Scheduling ----

function computeNextRunAt(recurrency: Recurrency): string {
  const days = recurrency === "high" ? 7 : recurrency === "normal" ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

// A failed run used to leave nextRunAt untouched, and the only place that sets
// it is the success path, so one failure disarmed recurrence permanently: the
// coverage went dormant until somebody noticed and started it by hand. The
// failures that caused it here were transient (a server restart mid-run, a NAS
// write timeout), which is exactly the case worth retrying.
//
// Retries use their own backoff rather than the configured interval, because
// that interval is 7 to 90 days — long enough that "retry at the normal time"
// is indistinguishable from giving up.
const RETRY_MAX = 5
const RETRY_BASE_MS = 5 * 60_000
const RETRY_CAP_MS = 6 * 60 * 60_000

function computeRetryAt(consecutiveFailures: number): string {
  const backoff = Math.min(RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), RETRY_CAP_MS)
  return new Date(Date.now() + backoff).toISOString()
}

// setTimeout takes a signed 32-bit delay, about 24.9 days. Recurrency goes up to
// 90, so anything longer has to be split into chunks or it fires immediately.
const MAX_TIMEOUT_MS = 2_147_483_647

function setLongTimeout(fn: () => void, delayMs: number): { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>
  let cancelled = false

  function arm(remaining: number) {
    if (cancelled) return
    const step = Math.min(remaining, MAX_TIMEOUT_MS)
    timer = setTimeout(() => {
      if (cancelled) return
      if (remaining <= step) fn()
      else arm(remaining - step)
    }, step)
  }
  arm(Math.max(0, delayMs))

  return { cancel: () => { cancelled = true; clearTimeout(timer) } }
}

function scheduleNextRun(coverage: Coverage) {
  if (coverage.recurrency === "none" || !coverage.nextRunAt) return
  const delay = new Date(coverage.nextRunAt).getTime() - Date.now()
  if (delay <= 0) return

  scheduledTimers.get(coverage.id)?.cancel()
  const timer = setLongTimeout(() => {
    scheduledTimers.delete(coverage.id)
    const mode: RunMode = coverage.lastRunStatus === "success" ? "update" : "resume"
    startCoverageRun(coverage, generateId(), mode).catch((e) =>
      console.error(`scheduled run for ${coverage.id}:`, e),
    )
  }, delay)
  scheduledTimers.set(coverage.id, timer)
}

function cancelScheduledRun(coverageId: string) {
  scheduledTimers.get(coverageId)?.cancel()
  scheduledTimers.delete(coverageId)
}

// Create the run record, then spawn it if a slot is free or queue it if not.
async function startCoverageRun(coverage: Coverage, runId: string, mode: RunMode): Promise<CoverageRun> {
  const queuedRun: CoverageRun = {
    id: runId,
    coverageId: coverage.id,
    status: "queued",
    mode,
    startedAt: null,
    endedAt: null,
    done: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    total: 0,
  }
  activeRuns.set(runId, queuedRun)
  allRuns.push(queuedRun)
  dbSaveRun(queuedRun)

  if (slotsInUse() < maxConcurrentRuns) {
    await spawnCoverageRun(coverage, runId, mode)
  } else {
    runQueue.push(runId)
    addLog(runId, `Waiting for a free slot (${maxConcurrentRuns} run${maxConcurrentRuns === 1 ? "" : "s"} at a time)`)
    broadcastQueue()
  }
  return queuedRun
}

// ---- Helpers ----

const lastBroadcastAt = new Map<string, number>()

function broadcastRun(run: CoverageRun, force = false) {
  const now = Date.now()
  const last = lastBroadcastAt.get(run.id) ?? 0
  if (force || now - last >= 250) {
    lastBroadcastAt.set(run.id, now)
    broadcast({ type: "run", payload: { ...run } })
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function generateMapId(): string {
  return crypto.randomUUID()
}

/** Race a promise against a timeout that resolves to `fallback`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}


// Tracks coverages currently being started to prevent duplicate concurrent starts
const startingCoverageIds = new Set<string>()

// ---- Tile ownership geometry ----

function tileBox(z: number, x: number, y: number) {
  const n = 2 ** z
  const toLat = (ty: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: toLat(y),
    south: toLat(y + 1),
  }
}

function isTileInCoverageList(z: number, x: number, y: number, list: Coverage[]): boolean {
  const tb = tileBox(z, x, y)
  for (const cov of list) {
    if (z < cov.zoomMin || z > cov.zoomMax) continue
    for (const region of cov.regions) {
      const md = (region.marginKm ?? 0) / 111
      if (
        tb.west < region.bbox.east + md &&
        tb.east > region.bbox.west - md &&
        tb.south < region.bbox.north + md &&
        tb.north > region.bbox.south - md
      )
        return true
    }
  }
  return false
}

// ---- Integrity-checked cleanup ----

const CLEANUP_WORKERS = 4

async function startCleanup(deleted: Coverage, otherMapCoverages: Coverage[]) {
  const progress: CleanupProgress = {
    coverageId: deleted.id,
    coverageName: deleted.name,
    checked: 0,
    deleted: 0,
    skipped: 0,
    done: false,
  }

  const mapDir = outputDir ? join(outputDir, deleted.mapId) : ""
  if (!mapDir || !(await access(mapDir).then(() => true).catch(() => false))) {
    progress.done = true
    broadcast({ type: "cleanup", payload: { ...progress } })
    return
  }

  broadcast({ type: "cleanup", payload: { ...progress } })

  let lastBroadcast = Date.now()

  async function walkDir(dir: string) {
    let entries: import("fs").Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name as string)
      if (entry.isDirectory()) { await walkDir(fullPath); continue }
      if (!isTileFile(entry.name as string)) continue

      const rel = fullPath.slice(mapDir.length + 1).replace(/\\/g, "/")
      const parts = rel.split("/")
      if (parts.length !== 3) continue
      const z = parseInt(parts[0])
      const x = parseInt(parts[1])
      const y = parseInt(parts[2].slice(0, -4))
      if (isNaN(z) || isNaN(x) || isNaN(y)) continue

      if (!isTileInCoverageList(z, x, y, [deleted])) continue

      progress.checked++
      if (isTileInCoverageList(z, x, y, otherMapCoverages)) {
        progress.skipped++
      } else {
        try { await unlink(fullPath); progress.deleted++ } catch { /* already gone */ }
      }

      const now = Date.now()
      if (now - lastBroadcast >= 300) {
        lastBroadcast = now
        broadcast({ type: "cleanup", payload: { ...progress } })
      }
    }
  }

  await walkDir(mapDir)

  progress.done = true
  broadcast({ type: "cleanup", payload: { ...progress } })
}

// ---- Disk utilities ----

// A tile folder is named after its map id. Two shapes exist: crypto.randomUUID()
// for anything generateMapId() made, and the older generateId() timestamp-random
// pair that legacy maps.json rows were imported with.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEGACY_ID_RE = /^[0-9a-z]{8}-[0-9a-z]{1,6}$/

function looksLikeMapFolder(name: string): boolean {
  return UUID_RE.test(name) || LEGACY_ID_RE.test(name)
}

// outputDir is operator-supplied and everything under it is a deletion target for
// purge, so a typo here is not a broken download. It is an rm -rf somewhere else
// on the host. Refuse anything that is not an existing directory named by an
// absolute path, and refuse the filesystem root outright.
async function validateOutputDir(dir: string): Promise<string | null> {
  if (!isAbsolute(dir)) return "output directory must be an absolute path"
  if (dir === "/" || dirname(dir) === dir) return "output directory cannot be the filesystem root"
  let s: Awaited<ReturnType<typeof stat>>
  try {
    s = await withTimeout(stat(dir), 5_000, null as never)
  } catch {
    return `output directory does not exist: ${dir}`
  }
  if (!s) return `output directory did not respond in time: ${dir}`
  if (!s.isDirectory()) return `output directory is not a directory: ${dir}`
  return null
}

async function dirSizeBytes(dir: string): Promise<number> {
  let entries: import("fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const p = join(dir, entry.name as string)
    if (entry.isDirectory()) {
      total += await dirSizeBytes(p)
    } else {
      try { total += (await stat(p)).size } catch { /* skip */ }
    }
  }
  return total
}

// ---- Land tile estimation ----

function estimateLandTiles(
  bbox: { north: number; south: number; west: number; east: number },
  marginKm: number,
  zoomMin: number,
  zoomMax: number,
): number {
  const tr = { bbox, marginKm, zoomMin, zoomMax }
  const bboxCount = countTiles(tr)
  if (!maskReady()) return bboxCount
  if (bboxCount <= 20_000_000) {
    let count = 0
    iterateTiles(tr, (z, x, y) => { if (tileIsLand(z, x, y)) count++ })
    return count
  }
  const marginDeg = marginKm / 111
  const s = Math.max(-85, bbox.south - marginDeg)
  const n = Math.min(85, bbox.north + marginDeg)
  const w = bbox.west - marginDeg
  const e = bbox.east + marginDeg
  const RES = 0.25
  let gridTotal = 0, gridLand = 0
  for (let lat = s + RES / 2; lat <= n; lat += RES) {
    for (let lon = w + RES / 2; lon <= e; lon += RES) {
      gridTotal++
      if (isLand(lat, lon)) gridLand++
    }
  }
  const fraction = gridTotal > 0 ? gridLand / gridTotal : 0.29
  return Math.round(bboxCount * fraction)
}

// ---- Sessions ----

// Constant-time compare. A plain !== leaks the length of the matching prefix
// through timing, which is enough to walk a secret one byte at a time.
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, so compare a fixed-size digest
  // instead and keep the comparison itself constant-time.
  const da = createHash("sha256").update(ba).digest()
  const db = createHash("sha256").update(bb).digest()
  return timingSafeEqual(da, db)
}

// ---- Login throttle ----

// Single-admin app, so an attacker who could lock the account out from anywhere
// would be handing themselves a denial of service. Counting per source address
// means one noisy IP cannot lock the operator out from another.
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_FREE_ATTEMPTS = 5
const LOGIN_MAX_DELAY_MS = 5 * 60 * 1000

const loginFailures = new Map<string, { count: number; blockedUntil: number; last: number }>()

function loginRetryAfterMs(ip: string): number {
  const rec = loginFailures.get(ip)
  if (!rec) return 0
  if (Date.now() - rec.last > LOGIN_WINDOW_MS) { loginFailures.delete(ip); return 0 }
  return Math.max(0, rec.blockedUntil - Date.now())
}

function noteLoginFailure(ip: string) {
  const now = Date.now()
  const rec = loginFailures.get(ip) ?? { count: 0, blockedUntil: 0, last: now }
  if (now - rec.last > LOGIN_WINDOW_MS) rec.count = 0
  rec.count++
  rec.last = now
  if (rec.count > LOGIN_FREE_ATTEMPTS) {
    const backoff = Math.min(LOGIN_MAX_DELAY_MS, 1000 * 2 ** (rec.count - LOGIN_FREE_ATTEMPTS - 1))
    rec.blockedUntil = now + backoff
  }
  loginFailures.set(ip, rec)
}

function clearLoginFailures(ip: string) {
  loginFailures.delete(ip)
}

const sessions = new Map<string, number>()

function isValidToken(token: string | null): boolean {
  if (!token) return false
  const exp = sessions.get(token)
  if (!exp || Date.now() > exp) { sessions.delete(token); return false }
  sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000)
  return true
}

function createSession(): string {
  const token = crypto.randomUUID() + "-" + crypto.randomUUID()
  sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000)
  return token
}

function isLoopbackAddress(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]
  return addr === "::1" || addr === "127.0.0.1" || addr.startsWith("127.") || addr === "::ffff:127.0.0.1"
}

// EventSource cannot set headers, so the SSE stream has to take its token in the
// query string. Nothing else does, and a token in a URL is a token in every
// access log and Referer between here and the browser, so everything else is
// header-only.
const QUERY_TOKEN_PATHS = new Set(["/api/events"])

function getToken(req: Request): string | null {
  const auth = req.headers.get("Authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7)
  const url = new URL(req.url)
  if (QUERY_TOKEN_PATHS.has(url.pathname)) return url.searchParams.get("token")
  return null
}

// ---- Run logs ----

function addLog(runId: string, msg: string) {
  try {
    appendFileSync(join(LOGS_DIR, `${runId}.log`), `[${new Date().toISOString()}] ${msg}\n`)
  } catch { /* ignore */ }
}

function runLogCleanup() {
  if (!existsSync(LOGS_DIR)) return
  const now = Date.now()
  const globalMs = retentionToMs(logSettings.retentionValue, logSettings.retentionUnit)
  try {
    for (const file of readdirSync(LOGS_DIR)) {
      if (!file.endsWith(".log")) continue
      const runId = file.slice(0, -4)
      const logPath = join(LOGS_DIR, file)
      const run = allRuns.find((r) => r.id === runId)
      if (!run) {
        try {
          if (now - statSync(logPath).mtimeMs > globalMs) unlinkSync(logPath)
        } catch { /* ignore */ }
        continue
      }
      const coverage = coverages.find((c) => c.id === run.coverageId)
      const retMs =
        coverage?.logRetention === "custom" &&
        coverage.logRetentionValue != null &&
        coverage.logRetentionUnit
          ? retentionToMs(coverage.logRetentionValue, coverage.logRetentionUnit)
          : globalMs
      const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null
      if (startedAt && now - startedAt > retMs) {
        try { unlinkSync(logPath) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

setTimeout(() => { if (!logSettings.cleanerPaused) runLogCleanup() }, 10_000)
setInterval(() => { if (!logSettings.cleanerPaused) runLogCleanup() }, 60 * 60 * 1000)

// ---- HTTP helpers ----

// In production the dashboard is served from this same origin, so these headers
// are inert, since a browser ignores them for same-origin requests. They exist only
// for `bun run dev`, where Vite serves the dashboard on another port. Naming
// that one origin rather than "*" is what stops any page the operator happens to
// visit from calling this API in their browser.
const DEV_ORIGIN = process.env.DASHBOARD_DEV_ORIGIN ?? "http://localhost:5173"

const CORS = {
  "Access-Control-Allow-Origin": DEV_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

// The session token lives in localStorage, so script injection in the dashboard
// would hand it straight over. There is no inline script in the build, since Vite
// emits a module with a src, so script-src can be strict without 'unsafe-inline'.
// Styles cannot: a couple of components set style={{…}} and React writes those as
// inline attributes. QR codes are rendered from data: URLs, hence img-src.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  })
}

// ---- Build land mask in background ----

initLandMask().catch((e) => console.error("  land mask error:", e))

// ============================================================
// ---- Startup -----------------------------------------------
// ============================================================

;(async () => {
  try {
    initSchema()
    console.log("  database ready")
  } catch (e) {
    console.error("  could not open the database:", e)
    process.exit(1)
  }

  maps.push(...dbLoadMaps())
  coverages.push(...dbLoadCoverages())
  allRuns.push(...dbLoadRuns())

  // disco.json was only written when a map changed, so a server with no maps
  // yet served 404 there and the Android client reported an error instead of an
  // empty catalogue. Write it once at startup so the endpoint always exists.
  // Both contract files are derived entirely from the database, so regenerate
  // them here rather than trusting whatever is on disk. A stale map.json is
  // silent and expensive: if it under-reports zoomMax the client caps its tile
  // source there and never asks for tiles that were downloaded.
  ;(async () => {
    await writeDiscoFile()
    for (const map of maps) await writeMapFile(map)
  })().catch(() => { /* output dir may not be mounted yet */ })

  // Say once, at the right moment, what the transport choice costs. A run will
  // fail rather than fall back, so a broken tunnel should be visible up front.
  if (tileTransport === "tor") {
    probeTorProxy().then(async (ok) => {
      torReachable = ok
      console.log(ok
        ? `  tile transport: tor via ${torProxyUrl} (verified)`
        : `  ⚠ tile transport is tor but ${torProxyUrl} did not answer as Tor. Downloads will fail until it does`)
      broadcast({ type: "state", payload: await getServerState() })
    })
  } else if (coverages.some((c) => c.transport === "tor")) {
    console.log("  tile transport: clearnet by default, some coverages use tor")
  } else {
    console.log("  ⚠ tile transport: clearnet. Which regions you download identifies this server to the tile host. Set tileTransport to \"tor\" in config.json if that matters.")
  }

  // Mark any runs that were interrupted at shutdown as errored
  const covById = new Map(coverages.map((c) => [c.id, c]))
  let interruptedCount = 0
  for (const run of allRuns) {
    if (run.status === "running" || run.status === "paused") {
      run.status = "error"
      run.error = "Interrupted by server restart"
      run.endedAt = new Date().toISOString()
      interruptedCount++
      const cov = covById.get(run.coverageId)
      if (cov && run.startedAt && (!cov.lastRunAt || run.startedAt > cov.lastRunAt)) {
        cov.lastRunAt = run.endedAt
        cov.lastRunStatus = "failed"
      }
    }
  }
  if (interruptedCount > 0) {
    for (const r of allRuns) if (r.status === "error") dbSaveRun(r)
    for (const c of coverages) dbSaveCoverage(c)
    console.log(`  marked ${interruptedCount} interrupted run(s) as failed`)
  }

  // Queued runs never survive a restart, because the child processes died with us.
  let lostQueued = 0
  for (const run of allRuns) {
    if (run.status !== "queued") continue
    run.status = "error"
    run.error = "Lost during server restart"
    run.endedAt = new Date().toISOString()
    dbSaveRun(run)
    lostQueued++
  }
  if (lostQueued > 0) console.log(`  marked ${lostQueued} queued run(s) as lost`)

  // Re-arm schedules from each coverage's own nextRunAt.
  let seeded = 0, pastDue = 0
  for (const coverage of coverages) {
    if (!coverage.nextRunAt || coverage.recurrency === "none") continue
    const delay = new Date(coverage.nextRunAt).getTime() - Date.now()
    const schedulerMode: RunMode = coverage.lastRunStatus === "success" ? "update" : "resume"
    if (delay > 0) {
      scheduleNextRun(coverage)
      seeded++
    } else {
      // Past due while we were down, so start it now.
      try {
        const run = await startCoverageRun(coverage, generateId(), schedulerMode)
        broadcast({ type: "run", payload: { ...run } })
        pastDue++
      } catch (e) {
        console.error(`  could not start past-due run for ${coverage.id}:`, e)
      }
    }
  }
  if (seeded + pastDue > 0) {
    console.log(`  armed ${seeded} schedule(s)${pastDue > 0 ? `, ${pastDue} past due and starting now` : ""}`)
  }

  // ============================================================
  // ---- HTTP server -------------------------------------------
  // ============================================================

  Bun.serve({
    port: PORT,
    hostname: BIND_HOST,
    async fetch(req, server) {
      const { pathname } = new URL(req.url)

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS })
      }

      // ── Internal webhook routes (secured by internalSecret) ──────────────
      if (pathname.startsWith("/api/internal/")) {
        // Only runners call these, and runners are children on this host talking
        // to INTERNAL_BASE_URL, which is loopback. Nothing legitimate reaches
        // them from off-box, so the secret does not have to be the only thing
        // standing between the network and the tile proxy.
        const peer = server.requestIP(req)?.address ?? ""
        if (!isLoopbackAddress(peer)) return json({ error: "not found" }, 404)

        const token = getToken(req)
        if (!token || !safeEqual(token, internalSecret)) return json({ error: "unauthorized" }, 401)

        // Progress update from a runner
        if (pathname === "/api/internal/progress" && req.method === "POST") {
          let body: {
            runId: string
            tileFormat?: TileFormat
            done: number
            skipped: number
            failed: number
            bytes: number
            total: number
            status?: string
          }
          try { body = await req.json() } catch { return json({ error: "invalid JSON" }, 400) }

          const run = activeRuns.get(body.runId)
          if (run) {
            run.done = body.done
            run.skipped = body.skipped
            run.failed = body.failed
            run.bytes = body.bytes
            run.total = body.total
            if (body.status && body.status !== run.status) {
              run.status = body.status as CoverageRun["status"]
              if (body.status === "running" && !run.startedAt) {
                run.startedAt = new Date().toISOString()
              }
            }
            broadcastRun(run)
            await dbSaveRun(run)

            // Publish the format as soon as a runner reports it, so map.json
            // stops advertising an extension the corpus does not use.
            if (body.tileFormat) {
              const cov = coverages.find((c) => c.id === run.coverageId)
              if (cov && cov.tileFormat !== body.tileFormat) {
                cov.tileFormat = body.tileFormat
                dbSaveCoverage(cov)
                const m = maps.find((x) => x.id === cov.mapId)
                if (m) await writeMapFile(m)
                console.log(`  coverage "${cov.name}" serves ${body.tileFormat}; map.json updated`)
              }
            }
          }
          return json({ ok: true })
        }

        // Runners poll this for pause/cancel
        if (pathname === "/api/internal/run-control" && req.method === "GET") {
          const runId = new URL(req.url).searchParams.get("runId")
          if (!runId) return json({ command: "none" })
          const run = activeRuns.get(runId)
          if (!run) return json({ command: "none" })
          if (run.status === "cancelling") return json({ command: "cancel" })
          if (run.status === "pausing" || run.status === "paused") return json({ command: "pause" })
          if (run.status === "running") return json({ command: "none" })
          return json({ command: "none" })
        }

        // Run completed / paused / errored
        if (pathname === "/api/internal/run-complete" && req.method === "POST") {
          let body: {
            runId: string
            status: string
            error?: string
            done?: number
            skipped?: number
            failed?: number
            bytes?: number
            total?: number
            tilesOnDisk?: number
            sizeBytes?: number
            tileFormat?: TileFormat
          }
          try { body = await req.json() } catch { return json({ error: "invalid JSON" }, 400) }

          const run = activeRuns.get(body.runId)
          if (!run) return json({ ok: true })

          const finalStatus = body.status as CoverageRun["status"]

          // Update final counters if provided
          if (body.done != null) run.done = body.done
          if (body.skipped != null) run.skipped = body.skipped
          if (body.failed != null) run.failed = body.failed
          if (body.bytes != null) run.bytes = body.bytes
          if (body.total != null) run.total = body.total

          run.status = finalStatus
          run.endedAt = new Date().toISOString()
          if (body.error) run.error = body.error
          if (!run.startedAt) run.startedAt = run.endedAt

          if (finalStatus === "paused") {
            // Keep in activeRuns; user must explicitly resume
            broadcastRun(run, true)
            await dbSaveRun(run)
            return json({ ok: true })
          }

          activeRuns.delete(body.runId)
          broadcastRun(run, true)

          // Persist run
          await dbSaveRun(run)
          await dbCapRuns()

          // Clean up stale log entries
          const cutoff = allRuns.length - 50 * coverages.length
          if (cutoff > 0) allRuns.splice(0, cutoff)

          // Update coverage stats
          const coverage = coverages.find((c) => c.id === run.coverageId)
          if (coverage) {
            coverage.totalRuns++
            if (body.tileFormat && coverage.tileFormat !== body.tileFormat) {
              coverage.tileFormat = body.tileFormat
            }
            coverage.lastRunAt = run.endedAt

            if (finalStatus === "done") {
              coverage.lastRunStatus = run.failed > 0 ? "partial" : "success"
              coverage.consecutiveFailures = 0
              if (body.tilesOnDisk != null) coverage.tilesOnDisk = body.tilesOnDisk
              if (body.sizeBytes != null) coverage.sizeBytes = body.sizeBytes
              if (coverage.recurrency !== "none") {
                coverage.nextRunAt = computeNextRunAt(coverage.recurrency)
                scheduleNextRun(coverage)
              }
            } else if (finalStatus === "cancelled") {
              // Deliberate stop. Leave the schedule exactly as it was rather
              // than arguing with the person who pressed cancel.
              coverage.lastRunStatus = "cancelled"
            } else {
              coverage.lastRunStatus = "failed"
              coverage.totalFailedRuns++
              if (coverage.recurrency !== "none") {
                const n = (coverage.consecutiveFailures ?? 0) + 1
                coverage.consecutiveFailures = n
                // After RETRY_MAX consecutive failures the fault is not
                // transient, so fall back to the configured interval instead
                // of retrying against a source or a disk that is not coming
                // back. The coverage stays scheduled either way.
                coverage.nextRunAt =
                  n <= RETRY_MAX ? computeRetryAt(n) : computeNextRunAt(coverage.recurrency)
                scheduleNextRun(coverage)
              }
            }

            await dbSaveCoverage(coverage)
            broadcast({ type: "coverage", payload: { ...coverage } })
          }

          // Auto-trigger validate after successful download run
          if (finalStatus === "done" && run.mode !== "validate") {
            const validateId = generateId()
            const coverage = coverages.find((c) => c.id === run.coverageId)
            if (coverage && !startingCoverageIds.has(run.coverageId)) {
              const validateRun: CoverageRun = {
                id: validateId,
                coverageId: run.coverageId,
                status: "queued",
                mode: "validate",
                startedAt: null,
                endedAt: null,
                done: 0,
                skipped: 0,
                failed: 0,
                bytes: 0,
                total: 0,
              }
              activeRuns.set(validateId, validateRun)
              allRuns.push(validateRun)
              broadcast({ type: "run", payload: { ...validateRun } })
              spawnCoverageRun(coverage, validateId, "validate")
                .catch((e) => {
                  activeRuns.delete(validateId)
                  const idx = allRuns.findIndex((r) => r.id === validateId)
                  if (idx >= 0) allRuns.splice(idx, 1)
                  console.error(`Auto-validate spawn failed for ${run.coverageId}:`, e)
                })
            }
          }

          return json({ ok: true })
        }

        // Tile download proxy: rate-limited per hostname, returns raw bytes
        if (pathname === "/api/internal/fetch-tile" && req.method === "POST") {
          let body: { tileUrl: string; ifModifiedSince?: string; maxCallsPerMinute?: number; transport?: TileTransport }
          try { body = await req.json() } catch { return json({ error: "invalid JSON" }, 400) }

          const { tileUrl, ifModifiedSince, maxCallsPerMinute = 120 } = body
          const transport: TileTransport = body.transport === "tor" ? "tor" : "clearnet"
          let parsedUrl: URL
          try { parsedUrl = new URL(tileUrl) } catch { return json({ error: "invalid URL" }, 400) }
          if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return json({ error: "only http/https URLs allowed" }, 400)
          }

          // Only fetch hosts a coverage is actually configured to use. Without
          // this the proxy will fetch any URL it is handed, which turns it into
          // a probe for whatever the server can reach.
          const service = hostServiceMap().get(parsedUrl.hostname)
          if (!service) {
            return json({ error: `host not configured for any coverage: ${parsedUrl.hostname}` }, 403)
          }

          // Being configured is not enough, because the configuration is user-written.
          const blocked = await blockedDestination(parsedUrl.hostname)
          if (blocked) return json({ error: blocked }, 403)

          // One bucket per upstream service, shared by all of its subdomains.
          const limiter = getServiceLimiter(service, maxCallsPerMinute)
          await limiter.wait()

          const headers: Record<string, string> = {
            "User-Agent": transport === "tor" ? TOR_UA : CLEARNET_UA,
          }
          if (ifModifiedSince) headers["If-Modified-Since"] = ifModifiedSince

          try {
            // Fail closed. If the proxy is down this throws and the run records
            // failures. It must never quietly retry over clearnet, because that
            // is exactly the moment the leak would go unnoticed.
            const res = await fetch(tileUrl, {
              headers,
              ...(transport === "tor" ? { proxy: torProxyUrl } : {}),
              signal: AbortSignal.timeout(transport === "tor" ? 60_000 : 30_000),
            })
            if (res.status === 304) {
              return new Response(null, { status: 204 }) // 304 → 204 No Content (not modified)
            }
            if (!res.ok) {
              return json({ error: `tile server ${res.status}` }, 502)
            }
            const buf = await res.arrayBuffer()
            return new Response(buf, { headers: { "Content-Type": "application/octet-stream" } })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (transport === "tor") {
              torReachable = false
              return json({ error: `tor transport failed (proxy ${torProxyUrl}): ${msg}` }, 502)
            }
            return json({ error: msg }, 502)
          }
        }

        return json({ error: "not found" }, 404)
      }

      // ── Auth endpoints (exempt from auth gate) ────────────────────────────

      if (pathname === "/api/auth/status" && req.method === "GET") {
        return json({ setup: authData === null })
      }

      if (pathname === "/api/auth/setup" && req.method === "POST") {
        if (authData !== null || setupCode === null) return json({ error: "already set up" }, 403)
        const ip = server.requestIP(req)?.address ?? "unknown"

        // Same throttle as login. The code is short enough to type, which makes
        // it short enough to guess without one.
        const waitMs = loginRetryAfterMs(ip)
        if (waitMs > 0) {
          return new Response(
            JSON.stringify({ error: "too many attempts", retryAfterSeconds: Math.ceil(waitMs / 1000) }),
            { status: 429, headers: { ...CORS, "Content-Type": "application/json", "Retry-After": String(Math.ceil(waitMs / 1000)) } },
          )
        }

        const { username, password, setupCode: offered } = await req.json().catch(() => ({}))
        if (!username || !password) return json({ error: "username and password required" }, 400)
        if (!safeEqual(String(offered ?? ""), setupCode)) {
          noteLoginFailure(ip)
          return json({ error: "invalid setup code. It is printed in the server's log on startup" }, 401)
        }
        if (String(password).length < MIN_PASSWORD_LENGTH) {
          return json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400)
        }
        clearLoginFailures(ip)
        const passwordHash = await Bun.password.hash(password)
        authData = { username, passwordHash }
        writeAuthFile()
        // Single use. Nothing should be able to replay it.
        setupCode = null
        console.log("  admin account created, setup code retired")
        return json({ token: createSession() })
      }

      if (pathname === "/api/auth/login" && req.method === "POST") {
        if (!authData) return json({ error: "not set up" }, 403)
        const ip = server.requestIP(req)?.address ?? "unknown"

        const waitMs = loginRetryAfterMs(ip)
        if (waitMs > 0) {
          return new Response(
            JSON.stringify({ error: "too many attempts", retryAfterSeconds: Math.ceil(waitMs / 1000) }),
            { status: 429, headers: { ...CORS, "Content-Type": "application/json", "Retry-After": String(Math.ceil(waitMs / 1000)) } },
          )
        }

        const { username, password } = await req.json().catch(() => ({}))
        // Always run the hash verify, even when the username is wrong, so a bad
        // username and a bad password cost the same and cannot be told apart.
        const userOk = safeEqual(String(username ?? ""), authData.username)
        const passOk = await Bun.password.verify(String(password ?? ""), authData.passwordHash).catch(() => false)
        if (!userOk || !passOk) {
          noteLoginFailure(ip)
          return json({ error: "invalid credentials" }, 401)
        }
        clearLoginFailures(ip)
        return json({ token: createSession() })
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        sessions.delete(getToken(req) ?? "")
        return json({ ok: true })
      }

      // Auth gate. Before setup there is no password to check against, so the
      // rest of the API stays shut rather than open, since otherwise a server that
      // has not been claimed yet answers every call to anyone who reaches it.
      if (pathname.startsWith("/api/")) {
        if (authData === null) return json({ error: "not set up" }, 403)
        if (!isValidToken(getToken(req))) {
          return json({ error: "unauthorized" }, 401)
        }
      }

      if (pathname === "/api/auth/check" && req.method === "GET") {
        return json({ ok: true })
      }

      // ── SSE stream ────────────────────────────────────────────────────────

      if (pathname === "/api/events" && req.method === "GET") {
        let clientCtrl: ReadableStreamDefaultController<Uint8Array>
        let pingTimer: ReturnType<typeof setInterval>
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            clientCtrl = c
            sseClients.add(c)
            const state = await getServerState()
            c.enqueue(
              enc.encode(`data: ${JSON.stringify({ type: "state", payload: state })}\n\n`),
            )
            pingTimer = setInterval(() => {
              try { c.enqueue(enc.encode(": ping\n\n")) } catch { clearInterval(pingTimer) }
            }, 10_000)
          },
          cancel() {
            clearInterval(pingTimer)
            sseClients.delete(clientCtrl)
          },
        })
        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        })
      }


      // ── GET /api/runs ─────────────────────────────────────────────────────

      if (pathname === "/api/runs" && req.method === "GET") {
        const coverageId = new URL(req.url).searchParams.get("coverageId")
        if (!coverageId) return json({ error: "missing coverageId" }, 400)
        const runs = allRuns
          .filter((r) => r.coverageId === coverageId)
          .map((r) => activeRuns.get(r.id) ?? r)
          .sort((a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime())
          .slice(0, 50)
        return json(runs)
      }

      // ── GET /api/runs/:runId/logs ──────────────────────────────────────────

      const logsMatch = /^\/api\/runs\/([^/]+)\/logs$/.exec(pathname)
      if (logsMatch && req.method === "GET") {
        const runId = logsMatch[1]
        const lines: string[] = []

        const logPath = join(LOGS_DIR, `${runId}.log`)
        if (existsSync(logPath)) {
          lines.push(...readFileSync(logPath, "utf8").split("\n").filter(Boolean))
        }

        return json(lines)
      }

      // ── POST /api/* ───────────────────────────────────────────────────────

      if (pathname.startsWith("/api/") && req.method === "POST") {
        let body: Record<string, unknown>
        try { body = await req.json() } catch { return json({ error: "invalid JSON" }, 400) }

        switch (pathname) {
          // ── Estimate ───────────────────────────────────────────────────
          case "/api/estimate": {
            const { regions: estRegions, zoomMin: estMin, zoomMax: estMax } = body as {
              regions?: { bbox: { north: number; south: number; west: number; east: number }; marginKm?: number }[]
              zoomMin?: number
              zoomMax?: number
            }
            if (!estRegions || estMin == null || estMax == null) {
              return json({ error: "missing fields" }, 400)
            }
            let tiles = 0
            for (const r of estRegions) {
              tiles += estimateLandTiles(r.bbox, r.marginKm ?? 0, estMin, estMax)
            }
            return json({ tiles, exact: maskReady() })
          }

          // ── Log settings ───────────────────────────────────────────────
          case "/api/settings/logs": {
            const { retentionValue, retentionUnit, cleanerPaused } = body as Partial<LogSettings>
            const validUnits: RetentionUnit[] = ["hours", "days", "weeks", "months", "years"]
            if (retentionValue != null) {
              if (!Number.isInteger(retentionValue) || retentionValue < 1)
                return json({ error: "retentionValue must be a positive integer" }, 400)
              logSettings.retentionValue = retentionValue
            }
            if (retentionUnit != null) {
              if (!validUnits.includes(retentionUnit))
                return json({ error: "invalid retentionUnit" }, 400)
              logSettings.retentionUnit = retentionUnit
            }
            if (cleanerPaused != null) logSettings.cleanerPaused = cleanerPaused
            saveLogSettings()
            broadcast({ type: "state", payload: await getServerState() })
            return json({ ok: true })
          }

          // ── Config ─────────────────────────────────────────────────────
          case "/api/config/update": {
            const { outputDir: newDir, onionUrl: newOnionUrl } = body as { outputDir?: string; onionUrl?: string }
            if (!newDir?.trim() && newOnionUrl === undefined) return json({ error: "nothing to update" }, 400)
            if (newDir?.trim()) {
              const problem = await validateOutputDir(newDir.trim())
              if (problem) return json({ error: problem }, 400)
            }
            try {
              const existing = existsSync(CONFIG_PATH)
                ? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
                : {}
              if (newDir?.trim()) { outputDir = newDir.trim(); existing.outputDir = outputDir }
              if (newOnionUrl !== undefined) { onionUrl = newOnionUrl.trim(); existing.onionUrl = onionUrl }
              writeConfigFile(existing)
            } catch {
              return json({ error: "failed to write config.json" }, 500)
            }
            await writeDiscoFile()
            if (newOnionUrl !== undefined) for (const map of maps) await writeMapFile(map)
            broadcast({ type: "state", payload: await getServerState() })
            return json({ ok: true })
          }

          // ── Purge all tiles ────────────────────────────────────────────
          case "/api/disk/purge": {
            if (activeRuns.size > 0) return json({ error: "cannot purge while runs are active" }, 409)
            if (!outputDir) return json({ error: "output directory not configured" }, 400)

            for (const cov of coverages) {
              cov.tilesOnDisk = 0
              cov.sizeBytes = 0
              cov.tilesFailed = 0
            }
            await Promise.all(coverages.map((c) => dbSaveCoverage(c)))
            await writeDiscoFile()
            broadcast({ type: "state", payload: await getServerState() })

            // Delete tile folders, not "every directory under outputDir". Those
            // were the same thing only as long as outputDir pointed where the
            // operator meant; one wrong path in settings turned this into an
            // rm -rf of unrelated data. A known map id or the id shape is the
            // whole permission; anything else is reported back, never removed,
            // so a folder left behind is visible rather than silently skipped.
            let foldersToDelete: string[] = []
            let skipped: string[] = []
            try {
              const knownIds = new Set(maps.map((m) => m.id))
              const dirs = (await readdir(outputDir, { withFileTypes: true }))
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
              for (const name of dirs) {
                if (knownIds.has(name) || looksLikeMapFolder(name)) foldersToDelete.push(name)
                else skipped.push(name)
              }
            } catch { /* ignore */ }

            if (skipped.length > 0) {
              console.warn(`  purge left ${skipped.length} non-tile folder(s) alone: ${skipped.join(", ")}`)
            }

            if (foldersToDelete.length > 0) {
              ;(async () => {
                try {
                  for (const name of foldersToDelete) {
                    await rm(join(outputDir, name), { recursive: true, force: true })
                  }
                } catch { /* ignore */ }
              })()
            }

            return json({ ok: true, foldersToDelete: foldersToDelete.length, skipped })
          }

          // ── Orphan scan ────────────────────────────────────────────────
          case "/api/disk/scan": {
            let orphanBytes = 0
            const orphanFolders: string[] = []
            if (outputDir) {
              const scanOrphans = async () => {
                for (const entry of await readdir(outputDir, { withFileTypes: true })) {
                  if (!entry.isDirectory()) continue
                  if (maps.find((m) => m.id === entry.name)) continue
                  orphanFolders.push(entry.name)
                  orphanBytes += await dirSizeBytes(join(outputDir, entry.name))
                }
              }
              await Promise.race([
                scanOrphans().catch(() => {}),
                new Promise<void>((r) => setTimeout(r, 10_000)),
              ])
            }
            return json({ orphanBytes, orphanFolders })
          }

          // ── Maps ───────────────────────────────────────────────────────
          case "/api/maps/create": {
            const { name, description = "", discoverable = false } = body as { name?: string; description?: string; discoverable?: boolean }
            if (!name?.trim()) return json({ error: "missing name" }, 400)

            const map: TileMap = {
              id: generateMapId(),
              name: name.trim(),
              description: (description as string).trim(),
              createdAt: new Date().toISOString(),
              discoverable: discoverable === true,
            }
            maps.push(map)
            await dbSaveMap(map)
            await writeDiscoFile()
            await writeMapFile(map)
            broadcast({ type: "state", payload: await getServerState() })
            return json({ ok: true, map })
          }

          case "/api/maps/update": {
            const { id, discoverable } = body as { id?: string; discoverable?: boolean }
            if (!id) return json({ error: "missing id" }, 400)
            const map = maps.find((m) => m.id === id)
            if (!map) return json({ error: "not found" }, 404)
            if (typeof discoverable === "boolean") map.discoverable = discoverable
            await dbSaveMap(map)
            await writeDiscoFile()
            await writeMapFile(map)
            broadcast({ type: "state", payload: await getServerState() })
            return json({ ok: true })
          }

          case "/api/maps/delete": {
            const { id } = body as { id?: string }
            if (!id) return json({ error: "missing id" }, 400)

            const mapCoverageIds = coverages.filter((c) => c.mapId === id).map((c) => c.id)
            for (const run of activeRuns.values()) {
              if (mapCoverageIds.includes(run.coverageId)) {
                return json({ error: "map has an active run" }, 409)
              }
            }

            const mapIdx = maps.findIndex((m) => m.id === id)
            if (mapIdx === -1) return json({ error: "not found" }, 404)
            maps.splice(mapIdx, 1)
            await writeDiscoFile()

            // Cancel scheduled runs for all coverages in this map
            for (const covId of mapCoverageIds) {
              cancelScheduledRun(covId)
            }

            // Cascade-delete in memory
            const deletedCoverageIds = new Set(mapCoverageIds)
            for (let i = coverages.length - 1; i >= 0; i--) {
              if (coverages[i].mapId === id) coverages.splice(i, 1)
            }
            const deletedRunIds = allRuns.filter((r) => deletedCoverageIds.has(r.coverageId)).map((r) => r.id)
            for (let i = allRuns.length - 1; i >= 0; i--) {
              if (deletedCoverageIds.has(allRuns[i].coverageId)) allRuns.splice(i, 1)
            }
            for (const runId of deletedRunIds) {
              rm(join(LOGS_DIR, `${runId}.log`), { force: true }).catch(() => {})
            }

            // DB cascade handles coverages + runs via FK ON DELETE CASCADE
            await dbDeleteMap(id)

            // Delete tile files
            if (outputDir) {
              const mapDir = join(outputDir, id)
              await rm(mapDir, { recursive: true, force: true }).catch(() => {})
            }

            broadcast({ type: "state", payload: await getServerState() })
            return json({ ok: true })
          }

          // ── Coverages ──────────────────────────────────────────────────
          case "/api/coverages/create": {
            const {
              mapId,
              name,
              type = "custom",
              regions,
              zoomMin,
              zoomMax,
              tileSource,
              tileSubdomains,
              recurrency = "normal",
              workers = 4,
              maxCallsPerMinute = 60,
              transport = "default",
              logRetention,
              logRetentionValue,
              logRetentionUnit,
            } = body as Partial<Coverage>

            if (!mapId || !name || !regions || zoomMin == null || zoomMax == null || !tileSource) {
              return json({ error: "missing required fields" }, 400)
            }
            if (!maps.find((m) => m.id === mapId)) {
              return json({ error: "map not found" }, 404)
            }

            const shapeError = validateCoverageShape({ regions, zoomMin, zoomMax, workers, maxCallsPerMinute })
            if (shapeError) return json({ error: shapeError }, 400)
            const sourceError = await blockedTileSource(tileSource as string, tileSubdomains as string[])
            if (sourceError) return json({ error: sourceError }, 400)

            // Learn the source's format now rather than discovering it after a
            // run has thrown thousands of tiles away, and refuse a coverage that
            // would leave its map advertising an extension half its tiles do not
            // use. A probe that cannot reach the source is not fatal, since the
            // format is detected at run time as before.
            const probeTransport: TileTransport =
              (transport as CoverageTransport) === "default" || !transport
                ? tileTransport
                : (transport as TileTransport)
            const probe = await probeTileFormat(
              tileSource as string,
              (tileSubdomains as string[]) ?? ["a", "b", "c"],
              (regions as Coverage["regions"])[0]?.bbox ?? { north: 1, south: 0, west: 0, east: 1 },
              zoomMin as number,
              probeTransport,
              (maxCallsPerMinute as number) ?? 60,
            )
            let probedFormat: TileFormat | undefined
            if ("format" in probe) {
              const clash = conflictingFormat(mapId as string, null, probe.format)
              if (clash) {
                return json({
                  error: `This map already serves ${clash} tiles and this source serves ${probe.format}. ` +
                    `A map can only advertise one tile format, so mixing them would make half the tiles unreachable. ` +
                    `Use a source that serves ${clash}, or put this coverage in its own map.`,
                }, 409)
              }
              probedFormat = probe.format
            } else {
              console.warn(`  coverage "${name}": could not probe tile source: ${probe.error}`)
            }

            let totalTilesExpected = 0
            for (const region of regions) {
              totalTilesExpected += estimateLandTiles(
                region.bbox,
                region.marginKm ?? 0,
                zoomMin as number,
                zoomMax as number,
              )
            }

            const coverage: Coverage = {
              id: generateId(),
              mapId: mapId as string,
              name: name as string,
              type: (type as Coverage["type"]) ?? "custom",
              regions: regions as Coverage["regions"],
              zoomMin: zoomMin as number,
              zoomMax: zoomMax as number,
              tileSource: tileSource as string,
              tileSubdomains: (tileSubdomains as string[]) ?? ["a", "b", "c"],
              recurrency: (recurrency as Coverage["recurrency"]) ?? "normal",
              workers: (workers as number) ?? 4,
              maxCallsPerMinute: (maxCallsPerMinute as number) ?? 60,
              transport: transport as CoverageTransport,
              tileFormat: probedFormat,
              createdAt: new Date().toISOString(),
              lastRunAt: null,
              lastRunStatus: null,
              nextRunAt: null,
              totalRuns: 0,
              totalFailedRuns: 0,
              totalTilesExpected,
              tilesOnDisk: 0,
              tilesFailed: 0,
              sizeBytes: 0,
              ...(logRetention === "custom" && logRetentionValue != null && logRetentionUnit
                ? { logRetention: "custom" as const, logRetentionValue, logRetentionUnit }
                : { logRetention: "default" as const }),
            }

            coverages.push(coverage)
            await dbSaveCoverage(coverage)
            await writeDiscoFile()
            const covMap = maps.find((m) => m.id === coverage.mapId)
            if (covMap) await writeMapFile(covMap)
            broadcast({ type: "coverage", payload: coverage })
            return json({ ok: true, coverage })
          }

          case "/api/coverages/update": {
            const {
              id,
              name,
              regions,
              zoomMin,
              zoomMax,
              tileSource,
              tileSubdomains,
              recurrency = "normal",
              workers,
              maxCallsPerMinute,
              transport,
              logRetention,
              logRetentionValue,
              logRetentionUnit,
            } = body as Partial<Coverage> & { id?: string }

            if (!id || !name || !regions || zoomMin == null || zoomMax == null || !tileSource) {
              return json({ error: "missing required fields" }, 400)
            }

            const coverage = coverages.find((c) => c.id === id)
            if (!coverage) return json({ error: "not found" }, 404)

            const updShapeError = validateCoverageShape({ regions, zoomMin, zoomMax, workers, maxCallsPerMinute })
            if (updShapeError) return json({ error: updShapeError }, 400)
            const updSourceError = await blockedTileSource(
              tileSource as string,
              (tileSubdomains as string[]) ?? coverage.tileSubdomains,
            )
            if (updSourceError) return json({ error: updSourceError }, 400)

            // Editing a coverage supersedes whatever it was doing. Every
            // non-terminal state has to go, not just running/paused, because a run left
            // in activeRuns blocks the coverage from ever starting again.
            for (const runId of [...activeRuns.keys()]) {
              const run = activeRuns.get(runId)
              if (run?.coverageId === id) cancelRun(runId, "Superseded by a coverage edit")
            }

            coverage.name = name as string
            coverage.regions = regions as Coverage["regions"]
            coverage.zoomMin = zoomMin as number
            coverage.zoomMax = zoomMax as number
            const sourceChanged = coverage.tileSource !== (tileSource as string)
            if (sourceChanged) {
              const upTransport: TileTransport =
                (transport as CoverageTransport | undefined) === "default" || !transport
                  ? tileTransport
                  : (transport as TileTransport)
              const probe = await probeTileFormat(
                tileSource as string,
                (tileSubdomains as string[]) ?? coverage.tileSubdomains,
                (regions as Coverage["regions"])[0]?.bbox ?? coverage.regions[0]?.bbox,
                (zoomMin as number) ?? coverage.zoomMin,
                upTransport,
                (maxCallsPerMinute as number) ?? coverage.maxCallsPerMinute ?? 60,
              )
              if ("format" in probe) {
                const clash = conflictingFormat(coverage.mapId, coverage.id, probe.format)
                if (clash) {
                  return json({
                    error: `This map already serves ${clash} tiles and the new source serves ${probe.format}. ` +
                      `A map can only advertise one tile format. Use a ${clash} source, or move this coverage to its own map.`,
                  }, 409)
                }
                coverage.tileFormat = probe.format
              } else {
                // Source changed but we could not check it, so drop the old format
                // so it is re-detected rather than advertising a stale extension.
                coverage.tileFormat = undefined
                console.warn(`  coverage "${coverage.name}": could not probe new tile source: ${probe.error}`)
              }
            }
            coverage.tileSource = tileSource as string
            coverage.tileSubdomains = (tileSubdomains as string[]) ?? ["a", "b", "c"]
            coverage.recurrency = (recurrency as Coverage["recurrency"]) ?? "normal"
            if (workers != null) coverage.workers = workers as number
            if (maxCallsPerMinute != null) coverage.maxCallsPerMinute = maxCallsPerMinute as number
            if (transport != null) coverage.transport = transport as CoverageTransport
            coverage.logRetention = logRetention === "custom" ? "custom" : "default"
            coverage.logRetentionValue = logRetention === "custom" ? logRetentionValue : undefined
            coverage.logRetentionUnit = logRetention === "custom" ? logRetentionUnit : undefined

            coverage.totalTilesExpected = 0
            for (const region of coverage.regions) {
              coverage.totalTilesExpected += estimateLandTiles(
                region.bbox,
                region.marginKm ?? 0,
                zoomMin as number,
                zoomMax as number,
              )
            }

            await dbSaveCoverage(coverage)
            await writeDiscoFile()
            const updMap = maps.find((m) => m.id === coverage.mapId)
            if (updMap) await writeMapFile(updMap)

            // Re-arm the schedule against the (possibly changed) recurrency
            if (coverage.recurrency === "none" || !coverage.nextRunAt) {
              cancelScheduledRun(coverage.id)
            } else {
              cancelScheduledRun(coverage.id)
              scheduleNextRun(coverage)
            }

            broadcast({ type: "coverage", payload: { ...coverage } })
            return json({ ok: true, coverage })
          }

          case "/api/coverages/delete": {
            const { id } = body as { id?: string }
            if (!id) return json({ error: "missing id" }, 400)

            for (const run of activeRuns.values()) {
              if (run.coverageId === id) {
                return json({ error: "coverage has an active run" }, 409)
              }
            }

            const idx = coverages.findIndex((c) => c.id === id)
            if (idx === -1) return json({ error: "not found" }, 404)

            const [deleted] = coverages.splice(idx, 1)
            await writeDiscoFile()
            const delMap = maps.find((m) => m.id === deleted.mapId)
            if (delMap) await writeMapFile(delMap)

            cancelScheduledRun(deleted.id)

            // Clean up run logs before DB cascade deletes the runs
            const deletedRunIds = allRuns.filter((r) => r.coverageId === id).map((r) => r.id)
            for (let i = allRuns.length - 1; i >= 0; i--) {
              if (allRuns[i].coverageId === id) allRuns.splice(i, 1)
            }
            for (const runId of deletedRunIds) {
              rm(join(LOGS_DIR, `${runId}.log`), { force: true }).catch(() => {})
            }

            // DB cascade handles runs via FK ON DELETE CASCADE
            await dbDeleteCoverage(id)

            const otherMapCoverages = coverages.filter((c) => c.mapId === deleted.mapId)
            startCleanup(deleted, otherMapCoverages)

            broadcast({ type: "state", payload: await getServerState() })
            return json({ ok: true })
          }

          // ── Runs ───────────────────────────────────────────────────────
          case "/api/runs/start": {
            const { coverageId, mode } = body as { coverageId?: string; mode?: RunMode }
            if (!coverageId) return json({ error: "missing coverageId" }, 400)
            const coverage = coverages.find((c) => c.id === coverageId)
            if (!coverage) return json({ error: "coverage not found" }, 404)

            for (const r of activeRuns.values()) {
              if (r.coverageId === coverageId) return json({ error: "A run is already active for this coverage" }, 409)
            }
            if (startingCoverageIds.has(coverageId)) return json({ error: "A run is already starting for this coverage" }, 409)
            startingCoverageIds.add(coverageId)

            const validModes: RunMode[] = ["resume", "update", "reset", "validate"]
            const runMode = validModes.includes(mode!) ? mode! : "resume"
            const runId = generateId()

            const queuedRun: CoverageRun = {
              id: runId,
              coverageId,
              status: "queued",
              mode: runMode,
              startedAt: null,
              endedAt: null,
              done: 0,
              skipped: 0,
              failed: 0,
              bytes: 0,
              total: 0,
            }

            try {
              const run = await startCoverageRun(coverage, runId, runMode)
              broadcast({ type: "run", payload: { ...run } })
              addLog(runId, `Started: mode=${runMode}, coverage=${coverage.name}`)
            } catch (e) {
              broadcast({ type: "state", payload: await getServerState() })
              console.error("Failed to spawn coverage run:", e)
              startingCoverageIds.delete(coverageId)
              return json({ error: "Failed to start run" }, 503)
            } finally {
              startingCoverageIds.delete(coverageId)
            }

            return json({ ok: true })
          }

          case "/api/runs/pause": {
            const { runId } = body as { runId?: string }
            if (!runId) return json({ error: "missing runId" }, 400)
            const run = activeRuns.get(runId)
            if (!run) return json({ error: "run not found" }, 404)
            if (run.status !== "running") return json({ error: "run is not running" }, 409)
            run.status = "pausing"
            broadcastRun(run, true)
            await dbSaveRun(run)
            return json({ ok: true })
          }

          case "/api/runs/resume": {
            const { runId } = body as { runId?: string }
            if (!runId) return json({ error: "missing runId" }, 400)
            const run = activeRuns.get(runId)
            if (!run) return json({ error: "run not found" }, 404)
            if (run.status !== "paused") return json({ error: "run is not paused" }, 409)
            const coverage = coverages.find((c) => c.id === run.coverageId)
            if (!coverage) return json({ error: "coverage not found" }, 404)

            // The paused runner has already exited. Counters restart from zero and
            // resume mode skips whatever is already on disk.
            run.status = "queued"
            run.mode = "resume"
            run.done = 0; run.skipped = 0; run.failed = 0; run.bytes = 0
            run.endedAt = null
            dbSaveRun(run)
            broadcastRun(run, true)

            if (slotsInUse() < maxConcurrentRuns) {
              try {
                await spawnCoverageRun(coverage, runId, "resume")
              } catch (e) {
                run.status = "error"
                run.error = `Could not resume: ${e instanceof Error ? e.message : String(e)}`
                run.endedAt = new Date().toISOString()
                activeRuns.delete(runId)
                dbSaveRun(run)
                broadcastRun(run, true)
                return json({ error: "Could not resume run" }, 503)
              }
            } else {
              runQueue.push(runId)
              broadcastQueue()
            }
            return json({ ok: true })
          }

          case "/api/runs/cancel": {
            const { runId } = body as { runId?: string }
            if (!runId) return json({ error: "missing runId" }, 400)
            const run = activeRuns.get(runId)
            if (!run) return json({ error: "run not found" }, 404)

            cancelRun(runId)
            return json({ ok: true })
          }

          case "/api/auth/change": {
            if (!authData) return json({ error: "not set up" }, 400)
            const { currentPassword, newUsername, newPassword } = body as {
              currentPassword?: string
              newUsername?: string
              newPassword?: string
            }
            if (!currentPassword) return json({ error: "current password required" }, 400)
            if (!(await Bun.password.verify(currentPassword, authData.passwordHash)))
              return json({ error: "current password is incorrect" }, 400)
            if (newPassword && String(newPassword).length < MIN_PASSWORD_LENGTH)
              return json({ error: `new password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400)
            if (newUsername?.trim()) authData.username = newUsername.trim()
            if (newPassword) authData.passwordHash = await Bun.password.hash(newPassword)
            writeAuthFile()
            sessions.clear()
            return json({ ok: true })
          }

          default:
            return json({ error: "not found" }, 404)
        }
      }

      // Static file serving (production build)
      if (SERVE_STATIC) {
        const filePath = join(DIST_DIR, pathname === "/" ? "index.html" : pathname)
        const file = Bun.file(filePath)
        if (await file.exists()) return new Response(file, { headers: SECURITY_HEADERS })
        return new Response(Bun.file(join(DIST_DIR, "index.html")), { headers: SECURITY_HEADERS })
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  console.log(`Maps running on http://localhost:${PORT}`)
  if (SERVE_STATIC) console.log("Serving dashboard from dist/")
  if (setupCode) {
    console.log("")
    console.log("  ┌──────────────────────────────────────────────┐")
    console.log("  │  This server has no admin account yet.       │")
    console.log("  │  Enter this code in the dashboard to claim   │")
    console.log("  │  it. It changes on every restart.            │")
    console.log("  │                                              │")
    console.log(`  │      setup code:  ${setupCode}                  │`)
    console.log("  └──────────────────────────────────────────────┘")
    console.log("")
  }
  if (!outputDir) console.log("No config.json or outputDir missing. Copy config.example.json")
})()
