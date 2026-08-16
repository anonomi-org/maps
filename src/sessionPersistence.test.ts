import { expect, test, describe, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Sessions have to outlive a restart, so this boots a server, takes a token,
// kills it, boots another against the same STATE_DIR, and checks the token is
// still good. Nothing in the single shared server in server.test.ts can cover
// that, because the whole point is what happens across two processes.
//
// A deploy restarts the service. While sessions lived only in memory, every
// deploy silently invalidated whatever token the operator or any automation was
// holding, and the resulting 401 looked like a bug rather than a sign-out.

const PORT = 34221
const BASE = `http://localhost:${PORT}`
const PASSWORD = "correct-horse-battery"

let stateDir: string
let proc: ReturnType<typeof Bun.spawn> | null = null
let output = ""
let token: string

async function boot() {
  proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, STATE_DIR: stateDir, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const drain = async (s: unknown) => {
    if (!s || typeof s === "number") return
    for await (const chunk of s as AsyncIterable<Uint8Array>) output += new TextDecoder().decode(chunk)
  }
  drain(proc.stdout); drain(proc.stderr)

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/auth/status`, { signal: AbortSignal.timeout(500) })).ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`server did not start:\n${output}`)
}

async function kill() {
  try { proc?.kill() } catch { /* already gone */ }
  // The next boot binds the same port, so wait for the old listener to go.
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/auth/status`, { signal: AbortSignal.timeout(300) })
    } catch { return }
    await new Promise((r) => setTimeout(r, 100))
  }
}

const check = (t: string) =>
  fetch(`${BASE}/api/auth/check`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.status)

function storedHashes(): string[] {
  const db = new Database(join(stateDir, "maps.db"), { readonly: true })
  const rows = db.query<{ token_hash: string }, []>(`SELECT token_hash FROM sessions`).all()
  db.close()
  return rows.map((r) => r.token_hash)
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "maps-session-"))
  mkdirSync(join(stateDir, "tiles"), { recursive: true })
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ outputDir: join(stateDir, "tiles"), internalSecret: "test-secret", maxConcurrentRuns: 1 }),
  )
  await boot()

  const deadline = Date.now() + 10_000
  let setupCode = ""
  while (Date.now() < deadline && !setupCode) {
    setupCode = /setup code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(output)?.[1] ?? ""
    if (!setupCode) await new Promise((r) => setTimeout(r, 50))
  }
  expect(setupCode).not.toBe("")

  const res = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD, setupCode }),
  })
  expect(res.status).toBe(200)
  token = (await res.json()).token as string
  expect(typeof token).toBe("string")
}, 200_000)

afterAll(() => {
  try { proc?.kill() } catch { /* already gone */ }
  try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe("sessions across a restart", () => {
  test("the token works before the restart", async () => {
    expect(await check(token)).toBe(200)
  })

  test("the database stores a hash of the token, never the token", async () => {
    // maps.db is backed up and copied around. A raw token in one of those
    // copies is a live credential to whoever reads it; a hash is not.
    const hashes = storedHashes()
    expect(hashes).toHaveLength(1)
    expect(hashes[0]).not.toBe(token)
    expect(hashes[0]).not.toContain(token)
    expect(hashes[0]).toBe(createHash("sha256").update(token).digest("hex"))
  })

  test("the same token still works after a restart", async () => {
    // The regression: a deploy used to sign the operator out silently.
    await kill()
    await boot()
    expect(await check(token)).toBe(200)
  }, 200_000)

  test("a token that was never issued is still refused after a restart", async () => {
    expect(await check("not-a-real-token")).toBe(401)
  })

  test("logging out survives a restart too", async () => {
    const res = await fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(await check(token)).toBe(401)
    expect(storedHashes()).toHaveLength(0)

    // A logout that only cleared memory would hand the session back on reboot.
    await kill()
    await boot()
    expect(await check(token)).toBe(401)
  }, 200_000)
})
