import type { RunMode, RunStatus } from "../types"

export const API_BASE = import.meta.env.DEV ? "http://localhost:3001" : ""

export const STATUS_STYLE: Record<RunStatus, string> = {
  queued: "bg-purple-500/20 text-purple-400",
  running: "bg-blue-500/20 text-blue-400",
  paused: "bg-yellow-500/20 text-yellow-400",
  pausing: "bg-yellow-500/20 text-yellow-300",
  done: "bg-green-500/20 text-green-400",
  error: "bg-red-500/20 text-red-400",
  cancelled: "bg-white/10 text-white/40",
  cancelling: "bg-white/10 text-white/50",
}

export const RECURRENCY_LABEL: Record<string, string> = {
  high: "weekly",
  normal: "monthly",
  low: "quarterly",
  none: "manual",
}

export const RECURRENCY_STYLE: Record<string, string> = {
  high: "bg-orange-500/15 text-orange-400",
  normal: "bg-white/10 text-white/40",
  low: "bg-white/5 text-white/30",
  none: "bg-white/5 text-white/20",
}

export const MODE_INFO: Record<RunMode, { label: string; desc: string }> = {
  resume: { label: "Resume", desc: "Download missing tiles only" },
  update: { label: "Update", desc: "Check for newer tiles (If-Modified-Since)" },
  reset: { label: "Reset", desc: "Re-download all tiles" },
  validate: { label: "Validate", desc: "Verify tiles on disk, update stats, remove leftovers" },
}
