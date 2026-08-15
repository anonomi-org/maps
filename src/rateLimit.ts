// The one place that decides how hard this server leans on an upstream tile
// service. Lives outside server.ts so it can be tested without booting a
// server: the proxy's 429 path cannot be reached end to end, because the
// destination guard refuses the loopback address a fake upstream would need.

// Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
// Capped, because the value is whatever an upstream chose to send and a run
// parking for a day on one header is worse than retrying too early.
export const RETRY_AFTER_MAX_MS = 5 * 60_000
// What a 429 costs when it arrives with no Retry-After at all, which is the
// common case. Backing off nothing is what made a rate-limit storm
// self-sustaining: the response to being told to slow down was a retry.
export const RETRY_AFTER_DEFAULT_MS = 30_000

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const raw = value.trim()
  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1_000, RETRY_AFTER_MAX_MS)
  // Every HTTP-date form begins with a day name, and requiring one matters
  // because Date.parse is far looser than the grammar: it reads "-5" as a year
  // and yields a date in the past, which would clamp to a zero-length penalty
  // and quietly turn the backoff off for that rejection.
  if (!/^[A-Za-z]/.test(raw)) return null
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_MAX_MS)
}

export class RateLimiter {
  private tokens: number
  private lastRefill: number
  private ratePerMs: number
  private maxTokens: number
  // Upstream told us to stop until this moment. It lives on the limiter and not
  // in the run that drew the rejection, because the bucket is the one thing
  // every concurrent run shares: a 429 earned by one of them has to slow all of
  // them, or the others keep the pressure on while it backs off alone.
  private penaltyUntil = 0

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

  // Only ever extends the penalty; a later, shorter Retry-After must not cut an
  // earlier, longer one short.
  backoff(ms: number) {
    const until = Date.now() + ms
    if (until > this.penaltyUntil) this.penaltyUntil = until
  }

  get penaltyRemainingMs(): number {
    return Math.max(0, this.penaltyUntil - Date.now())
  }

  async wait() {
    while (true) {
      // Re-checked in slices rather than slept through in one go, so a penalty
      // extended while callers are already parked here is still honoured.
      const penalty = this.penaltyUntil - Date.now()
      if (penalty > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(penalty, 5_000)))
        continue
      }
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
