import { useEffect, useRef, useState } from "react"
import type { CoverageRun } from "../../types"
import { API_BASE, STATUS_STYLE } from "../constants"
import { fmtDatetime } from "../utils"
import { RunProgressBar } from "./RunProgressBar"
import { StatCell } from "./StatCell"

type Props = {
  runId: string
  coverageId: string
  coverageName: string
  authToken: string | null
  liveRun?: CoverageRun  // from SSE if active
  onBack: () => void
}

export function RunDetailView({ runId, coverageId, coverageName, authToken, liveRun, onBack }: Props) {
  const [run, setRun] = useState<CoverageRun | null>(liveRun ?? null)
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now())
  const logsEndRef = useRef<HTMLDivElement>(null)

  const displayRun = liveRun ?? run
  const isActive = displayRun?.status === "running" || displayRun?.status === "paused"

  useEffect(() => {
    if (!isActive) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isActive])

  useEffect(() => {
    const headers: HeadersInit = authToken ? { Authorization: `Bearer ${authToken}` } : {}

    async function load() {
      try {
        const [logsRes, runsRes] = await Promise.all([
          fetch(`${API_BASE}/api/runs/${runId}/logs`, { headers }),
          liveRun
            ? Promise.resolve(null)
            : fetch(`${API_BASE}/api/runs?coverageId=${coverageId}`, { headers }),
        ])
        const logsData = await logsRes.json().catch(() => [])
        setLogs(Array.isArray(logsData) ? logsData : [])
        if (runsRes) {
          const runs: CoverageRun[] = await runsRes.json().catch(() => [])
          const found = runs.find((r) => r.id === runId)
          if (found) setRun(found)
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [runId, coverageId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isActive) return
    const headers: HeadersInit = authToken ? { Authorization: `Bearer ${authToken}` } : {}
    const id = setInterval(async () => {
      const res = await fetch(`${API_BASE}/api/runs/${runId}/logs`, { headers }).catch(() => null)
      if (!res?.ok) return
      const data = await res.json().catch(() => [])
      if (Array.isArray(data)) setLogs(data)
    }, 2000)
    return () => clearInterval(id)
  }, [isActive, runId, authToken])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs.length])

  const startMs = displayRun?.startedAt ? new Date(displayRun.startedAt).getTime() : null
  const endMs = displayRun?.endedAt ? new Date(displayRun.endedAt).getTime() : null
  const durationMs = startMs ? (endMs ?? now) - startMs : 0
  const progress = displayRun && displayRun.total > 0
    ? (displayRun.done + displayRun.skipped) / displayRun.total
    : 0

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={onBack}
            className="text-white/40 hover:text-white/70 text-xs transition-colors mb-2 flex items-center gap-1"
          >
            ← {coverageName}
          </button>
          <div className="flex items-center gap-3 mt-1">
            <h1 className="text-xl font-semibold tracking-tight">Run detail</h1>
            {displayRun && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[displayRun.status]}`}>
                {displayRun.status}
              </span>
            )}
            {displayRun?.mode && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/5 text-white/30">
                {displayRun.mode}
              </span>
            )}
          </div>
          {displayRun?.startedAt && (
            <p className="text-white/30 text-xs mt-1">{fmtDatetime(displayRun.startedAt)}</p>
          )}
        </div>

        {loading && !displayRun && (
          <p className="text-white/30 text-sm">Loading…</p>
        )}

        {displayRun && (
          <>
            {isActive && (
              <RunProgressBar
                total={displayRun.total}
                processed={displayRun.done + displayRun.skipped}
                isActive={isActive}
                className="mb-6"
              />
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-3 gap-2 mb-6">
              <StatCell label="Downloaded" value={displayRun.done.toLocaleString()} />
              <StatCell label="Skipped" value={displayRun.skipped.toLocaleString()} />
              <StatCell
                label="Failed"
                value={displayRun.failed > 0 ? displayRun.failed.toLocaleString() : "0"}
              />
              <StatCell label="Total tiles" value={displayRun.total.toLocaleString()} />
              <StatCell label="Downloaded size" value={
                displayRun.bytes > 0
                  ? `${(displayRun.bytes / 1024 ** 2).toFixed(1)} MB`
                  : "0 B"
              } />
              <StatCell label="Duration" value={
                durationMs > 0
                  ? (() => {
                      const s = Math.floor(durationMs / 1000)
                      const m = Math.floor(s / 60)
                      const h = Math.floor(m / 60)
                      if (h > 0) return `${h}h ${m % 60}m`
                      if (m > 0) return `${m}m ${s % 60}s`
                      return `${s}s`
                    })()
                  : "—"
              } />
            </div>

            {/* Logs */}
            <div className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                <p className="text-xs font-medium text-white/50">Worker logs</p>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-white/20">{logs.length} entries</span>
                  {isActive && (
                    <span className="text-xs text-blue-400 animate-pulse">live</span>
                  )}
                </div>
              </div>
              <div className="p-4 h-96 overflow-y-auto font-mono">
                {logs.length === 0 && (
                  <p className="text-white/20 text-xs">No logs available yet</p>
                )}
                {logs.map((log, i) => {
                  const isError = log.includes("Tile error") || log.includes("error")
                  return (
                    <div
                      key={i}
                      className={`text-xs py-0.5 leading-relaxed ${isError ? "text-red-400/70" : "text-white/40"}`}
                    >
                      {log}
                    </div>
                  )
                })}
                <div ref={logsEndRef} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
