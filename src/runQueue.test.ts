import { expect, test, describe } from "bun:test"
import { queueInStartOrder, nextInStartOrder } from "./runQueue"

// runId -> priority, so each test reads as the queue it is describing.
function lookup(priorities: Record<string, number>) {
  return (runId: string) => priorities[runId] ?? 0
}

describe("run queue ordering", () => {
  const seed = lookup({ lisbon: 10, tehran: 10, refresh: 0, backfill: -5 })

  test("an untouched queue is still FIFO", () => {
    // Every existing coverage has no priority, so this is the case that must not
    // change behaviour when the field is deployed to a server that never sets it.
    const flat = lookup({})
    const queue = ["a", "b", "c"]
    expect(queueInStartOrder(queue, flat)).toEqual(["a", "b", "c"])
    expect(nextInStartOrder(queue, flat)).toBe("a")
  })

  test("higher priority takes the slot ahead of an earlier arrival", () => {
    // The case this exists for: a recurring refresh fires mid-seed and would
    // otherwise hold the only worker slot while seed work waits behind it.
    const queue = ["refresh", "lisbon"]
    expect(nextInStartOrder(queue, seed)).toBe("lisbon")
    expect(queueInStartOrder(queue, seed)).toEqual(["lisbon", "refresh"])
  })

  test("equal priorities keep their arrival order", () => {
    expect(queueInStartOrder(["lisbon", "tehran"], seed)).toEqual(["lisbon", "tehran"])
    expect(queueInStartOrder(["tehran", "lisbon"], seed)).toEqual(["tehran", "lisbon"])
    expect(nextInStartOrder(["tehran", "lisbon"], seed)).toBe("tehran")
  })

  test("negative priority sinks below the unset default", () => {
    expect(queueInStartOrder(["backfill", "refresh"], seed)).toEqual(["refresh", "backfill"])
  })

  test("a full queue comes out in priority then arrival order", () => {
    expect(queueInStartOrder(["backfill", "refresh", "lisbon", "tehran"], seed)).toEqual([
      "lisbon",
      "tehran",
      "refresh",
      "backfill",
    ])
  })

  test("the two functions never disagree about what runs next", () => {
    // broadcastQueue shows the operator queueInStartOrder while
    // releaseSlotAndStartNext actually dequeues with nextInStartOrder. If those
    // two ever differ, the dashboard is lying about what starts next.
    const queues = [
      ["a"],
      ["refresh", "lisbon"],
      ["lisbon", "tehran", "refresh"],
      ["backfill", "backfill2", "refresh", "tehran"],
    ]
    const p = lookup({ lisbon: 10, tehran: 10, refresh: 0, backfill: -5, backfill2: -5 })
    for (const q of queues) {
      expect(nextInStartOrder(q, p)).toBe(queueInStartOrder(q, p)[0]!)
    }
  })

  test("an empty queue has nothing to start", () => {
    expect(nextInStartOrder([], seed)).toBeUndefined()
    expect(queueInStartOrder([], seed)).toEqual([])
  })

  test("ordering does not mutate the caller's queue", () => {
    // server.ts holds runQueue in arrival order and splices out of it by index,
    // so sorting in place here would corrupt the removal.
    const queue = ["refresh", "lisbon", "backfill"]
    queueInStartOrder(queue, seed)
    nextInStartOrder(queue, seed)
    expect(queue).toEqual(["refresh", "lisbon", "backfill"])
  })
})
