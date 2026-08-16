import { expect, test, describe } from "bun:test"
import { scheduleAfterRun, RETRY_MAX, PARTIAL_RETRY_MAX } from "./schedule"

describe("scheduling the next run", () => {
  test("a clean run uses the configured interval and clears both counters", () => {
    const r = scheduleAfterRun("success", { consecutiveFailures: 3, consecutivePartials: 2 })
    expect(r.choice).toEqual({ kind: "interval" })
    expect(r.consecutiveFailures).toBe(0)
    expect(r.consecutivePartials).toBe(0)
  })

  test("a failed run retries rather than waiting out the interval", () => {
    // The regression this whole area exists for: one failure used to leave the
    // coverage with no schedule at all, dormant until somebody noticed.
    const r = scheduleAfterRun("failed", undefined)
    expect(r.choice).toEqual({ kind: "retry", attempt: 1 })
    expect(r.consecutiveFailures).toBe(1)
  })

  test("consecutive failures walk up the backoff and then give up on it", () => {
    let counters = { consecutiveFailures: 0, consecutivePartials: 0 }
    for (let i = 1; i <= RETRY_MAX; i++) {
      const r = scheduleAfterRun("failed", counters)
      expect(r.choice).toEqual({ kind: "retry", attempt: i })
      counters = r
    }
    // Past the budget the fault is not transient. Still scheduled, just slowly.
    const past = scheduleAfterRun("failed", counters)
    expect(past.choice).toEqual({ kind: "interval" })
    expect(past.consecutiveFailures).toBe(RETRY_MAX + 1)
  })

  test("a partial run retries soon instead of waiting out the interval", () => {
    // Before this, a run that lost a handful of tiles was scheduled at the full
    // 30 or 90 days, even though a resume would have collected them in minutes
    // because everything else on disk skips.
    const r = scheduleAfterRun("partial", { consecutiveFailures: 0, consecutivePartials: 0 })
    expect(r.choice).toEqual({ kind: "retry", attempt: 1 })
    expect(r.consecutivePartials).toBe(1)
  })

  test("consecutive partials back off and then fall back to the interval", () => {
    let counters = { consecutiveFailures: 0, consecutivePartials: 0 }
    for (let i = 1; i <= PARTIAL_RETRY_MAX; i++) {
      const r = scheduleAfterRun("partial", counters)
      expect(r.choice).toEqual({ kind: "retry", attempt: i })
      counters = r
    }
    // Tiles that fail every time are not transient, and each retry re-walks the
    // whole coverage, so the short cadence has to stop.
    const past = scheduleAfterRun("partial", counters)
    expect(past.choice).toEqual({ kind: "interval" })
    expect(past.consecutivePartials).toBe(PARTIAL_RETRY_MAX + 1)
  })

  test("partials give up sooner than failures, because each retry costs a full walk", () => {
    expect(PARTIAL_RETRY_MAX).toBeLessThan(RETRY_MAX)
  })

  test("a partial clears the failure counter but a failure keeps the partial count", () => {
    // Reaching the end of the list proves the source and the disk are up, so an
    // earlier outage is over. The reverse is not true: an outage says nothing
    // about whether the tiles that were failing have started arriving, so
    // clearing partials there would quietly hand back a fresh retry budget.
    const afterPartial = scheduleAfterRun("partial", { consecutiveFailures: 4, consecutivePartials: 0 })
    expect(afterPartial.consecutiveFailures).toBe(0)

    const afterFailure = scheduleAfterRun("failed", { consecutiveFailures: 0, consecutivePartials: 2 })
    expect(afterFailure.consecutivePartials).toBe(2)
  })

  test("a coverage with no counters yet is treated as zero", () => {
    // Rows written before these fields existed have neither.
    for (const outcome of ["success", "partial", "failed"] as const) {
      expect(() => scheduleAfterRun(outcome, undefined)).not.toThrow()
      expect(() => scheduleAfterRun(outcome, {})).not.toThrow()
    }
    expect(scheduleAfterRun("partial", {}).consecutivePartials).toBe(1)
    expect(scheduleAfterRun("failed", {}).consecutiveFailures).toBe(1)
  })

  test("a success after a long partial streak returns to the interval immediately", () => {
    const r = scheduleAfterRun("success", { consecutiveFailures: 0, consecutivePartials: 99 })
    expect(r.choice).toEqual({ kind: "interval" })
    expect(r.consecutivePartials).toBe(0)
  })
})
