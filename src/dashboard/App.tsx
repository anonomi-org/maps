import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CleanupProgress, Coverage, CoverageRun, LogSettings, RetentionUnit, RunMode, ServerState, SSEEvent, TileMap } from "../types"
import { fmtBytes } from "./utils"
import { CoverageCard } from "./components/CoverageCard"
import { NewCoverageModal } from "./components/NewCoverageModal"
import { MapCard } from "./components/MapCard"
import { NewMapModal } from "./components/NewMapModal"
import { SetupScreen } from "./components/SetupScreen"
import { LoginScreen } from "./components/LoginScreen"
import { RunDetailView } from "./components/RunDetailView"
import { CoverageDetailView } from "./components/CoverageDetailView"
import { ShareModal } from "./components/ShareModal"

type AppNotification = {
  id: string
  kind: "info" | "success" | "partial" | "error"
  title: string
  detail: string
  timestamp: number
}

async function apiGet(path: string, token: string | null = null) {
  const res = await fetch(`/api/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) return { __unauthorized: true }
  return res.json().catch(() => ({}))
}

async function apiPost(path: string, body: object, token: string | null = null) {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) return { __unauthorized: true }
  return res.json().catch(() => ({}))
}

export default function App() {
  const [serverState, setServerState] = useState<ServerState | null>(null)
  const [connected, setConnected] = useState(false)
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null)
  const [showNewMapModal, setShowNewMapModal] = useState(false)
  const [showNewCoverageModal, setShowNewCoverageModal] = useState(false)
  const [editingCoverage, setEditingCoverage] = useState<Coverage | null>(null)
  const [sortBy, setSortBy] = useState<"status" | "name" | "queue">("status")
  const [coverageSearch, setCoverageSearch] = useState("")
  const [deletingCoverage, setDeletingCoverage] = useState<Coverage | null>(null)
  const [deletingMapIds, setDeletingMapIds] = useState<Set<string>>(new Set())
  const [cleanups, setCleanups] = useState<Record<string, CleanupProgress>>({})
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [scheduledQueue, setScheduledQueue] = useState<string[]>([])
  const latestCoveragesRef = useRef<Coverage[]>([])
  const knownRunIdsRef = useRef(new Set<string>())
  const [showSettings, setShowSettings] = useState(false)
  const [outputDirInput, setOutputDirInput] = useState("")
  const [outputDirSaving, setOutputDirSaving] = useState(false)
  const [outputDirSaved, setOutputDirSaved] = useState(false)
  const [outputDirError, setOutputDirError] = useState("")
  const [onionUrlInput, setOnionUrlInput] = useState("")
  const [onionUrlSaving, setOnionUrlSaving] = useState(false)
  const [onionUrlSaved, setOnionUrlSaved] = useState(false)
  const [shareMap, setShareMap] = useState<TileMap | null>(null)
  const [showServerShare, setShowServerShare] = useState(false)
  const [logRetentionValue, setLogRetentionValue] = useState(30)
  const [logRetentionUnit, setLogRetentionUnit] = useState<RetentionUnit>("days")
  const [logRetentionSaving, setLogRetentionSaving] = useState(false)
  const [logRetentionSaved, setLogRetentionSaved] = useState(false)
  const [orphanScan, setOrphanScan] = useState<{ orphanBytes: number; orphanFolders: string[] } | null>(null)
  const [orphanScanning, setOrphanScanning] = useState(false)
  const [purgeConfirm, setPurgeConfirm] = useState(false)
  const [purging, setPurging] = useState(false)
  const [purgeResult, setPurgeResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [accountUsername, setAccountUsername] = useState("")
  const [accountCurrentPass, setAccountCurrentPass] = useState("")
  const [accountNewPass, setAccountNewPass] = useState("")
  const [accountConfirm, setAccountConfirm] = useState("")
  const [accountError, setAccountError] = useState("")
  const [accountSuccess, setAccountSuccess] = useState("")
  const [accountSaving, setAccountSaving] = useState(false)

  // Run actions used to be fire-and-forget: the response was thrown away, so a
  // rejected request looked exactly like a button that did nothing. The server
  // refuses to start a coverage that already has an active run, which is easy to
  // hit after pausing one, and there was no way to tell from the UI.
  async function runAction(path: string, body: object, label: string) {
    const res = await apiPost(path, body, authToken)
    if (res?.__unauthorized) { handleUnauthorized(); return }
    if (res?.error) {
      setNotifications((prev) => [
        {
          id: `run-action-error-${Date.now()}`,
          kind: "error" as const,
          title: `${label} failed`,
          detail: String(res.error),
          timestamp: Date.now(),
        },
        ...prev,
      ])
    }
  }

  const [selectedCoverageId, setSelectedCoverageId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedRunCoverageId, setSelectedRunCoverageId] = useState<string | null>(null)

  const [authToken, setAuthToken] = useState<string | null>(
    () => localStorage.getItem("authToken"),
  )
  const [authStatus, setAuthStatus] = useState<"loading" | "setup" | "login" | "app">("loading")

  function handleAuthDone(token: string) {
    localStorage.setItem("authToken", token)
    setAuthToken(token)
    setAuthStatus("app")
  }

  function handleUnauthorized() {
    localStorage.removeItem("authToken")
    setAuthToken(null)
    setAuthStatus("login")
  }

  // On mount: check whether setup is needed or the stored token is valid
  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then(({ setup }) => {
        if (setup) { setAuthStatus("setup"); return }
        if (!localStorage.getItem("authToken")) { setAuthStatus("login"); return }
        setAuthStatus("app")
      })
      .catch(() => setAuthStatus("app"))
  }, [])

  useEffect(() => {
    if (authStatus !== "app") return

    let es: EventSource
    let retryTimer: ReturnType<typeof setTimeout>

    function connect() {
      // In dev, bypass the Vite proxy for SSE, since it buffers chunks and breaks real-time updates.
      // In production, Bun serves everything so the relative URL works fine.
      const base = import.meta.env.DEV ? "http://localhost:3001" : ""
      const sseUrl = `${base}/api/events${authToken ? `?token=${authToken}` : ""}`
      es = new EventSource(sseUrl)

      es.onopen = () => setConnected(true)

      es.onmessage = (e: MessageEvent) => {
        const event = JSON.parse(e.data) as SSEEvent

        if (event.type === "state") {
          latestCoveragesRef.current = event.payload.coverages
          // Mark already-active runs as known so reconnect doesn't re-notify "started"
          for (const r of event.payload.activeRuns) knownRunIdsRef.current.add(r.id)
          setServerState(event.payload)
        } else if (event.type === "run") {
          const run = event.payload
          const covName =
            latestCoveragesRef.current.find((c) => c.id === run.coverageId)?.name ?? "Coverage"

          if (run.status === "running" && !knownRunIdsRef.current.has(run.id)) {
            // First time we see this run, so notify started (covers both manual and scheduled)
            knownRunIdsRef.current.add(run.id)
            setNotifications((prev) => [
              {
                id: `run-start-${run.id}`,
                kind: "info",
                title: "Run started",
                detail: covName,
                timestamp: Date.now(),
              },
              ...prev,
            ])
          }

          if (run.status === "done" || run.status === "error") {
            knownRunIdsRef.current.delete(run.id)
            let kind: AppNotification["kind"]
            let title: string
            let detail: string
            if (run.status === "error") {
              kind = "error"
              title = "Run failed"
              detail = `${covName}: ${run.error ?? "unknown error"}`
            } else if (run.failed > 0) {
              kind = "partial"
              title = "Run complete with errors"
              detail = `${covName}: ${run.done.toLocaleString()} downloaded, ${run.failed.toLocaleString()} failed`
            } else {
              kind = "success"
              title = "Run complete"
              const size = run.bytes > 0 ? ` · ${fmtBytes(run.bytes)}` : ""
              detail = `${covName}: ${run.done.toLocaleString()} tiles${size}`
            }
            setNotifications((prev) => [
              { id: `run-end-${run.id}`, kind, title, detail, timestamp: Date.now() },
              ...prev,
            ])
          }

          setServerState((prev) => {
            if (!prev) return prev
            const isActive = run.status === "queued" || run.status === "running" || run.status === "paused"
            const existing = prev.activeRuns.find((r) => r.id === run.id)
            let activeRuns: CoverageRun[]
            if (isActive) {
              activeRuns = existing
                ? prev.activeRuns.map((r) => (r.id === run.id ? run : r))
                : [...prev.activeRuns, run]
            } else {
              activeRuns = prev.activeRuns.filter((r) => r.id !== run.id)
            }
            return { ...prev, activeRuns }
          })
        } else if (event.type === "coverage") {
          const cov = event.payload
          latestCoveragesRef.current = latestCoveragesRef.current.find((c) => c.id === cov.id)
            ? latestCoveragesRef.current.map((c) => (c.id === cov.id ? cov : c))
            : [...latestCoveragesRef.current, cov]
          setServerState((prev) => {
            if (!prev) return prev
            const exists = prev.coverages.find((c) => c.id === cov.id)
            const coverages = exists
              ? prev.coverages.map((c) => (c.id === cov.id ? cov : c))
              : [...prev.coverages, cov]
            return { ...prev, coverages }
          })
        } else if (event.type === "queue") {
          setScheduledQueue(event.payload)
        } else if (event.type === "cleanup") {
          const cp = event.payload
          if (cp.done) {
            // Notify and remove progress bar after a short delay
            setNotifications((prev) => [
              {
                id: `cleanup-${cp.coverageId}`,
                kind: cp.error ? "error" : "success",
                title: cp.error ? "Cleanup failed" : "Cleanup complete",
                detail: cp.error
                  ? `${cp.coverageName}: ${cp.error}`
                  : `${cp.coverageName}: ${cp.deleted.toLocaleString()} tiles deleted, ${cp.skipped.toLocaleString()} shared tiles kept`,
                timestamp: Date.now(),
              },
              ...prev,
            ])
            setTimeout(
              () => setCleanups((p) => { const n = { ...p }; delete n[cp.coverageId]; return n }),
              2000,
            )
          }
          setCleanups((prev) => ({ ...prev, [cp.coverageId]: cp }))
        }
      }

      es.onerror = async () => {
        setConnected(false)
        es.close()
        // Check if the SSE failure was due to an expired/invalid token
        if (authToken) {
          try {
            const checkUrl = import.meta.env.DEV ? "http://localhost:3001/api/auth/check" : "/api/auth/check"
            const r = await fetch(checkUrl, { headers: { Authorization: `Bearer ${authToken}` } })
            if (r.status === 401) { handleUnauthorized(); return }
          } catch { /* network error, not auth */ }
        }
        retryTimer = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      clearTimeout(retryTimer)
      es?.close()
    }
  }, [authToken, authStatus])

  // Reset selection if the selected map was deleted
  useEffect(() => {
    if (
      selectedMapId &&
      serverState &&
      !serverState.maps.find((m) => m.id === selectedMapId)
    ) {
      setSelectedMapId(null)
    }
  }, [serverState?.maps, selectedMapId])

  // Reset selection if the selected coverage was deleted
  useEffect(() => {
    if (
      selectedCoverageId &&
      serverState &&
      !serverState.coverages.find((c) => c.id === selectedCoverageId)
    ) {
      setSelectedCoverageId(null)
    }
  }, [serverState?.coverages, selectedCoverageId])

  const handleCreateMap = useCallback(async (data: { name: string; description: string; discoverable: boolean }) => {
    const res = await apiPost("maps/create", data, authToken)
    if (res?.__unauthorized) { handleUnauthorized(); return }
    setShowNewMapModal(false)
    if (res?.map) {
      setServerState((prev) => {
        if (!prev || prev.maps.find((m) => m.id === res.map.id)) return prev
        return { ...prev, maps: [...prev.maps, res.map] }
      })
      setNotifications((prev) => [
        {
          id: `map-create-${res.map.id}`,
          kind: "success",
          title: "Map created",
          detail: res.map.name,
          timestamp: Date.now(),
        },
        ...prev,
      ])
    }
  }, [authToken])

  const handleToggleDiscoverable = useCallback(async (map: TileMap) => {
    await apiPost("maps/update", { id: map.id, discoverable: !map.discoverable }, authToken)
  }, [authToken])

  const handleCreateCoverage = useCallback(
    async (data: object) => {
      const res = await apiPost("coverages/create", { ...data, mapId: selectedMapId }, authToken)
      if (res?.__unauthorized) { handleUnauthorized(); return }
      setShowNewCoverageModal(false)
      if (res?.coverage) {
        setServerState((prev) => {
          if (!prev || prev.coverages.find((c) => c.id === res.coverage.id)) return prev
          return { ...prev, coverages: [...prev.coverages, res.coverage] }
        })
      }
    },
    [selectedMapId, authToken],
  )

  const handleEditCoverage = useCallback(async (data: object) => {
    if (!editingCoverage) return
    await apiPost("coverages/update", { id: editingCoverage.id, ...data }, authToken)
    setEditingCoverage(null)
  }, [editingCoverage, authToken])

  function optimisticRun(runId: string, patch: Partial<CoverageRun> | "remove") {
    setServerState((prev) => {
      if (!prev) return prev
      if (patch === "remove") {
        return { ...prev, activeRuns: prev.activeRuns.filter((r) => r.id !== runId) }
      }
      return {
        ...prev,
        activeRuns: prev.activeRuns.map((r) => (r.id === runId ? { ...r, ...patch } : r)),
      }
    })
  }

  async function handleDeleteMap(map: TileMap) {
    setDeletingMapIds((prev) => new Set([...prev, map.id]))
    const res = await apiPost("maps/delete", { id: map.id }, authToken)
    if (res?.__unauthorized) { handleUnauthorized(); return }
    if (res?.error) {
      setDeletingMapIds((prev) => { const n = new Set(prev); n.delete(map.id); return n })
      setNotifications((prev) => [
        { id: `map-delete-err-${map.id}`, kind: "error", title: "Cannot delete map", detail: res.error, timestamp: Date.now() },
        ...prev,
      ])
      return
    }
    setNotifications((prev) => [
      { id: `map-delete-${map.id}`, kind: "info", title: "Map deleted", detail: map.name, timestamp: Date.now() },
      ...prev,
    ])
  }

  async function handleDeleteCoverage(coverage: Coverage) {
    setDeletingCoverage(null)
    // Optimistic removal
    setServerState((prev) =>
      prev ? { ...prev, coverages: prev.coverages.filter((c) => c.id !== coverage.id) } : prev,
    )
    await apiPost("coverages/delete", { id: coverage.id }, authToken)
  }

  async function handleSaveOutputDir() {
    setOutputDirSaving(true)
    setOutputDirError("")
    const res = await apiPost("config/update", { outputDir: outputDirInput }, authToken)
    setOutputDirSaving(false)
    if (res?.__unauthorized) { handleUnauthorized(); return }
    if (res?.error) {
      // The server rejects a path it cannot use. Saying nothing here left the
      // form looking like it had saved.
      setOutputDirError(res.error)
      return
    }
    setOutputDirInput("")
    setOutputDirSaved(true)
    setTimeout(() => setOutputDirSaved(false), 2000)
  }

  async function handleSaveOnionUrl() {
    setOnionUrlSaving(true)
    const res = await apiPost("config/update", { onionUrl: onionUrlInput }, authToken)
    setOnionUrlSaving(false)
    if (res?.__unauthorized) { handleUnauthorized(); return }
    if (!res?.error) {
      setOnionUrlInput("")
      setOnionUrlSaved(true)
      setTimeout(() => setOnionUrlSaved(false), 2000)
    }
  }

  async function handlePurge() {
    setPurging(true)
    setPurgeConfirm(false)
    setPurgeResult(null)
    const res = await apiPost("disk/purge", {}, authToken)
    setPurging(false)
    if (res?.__unauthorized) { handleUnauthorized(); return }
    if (res?.error) {
      setPurgeResult({ ok: false, message: res.error })
      return
    }
    setOrphanScan(null)
    const n = res.foldersToDelete ?? 0
    setPurgeResult({
      ok: true,
      message: n === 0
        ? "Nothing to delete. Disk was already empty."
        : `Stats reset. Deleting ${n} folder${n !== 1 ? "s" : ""} from disk in the background.`,
    })
  }

  async function handleOrphanScan() {
    setOrphanScanning(true)
    const res = await apiPost("disk/scan", {}, authToken)
    setOrphanScanning(false)
    if (res?.__unauthorized) { handleUnauthorized(); return }
    if (res?.error) {
      setNotifications((prev) => [
        { id: `orphan-scan-err-${Date.now()}`, kind: "error", title: "Orphan scan failed", detail: res.error, timestamp: Date.now() },
        ...prev,
      ])
      return
    }
    setOrphanScan(res)
  }

  const getActiveRun = (coverage: Coverage): CoverageRun | undefined => {
    const runs = serverState?.activeRuns.filter((r) => r.coverageId === coverage.id) ?? []
    // Prefer running/paused over queued in case of transient duplicates
    return runs.find((r) => r.status === "running" || r.status === "paused") ?? runs[0]
  }

  const queueOrderMap = useMemo(() => {
    const m = new Map<string, number>()
    let pos = 1
    for (const r of serverState?.activeRuns ?? []) {
      if (r.status === "queued") m.set(r.coverageId, pos++)
    }
    return m
  }, [serverState?.activeRuns])

  const getQueuePosition = (c: Coverage): number | undefined => queueOrderMap.get(c.id)

  // ---- MAP DETAIL VIEW ----
  const selectedMap = serverState?.maps.find((m) => m.id === selectedMapId)
  const mapCoverages = useMemo(
    () => (serverState?.coverages ?? []).filter((c) => c.mapId === selectedMapId),
    [serverState?.coverages, selectedMapId],
  )
  const filteredCoverages = useMemo(() => {
    const q = coverageSearch.trim().toLowerCase()
    if (!q) return mapCoverages

    const recurrencyLabel: Record<string, string> = {
      high: "weekly", normal: "monthly", low: "quarterly", none: "manual",
    }

    function fmtBytesSearch(n: number) {
      if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kb`
      if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} mb`
      return `${(n / 1024 ** 3).toFixed(2)} gb`
    }

    return mapCoverages.filter((c) => {
      const activeRun = serverState?.activeRuns.find((r) => r.coverageId === c.id)
      const statusTokens = activeRun
        ? [activeRun.status]
        : [c.lastRunStatus ?? "never", c.lastRunStatus === null ? "never run" : ""]
      if (c.nextRunAt && !activeRun) statusTokens.push("scheduled")

      const searchable = [
        c.name,
        c.type,
        recurrencyLabel[c.recurrency],
        ...statusTokens,
        ...c.regions.map((r) => r.name),
        c.sizeBytes > 0 ? fmtBytesSearch(c.sizeBytes) : "",
        c.tilesOnDisk > 0 ? `${c.tilesOnDisk} tiles` : "",
      ].join(" ").toLowerCase()

      return searchable.includes(q)
    })
  }, [mapCoverages, coverageSearch, serverState?.activeRuns])

  // ---- AUTH ROUTING ----
  if (authStatus === "loading") {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <p className="text-white/30 text-sm">Loading…</p>
      </div>
    )
  }
  if (authStatus === "setup") return <SetupScreen onDone={handleAuthDone} />
  if (authStatus === "login") return <LoginScreen onDone={handleAuthDone} />

  // ---- RUN DETAIL VIEW ----
  if (selectedRunId && selectedRunCoverageId) {
    const liveRun = serverState?.activeRuns.find((r) => r.id === selectedRunId)
    const coverage = serverState?.coverages.find((c) => c.id === selectedRunCoverageId)
    return (
      <RunDetailView
        runId={selectedRunId}
        coverageId={selectedRunCoverageId}
        coverageName={coverage?.name ?? "Coverage"}
        authToken={authToken}
        liveRun={liveRun}
        onBack={() => { setSelectedRunId(null); setSelectedRunCoverageId(null) }}
      />
    )
  }

  // ---- COVERAGE DETAIL VIEW ----
  if (selectedCoverageId) {
    const coverage = serverState?.coverages.find((c) => c.id === selectedCoverageId)
    if (coverage) {
      const run = getActiveRun(coverage)
      const parentMap = serverState?.maps.find((m) => m.id === coverage.mapId)
      return (
        <>
          <CoverageDetailView
            coverage={coverage}
            activeRun={run}
            queuePosition={getQueuePosition(coverage)}
            authToken={authToken}
            mapName={parentMap?.name ?? "Map"}
            onBack={() => setSelectedCoverageId(null)}
            onRun={(mode) => {
              runAction("runs/start", { coverageId: coverage.id, mode }, "Start")
            }}
            onPause={() => {
              if (!run) return
              optimisticRun(run.id, { status: "paused" })
              runAction("runs/pause", { runId: run.id }, "Pause")
            }}
            onResume={() => {
              if (!run) return
              optimisticRun(run.id, { status: "running" })
              runAction("runs/resume", { runId: run.id }, "Resume")
            }}
            onCancel={() => {
              if (!run) return
              optimisticRun(run.id, "remove")
              runAction("runs/cancel", { runId: run.id }, "Cancel")
            }}
            onEdit={() => setEditingCoverage(coverage)}
            onDelete={() => setDeletingCoverage(coverage)}
            onViewRun={(runId) => {
              setSelectedRunId(runId)
              setSelectedRunCoverageId(coverage.id)
            }}
          />
          {editingCoverage && (
            <NewCoverageModal
              serverTransport={serverState?.tileTransport}
              onClose={() => setEditingCoverage(null)}
              onSubmit={handleEditCoverage}
              initialCoverage={editingCoverage}
              hasActiveRun={!!getActiveRun(editingCoverage)}
              authToken={authToken}
            />
          )}
          {deletingCoverage && (
            <DeleteCoverageModal
              coverage={deletingCoverage}
              onClose={() => setDeletingCoverage(null)}
              onConfirm={() => handleDeleteCoverage(deletingCoverage)}
            />
          )}
          {showNotifications && (
            <NotificationPanel
              notifications={notifications}
              onDismiss={(id) => setNotifications((prev) => prev.filter((n) => n.id !== id))}
              onClearAll={() => setNotifications([])}
              onClose={() => setShowNotifications(false)}
            />
          )}
        </>
      )
    }
  }

  if (selectedMapId && selectedMap) {
    // Aggregate stats
    const totalTiles = mapCoverages.reduce((s, c) => s + c.tilesOnDisk, 0)
    const totalBytes = mapCoverages.reduce((s, c) => s + c.sizeBytes, 0)
    const runningCount = mapCoverages.filter((c) => {
      const r = getActiveRun(c); return r?.status === "running" || r?.status === "paused"
    }).length
    const queuedCount = mapCoverages.filter((c) => getActiveRun(c)?.status === "queued").length
    const scheduledCount = mapCoverages.filter((c) => c.nextRunAt && !getActiveRun(c)).length

    // How many of the download slots are taken
    const concurrency = serverState?.maxConcurrentRuns ?? 2
    const activeSlots = (serverState?.activeRuns ?? []).filter(r => r.status === "running" || r.status === "paused").length
    const freeSlots = Math.max(0, concurrency - activeSlots)

    function coverageStatusRank(c: Coverage): number {
      const run = getActiveRun(c)
      if (run?.status === "running") return 0
      if (run?.status === "paused") return 1
      if (run?.status === "queued") return 2
      if (c.nextRunAt) return 3
      if (c.lastRunStatus === "success" || c.lastRunStatus === "partial") return 4
      if (c.lastRunStatus === "failed") return 5
      if (c.lastRunStatus === "cancelled") return 6
      return 7
    }

    const sortedCoverages = [...filteredCoverages].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name)
      if (sortBy === "queue") {
        const runA = getActiveRun(a), runB = getActiveRun(b)
        const rankA = (runA?.status === "running" || runA?.status === "paused") ? 0
          : runA?.status === "queued" ? 1
          : a.nextRunAt ? 2
          : a.lastRunAt ? 3
          : 4
        const rankB = (runB?.status === "running" || runB?.status === "paused") ? 0
          : runB?.status === "queued" ? 1
          : b.nextRunAt ? 2
          : b.lastRunAt ? 3
          : 4
        if (rankA !== rankB) return rankA - rankB
        if (rankA === 0) {
          const tA = runA?.startedAt ? new Date(runA.startedAt).getTime() : 0
          const tB = runB?.startedAt ? new Date(runB.startedAt).getTime() : 0
          return tA !== tB ? tA - tB : a.name.localeCompare(b.name)
        }
        if (rankA === 1) {
          const pA = queueOrderMap.get(a.id) ?? 999
          const pB = queueOrderMap.get(b.id) ?? 999
          return pA !== pB ? pA - pB : a.name.localeCompare(b.name)
        }
        if (rankA === 2) {
          const tA = new Date(a.nextRunAt!).getTime()
          const tB = new Date(b.nextRunAt!).getTime()
          return tA !== tB ? tA - tB : a.name.localeCompare(b.name)
        }
        if (rankA === 3) {
          const tA = new Date(a.lastRunAt!).getTime()
          const tB = new Date(b.lastRunAt!).getTime()
          return tA !== tB ? tB - tA : a.name.localeCompare(b.name)
        }
        return a.name.localeCompare(b.name)
      }
      const rankDiff = coverageStatusRank(a) - coverageStatusRank(b)
      return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name)
    })

    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <div className="max-w-3xl mx-auto px-6 py-10">
          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <button
                onClick={() => setSelectedMapId(null)}
                className="text-white/40 hover:text-white/70 text-xs transition-colors mb-2 flex items-center gap-1"
              >
                ← Maps
              </button>
              <h1 className="text-xl font-semibold tracking-tight">{selectedMap.name}</h1>
              <p className="text-white/40 text-sm mt-0.5">
                {selectedMap.description || "No description"}
              </p>
            </div>
            <div className="flex gap-2">
              <NotificationBell count={notifications.length} onClick={() => setShowNotifications(true)} />
              <ShareButton onClick={() => setShareMap(selectedMap)} />
              <button
                onClick={() => setShowNewCoverageModal(true)}
                className="px-4 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium transition-colors hover:bg-blue-400"
              >
                New Coverage
              </button>
            </div>
          </div>

          {/* Map stats */}
          {mapCoverages.length > 0 && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-white/40 mb-8 pb-6 border-b border-white/5">
              <span>
                <span className="text-white/70">{mapCoverages.length}</span>{" "}
                coverage{mapCoverages.length !== 1 ? "s" : ""}
              </span>
              {totalTiles > 0 && (
                <span>
                  <span className="text-white/70">{totalTiles.toLocaleString()}</span> tiles on disk
                </span>
              )}
              {totalBytes > 0 && (
                <span><span className="text-white/70">{fmtBytes(totalBytes)}</span> on disk</span>
              )}
              {runningCount > 0 && (
                <span className="text-blue-400">
                  {runningCount} running
                </span>
              )}
              {scheduledCount > 0 && (
                <span>
                  <span className="text-white/70">{scheduledCount}</span> scheduled
                </span>
              )}
              {queuedCount > 0 && (
                <span className="text-purple-400">
                  {queuedCount} queued
                </span>
              )}
              <span className={freeSlots === 0 && activeSlots > 0 ? "text-white/60" : "text-white/25"}>
                {activeSlots}/{concurrency} workers
                {freeSlots > 0 && <span className="text-white/25"> · {freeSlots} free</span>}
              </span>
            </div>
          )}

          {mapCoverages.length === 0 && (
            <p className="text-center text-white/30 py-20 text-sm">
              No coverages yet. Click "New Coverage" to get started.
            </p>
          )}

          {/* Search + sort toolbar */}
          {mapCoverages.length > 0 && (
            <div className="flex items-center gap-3 mb-4">
              <input
                type="text"
                value={coverageSearch}
                onChange={(e) => setCoverageSearch(e.target.value)}
                placeholder="Search coverages…"
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-white/25"
              />
              {mapCoverages.length > 1 && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs text-white/25 mr-0.5">Sort</span>
                  {(["status", "name", "queue"] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setSortBy(opt)}
                      className={`px-2.5 py-1 rounded-lg text-xs transition-colors capitalize ${
                        sortBy === opt
                          ? "bg-white/10 text-white/80"
                          : "text-white/30 hover:text-white/60"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {coverageSearch && sortedCoverages.length === 0 && (
            <p className="text-center text-white/30 py-10 text-sm">
              No coverages match "{coverageSearch}"
            </p>
          )}

          <div className="flex flex-col gap-4">
            {(() => {
              const QUEUE_TIERS: { tier: number; label: string }[] = [
                { tier: 0, label: "Active" },
                { tier: 1, label: "Queued" },
                { tier: 2, label: "Scheduled" },
                { tier: 3, label: "Recently run" },
                { tier: 4, label: "Never run" },
              ]
              function getQueueTier(c: Coverage): number {
                const r = getActiveRun(c)
                if (r?.status === "running" || r?.status === "paused") return 0
                if (r?.status === "queued") return 1
                if (c.nextRunAt) return 2
                if (c.lastRunAt) return 3
                return 4
              }

              let lastTier = -1
              return sortedCoverages.map((coverage, index) => {
                const run = getActiveRun(coverage)
                const tier = sortBy === "queue" ? getQueueTier(coverage) : -1
                const showHeader = sortBy === "queue" && tier !== lastTier
                if (showHeader) lastTier = tier
                const tierLabel = showHeader ? QUEUE_TIERS.find((t) => t.tier === tier)?.label : null
                return (
                  <div key={coverage.id}>
                    {tierLabel && (
                      <div className="flex items-center gap-2 mb-2 mt-1">
                        <span className="text-xs text-white/25">{tierLabel}</span>
                        <div className="flex-1 h-px bg-white/5" />
                      </div>
                    )}
                    <CoverageCard
                      coverage={coverage}
                      activeRun={run}
                      queuePosition={getQueuePosition(coverage)}
                      sortPosition={sortBy === "queue" ? index + 1 : undefined}
                      authToken={authToken}
                      onOpen={() => setSelectedCoverageId(coverage.id)}
                      onViewRun={(runId) => {
                        setSelectedCoverageId(coverage.id)
                        setSelectedRunId(runId)
                        setSelectedRunCoverageId(coverage.id)
                      }}
                      onRun={(mode: RunMode) => {
                        runAction("runs/start", { coverageId: coverage.id, mode }, "Start")
                      }}
                      onPause={() => {
                        if (!run) return
                        optimisticRun(run.id, { status: "paused" })
                        runAction("runs/pause", { runId: run.id }, "Pause")
                      }}
                      onResume={() => {
                        if (!run) return
                        optimisticRun(run.id, { status: "running" })
                        runAction("runs/resume", { runId: run.id }, "Resume")
                      }}
                      onCancel={() => {
                        if (!run) return
                        optimisticRun(run.id, "remove")
                        runAction("runs/cancel", { runId: run.id }, "Cancel")
                      }}
                      onEdit={() => setEditingCoverage(coverage)}
                      onDelete={() => setDeletingCoverage(coverage)}
                    />
                  </div>
                )
              })
            })()}
          </div>
        </div>

        {/* Active cleanup progress, shown for recently deleted coverages of this map */}
        {Object.values(cleanups).map((cp) => (
            <div
              key={cp.coverageId}
              className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3"
            >
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs text-white/50">
                  Cleaning up <span className="text-white/70">{cp.coverageName}</span>
                </p>
                <span className={`text-xs ${cp.done ? "text-green-400" : "text-white/30"}`}>
                  {cp.done ? "Done" : "Running…"}
                </span>
              </div>
              <div className="h-1 rounded-full bg-white/10 overflow-hidden mb-1.5">
                {!cp.done && <div className="h-full bg-blue-400/50 animate-pulse w-full" />}
                {cp.done && <div className="h-full bg-green-400 w-full" />}
              </div>
              <p className="text-xs text-white/30">
                {cp.deleted.toLocaleString()} deleted · {cp.skipped.toLocaleString()} shared (kept) · {cp.checked.toLocaleString()} checked
              </p>
            </div>
          ))}

        {showNewCoverageModal && (
          <NewCoverageModal
            serverTransport={serverState?.tileTransport}
            onClose={() => setShowNewCoverageModal(false)}
            onSubmit={handleCreateCoverage}
            authToken={authToken}
          />
        )}
        {editingCoverage && (
          <NewCoverageModal
            serverTransport={serverState?.tileTransport}
            onClose={() => setEditingCoverage(null)}
            onSubmit={handleEditCoverage}
            initialCoverage={editingCoverage}
            hasActiveRun={!!getActiveRun(editingCoverage)}
            authToken={authToken}
          />
        )}
        {deletingCoverage && (
          <DeleteCoverageModal
            coverage={deletingCoverage}
            onClose={() => setDeletingCoverage(null)}
            onConfirm={() => handleDeleteCoverage(deletingCoverage)}
          />
        )}
        {showNotifications && (
          <NotificationPanel
            notifications={notifications}
            onDismiss={(id) => setNotifications((prev) => prev.filter((n) => n.id !== id))}
            onClearAll={() => setNotifications([])}
            onClose={() => setShowNotifications(false)}
          />
        )}
        {shareMap && (
          <ShareModal
            title={`Share "${shareMap.name}"`}
            url={serverState?.onionUrl ? `${serverState.onionUrl}/${shareMap.id}` : null}
            hint="Scan with Anonomi Messenger to import this map."
            onClose={() => setShareMap(null)}
          />
        )}
      </div>
    )
  }

  // ---- SETTINGS VIEW ----
  if (showSettings) {
    const currentDir = serverState?.outputDir ?? ""
    const dirOk = serverState?.outputDirOk ?? false

    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <div className="max-w-3xl mx-auto px-6 py-10">
          <div className="mb-8">
            <button
              onClick={() => setShowSettings(false)}
              className="text-white/40 hover:text-white/70 text-xs transition-colors mb-2 flex items-center gap-1"
            >
              ← Maps
            </button>
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-white/40 text-sm mt-0.5">Maps configuration</p>
          </div>

          <div className="space-y-4">
            {/* Output directory */}
            <div className="rounded-2xl border border-white/10 bg-black/30 p-6 space-y-3">
              <div>
                <label className="text-xs font-medium text-white/50 block mb-1">Output directory</label>
                <p className="text-xs text-white/30 mb-3">
                  Where tile files are written. Must be an accessible path (local or network mount).
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={outputDirInput || currentDir}
                    onChange={(e) => setOutputDirInput(e.target.value)}
                    placeholder="/Volumes/YourDisk/tiles"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30 font-mono"
                  />
                  <button
                    onClick={handleSaveOutputDir}
                    disabled={outputDirSaving || !(outputDirInput || currentDir)}
                    className={`px-4 py-2 rounded-xl text-white text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${outputDirSaved ? "bg-green-600 hover:bg-green-500" : "bg-blue-500 hover:bg-blue-400"}`}
                  >
                    {outputDirSaving ? "Saving…" : outputDirSaved ? "Saved ✓" : "Save"}
                  </button>
                </div>
                {outputDirError && (
                  <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2 mt-2">{outputDirError}</p>
                )}
                {currentDir && !outputDirError && (
                  <p className={`text-xs mt-2 ${dirOk ? "text-green-400" : "text-red-400"}`}>
                    {dirOk ? "✓ Directory is accessible" : "✗ Directory not accessible"}
                  </p>
                )}
              </div>
            </div>

            {/* Storage */}
            <div className="rounded-2xl border border-white/10 bg-black/30 p-6 space-y-4">
              <p className="text-xs font-medium text-white/50">Storage</p>

              {/* Per-map breakdown, always visible, from serverState */}
              {serverState && serverState.maps.length > 0 ? (
                <div className="space-y-1.5">
                  {serverState.maps.map((map) => {
                    const size = (serverState.coverages ?? [])
                      .filter((c) => c.mapId === map.id)
                      .reduce((s, c) => s + c.sizeBytes, 0)
                    return (
                      <div key={map.id} className="flex justify-between text-xs">
                        <span className="text-white/50 truncate mr-4">{map.name}</span>
                        <span className="text-white/40 tabular-nums flex-shrink-0">{fmtBytes(size)}</span>
                      </div>
                    )
                  })}
                  <p className="text-xs text-white/20 mt-1">Sizes from last validate run per coverage.</p>
                </div>
              ) : (
                <p className="text-xs text-white/20">No maps yet.</p>
              )}

              {/* Orphan check */}
              <div className="border-t border-white/5 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-white/50">Orphan folders</p>
                    <p className="text-xs text-white/25 mt-0.5">Folders on disk with no matching map.</p>
                  </div>
                  <button
                    onClick={handleOrphanScan}
                    disabled={orphanScanning}
                    className="px-3 py-1.5 rounded-lg bg-white/5 text-white/50 text-xs font-medium transition-colors hover:bg-white/10 hover:text-white/70 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {orphanScanning ? "Checking…" : "Check for orphans"}
                  </button>
                </div>
                {orphanScan && (
                  <div className="mt-3">
                    {orphanScan.orphanBytes > 0 ? (
                      <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-3">
                        <p className="text-xs text-yellow-400 font-medium mb-1">
                          {fmtBytes(orphanScan.orphanBytes)} in orphan folders
                        </p>
                        <p className="text-xs text-white/30">
                          {orphanScan.orphanFolders.length} folder{orphanScan.orphanFolders.length !== 1 ? "s" : ""} with no matching map:{" "}
                          <span className="font-mono">{orphanScan.orphanFolders.join(", ")}</span>
                        </p>
                        <p className="text-xs text-white/20 mt-1">
                          These can be safely deleted from {currentDir}
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-green-400">✓ No orphan folders found</p>
                    )}
                  </div>
                )}
              </div>

              {/* Purge all tiles */}
              <div className="border-t border-white/5 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-white/50">Purge all tiles</p>
                    <p className="text-xs text-white/25 mt-0.5">Delete every tile folder from disk and reset coverage stats.</p>
                  </div>
                  {purgeConfirm ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPurgeConfirm(false)}
                        className="px-3 py-1.5 rounded-lg bg-white/5 text-white/40 text-xs font-medium hover:text-white/60 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handlePurge}
                        disabled={purging}
                        className="px-3 py-1.5 rounded-lg bg-red-500/80 text-white text-xs font-medium hover:bg-red-500 transition-colors disabled:opacity-50"
                      >
                        {purging ? "Purging…" : "Yes, delete all tiles"}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setPurgeConfirm(true)}
                      disabled={purging}
                      className="px-3 py-1.5 rounded-lg bg-white/5 text-red-400/70 text-xs font-medium hover:bg-red-500/10 hover:text-red-400 transition-colors disabled:opacity-30"
                    >
                      Purge all tiles…
                    </button>
                  )}
                </div>
                {purgeResult && (
                  <p className={`text-xs mt-3 ${purgeResult.ok ? "text-white/40" : "text-red-400"}`}>
                    {purgeResult.ok ? "✓ " : "✗ "}{purgeResult.message}
                  </p>
                )}
              </div>
            </div>

            {/* Share */}
            <div className="rounded-2xl border border-white/10 bg-black/30 p-6 space-y-4">
              <p className="text-xs font-medium text-white/50">Share</p>

              {/* Onion URL */}
              <div>
                <label className="text-xs text-white/40 block mb-1.5">Onion URL</label>
                <p className="text-xs text-white/25 mb-2">
                  The .onion address where your tiles are served. Used to generate share links and QR codes.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={onionUrlInput || (serverState?.onionUrl ?? "")}
                    onChange={(e) => setOnionUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveOnionUrl()}
                    placeholder="http://youraddress.onion"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30 font-mono"
                  />
                  <button
                    onClick={handleSaveOnionUrl}
                    disabled={onionUrlSaving || !(onionUrlInput || serverState?.onionUrl)}
                    className={`px-4 py-2 rounded-xl text-white text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${onionUrlSaved ? "bg-green-600 hover:bg-green-500" : "bg-blue-500 hover:bg-blue-400"}`}
                  >
                    {onionUrlSaving ? "Saving…" : onionUrlSaved ? "Saved ✓" : "Save"}
                  </button>
                </div>
              </div>

            </div>

            {/* Log retention */}
            <div className="rounded-2xl border border-white/10 bg-black/30 p-6 space-y-4">
              <div>
                <p className="text-xs font-medium text-white/50 mb-1">Log retention</p>
                <p className="text-xs text-white/30 mb-3">
                  Run logs older than this are automatically deleted. Each coverage can override this with a custom retention period.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    value={logRetentionValue}
                    onChange={(e) => setLogRetentionValue(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-20 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30 tabular-nums"
                  />
                  <select
                    value={logRetentionUnit}
                    onChange={(e) => setLogRetentionUnit(e.target.value as RetentionUnit)}
                    className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                  >
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                    <option value="weeks">Weeks</option>
                    <option value="months">Months</option>
                    <option value="years">Years</option>
                  </select>
                  <button
                    onClick={async () => {
                      setLogRetentionSaving(true)
                      const res = await apiPost("settings/logs", { retentionValue: logRetentionValue, retentionUnit: logRetentionUnit }, authToken)
                      setLogRetentionSaving(false)
                      if (res?.__unauthorized) { handleUnauthorized(); return }
                      if (!res?.error) {
                        setLogRetentionSaved(true)
                        setTimeout(() => setLogRetentionSaved(false), 2000)
                      }
                    }}
                    disabled={logRetentionSaving}
                    className={`px-4 py-2 rounded-xl text-white text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${logRetentionSaved ? "bg-green-600 hover:bg-green-500" : "bg-blue-500 hover:bg-blue-400"}`}
                  >
                    {logRetentionSaving ? "Saving…" : logRetentionSaved ? "Saved ✓" : "Save"}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-white/5">
                <div>
                  <p className="text-xs font-medium text-white/50">Automatic cleanup</p>
                  <p className="text-xs text-white/25 mt-0.5">Runs hourly in the background</p>
                </div>
                <button
                  onClick={async () => {
                    const paused = !serverState?.logSettings?.cleanerPaused
                    const res = await apiPost("settings/logs", { cleanerPaused: paused }, authToken)
                    if (res?.__unauthorized) handleUnauthorized()
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    serverState?.logSettings?.cleanerPaused
                      ? "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
                      : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70"
                  }`}
                >
                  {serverState?.logSettings?.cleanerPaused ? "Paused, click to resume" : "Running, click to pause"}
                </button>
              </div>
            </div>

            {/* Downloads */}
            <div className="rounded-2xl border border-white/10 bg-black/30 p-6">
              <p className="text-xs font-medium text-white/50 mb-1">Downloads</p>
              <p className="text-xs text-white/30 mb-4">
                How many coverages download at once. Anything beyond this waits its turn.
                Set <span className="font-mono text-white/50">maxConcurrentRuns</span> in config.json.
              </p>
              <p className="text-sm font-mono text-white/70">
                {serverState?.maxConcurrentRuns ?? 2} at a time
              </p>
              <div className="mt-4 pt-4 border-t border-white/5">
                <p className="text-xs text-white/30 mb-1.5">
                  Default connection for tile fetches. Set <span className="font-mono text-white/50">tileTransport</span> in config.json;
                  a coverage can override it.
                </p>
                <p className="text-sm font-mono text-white/70">
                  {serverState?.tileTransport === "tor" ? "Tor" : "Direct"}
                  {serverState?.tileTransport === "tor" && serverState?.torReachable === false && (
                    <span className="text-red-400">: tunnel not answering, runs will fail</span>
                  )}
                  {serverState?.tileTransport === "tor" && serverState?.torReachable === true && (
                    <span className="text-green-400/70">: verified</span>
                  )}
                </p>
              </div>
            </div>

            {/* Account */}
            <div className="rounded-2xl border border-white/10 bg-black/30 p-6">
              <p className="text-xs font-medium text-white/50 mb-1">Account</p>
              <p className="text-xs text-white/30 mb-4">
                Change your username or password. Current password is always required.
              </p>
              <form
                className="space-y-3"
                onSubmit={async (e) => {
                  e.preventDefault()
                  setAccountError("")
                  setAccountSuccess("")
                  if (!accountCurrentPass) {
                    setAccountError("Current password is required.")
                    return
                  }
                  if (accountNewPass && accountNewPass.length < 8) {
                    setAccountError("New password must be at least 8 characters.")
                    return
                  }
                  if (accountNewPass && accountNewPass !== accountConfirm) {
                    setAccountError("New passwords do not match.")
                    return
                  }
                  if (!accountUsername && !accountNewPass) {
                    setAccountError("Enter a new username or password to change.")
                    return
                  }
                  setAccountSaving(true)
                  const res = await apiPost("auth/change", {
                    currentPassword: accountCurrentPass,
                    ...(accountUsername ? { newUsername: accountUsername } : {}),
                    ...(accountNewPass ? { newPassword: accountNewPass } : {}),
                  }, authToken)
                  setAccountSaving(false)
                  if (res?.__unauthorized) { handleUnauthorized(); return }
                  if (res?.error) {
                    setAccountError(res.error)
                  } else {
                    // Force re-login to confirm new credentials work
                    await apiPost("auth/logout", {}, authToken)
                    localStorage.removeItem("authToken")
                    setAuthToken(null)
                    setAuthStatus("login")
                  }
                }}
              >
                <div>
                  <label className="text-xs font-medium text-white/50 block mb-1">New username</label>
                  <input
                    type="text"
                    value={accountUsername}
                    onChange={(e) => setAccountUsername(e.target.value)}
                    placeholder="Leave blank to keep current"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-white/50 block mb-1">New password</label>
                  <input
                    type="password"
                    value={accountNewPass}
                    onChange={(e) => setAccountNewPass(e.target.value)}
                    placeholder="Leave blank to keep current"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                  />
                </div>
                {accountNewPass && (
                  <div>
                    <label className="text-xs font-medium text-white/50 block mb-1">Confirm new password</label>
                    <input
                      type="password"
                      value={accountConfirm}
                      onChange={(e) => setAccountConfirm(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                    />
                  </div>
                )}
                <div className="pt-1 border-t border-white/5">
                  <label className="text-xs font-medium text-white/50 block mb-1">Current password</label>
                  <input
                    type="password"
                    value={accountCurrentPass}
                    onChange={(e) => setAccountCurrentPass(e.target.value)}
                    placeholder="Required to confirm changes"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                  />
                </div>
                {accountError && (
                  <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{accountError}</p>
                )}
                {accountSuccess && (
                  <p className="text-xs text-green-400 bg-green-500/10 rounded-lg px-3 py-2">{accountSuccess}</p>
                )}
                <button
                  type="submit"
                  disabled={accountSaving}
                  className="px-4 py-2 rounded-xl bg-white/5 text-white/60 text-sm font-medium transition-colors hover:bg-white/10 hover:text-white/80 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {accountSaving ? "Saving…" : "Save changes"}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---- MAP LIST VIEW ----
  const maps: TileMap[] = serverState?.maps ?? []

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Maps</h1>
            <div className="flex items-center gap-2 mt-1">
              {serverState?.outputDir && (
                <span className="text-white/30 text-sm font-mono truncate max-w-xs">{serverState.outputDir}</span>
              )}
              {!connected
                ? <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 flex-shrink-0">Connecting…</span>
                : !serverState
                  ? <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/30 border border-white/10 flex-shrink-0">Loading…</span>
                  : !serverState.outputDir
                    ? <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/30 border border-white/10 flex-shrink-0">No output dir set</span>
                    : serverState.outputDirOk
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25 flex-shrink-0">Online</span>
                      : <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25 flex-shrink-0">Not reachable</span>
              }
            </div>
          </div>
          <div className="flex gap-2">
            <NotificationBell count={notifications.length} onClick={() => setShowNotifications(true)} />
            <ShareButton onClick={() => setShowServerShare(true)} />
            <SettingsButton onClick={async () => {
              setOutputDirInput("")
              setLogRetentionValue(serverState?.logSettings?.retentionValue ?? 30)
              setLogRetentionUnit(serverState?.logSettings?.retentionUnit ?? "days")
              setShowSettings(true)
            }} />
            <LogoutButton onClick={async () => {
              await apiPost("auth/logout", {}, authToken)
              localStorage.removeItem("authToken")
              setAuthToken(null)
              setAuthStatus("login")
            }} />
            <button
              onClick={() => setShowNewMapModal(true)}
              className="px-4 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium transition-colors hover:bg-blue-400"
            >
              New Map
            </button>
          </div>
        </div>

        {serverState && maps.length === 0 && (
          <p className="text-center text-white/30 py-20 text-sm">
            No maps yet. Click "New Map" to get started.
          </p>
        )}

        <div className="flex flex-col gap-4">
          {maps.map((map) => {
            const mapCoverages = (serverState?.coverages ?? []).filter(
              (c) => c.mapId === map.id,
            )
            return (
              <MapCard
                key={map.id}
                map={map}
                coverages={mapCoverages}
                activeRuns={serverState?.activeRuns ?? []}
                deleting={deletingMapIds.has(map.id)}
                onClick={() => setSelectedMapId(map.id)}
                onDelete={() => handleDeleteMap(map)}
                onToggleDiscoverable={() => handleToggleDiscoverable(map)}
                onShare={() => setShareMap(map)}
              />
            )
          })}
        </div>
      </div>

      {showNewMapModal && (
        <NewMapModal
          onClose={() => setShowNewMapModal(false)}
          onSubmit={handleCreateMap}
        />
      )}

      {shareMap && (
        <ShareModal
          title={`Share "${shareMap.name}"`}
          url={serverState?.onionUrl ? `${serverState.onionUrl}/${shareMap.id}` : null}
          hint="Scan with Anonomi Messenger to import this map."
          onClose={() => setShareMap(null)}
        />
      )}

      {showServerShare && (
        <ShareModal
          title="Share this server"
          url={serverState?.onionUrl || null}
          hint="Scan with Anonomi Messenger to discover all maps on this server."
          onClose={() => setShowServerShare(false)}
        />
      )}
      {showNotifications && (
        <NotificationPanel
          notifications={notifications}
          onDismiss={(id) => setNotifications((prev) => prev.filter((n) => n.id !== id))}
          onClearAll={() => setNotifications([])}
          onClose={() => setShowNotifications(false)}
        />
      )}
    </div>
  )
}

// ---- Header icon buttons ----

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 rounded-xl bg-white/5 text-white/40 text-sm transition-colors hover:bg-white/10 hover:text-white/60"
      title="Settings"
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="inline-block">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M6.3 1a.55.55 0 0 0-.54.44l-.23 1.14a5 5 0 0 0-.9.52l-1.07-.36a.55.55 0 0 0-.63.25L1.74 4.8a.55.55 0 0 0 .12.69l.88.75a5 5 0 0 0-.04.64c0 .22.01.43.04.64l-.88.75a.55.55 0 0 0-.12.69l1.19 2.06c.13.22.4.32.63.24l1.07-.36a5 5 0 0 0 .9.52l.23 1.14c.05.26.27.44.54.44h2.4c.27 0 .5-.18.54-.44l.23-1.14a5 5 0 0 0 .9-.52l1.07.36c.23.08.5-.02.63-.24l1.19-2.06a.55.55 0 0 0-.12-.69l-.88-.75c.03-.21.04-.42.04-.64 0-.22-.01-.43-.04-.64l.88-.75a.55.55 0 0 0 .12-.69L11.44 2.99a.55.55 0 0 0-.63-.25l-1.07.36a5 5 0 0 0-.9-.52L8.6 1.44A.55.55 0 0 0 8.07 1H6.3ZM7.5 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"
          fill="currentColor"
        />
      </svg>
    </button>
  )
}


function ShareButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 rounded-xl bg-white/5 text-white/40 text-sm transition-colors hover:bg-white/10 hover:text-white/60"
      title="Share"
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="inline-block">
        <circle cx="12" cy="3" r="2" stroke="currentColor" strokeWidth="1.3"/>
        <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.3"/>
        <circle cx="3" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.3"/>
        <line x1="4.9" y1="6.5" x2="10.1" y2="3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="4.9" y1="8.5" x2="10.1" y2="11.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    </button>
  )
}

function LogoutButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 rounded-xl bg-white/5 text-white/40 text-sm transition-colors hover:bg-white/10 hover:text-white/60"
      title="Log out"
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="inline-block">
        <path
          d="M6 2H2.5A.5.5 0 0 0 2 2.5v10a.5.5 0 0 0 .5.5H6M10 10.5 13 7.5 10 4.5M13 7.5H5.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

// ---- Notification bell ----

function NotificationBell({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative px-3 py-2 rounded-xl bg-white/5 text-white/40 text-sm transition-colors hover:bg-white/10 hover:text-white/60"
      title="Notifications"
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="inline-block">
        <path
          d="M7.5 1.5a4 4 0 0 0-4 4v2.5l-1 2h10l-1-2V5.5a4 4 0 0 0-4-4ZM7.5 13.5a1.5 1.5 0 0 0 1.415-1h-2.83A1.5 1.5 0 0 0 7.5 13.5Z"
          fill="currentColor"
        />
      </svg>
      {count > 0 && (
        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-0.5">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  )
}

// ---- Notification panel ----

function NotificationPanel({
  notifications,
  onDismiss,
  onClearAll,
  onClose,
}: {
  notifications: AppNotification[]
  onDismiss: (id: string) => void
  onClearAll: () => void
  onClose: () => void
}) {
  function timeAgo(ts: number) {
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return "just now"
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    return `${Math.floor(m / 60)}h ago`
  }

  const kindStyle: Record<AppNotification["kind"], string> = {
    info: "text-blue-400",
    success: "text-green-400",
    partial: "text-yellow-400",
    error: "text-red-400",
  }

  const kindIcon: Record<AppNotification["kind"], string> = {
    info: "▶",
    success: "✓",
    partial: "⚠",
    error: "✗",
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 bottom-0 z-50 w-80 bg-[#111] border-l border-white/10 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-white/10 flex-shrink-0">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <div className="flex items-center gap-2">
            {notifications.length > 0 && (
              <button
                onClick={onClearAll}
                className="text-xs text-white/30 hover:text-white/60 transition-colors"
              >
                Clear all
              </button>
            )}
            <button
              onClick={onClose}
              className="text-white/30 hover:text-white/70 transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-white/20">No notifications yet</p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {notifications.map((n) => (
                <div key={n.id} className="px-4 py-3 flex items-start gap-3">
                  <span className={`text-xs font-bold mt-0.5 flex-shrink-0 ${kindStyle[n.kind]}`}>
                    {kindIcon[n.kind]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2 mb-0.5">
                      <p className="text-xs font-medium text-white/80 truncate">{n.title}</p>
                      <span className="text-[10px] text-white/25 flex-shrink-0">{timeAgo(n.timestamp)}</span>
                    </div>
                    <p className="text-xs text-white/40 leading-relaxed">{n.detail}</p>
                  </div>
                  <button
                    onClick={() => onDismiss(n.id)}
                    className="text-white/20 hover:text-white/50 transition-colors text-sm leading-none flex-shrink-0 mt-0.5"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ---- Delete confirmation modal ----

function DeleteCoverageModal({
  coverage,
  onClose,
  onConfirm,
}: {
  coverage: Coverage
  onClose: () => void
  onConfirm: () => void
}) {
  const tileCount = coverage.tilesOnDisk.toLocaleString()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[#111] border border-white/10 rounded-2xl shadow-2xl p-6">
        <h2 className="text-sm font-semibold mb-1">Delete coverage?</h2>
        <p className="text-white/50 text-xs mb-5">
          <span className="text-white/80">{coverage.name}</span>
        </p>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2 mb-5 text-xs text-white/50">
          <p className="font-medium text-white/70">Integrity-checked file cleanup</p>
          <p>
            The coverage record is removed immediately. Then {tileCount} tile{coverage.tilesOnDisk !== 1 ? "s" : ""} are
            scanned on disk:
          </p>
          <ul className="space-y-1 pl-3">
            <li>· Tiles <span className="text-white/70">shared with other coverages</span> in this map are kept.</li>
            <li>· Tiles <span className="text-white/70">exclusive to this coverage</span> are deleted.</li>
          </ul>
          <p className="text-white/30">
            This runs in the background and may take a while for large coverages.
            Progress is shown in the coverage list.
          </p>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-white/40 hover:text-white/70 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl bg-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/30 transition-colors"
          >
            Delete coverage
          </button>
        </div>
      </div>
    </div>
  )
}
