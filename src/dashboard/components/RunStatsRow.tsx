import { fmtBytes, fmtDuration } from "../utils"

type RunLike = { done: number; skipped: number; failed: number; bytes: number }

type Props = {
  run: RunLike
  elapsedMs: number
  isRunning: boolean
  tilesPerSec: string | null
  etaSec?: number | null
  className?: string
}

export function RunStatsRow({ run, elapsedMs, isRunning, tilesPerSec, etaSec, className = "" }: Props) {
  if (run.done === 0 && run.skipped === 0 && run.failed === 0 && elapsedMs === 0) return null

  return (
    <div className={`flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/40 ${className}`}>
      {run.done > 0 && (
        <span>
          <span className="text-white/70">{run.done.toLocaleString()}</span> downloaded
        </span>
      )}
      {run.skipped > 0 && (
        <span>
          <span className="text-white/70">{run.skipped.toLocaleString()}</span> skipped
        </span>
      )}
      {run.failed > 0 && (
        <span>
          <span className="text-red-400">{run.failed.toLocaleString()}</span> failed
        </span>
      )}
      {run.bytes > 0 && <span>{fmtBytes(run.bytes)}</span>}
      {elapsedMs > 0 && <span>{fmtDuration(elapsedMs)}</span>}
      {isRunning && tilesPerSec && <span>{tilesPerSec} tiles/s</span>}
      {isRunning && etaSec != null && etaSec > 0 && (
        <span>ETA {fmtDuration(etaSec * 1000)}</span>
      )}
    </div>
  )
}
