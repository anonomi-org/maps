import { useEffect, useState } from "react"
import type { Coverage, CoverageRun, RunMode } from "../../types"
import { API_BASE, RECURRENCY_LABEL, RECURRENCY_STYLE, STATUS_STYLE } from "../constants"
import { fmtBytes, fmtDate, fmtRelative } from "../utils"
import { RunHistoryRow } from "./RunHistoryRow"
import { RunModeButton } from "./RunModeButton"
import { RunProgressBar } from "./RunProgressBar"
import { RunStatsRow } from "./RunStatsRow"

type Props = {
  coverage: Coverage
  activeRun?: CoverageRun
  queuePosition?: number
  sortPosition?: number
  authToken?: string | null
  onOpen?: () => void
  onRun: (mode: RunMode) => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onEdit: () => void
  onDelete: () => void
  onViewRun?: (runId: string) => void
}

export function CoverageCard({
  coverage,
  activeRun,
  queuePosition,
  sortPosition,
  authToken,
  onOpen,
  onRun,
  onPause,
  onResume,
  onCancel,
  onEdit,
  onDelete,
  onViewRun,
}: Props) {
  const [now, setNow] = useState(Date.now())
  const [runsExpanded, setRunsExpanded] = useState(false)
  const [historicalRuns, setHistoricalRuns] = useState<CoverageRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  useEffect(() => {
    if (!activeRun || (activeRun.status !== "running" && activeRun.status !== "paused")) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [activeRun?.status])

  useEffect(() => {
    if (!runsExpanded) return
    const headers: HeadersInit = authToken ? { Authorization: `Bearer ${authToken}` } : {}
    setRunsLoading(true)
    fetch(`${API_BASE}/api/runs?coverageId=${coverage.id}`, { headers })
      .then((r) => r.json())
      .then((data: CoverageRun[]) => {
        if (Array.isArray(data)) setHistoricalRuns(data)
      })
      .catch(() => {})
      .finally(() => setRunsLoading(false))
  }, [runsExpanded, coverage.id, authToken])

  const run = activeRun
  const startMs = run?.startedAt ? new Date(run.startedAt).getTime() : null
  const endMs = run?.endedAt ? new Date(run.endedAt).getTime() : null
  const elapsedMs = startMs ? (endMs ?? now) - startMs : 0
  const processed = run ? run.done + run.skipped : 0
  const total = run?.total ?? 0
  const tilesPerSecNum =
    run && elapsedMs > 1000 ? run.done / (elapsedMs / 1000) : null
  const tilesPerSec = tilesPerSecNum != null ? tilesPerSecNum.toFixed(1) : null
  const remaining = run ? run.total - run.done - run.skipped : 0
  const etaSec =
    tilesPerSecNum && tilesPerSecNum > 0 && remaining > 0
      ? Math.round(remaining / tilesPerSecNum)
      : null

  const isQueued = run?.status === "queued"
  const isRunning = run?.status === "running"
  const isPaused = run?.status === "paused"
  const isActive = isQueued || isRunning || isPaused
  const hasRun = coverage.lastRunAt !== null
  const smartMode: RunMode = coverage.lastRunStatus === "success" ? "update" : "resume"

  const lastStatusStyle =
    coverage.lastRunStatus === "success"
      ? "text-green-400"
      : coverage.lastRunStatus === "partial"
        ? "text-yellow-400"
        : coverage.lastRunStatus === "cancelled"
          ? "text-white/40"
          : coverage.lastRunStatus === "failed"
            ? "text-red-400"
            : "text-white/30"

  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0 mr-3">
          <h2 className="font-medium text-sm truncate">
            {sortPosition !== undefined && (
              <span className="text-white/20 font-mono text-xs mr-1.5">#{sortPosition}</span>
            )}
            {coverage.name}
          </h2>
          <p className="text-white/30 text-xs mt-0.5">
            {coverage.regions.length === 1
              ? coverage.regions[0].name
              : `${coverage.regions.length} regions`}{" "}
            · z{coverage.zoomMin}–{coverage.zoomMax}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${RECURRENCY_STYLE[coverage.recurrency]}`}
          >
            {RECURRENCY_LABEL[coverage.recurrency]}
          </span>
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/5 text-white/30">
            {coverage.type}
          </span>
          {!run && coverage.nextRunAt && coverage.recurrency !== "none" && (() => {
            const rel = fmtRelative(coverage.nextRunAt)
            const urgent = rel === "overdue" || rel.startsWith("in ") && (rel.endsWith("m") || rel.endsWith("h"))
            return (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${urgent ? "bg-yellow-500/10 text-yellow-400" : "bg-white/5 text-white/30"}`}>
                {rel}
              </span>
            )
          })()}
          {run && (
            <>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[run.status]}`}
              >
                {run.status === "queued" && queuePosition ? `queued #${queuePosition}` : run.status}
              </span>
              {run.mode && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/5 text-white/30">
                  {run.mode}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {run && (
        <RunProgressBar
          total={total}
          processed={processed}
          isActive={isActive}
          isQueued={isQueued}
          className="mb-4"
        />
      )}

      {run && (
        <RunStatsRow
          run={run}
          elapsedMs={elapsedMs}
          isRunning={isRunning}
          tilesPerSec={tilesPerSec}
          etaSec={etaSec}
          className="mb-4"
        />
      )}

      {run?.error && <p className="text-red-400 text-xs mb-4">{run.error}</p>}

      {/* Persistent stats (no active run) */}
      {!run && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/40 mb-4">
          <span>
            <span className="text-white/70">
              {coverage.tilesOnDisk.toLocaleString()}
            </span>{" "}
            /{" "}
            {coverage.totalTilesExpected.toLocaleString()} tiles on disk
          </span>
          {coverage.sizeBytes > 0 && (
            <span>{fmtBytes(coverage.sizeBytes)}</span>
          )}
          <span>
            Last run:{" "}
            <span className={lastStatusStyle}>
              {hasRun
                ? `${fmtDate(coverage.lastRunAt)} (${coverage.lastRunStatus})`
                : "never"}
            </span>
          </span>
          {coverage.totalRuns > 0 && (
            <span>
              <span className="text-white/70">{coverage.totalRuns}</span> run
              {coverage.totalRuns !== 1 ? "s" : ""}
              {coverage.totalFailedRuns > 0 && (
                <span className="text-red-400"> · {coverage.totalFailedRuns} failed</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Next run */}
      {coverage.recurrency !== "none" && !isActive && (
        <p className="text-xs mb-3">
          <span className="text-white/30">Next run: </span>
          {queuePosition ? (
            <span className="text-purple-400">queued #{queuePosition}</span>
          ) : coverage.nextRunAt ? (
            new Date(coverage.nextRunAt) <= new Date() ? (
              <span className="text-yellow-400">due now, waiting for queue</span>
            ) : (
              <span className="text-white/60">{fmtDate(coverage.nextRunAt)}</span>
            )
          ) : (
            <span className="text-white/25">run manually to activate schedule</span>
          )}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        {onOpen && (
          <button
            onClick={onOpen}
            className="px-3 py-1.5 rounded-lg bg-white/5 text-white/50 text-xs font-medium transition-colors hover:bg-white/10 hover:text-white/70"
          >
            Open
          </button>
        )}
        {!isActive && (
          <RunModeButton
            hasRun={hasRun}
            smartMode={smartMode}
            showValidate={coverage.tilesOnDisk > 0}
            onRun={onRun}
            dropdownPosition="above-left"
          />
        )}
        {isRunning && !isQueued && (
          <button
            onClick={onPause}
            className="px-3 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-400 text-xs font-medium transition-colors hover:bg-yellow-500/30"
          >
            Pause
          </button>
        )}
        {isPaused && (
          <button
            onClick={onResume}
            className="px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-400 text-xs font-medium transition-colors hover:bg-blue-500/30"
          >
            Continue
          </button>
        )}
        {isActive && (
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg bg-white/5 text-white/40 text-xs font-medium transition-colors hover:bg-white/10 hover:text-white/60"
          >
            Cancel
          </button>
        )}
        <button
          onClick={onEdit}
          className="px-3 py-1.5 rounded-lg bg-white/5 text-white/40 text-xs font-medium transition-colors hover:bg-white/10 hover:text-white/70"
        >
          Edit
        </button>
        {!isActive && (
          <button
            onClick={onDelete}
            className="px-3 py-1.5 rounded-lg bg-white/5 text-white/30 text-xs font-medium transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            Delete
          </button>
        )}
      </div>

      {/* Run history toggle */}
      {coverage.totalRuns > 0 && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <button
            onClick={() => setRunsExpanded((v) => !v)}
            className="text-xs text-white/25 hover:text-white/60 transition-colors select-none"
          >
            {runsExpanded ? "▾" : "▸"} Runs ({coverage.totalRuns})
          </button>

          {runsExpanded && (
            <div className="mt-2">
              {runsLoading && <p className="text-xs text-white/20 py-1">Loading…</p>}

              {!runsLoading && historicalRuns.length === 0 && (
                <p className="text-xs text-white/20 py-1">No run history</p>
              )}

              {!runsLoading && historicalRuns.length > 0 && (
                <div className="space-y-0.5">
                  {historicalRuns.map((r) => (
                    <RunHistoryRow
                      key={r.id}
                      run={r.id === activeRun?.id ? activeRun! : r}
                      onView={onViewRun ? () => onViewRun(r.id) : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
