import { expect, test, describe, beforeAll, afterAll } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Boots a real server against a disposable STATE_DIR. These cover the auth gate,
// which is the one place where a wrong boolean exposes every route at once.

const PORT = 34117
const BASE = `http://localhost:${PORT}`

let stateDir: string
let proc: ReturnType<typeof Bun.spawn>
// Everything the server printed. The setup code is only ever emitted here, so
// reading it back out is the same move the operator makes.
let serverOutput = ""

// The banner is printed right after the listener opens, so the server can answer
// a request before the pipe has been drained. Poll rather than read once.
async function readSetupCode(timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /setup code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(serverOutput)
    if (match) return match[1]
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no setup code in server output:\n${serverOutput}`)
}

// Generous, because a clean checkout has no land-mask.bin: the first boot
// fetches Natural Earth and rasterises it, and the rasterising is synchronous,
// so the listener does not answer until it finishes. On a warm checkout this
// returns in well under a second.
async function waitForServer(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/auth/status`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("server did not start in time")
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "maps-test-"))
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({
      outputDir: join(stateDir, "tiles"),
      internalSecret: "test-secret",
      // One slot, so the queueing path is exercised by starting two runs.
      maxConcurrentRuns: 1,
    }),
  )

  // Deliberately world-readable, so the mode assertion later has something to
  // prove. Left at the umask it would pass on a machine that happens to mask
  // group and other off anyway, which is a check that cannot fail.
  chmodSync(join(stateDir, "config.json"), 0o644)

  mkdirSync(join(stateDir, "tiles"), { recursive: true })

  // Drain both streams. Leaving them piped and unread lets the buffer fill and
  // block the server mid-test, which looks exactly like a crash.
  proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, STATE_DIR: stateDir, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const drain = async (s: unknown, name: string) => {
    if (!s || typeof s === "number") return
    for await (const chunk of s as AsyncIterable<Uint8Array>) {
      const text = new TextDecoder().decode(chunk)
      serverOutput += text
      if (process.env.SERVER_LOG) process.stderr.write(`[server ${name}] ${text}`)
    }
  }
  drain(proc.stdout, "out"); drain(proc.stderr, "err")
  await waitForServer()
  // The explicit timeout is load-bearing, not decoration: bun kills a hook at
  // 5s by default, so waitForServer's patience above is unreachable without it.
  // A warm checkout gets here in under a second and a cold one on a slow shared
  // runner takes tens of seconds, and only the second case needs this.
}, 200_000)

afterAll(() => {
  try { proc.kill() } catch { /* already gone */ }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

// The throttle counts per address and the whole suite shares one, so a block
// armed by the throttle tests lands on whichever describe logs in next. Wait it
// out rather than letting a 429 masquerade as a broken assertion.
async function login(username = "admin", password = "correct-horse-battery"): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 1)
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000))
      continue
    }
    const body = await res.json()
    if (body.token) return body.token as string
    throw new Error(`login failed: ${res.status} ${JSON.stringify(body)}`)
  }
  throw new Error("login never got past the throttle")
}

// Routes that must never answer an unauthenticated caller, chosen because each
// one does something destructive or leaks state.
const PROTECTED_POSTS = ["maps/create", "maps/delete", "coverages/create", "disk/purge", "config/update", "runs/start"]
const PROTECTED_GETS = ["runs", "events"]

describe("before an admin account exists", () => {
  test("auth/status is reachable, and says setup is needed", async () => {
    const res = await fetch(`${BASE}/api/auth/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ setup: true })
  })

  test("every other route is closed", async () => {
    for (const path of PROTECTED_GETS) {
      const res = await fetch(`${BASE}/api/${path}`, { signal: AbortSignal.timeout(3000) })
      expect(res.status, `GET /api/${path}`).toBe(403)
    }
    for (const path of PROTECTED_POSTS) {
      const res = await fetch(`${BASE}/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      expect(res.status, `POST /api/${path}`).toBe(403)
    }
  })

  test("CORS names one origin rather than a wildcard", async () => {
    const res = await fetch(`${BASE}/api/auth/status`)
    const allowed = res.headers.get("access-control-allow-origin")
    expect(allowed).not.toBe("*")
    expect(allowed).toBe("http://localhost:5173")
  })
})

