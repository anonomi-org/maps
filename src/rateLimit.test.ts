import { expect, test, describe } from "bun:test"
import { RateLimiter, parseRetryAfter, RETRY_AFTER_MAX_MS } from "./rateLimit"

// The proxy used to flatten every upstream status into a 502, which threw away
// Retry-After along with it. The runner then retried three times per tile at
// full rate, so being told to slow down produced three times the traffic.

describe("parseRetryAfter", () => {
  test("reads delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000)
    expect(parseRetryAfter("  30  ")).toBe(30_000)
    expect(parseRetryAfter("0")).toBe(0)
  })

  test("reads an HTTP-date as a delay from now", () => {
    const ms = parseRetryAfter(new Date(Date.now() + 20_000).toUTCString())
    expect(ms).not.toBeNull()
    // toUTCString truncates to whole seconds, so allow a second of slack.
    expect(ms!).toBeGreaterThan(18_000)
    expect(ms!).toBeLessThanOrEqual(20_000)
  })

  // An upstream sending a date already gone would otherwise produce a negative
  // sleep, which reads as "no penalty at all" rather than "retry now".
  test("a date in the past is zero, not negative", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0)
  })

  test("caps an absurd value instead of parking the run on it", () => {
    expect(parseRetryAfter("86400")).toBe(RETRY_AFTER_MAX_MS)
    expect(parseRetryAfter(new Date(Date.now() + 86_400_000).toUTCString())).toBe(RETRY_AFTER_MAX_MS)
  })

  test("returns null for a missing or unparseable header", () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter("")).toBeNull()
    expect(parseRetryAfter("soon")).toBeNull()
    // Signed and fractional values are not delta-seconds, and Date.parse does
    // not accept them either.
    expect(parseRetryAfter("-5")).toBeNull()
  })
})

describe("RateLimiter backoff", () => {
  // The point of holding the penalty on the limiter: every run sharing this
  // bucket stalls, not just the one that drew the 429.
  test("wait() parks until the penalty expires", async () => {
    const limiter = new RateLimiter(6_000) // fast enough that tokens are never the delay
    limiter.backoff(300)
    const t0 = Date.now()
    await limiter.wait()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
  }, 10_000)

  test("concurrent waiters all stall on one backoff", async () => {
    const limiter = new RateLimiter(6_000)
    limiter.backoff(300)
    const t0 = Date.now()
    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait(), limiter.wait()])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
  }, 10_000)

  test("a shorter later backoff does not cut a longer one short", () => {
    const limiter = new RateLimiter(60)
    limiter.backoff(60_000)
    limiter.backoff(1_000)
    expect(limiter.penaltyRemainingMs).toBeGreaterThan(50_000)
  })

  test("no backoff means no delay", async () => {
    const limiter = new RateLimiter(6_000)
    const t0 = Date.now()
    await limiter.wait()
    expect(Date.now() - t0).toBeLessThan(100)
    expect(limiter.penaltyRemainingMs).toBe(0)
  }, 10_000)
})
