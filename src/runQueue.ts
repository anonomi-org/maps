// The order queued runs take free worker slots in.
//
// Split out of server.ts for the same reason rateLimit.ts was: importing that
// module boots a listener, so anything left inside it cannot be unit tested.
// The caller owns the queue array and the priority lookup, which keeps this
// pure and leaves the server holding the mutable state.

// Arrival order in, start order out. Highest priority first; Array.sort is
// stable, so equal priorities keep the order they arrived in and a deployment
// that never sets a priority behaves exactly as the FIFO this replaced.
//
// Sorting on read rather than keeping the array sorted means a priority edited
// while runs are already waiting is picked up on the next dequeue, instead of
// only applying to runs queued after the edit.
export function queueInStartOrder(
  queue: readonly string[],
  priorityOf: (runId: string) => number,
): string[] {
  return [...queue].sort((a, b) => priorityOf(b) - priorityOf(a))
}

// The run that should take the next free slot, or undefined if nothing waits.
export function nextInStartOrder(
  queue: readonly string[],
  priorityOf: (runId: string) => number,
): string | undefined {
  let best: string | undefined
  let bestPriority = -Infinity
  for (const runId of queue) {
    const p = priorityOf(runId)
    // Strictly greater, so the earliest arrival wins a tie.
    if (p > bestPriority) {
      best = runId
      bestPriority = p
    }
  }
  return best
}