// The window between "listening" and "claimed" is the one moment the API has no
// password to check against. These cover what stands in for one.
describe("claiming an unclaimed server", () => {
  test("setup without the code is refused", async () => {
    const res = await fetch(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "correct-horse-battery" }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toContain("setup code")
  })

  test("setup with a wrong code is refused", async () => {
    const res = await fetch(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "correct-horse-battery", setupCode: "AAAA-AAAA" }),
    })
    expect([401, 429]).toContain(res.status)
  })

  test("the account is still unclaimed after those attempts", async () => {
    expect(await (await fetch(`${BASE}/api/auth/status`)).json()).toEqual({ setup: true })
  })

  test("a password under the minimum is refused even with a valid code", async () => {
    const res = await fetch(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "short", setupCode: await readSetupCode() }),
    })
    // The two failed attempts above may have armed the throttle; either answer
    // proves the weak password did not create an account.
    expect([400, 429]).toContain(res.status)
    expect(await (await fetch(`${BASE}/api/auth/status`)).json()).toEqual({ setup: true })
  })
})

describe("after setup", () => {
  let token: string

  test("setup issues a session token", async () => {
    // Two wrong codes above, against five free attempts, so the throttle has not
    // armed yet and this still gets a straight answer.
    const res = await fetch(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "correct-horse-battery",
        setupCode: await readSetupCode(),
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.token).toBe("string")
    token = body.token
  })

  test("setup cannot be replayed to steal the account", async () => {
    const res = await fetch(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "hunter2" }),
    })
    expect(res.status).toBe(403)
  })

  test("protected routes reject an absent or bogus token", async () => {
    const cases: Record<string, string>[] = [{}, { Authorization: "Bearer not-a-real-token" }]
    for (const headers of cases) {
      const res = await fetch(`${BASE}/api/runs?coverageId=x`, { headers })
      expect(res.status).toBe(401)
    }
  })

  test("a valid token gets through", async () => {
    const res = await fetch(`${BASE}/api/runs?coverageId=nonexistent`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("login rejects a wrong password and accepts the right one", async () => {
    const bad = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    })
    expect(bad.status).toBe(401)

    const good = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
    })
    expect(good.status).toBe(200)
    expect(typeof (await good.json()).token).toBe("string")
  })

  test("logout invalidates the token it was called with", async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
    })
    const throwaway = (await login.json()).token as string

    await fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${throwaway}` },
    })

    const after = await fetch(`${BASE}/api/runs?coverageId=x`, {
      headers: { Authorization: `Bearer ${throwaway}` },
    })
    expect(after.status).toBe(401)
  })
})

// Purge deletes whole directory trees under a path the operator can retype at
// will, so it has to be the tile folders it owns and nothing else.
describe("purge stays inside its own tile folders", () => {
  let token: string
  const tilesDir = () => join(stateDir, "tiles")

  beforeAll(async () => {
    token = await login()
  })

  test("an unrelated folder survives, and is named in the response", async () => {
    // One of each id shape the app has ever minted: a UUID and a legacy
    // timestamp-random pair, both synthetic, plus something plainly not ours.
    mkdirSync(join(tilesDir(), "550e8400-e29b-41d4-a716-446655440000"), { recursive: true })
    mkdirSync(join(tilesDir(), "legacy01-abc123"), { recursive: true })
    mkdirSync(join(tilesDir(), "important-unrelated-data"), { recursive: true })
    writeFileSync(join(tilesDir(), "important-unrelated-data", "keep.txt"), "irreplaceable")

    const res = await fetch(`${BASE}/api/disk/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.foldersToDelete).toBe(2)
    expect(body.skipped).toEqual(["important-unrelated-data"])

    // Deletion runs detached from the response, so give it a moment.
    await new Promise((r) => setTimeout(r, 500))
    expect(existsSync(join(tilesDir(), "important-unrelated-data", "keep.txt"))).toBe(true)
    expect(existsSync(join(tilesDir(), "550e8400-e29b-41d4-a716-446655440000"))).toBe(false)
    expect(existsSync(join(tilesDir(), "legacy01-abc123"))).toBe(false)
  }, 15_000)

  test("outputDir must be an existing absolute directory", async () => {
    const reject = async (outputDir: string) => {
      const res = await fetch(`${BASE}/api/config/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outputDir }),
      })
      expect(res.status, outputDir).toBe(400)
      return (await res.json()).error as string
    }
    expect(await reject("relative/path")).toContain("absolute")
    expect(await reject("/")).toContain("root")
    expect(await reject(join(stateDir, "does-not-exist"))).toContain("does not exist")
    expect(await reject(join(stateDir, "config.json"))).toContain("not a directory")
  })

  test("a good path is still accepted", async () => {
    const res = await fetch(`${BASE}/api/config/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ outputDir: tilesDir() }),
    })
    expect(res.status).toBe(200)
  })
})

