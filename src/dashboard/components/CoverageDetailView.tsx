import { useEffect, useRef, useState } from "react"
import type { Coverage, CoverageRun, RunMode } from "../../types"
import { API_BASE, RECURRENCY_LABEL, RECURRENCY_STYLE, STATUS_STYLE } from "../constants"
import { fmtBytes, fmtDate, fmtRelative } from "../utils"
import { RunHistoryRow } from "./RunHistoryRow"
import { RunModeButton } from "./RunModeButton"
import { RunProgressBar } from "./RunProgressBar"
import { RunStatsRow } from "./RunStatsRow"
import { StatCell } from "./StatCell"

type Props = {
  coverage: Coverage
  activeRun?: CoverageRun
  queuePosition?: number
  authToken: string | null
  mapName: string
  onBack: () => void
  onRun: (mode: RunMode) => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onEdit: () => void
  onDelete: () => void
  onViewRun: (runId: string) => void
}

export function CoverageDetailView({
  coverage,
  activeRun,
  queuePosition,
  authToken,
  mapName,
  onBack,
  onRun,
  onPause,
  onResume,
  onCancel,
  onEdit,
  onDelete,
  onViewRun,
}: Props) {
  const [runs, setRuns] = useState<CoverageRun[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [now, setNow] = useState(Date.now())
  const wasActiveRef = useRef(false)

  const run = activeRun
  const isQueued = run?.status === "queued"
  const isRunning = run?.status === "running"
  const isPaused = run?.status === "paused"
  const isActive = isQueued || isRunning || isPaused
  const hasRun = coverage.lastRunAt !== null
  const smartMode: RunMode = coverage.lastRunStatus === "success" ? "update" : "resume"

  const startMs = run?.startedAt ? new Date(run.startedAt).getTime() : null
  const endMs = run?.endedAt ? new Date(run.endedAt).getTime() : null
  const elapsedMs = startMs ? (endMs ?? now) - startMs : 0
  const processed = run ? run.done + run.skipped : 0
  const total = run?.total ?? 0
  const tilesPerSec =
    run && elapsedMs > 1000 ? (run.done / (elapsedMs / 1000)).toFixed(1) : null

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

  useEffect(() => {
    if (!isActive) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isActive])

  const fetchRuns = () => {
    const headers: HeadersInit = authToken ? { Authorization: `Bearer ${authToken}` } : {}
    setRunsLoading(true)
    fetch(`${API_BASE}/api/runs?coverageId=${coverage.id}`, { headers })
      .then((r) => r.json())
      .then((data: CoverageRun[]) => {
        if (Array.isArray(data)) setRuns(data)
      })
      .catch(() => {})
      .finally(() => setRunsLoading(false))
  }

  useEffect(() => {
    fetchRuns()
  }, [coverage.id, authToken]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const nowActive = isActive
    if (wasActiveRef.current && !nowActive) fetchRuns()
    wasActiveRef.current = nowActive
  }, [isActive]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-3xl mx-auto px-6 py-10">

        {/* Breadcrumb + header */}
        <div className="mb-6">
          <button
            onClick={onBack}
            className="text-white/40 hover:text-white/70 text-xs transition-colors mb-2 flex items-center gap-1"
          >
            ← {mapName}
          </button>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight truncate">{coverage.name}</h1>
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
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
                  const urgent = rel === "overdue" || (rel.startsWith("in ") && (rel.endsWith("m") || rel.endsWith("h")))
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
                      {run.status}
                    </span>
                    {run.mode && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/5 text-white/30">
                        {run.mode}
                      </span>
                    )}
                  </>
                )}
                {queuePosition && !run && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
                    queued #{queuePosition}
                  </span>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {!isActive && (
                <RunModeButton
                  hasRun={hasRun}
                  smartMode={smartMode}
                  showValidate={coverage.tilesOnDisk > 0}
                  onRun={onRun}
                  dropdownPosition="below-right"
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
          </div>
        </div>

        {/* Active run section */}
        {run && (
          <div className="rounded-2xl border border-white/10 bg-black/30 p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-medium text-white/50">Active run</p>
              <button
                onClick={() => onViewRun(run.id)}
                className="text-xs text-white/30 hover:text-white/70 transition-colors"
              >
                View detail →
              </button>
            </div>

            <RunProgressBar
              total={total}
              processed={processed}
              isActive={isActive}
              isQueued={isQueued}
              className="mb-3"
            />

            <RunStatsRow
              run={run}
              elapsedMs={elapsedMs}
              isRunning={isRunning}
              tilesPerSec={tilesPerSec}
            />

            {run.error && <p className="text-red-400 text-xs mt-2">{run.error}</p>}
          </div>
        )}

        {/* Lifetime stats grid */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          <StatCell
            label="Tiles on disk"
            value={`${coverage.tilesOnDisk.toLocaleString()} / ${coverage.totalTilesExpected.toLocaleString()}`}
          />
          <StatCell
            label="Size on disk"
            value={coverage.sizeBytes > 0 ? fmtBytes(coverage.sizeBytes) : "—"}
          />
          <StatCell
            label="Total runs"
            value={
              coverage.totalRuns > 0
                ? `${coverage.totalRuns}${coverage.totalFailedRuns > 0 ? ` (${coverage.totalFailedRuns} failed)` : ""}`
                : "0"
            }
          />
          <StatCell
            label="Last run"
            value={coverage.lastRunAt ? fmtDate(coverage.lastRunAt) : "Never"}
          />
          <StatCell label="Last result" value={coverage.lastRunStatus ?? "—"} />
          <StatCell
            label="Next run"
            value={
              coverage.nextRunAt
                ? fmtDate(coverage.nextRunAt)
                : coverage.recurrency !== "none"
                  ? "Not scheduled"
                  : "Manual only"
            }
          />
        </div>

        {/* Schedule info */}
        {coverage.recurrency !== "none" && !isActive && coverage.nextRunAt && (
          <p className="text-xs mb-4">
            <span className="text-white/30">Next run: </span>
            {queuePosition ? (
              <span className="text-purple-400">queued #{queuePosition}</span>
            ) : new Date(coverage.nextRunAt) <= new Date() ? (
              <span className="text-yellow-400">due now, waiting for queue</span>
            ) : (
              <span className="text-white/50">{fmtDate(coverage.nextRunAt)}</span>
            )}
          </p>
        )}

        {/* Configuration */}
        <div className="rounded-2xl border border-white/10 bg-black/30 p-5 mb-4">
          <p className="text-xs font-medium text-white/40 mb-3">Configuration</p>
          <div className="space-y-3 text-xs">
            <div>
              <p className="text-white/25 mb-1.5">
                {coverage.regions.length === 1 ? "Region" : `Regions (${coverage.regions.length})`}
              </p>
              <div className="space-y-1">
                {coverage.regions.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2"
                  >
                    <span className="text-white/60">{r.name}</span>
                    <span className="text-white/25 font-mono text-[10px]">
                      {r.bbox.north.toFixed(2)},{r.bbox.west.toFixed(2)} →{" "}
                      {r.bbox.south.toFixed(2)},{r.bbox.east.toFixed(2)}
                      {r.marginKm > 0 && (
                        <span className="ml-2 text-white/20">+{r.marginKm}km</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-white/30">
              <span>z{coverage.zoomMin}–{coverage.zoomMax}</span>
              <span>{coverage.workers} workers</span>
              {coverage.maxCallsPerMinute > 0 && (
                <span>{coverage.maxCallsPerMinute} req/min</span>
              )}
            </div>

            <p className="font-mono text-[10px] text-white/20 break-all">{coverage.tileSource}</p>
          </div>
        </div>

        {/* Run history */}
        <div className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
          <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
            <p className="text-xs font-medium text-white/50">Run history</p>
            <span className="text-xs text-white/20">{coverage.totalRuns} total</span>
          </div>
          <div className="p-4">
            {runsLoading && <p className="text-xs text-white/20">Loading…</p>}
            {!runsLoading && runs.length === 0 && (
              <p className="text-xs text-white/20">No runs yet. Start one above.</p>
            )}
            {!runsLoading && runs.length > 0 && (
              <div className="space-y-0.5">
                {runs.map((r) => (
                  <RunHistoryRow
                    key={r.id}
                    run={r.id === run?.id ? run! : r}
                    onView={() => onViewRun(r.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Persistent stats footer */}
        {!run && (
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/30">
            <span>
              Last run:{" "}
              <span className={lastStatusStyle}>
                {hasRun
                  ? `${fmtDate(coverage.lastRunAt)} (${coverage.lastRunStatus})`
                  : "never"}
              </span>
            </span>
            <span>Created {fmtDate(coverage.createdAt)}</span>
          </div>
        )}

      </div>
    </div>
  )
}
