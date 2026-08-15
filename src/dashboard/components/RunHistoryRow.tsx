import type { CoverageRun } from "../../types"
import { STATUS_STYLE } from "../constants"
import { fmtBytes, fmtDatetime } from "../utils"

type Props = {
  run: CoverageRun
  onView?: () => void
}

export function RunHistoryRow({ run, onView }: Props) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-xs group">
      <span
        className={`flex-shrink-0 px-1.5 py-0.5 rounded-full font-medium ${STATUS_STYLE[run.status] ?? "bg-white/10 text-white/40"}`}
      >
        {run.status}
      </span>
      {run.mode && (
        <span className="text-white/25 flex-shrink-0">{run.mode}</span>
      )}
      <span className="text-white/20 flex-shrink-0 tabular-nums">
        {fmtDatetime(run.startedAt)}
      </span>
      <span className="text-white/30 tabular-nums flex-shrink-0">
        {run.done.toLocaleString()} dl
        {run.skipped > 0 && <span className="text-white/20"> · {run.skipped.toLocaleString()} skip</span>}
        {run.failed > 0 && <span className="text-red-400/70"> · {run.failed} err</span>}
      </span>
      {run.bytes > 0 && (
        <span className="text-white/20 flex-shrink-0">{fmtBytes(run.bytes)}</span>
      )}
      <span className="flex-1" />
      {onView && (
        <button
          onClick={onView}
          className="text-white/20 hover:text-white/70 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
        >
          View →
        </button>
      )}
    </div>
  )
}