describe("tile transport", () => {
  // The proxy only fetches hosts a coverage is configured to use, so these
  // create one first rather than relying on another block having run.
  const HOST = "tiles.example.test"
  // The rate test throttles its service hard, so it gets its own to avoid
  // starving every later test that shares a bucket.
  const SLOW_HOST = "slow.example.test"

  beforeAll(async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
    })
    const token = (await login.json()).token as string
    const map = await fetch(`${BASE}/api/maps/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "transport map" }),
    })
    const mapId = (await map.json()).map.id
    expect(typeof mapId).toBe("string")
    const cov = await fetch(`${BASE}/api/coverages/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mapId, name: "transport cov",
        regions: [{ name: "t", bbox: { north: 1, south: 0, west: 0, east: 1 }, marginKm: 0 }],
        zoomMin: 0, zoomMax: 0,
        tileSource: `https://{s}.${HOST}/{z}/{x}/{y}.png`,
        tileSubdomains: ["a", "b", "c"], recurrency: "none", workers: 1, maxCallsPerMinute: 60,
      }),
    })
    expect(cov.status).toBe(200)

    const slow = await fetch(`${BASE}/api/coverages/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mapId, name: "slow cov",
        regions: [{ name: "t", bbox: { north: 1, south: 0, west: 0, east: 1 }, marginKm: 0 }],
        zoomMin: 0, zoomMax: 0,
        tileSource: `https://{s}.${SLOW_HOST}/{z}/{x}/{y}.png`,
        tileSubdomains: ["a", "b", "c"], recurrency: "none", workers: 1, maxCallsPerMinute: 60,
      }),
    })
    expect(slow.status).toBe(200)
  })

  async function fetchTile(body: Record<string, unknown>) {
    const res = await fetch(`${BASE}/api/internal/fetch-tile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) as { error?: string } }
  }

  test("refuses a host no coverage is configured to use", async () => {
    const res = await fetchTile({ tileUrl: "https://not-configured.example/0/0/0.png" })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("not configured")
  })

  test("all subdomains of one source share a single rate bucket", async () => {
    // A rate limit belongs to the provider, not to DNS. Keyed on the hostname, a
    // three-subdomain template got three buckets and ran at three times the
    // configured rate.
    //
    // Measured as throughput rather than a single wait, so it does not depend on
    // how many tokens happen to be left: at 60/min the bucket holds 6, so 12
    // calls spread over three subdomains must block if they share one bucket,
    // and would not if each subdomain had its own.
    const t0 = Date.now()
    for (let i = 0; i < 12; i++) {
      const sub = ["a", "b", "c"][i % 3]
      await fetchTile({ tileUrl: `https://${sub}.${SLOW_HOST}/0/0/${i}.png`, maxCallsPerMinute: 60 })
    }
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThan(2000)
  }, 60_000)

  test("allows every subdomain a coverage could produce, not just the first", async () => {
    // Runners pick {s} at random per tile, so an allowlist built from one
    // substitution would reject most requests.
    for (const sub of ["a", "b", "c"]) {
      const res = await fetchTile({ tileUrl: `https://${sub}.${HOST}/0/0/0.png` })
      expect(res.status, `subdomain ${sub}`).not.toBe(403)
    }
  })

  // The point of the tor mode is that a broken tunnel stops the download rather
  // than quietly finishing it over clearnet, which is when a leak goes unnoticed.
  test("a tor fetch fails closed when the proxy is not there", async () => {
    const res = await fetchTile({ tileUrl: `https://a.${HOST}/0/0/0.png`, transport: "tor" })
    expect(res.status).toBe(502)
    expect(res.body.error).toContain("tor transport failed")
  })

  test("the clearnet path reports a different failure, not the tor one", async () => {
    const res = await fetchTile({ tileUrl: `https://a.${HOST}/0/0/0.png`, transport: "clearnet" })
    expect(res.status).toBe(502)
    expect(res.body.error).not.toContain("tor transport failed")
  })
})

