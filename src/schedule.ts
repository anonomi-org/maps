// When a coverage should run next, given how its last run ended.
//
// Split out of server.ts for the same reason rateLimit.ts and runQueue.ts were:
// importing that module boots a listener, so anything left inside it cannot be
// unit tested. Testing this through the HTTP API is worse than inconvenient,
// it is unreliable: starting a run spawns a real runner, and against a dead
// tile source that runner can post its own completion before the test posts
// one, so the assertion silently measures the wrong outcome.
//
// This decides counters and which cadence applies. Turning that into a date is
// left to the caller, which owns the clock.

export type RunOutcome = "success" | "partial" | "failed"

export type ScheduleChoice =
  // Exponential backoff; attempt is 1-based and indexes the backoff curve.
  | { kind: "retry"; attempt: number }
  // The coverage's configured recurrency interval.
  | { kind: "interval" }

export type ScheduleCounters = {
  consecutiveFailures: number
  consecutivePartials: number
}

// A run that never reached the end of its list. Backs off 5 min, 10, 20, 40,
// 80, capped, then gives up on the fast cadence: past this the fault is not
// transient and retrying against a source or a disk that is not coming back
// is just noise. The coverage stays scheduled either way.
export const RETRY_MAX = 5

// A run that reached the end of its list but lost some tiles on the way gets a
// short retry too. The remainder is small and a resume collects it cheaply,
// because everything already on disk skips. Waiting the configured 30 or 90
// days for a handful of tiles a dropped connection lost is the difference
// between a gap that heals itself and one that lasts a quarter. Over Tor that
// matters much more, since a dropped circuit fails a few tiles on most runs and
// partial stops being the rare ending.
//
// Fewer attempts than RETRY_MAX on purpose. Each retry re-walks the whole
// coverage to find what is missing, which for a large one is hours of directory
// listings to re-fetch a few tiles, and a tile that fails every time (a genuine
// 404 at the source) will never arrive however often it is asked for. Three
// tries catches the transient case; after that the normal interval still
// collects them, just later.
export const PARTIAL_RETRY_MAX = 3

// Counters carried forward plus the cadence to use. Both counters are returned
// on every outcome so the caller never has to remember which ones to clear.
export function scheduleAfterRun(
  outcome: RunOutcome,
  prev: Partial<ScheduleCounters> | undefined,
): ScheduleCounters & { choice: ScheduleChoice } {
  const failures = prev?.consecutiveFailures ?? 0
  const partials = prev?.consecutivePartials ?? 0

  if (outcome === "failed") {
    const n = failures + 1
    // Partials are left alone rather than cleared: an outage says nothing about
    // whether the tiles that were failing before have started arriving.
    return {
      consecutiveFailures: n,
      consecutivePartials: partials,
      choice: n <= RETRY_MAX ? { kind: "retry", attempt: n } : { kind: "interval" },
    }
  }

  if (outcome === "partial") {
    const n = partials + 1
    // Reaching the end of the list is not an outage, so the failure counter
    // clears. Without that, a partial would keep a previous outage's backoff
    // alive and eventually be mistaken for one.
    return {
      consecutiveFailures: 0,
      consecutivePartials: n,
      choice: n <= PARTIAL_RETRY_MAX ? { kind: "retry", attempt: n } : { kind: "interval" },
    }
  }

  return { consecutiveFailures: 0, consecutivePartials: 0, choice: { kind: "interval" } }
}
