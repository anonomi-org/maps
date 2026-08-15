type Props = {
  total: number
  processed: number
  isActive: boolean
  isQueued?: boolean
  className?: string
}

export function RunProgressBar({ total, processed, isActive, isQueued, className = "" }: Props) {
  if (!isActive && total === 0) return null

  const progress = total > 0 ? processed / total : 0

  if (total === 0) {
    return (
      <div className={className}>
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className={`h-full w-full animate-pulse ${isQueued ? "bg-purple-400/40" : "bg-blue-400/50"}`} />
        </div>
        <p className="text-xs text-white/30 mt-1.5">{isQueued ? "Queued…" : "Starting…"}</p>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full bg-blue-400 transition-all duration-300"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-white/40 mt-1.5">
        <span>{Math.round(progress * 100)}%</span>
        <span>{processed.toLocaleString()} / {total.toLocaleString()} tiles</span>
      </div>
    </div>
  )
}