describe("run lifecycle", () => {
  let token: string
  let mapId: string
  const coverageIds: string[] = []

  async function api(path: string, body: unknown) {
    const res = await fetch(`${BASE}/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  async function activeRuns(): Promise<Array<{ id: string; coverageId: string; status: string }>> {
    const res = await fetch(`${BASE}/api/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    })
    // The SSE stream opens with a full state frame; one read is enough.
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    reader.cancel()
    const text = new TextDecoder().decode(value)
    const payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
    return payload.payload.activeRuns
  }

  test("set up a map and two coverages", async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
    })
    token = (await login.json()).token

    const map = await api("maps/create", { name: "test map" })
    expect(map.status).toBe(200)
    mapId = map.body.map.id
    expect(typeof mapId).toBe("string")

    for (const name of ["cov-a", "cov-b", "cov-edit"]) {
      const cov = await api("coverages/create", {
        mapId, name,
        regions: [{ name: "tiny", bbox: { north: 38.8, south: 38.7, west: -9.2, east: -9.1 }, marginKm: 0 }],
        zoomMin: 0, zoomMax: 1,
        // Unreachable on purpose; these tests are about the state machine.
        // A .test name rather than a loopback address: the server now refuses a
        // tile source that resolves somewhere non-public, and this fixture only
        // ever wanted a host that never answers.
        tileSource: "https://unreachable.example.test/{z}/{x}/{y}.png",
        tileSubdomains: ["a"], recurrency: "none", workers: 1, maxCallsPerMinute: 60,
      })
      expect(cov.status).toBe(200)
      coverageIds.push(cov.body.coverage.id)
    }
    expect(coverageIds.filter(Boolean).length).toBe(3)
  })

  test("a second run waits for a slot instead of spawning when the cap is 1", async () => {
    const first = await api("runs/start", { coverageId: coverageIds[0] })
    expect(first.status).toBe(200)
    const second = await api("runs/start", { coverageId: coverageIds[1] })
    expect(second.status).toBe(200)

    const runs = await activeRuns()
    const b = runs.find((r) => r.coverageId === coverageIds[1])
    expect(b).toBeDefined()

    // Status alone proves nothing: a run that HAS just spawned also reads
    // "queued" until its runner reports in. The gate is what writes this line,
    // so it is the only thing that distinguishes waiting from started.
    const log = readFileSync(join(stateDir, "logs", `${b!.id}.log`), "utf8")
    expect(log).toContain("Waiting for a free slot")
  })

  test("starting a second run for the same coverage is rejected", async () => {
    const dup = await api("runs/start", { coverageId: coverageIds[1] })
    expect(dup.status).toBe(409)
  })

  test("cancelling a queued run finalises it, since no process will ever exit", async () => {
    const runs = await activeRuns()
    const queued = runs.find((r) => r.coverageId === coverageIds[1] && r.status === "queued")
    expect(queued).toBeDefined()

    const res = await api("runs/cancel", { runId: queued!.id })
    expect(res.status).toBe(200)

    const after = await activeRuns()
    expect(after.find((r) => r.id === queued!.id)).toBeUndefined()
  })

  test("editing a coverage clears its run, so the coverage can start again", async () => {
    // A paused or queued run has no process to kill. If the edit path only
    // signalled and waited, the run would sit in activeRuns forever and every
    // later start would 409 with no way out from the UI.
    const start = await api("runs/start", { coverageId: coverageIds[2] })
    expect(start.status).toBe(200)

    const edit = await api("coverages/update", {
      id: coverageIds[2], name: "cov-edit edited",
      regions: [{ name: "tiny", bbox: { north: 38.8, south: 38.7, west: -9.2, east: -9.1 }, marginKm: 0 }],
      zoomMin: 0, zoomMax: 1,
      tileSource: "https://unreachable.example.test/{z}/{x}/{y}.png",
      tileSubdomains: ["a"], recurrency: "none", workers: 1, maxCallsPerMinute: 60,
    })
    expect(edit.status).toBe(200)

    const after = await activeRuns()
    expect(after.find((r) => r.coverageId === coverageIds[2])).toBeUndefined()

    // and the coverage is startable again rather than permanently 409
    const restart = await api("runs/start", { coverageId: coverageIds[2] })
    expect(restart.status).toBe(200)
    const runs2 = await activeRuns()
    const fresh = runs2.find((r) => r.coverageId === coverageIds[2])
    expect(fresh).toBeDefined()
    await api("runs/cancel", { runId: fresh!.id })
  }, 30_000)
})

describe("mixed tile formats", () => {
  // map.json advertises exactly one extension, so a map whose coverages disagree
  // leaves half its tiles unreachable to the client. Caught at save time rather
  // than after a run has downloaded thousands of tiles nobody can fetch.
  let token: string
  let mapId: string

  async function post(path: string, body: unknown) {
    const res = await fetch(`${BASE}/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) as any }
  }

  function coverage(name: string, tileSource: string) {
    return {
      mapId, name,
      regions: [{ name: "t", bbox: { north: 39, south: 38, west: -10, east: -9 }, marginKm: 0 }],
      zoomMin: 2, zoomMax: 2, tileSource,
      tileSubdomains: ["a"], recurrency: "none", workers: 1, maxCallsPerMinute: 120,
      transport: "clearnet",
    }
  }

  test("set up a map", async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
    })
    token = (await login.json()).token
    const m = await post("maps/create", { name: "format test" })
    mapId = m.body.map.id
    expect(typeof mapId).toBe("string")
  }, 30_000)

  test("a PNG source is probed and its format recorded", async () => {
    const r = await post("coverages/create", coverage("osm", "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"))
    expect(r.status).toBe(200)
    expect(r.body.coverage.tileFormat).toBe("png")
  }, 40_000)

  test("adding a JPEG source to that map is refused, with a reason", async () => {
    const r = await post("coverages/create", coverage("sat", "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"))
    expect(r.status).toBe(409)
    expect(r.body.error).toContain("png")
    expect(r.body.error).toContain("jpg")
  }, 40_000)

  test("the same JPEG source is fine in a map of its own", async () => {
    const m2 = await post("maps/create", { name: "satellite" })
    const r = await post("coverages/create", {
      ...coverage("sat", "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"),
      mapId: m2.body.map.id,
    })
    expect(r.status).toBe(200)
    expect(r.body.coverage.tileFormat).toBe("jpg")
  }, 40_000)
})

describe("login throttle", () => {
  test("repeated wrong passwords eventually get a 429 with Retry-After", async () => {
    let sawThrottle = false
    let retryAfter: string | null = null
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: `wrong-${i}` }),
      })
      if (res.status === 429) {
        sawThrottle = true
        retryAfter = res.headers.get("retry-after")
        break
      }
      expect(res.status).toBe(401)
    }
    expect(sawThrottle).toBe(true)
    expect(Number(retryAfter)).toBeGreaterThan(0)
  }, 30_000)

  test("a wrong username is refused the same way as a wrong password", async () => {
    // Same status and shape either way, so the response cannot be used to work
    // out whether the username exists.
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: "whatever" }),
    })
    expect([401, 429]).toContain(res.status)
    if (res.status === 401) expect((await res.json()).error).toBe("invalid credentials")
  })
})

// The proxy's host allowlist is built from coverage config, and coverage config
// is written by whoever is logged in, so the allowlist alone bounds nothing.
describe("outbound destinations", () => {
  let token: string
  let mapId: string

  beforeAll(async () => {
    token = await login()
    const map = await fetch(`${BASE}/api/maps/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "ssrf map" }),
    })
    mapId = (await map.json()).map.id
  })

  const createCoverage = (tileSource: string, extra: Record<string, unknown> = {}) =>
    fetch(`${BASE}/api/coverages/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mapId, name: `cov-${Math.random().toString(36).slice(2, 8)}`,
        regions: [{ name: "t", bbox: { north: 1, south: 0, west: 0, east: 1 }, marginKm: 0 }],
        zoomMin: 0, zoomMax: 1, tileSource, tileSubdomains: ["a"],
        recurrency: "none", workers: 1, maxCallsPerMinute: 60,
        ...extra,
      }),
    })

  test("a tile source pointing at a non-public address is refused", async () => {
    for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "192.168.1.1", "10.0.0.1", "[::1]"]) {
      const res = await createCoverage(`http://${host}/{z}/{x}/{y}.png`)
      expect(res.status, host).toBe(400)
      expect((await res.json()).error, host).toContain("non-public")
    }
  }, 20_000)

  test("the tile proxy refuses one too, even for a host a coverage named", async () => {
    // Belt and braces: the save-time check is UX, this is the one that counts.
    const res = await fetch(`${BASE}/api/internal/fetch-tile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ tileUrl: "http://169.254.169.254/latest/meta-data/" }),
    })
    expect(res.status).toBe(403)
  })

  test("a public tile source is still accepted", async () => {
    const res = await createCoverage("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png")
    expect(res.status).toBe(200)
  }, 20_000)

  test("zoom, workers and rate are bounded", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ zoomMax: 30 }, "zoomMax"],
      [{ zoomMin: -1 }, "zoomMin"],
      [{ zoomMin: 5, zoomMax: 2 }, "greater than"],
      [{ workers: 99999 }, "workers"],
      [{ maxCallsPerMinute: 1_000_000_000 }, "maxCallsPerMinute"],
    ]
    for (const [extra, needle] of cases) {
      const res = await createCoverage("https://tiles.example.test/{z}/{x}/{y}.png", extra)
      expect(res.status, JSON.stringify(extra)).toBe(400)
      expect((await res.json()).error, JSON.stringify(extra)).toContain(needle)
    }
  }, 20_000)

  test("a nonsense bbox is refused", async () => {
    const res = await fetch(`${BASE}/api/coverages/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mapId, name: "bad bbox",
        regions: [{ name: "t", bbox: { north: 0, south: 10, west: 0, east: 1 }, marginKm: 0 }],
        zoomMin: 0, zoomMax: 1,
        tileSource: "https://tiles.example.test/{z}/{x}/{y}.png",
      }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("north")
  })
})

describe("token handling and headers", () => {
  let token: string

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
    })
    token = (await res.json()).token
  })

  test("a query-string token works for SSE and nowhere else", async () => {
    // EventSource cannot set headers, so /api/events has to accept it. Every
    // other route would just be leaking the token into access logs.
    const other = await fetch(`${BASE}/api/runs?coverageId=x&token=${token}`)
    expect(other.status).toBe(401)

    const sse = await fetch(`${BASE}/api/events?token=${token}`, { signal: AbortSignal.timeout(2000) })
      .catch(() => null)
    expect(sse?.status).toBe(200)
  })

  // The server only serves the dashboard when dist/index.html exists, so on a
  // checkout that has not been built there is no page to carry the headers.
  // Skipped visibly rather than passed quietly, so "green" never means "not run".
  const built = existsSync(join(import.meta.dir, "..", "dist", "index.html"))
  test.skipIf(!built)("the dashboard is served with a CSP and its content type intact", async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(200)
    // nosniff plus a wrong content type would stop the bundle executing, so the
    // inferred type has to survive the added headers.
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
  })
})

describe("internal routes", () => {
  test("reject a caller without the internal secret", async () => {
    const res = await fetch(`${BASE}/api/internal/run-control?runId=x`)
    expect(res.status).toBe(401)
  })

  test("the tile proxy refuses a non-http scheme", async () => {
    const res = await fetch(`${BASE}/api/internal/fetch-tile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ tileUrl: "file:///etc/passwd" }),
    })
    expect(res.status).toBe(400)
  })
})

// config.json carries internalSecret, so it has no more business being
// world-readable than auth.json does. The fixture is written 0644 before the
// server boots, which makes this the case that matters: an install that already
// has a loose config on disk, not just one the server creates itself.
describe("config.json permissions", () => {
  test("an existing 0644 config.json is brought down to 0600 on load", () => {
    expect(statSync(join(stateDir, "config.json")).mode & 0o777).toBe(0o600)
  })
})

// auth.json is only rewritten when the password changes, so an install that
// first wrote it before the 0600 handling existed would keep a loose file
// indefinitely. Writing it 0600 cannot reach that install; tightening on load
// is what does. This needs its own server against its own state dir, because
// the file has to already exist, and already be loose, before the boot.
describe("auth.json permissions", () => {
  const PERM_PORT = 34119
  let permDir: string
  let permProc: ReturnType<typeof Bun.spawn>

  beforeAll(async () => {
    permDir = mkdtempSync(join(tmpdir(), "maps-authperm-"))
    writeFileSync(
      join(permDir, "config.json"),
      JSON.stringify({ outputDir: join(permDir, "tiles"), internalSecret: "perm-test" }),
    )
    mkdirSync(join(permDir, "tiles"), { recursive: true })
    // A pre-existing, already-claimed install with a world-readable hash.
    writeFileSync(join(permDir, "auth.json"), JSON.stringify({ username: "admin", passwordHash: "x" }))
    chmodSync(join(permDir, "auth.json"), 0o644)

    // Streams ignored rather than piped: an unread pipe fills and blocks the
    // server, and nothing here reads its output.
    permProc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
      env: { ...process.env, STATE_DIR: permDir, PORT: String(PERM_PORT) },
      stdout: "ignore",
      stderr: "ignore",
    })

    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${PERM_PORT}/api/auth/status`, {
          signal: AbortSignal.timeout(500),
        })
        if (res.ok) return
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 150))
    }
    throw new Error("permissions server did not start in time")
  // Same reason as the suite's main hook: without this, bun stops waiting at 5s
  // no matter what the loop above is willing to tolerate.
  }, 200_000)

  afterAll(() => {
    try { permProc.kill() } catch { /* already gone */ }
    if (permDir) rmSync(permDir, { recursive: true, force: true })
  })

  test("an existing 0644 auth.json is brought down to 0600 on load", () => {
    expect(statSync(join(permDir, "auth.json")).mode & 0o777).toBe(0o600)
  })
})
