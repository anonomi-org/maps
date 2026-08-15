import { useEffect, useMemo, useState, type ReactNode } from "react"
import { PRESETS, CONTINENTS } from "../../presets"
import type { Bbox, Coverage, CoverageRegion, CoverageTransport, Recurrency, RetentionUnit, TileTransport } from "../../types"
import { fmtBytes } from "../utils"

// ---- Tile source options ----
const TILE_SOURCES = [
  {
    id: "osm",
    label: "OSM",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
  },
  {
    id: "carto-dark",
    label: "CARTO Dark",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
  },
  {
    id: "carto-light",
    label: "CARTO Light",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
  },
  {
    id: "topo",
    label: "OpenTopo",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
  },
  { id: "custom", label: "Custom", url: "", subdomains: [] },
]

// ---- Zoom presets ----
const ZOOM_PRESETS = [
  { id: "low", label: "Low", description: "Continents / countries", min: 0, max: 8 },
  { id: "medium", label: "Medium", description: "Cities / roads", min: 0, max: 12 },
  { id: "high", label: "High", description: "Neighbourhoods", min: 0, max: 16 },
  { id: "advanced", label: "Advanced", description: "Custom range", min: null, max: null },
]

// Very rough estimate: average tile size 15 KB
const AVG_TILE_BYTES = 15 * 1024

type Props = {
  onClose: () => void
  onSubmit: (data: object) => void
  initialCoverage?: Coverage
  hasActiveRun?: boolean
  authToken?: string | null
  serverTransport?: TileTransport
}

type AreaTab = "presets" | "custom"
type ZoomPresetId = "low" | "medium" | "high" | "advanced"

export function NewCoverageModal({ onClose, onSubmit, initialCoverage, hasActiveRun = false, authToken, serverTransport }: Props) {
  const isEditing = !!initialCoverage
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // ── Step 1 state (lazy-initialized from initialCoverage when editing) ──
  const [areaTab, setAreaTab] = useState<AreaTab>(() =>
    initialCoverage?.type === "custom" ? "custom" : "presets",
  )
  const [selectedPresets, setSelectedPresets] = useState<Set<string>>(() => {
    if (!initialCoverage || initialCoverage.type !== "preset") return new Set()
    const ids = new Set<string>()
    for (const r of initialCoverage.regions) {
      const p = PRESETS.find((pr) => pr.name === r.name)
      if (p) ids.add(p.id)
    }
    return ids
  })
  const [search, setSearch] = useState("")
  const [customName, setCustomName] = useState(
    () => (initialCoverage?.type === "custom" ? initialCoverage.regions[0]?.name : "") ?? "",
  )
  const [customBbox, setCustomBbox] = useState<Partial<Bbox>>(
    () => (initialCoverage?.type === "custom" ? initialCoverage.regions[0]?.bbox : {}) ?? {},
  )
  const [customMargin, setCustomMargin] = useState(
    () => (initialCoverage?.type === "custom" ? initialCoverage.regions[0]?.marginKm : 0) ?? 0,
  )
  const [coverageName, setCoverageName] = useState(() => initialCoverage?.name ?? "")

  // ── Step 2 state ──
  const [tileSourceId, setTileSourceId] = useState(() => {
    if (!initialCoverage) return "osm"
    return (
      TILE_SOURCES.find((s) => s.id !== "custom" && s.url === initialCoverage.tileSource)?.id ??
      "custom"
    )
  })
  const [customUrl, setCustomUrl] = useState(() => {
    if (!initialCoverage) return ""
    const matched = TILE_SOURCES.find(
      (s) => s.id !== "custom" && s.url === initialCoverage.tileSource,
    )
    return matched ? "" : initialCoverage.tileSource
  })
  const [customSubdomains, setCustomSubdomains] = useState(
    () => initialCoverage?.tileSubdomains.join(",") ?? "a,b,c",
  )
  const [workers, setWorkers] = useState(() => initialCoverage?.workers ?? 4)
  const [maxCallsPerMinute, setMaxCallsPerMinute] = useState(
    () => initialCoverage?.maxCallsPerMinute ?? 60,
  )
  const [transport, setTransport] = useState<CoverageTransport>(
    () => initialCoverage?.transport ?? "default",
  )
  const [zoomPresetId, setZoomPresetId] = useState<ZoomPresetId>(() => {
    if (!initialCoverage) return "medium"
    return (
      (ZOOM_PRESETS.find(
        (z) => z.min === initialCoverage.zoomMin && z.max === initialCoverage.zoomMax,
      )?.id as ZoomPresetId) ?? "advanced"
    )
  })
  const [customZoomMin, setCustomZoomMin] = useState(() => initialCoverage?.zoomMin ?? 0)
  const [customZoomMax, setCustomZoomMax] = useState(() => initialCoverage?.zoomMax ?? 14)
  const [margin, setMargin] = useState(
    () =>
      (initialCoverage?.type !== "custom" ? initialCoverage?.regions[0]?.marginKm : undefined) ??
      5,
  )
  const [logRetention, setLogRetention] = useState<"default" | "custom">(
    () => initialCoverage?.logRetention ?? "default",
  )
  const [logRetentionValue, setLogRetentionValue] = useState(
    () => initialCoverage?.logRetentionValue ?? 30,
  )
  const [logRetentionUnit, setLogRetentionUnit] = useState<RetentionUnit>(
    () => initialCoverage?.logRetentionUnit ?? "days",
  )

  const [recurrency, setRecurrency] = useState<Recurrency>(
    () => initialCoverage?.recurrency ?? "normal",
  )

  // ── Derived ──
  const filteredPresets = useMemo(() => {
    const q = search.toLowerCase()
    return PRESETS.filter((p) => p.name.toLowerCase().includes(q) || (p.continent ?? "").toLowerCase().includes(q))
  }, [search])

  const selectedSource = TILE_SOURCES.find((s) => s.id === tileSourceId)!
  const effectiveZoomMin =
    zoomPresetId === "advanced"
      ? customZoomMin
      : (ZOOM_PRESETS.find((z) => z.id === zoomPresetId)!.min ?? 0)
  const effectiveZoomMax =
    zoomPresetId === "advanced"
      ? customZoomMax
      : (ZOOM_PRESETS.find((z) => z.id === zoomPresetId)!.max ?? 14)

  const effectiveTileSource = tileSourceId === "custom" ? customUrl : selectedSource.url
  const effectiveSubdomains =
    tileSourceId === "custom"
      ? customSubdomains
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : selectedSource.subdomains

  function buildRegions(): CoverageRegion[] {
    if (areaTab === "presets") {
      return [...selectedPresets].map((id) => {
        const p = PRESETS.find((pr) => pr.id === id)!
        return { name: p.name, bbox: p.bbox, marginKm: margin }
      })
    } else {
      const bbox = customBbox as Bbox
      return [{ name: customName || "Custom area", bbox, marginKm: customMargin }]
    }
  }

  const regions = useMemo(() => {
    if (areaTab === "presets" && selectedPresets.size === 0) return []
    if (areaTab === "custom") {
      const b = customBbox as Bbox
      if (b.north == null || b.south == null || b.east == null || b.west == null) return []
    }
    return buildRegions()
  }, [areaTab, selectedPresets, customBbox, customName, customMargin, margin])

  const [estimatedTiles, setEstimatedTiles] = useState<number | null>(null)
  const [estimating, setEstimating] = useState(false)

  useEffect(() => {
    if (regions.length === 0) {
      setEstimatedTiles(null)
      return
    }
    setEstimating(true)
    const abort = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/estimate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            regions: regions.map((r) => ({ bbox: r.bbox, marginKm: r.marginKm })),
            zoomMin: effectiveZoomMin,
            zoomMax: effectiveZoomMax,
          }),
          signal: abort.signal,
        })
        const data = (await res.json()) as { tiles: number }
        setEstimatedTiles(data.tiles)
      } catch {
        // aborted or network error, so leave previous value
      } finally {
        setEstimating(false)
      }
    }, 400)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [regions, effectiveZoomMin, effectiveZoomMax])

  // Step 1 validation
  const step1Valid =
    areaTab === "presets"
      ? selectedPresets.size > 0
      : (() => {
          const b = customBbox as Bbox
          return (
            b.north != null &&
            b.south != null &&
            b.east != null &&
            b.west != null &&
            b.north > b.south &&
            b.east > b.west
          )
        })()

  // Step 2 validation
  const step2Valid =
    effectiveTileSource.length > 0 &&
    effectiveZoomMin <= effectiveZoomMax

  // Auto-fill coverage name when presets change
  function togglePreset(id: string) {
    setSelectedPresets((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      // Auto-fill name
      if (next.size === 1) {
        const p = PRESETS.find((pr) => pr.id === [...next][0])
        if (p) setCoverageName(p.name)
      } else if (next.size > 1) {
        // Don't overwrite if user edited it
      }
      return next
    })
  }

  function toggleContinent(continent: string) {
    const ids = PRESETS.filter((p) => p.continent === continent).map((p) => p.id)
    setSelectedPresets((prev) => {
      const allSelected = ids.every((id) => prev.has(id))
      const next = new Set(prev)
      if (allSelected) {
        ids.forEach((id) => next.delete(id))
      } else {
        ids.forEach((id) => next.add(id))
      }
      return next
    })
  }

  function buildPayload() {
    return {
      name: coverageName || (areaTab === "presets" ? "Coverage" : customName || "Custom area"),
      type: areaTab === "presets" ? "preset" : "custom",
      regions: buildRegions(),
      zoomMin: effectiveZoomMin,
      zoomMax: effectiveZoomMax,
      tileSource: effectiveTileSource,
      tileSubdomains: effectiveSubdomains,
      recurrency,
      workers,
      maxCallsPerMinute,
      transport,
      logRetention,
      ...(logRetention === "custom"
        ? { logRetentionValue, logRetentionUnit }
        : {}),
    }
  }

  function handleSubmit() {
    if (isEditing && hasActiveRun) {
      setShowCancelConfirm(true)
      return
    }
    onSubmit(buildPayload())
  }

  function handleConfirmedSubmit() {
    setShowCancelConfirm(false)
    onSubmit(buildPayload())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-2xl bg-[#111] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold">{isEditing ? "Edit Coverage" : "New Coverage"}</h2>
            <p className="text-xs text-white/30 mt-0.5">
              Step {step} of 3:{" "}
              {step === 1 ? "Name & Area" : step === 2 ? "Source & Zoom" : "Review"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white/70 transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-1 px-6 pt-4 flex-shrink-0">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className={`h-0.5 flex-1 rounded-full transition-colors ${
                n <= step ? "bg-blue-400" : "bg-white/10"
              }`}
            />
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {/* ── Step 1: Name & Area ── */}
          {step === 1 && (
            <div className="space-y-5">
              {/* Coverage name */}
              <div>
                <label className="text-xs text-white/50 block mb-1.5">Coverage name</label>
                <input
                  type="text"
                  value={coverageName}
                  onChange={(e) => setCoverageName(e.target.value)}
                  placeholder={
                    areaTab === "presets"
                      ? selectedPresets.size === 1
                        ? PRESETS.find((p) => p.id === [...selectedPresets][0])?.name ?? "Coverage"
                        : selectedPresets.size > 1
                          ? `${selectedPresets.size} regions selected`
                          : "Coverage name"
                      : "Custom area"
                  }
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                />
              </div>

              {/* Area tabs */}
              <div>
                <div className="flex gap-1 mb-3 bg-white/5 rounded-xl p-1">
                  {(["presets", "custom"] as AreaTab[]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setAreaTab(tab)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                        areaTab === tab
                          ? "bg-white/10 text-white"
                          : "text-white/40 hover:text-white/60"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Presets tab */}
                {areaTab === "presets" && (
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search regions…"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                    />
                    <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                      {CONTINENTS.map((continent) => {
                        const presetsInContinent = filteredPresets.filter(
                          (p) => p.continent === continent,
                        )
                        if (presetsInContinent.length === 0) return null
                        const continentIds = PRESETS.filter(
                          (p) => p.continent === continent,
                        ).map((p) => p.id)
                        const allSelected = continentIds.every((id) => selectedPresets.has(id))
                        return (
                          <div key={continent}>
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className="text-xs font-medium text-white/50">
                                {continent}
                              </span>
                              <button
                                onClick={() => toggleContinent(continent)}
                                className="text-xs text-white/30 hover:text-white/60 transition-colors"
                              >
                                {allSelected ? "deselect all" : "select all"}
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {presetsInContinent.map((p) => (
                                <button
                                  key={p.id}
                                  onClick={() => togglePreset(p.id)}
                                  className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                                    selectedPresets.has(p.id)
                                      ? "bg-blue-500/30 text-blue-300 border border-blue-500/40"
                                      : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/70"
                                  }`}
                                >
                                  {p.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                      {/* World (no continent) */}
                      {filteredPresets.filter((p) => !p.continent).length > 0 && (
                        <div>
                          <span className="text-xs font-medium text-white/50 block mb-1.5">
                            Global
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {filteredPresets
                              .filter((p) => !p.continent)
                              .map((p) => (
                                <button
                                  key={p.id}
                                  onClick={() => togglePreset(p.id)}
                                  className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                                    selectedPresets.has(p.id)
                                      ? "bg-blue-500/30 text-blue-300 border border-blue-500/40"
                                      : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/70"
                                  }`}
                                >
                                  {p.name}
                                </button>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {selectedPresets.size > 0 && (
                      <p className="text-xs text-white/30">
                        {selectedPresets.size} region{selectedPresets.size !== 1 ? "s" : ""}{" "}
                        selected
                      </p>
                    )}
                  </div>
                )}

                {/* Custom tab */}
                {areaTab === "custom" && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-white/50 block mb-1.5">Area name</label>
                      <input
                        type="text"
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder="My custom area"
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {(
                        [
                          ["north", "North"],
                          ["south", "South"],
                          ["west", "West"],
                          ["east", "East"],
                        ] as [keyof Bbox, string][]
                      ).map(([key, label]) => (
                        <div key={key}>
                          <label className="text-xs text-white/50 block mb-1.5">{label}</label>
                          <input
                            type="number"
                            step="0.01"
                            value={customBbox[key] ?? ""}
                            onChange={(e) =>
                              setCustomBbox((prev) => ({
                                ...prev,
                                [key]: parseFloat(e.target.value),
                              }))
                            }
                            placeholder={
                              key === "north"
                                ? "51.5"
                                : key === "south"
                                  ? "49.0"
                                  : key === "west"
                                    ? "-0.5"
                                    : "0.5"
                            }
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                          />
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="text-xs text-white/50 block mb-1.5">
                        Margin (km)
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={customMargin}
                        onChange={(e) => setCustomMargin(Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 2: Source & Zoom ── */}
          {step === 2 && (
            <div className="space-y-5">
              {/* Tile source */}
              <div>
                <label className="text-xs text-white/50 block mb-2">Tile source</label>
                <div className="flex flex-wrap gap-2">
                  {TILE_SOURCES.map((src) => (
                    <button
                      key={src.id}
                      onClick={() => setTileSourceId(src.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        tileSourceId === src.id
                          ? "bg-blue-500/30 text-blue-300 border border-blue-500/40"
                          : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {src.label}
                    </button>
                  ))}
                </div>
                {tileSourceId === "custom" && (
                  <div className="mt-3 space-y-2">
                    <input
                      type="text"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="https://{s}.example.com/{z}/{x}/{y}.png"  title="PNG and JPEG sources both work; the file extension served is detected from the first tile"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                    />
                    <input
                      type="text"
                      value={customSubdomains}
                      onChange={(e) => setCustomSubdomains(e.target.value)}
                      placeholder="a,b,c"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
                    />
                  </div>
                )}
              </div>

              {/* Workers + Rate limit */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-white/50 block mb-1.5">Concurrent workers</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="16"
                      value={workers}
                      onChange={(e) => setWorkers(Math.max(1, Math.min(16, Number(e.target.value))))}
                      className="w-20 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                    />
                    <span className="text-xs text-white/30">parallel</span>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-white/50 block mb-1.5">Max calls / min</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max="3600"
                      value={maxCallsPerMinute}
                      onChange={(e) =>
                        setMaxCallsPerMinute(Math.max(0, Math.min(3600, Number(e.target.value))))
                      }
                      className="w-20 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                    />
                    <span className="text-xs text-white/30">total</span>
                  </div>
                </div>
              </div>

              {/* Connection */}
              <div>
                <label className="text-xs text-white/50 block mb-1.5">Connection</label>
                <div className="flex flex-wrap gap-2">
                  {([
                    { id: "default", label: `Server default${serverTransport ? ` (${serverTransport})` : ""}` },
                    { id: "tor", label: "Tor" },
                    { id: "clearnet", label: "Direct" },
                  ] as { id: CoverageTransport; label: string }[]).map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setTransport(opt.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                        transport === opt.id
                          ? "bg-blue-500/30 text-blue-300 border border-blue-500/40"
                          : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-white/30 mt-1.5">
                  Which regions you download identifies this server to the tile host.
                  Over Tor that link is broken; if the tunnel is down the run fails
                  rather than falling back.
                </p>
              </div>

              {/* Detail level */}
              <div>
                <label className="text-xs text-white/50 block mb-2">Detail level</label>
                <div className="flex flex-wrap gap-2">
                  {ZOOM_PRESETS.map((z) => (
                    <button
                      key={z.id}
                      onClick={() => setZoomPresetId(z.id as ZoomPresetId)}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                        zoomPresetId === z.id
                          ? "bg-blue-500/30 text-blue-300 border border-blue-500/40"
                          : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10"
                      }`}
                    >
                      <span className="font-medium">{z.label}</span>
                      <span className="text-white/30 ml-1">
                        {z.min != null ? `z${z.min}–${z.max}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
                {zoomPresetId === "advanced" && (
                  <div className="flex gap-3 mt-3">
                    <div className="flex-1">
                      <label className="text-xs text-white/50 block mb-1.5">Min zoom</label>
                      <input
                        type="number"
                        min="0"
                        max="20"
                        value={customZoomMin}
                        onChange={(e) => setCustomZoomMin(Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-white/50 block mb-1.5">Max zoom</label>
                      <input
                        type="number"
                        min="0"
                        max="20"
                        value={customZoomMax}
                        onChange={(e) => setCustomZoomMax(Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Margin (presets only; custom has its own) */}
              {areaTab === "presets" && (
                <div>
                  <label className="text-xs text-white/50 block mb-1.5">Margin (km)</label>
                  <input
                    type="number"
                    min="0"
                    value={margin}
                    onChange={(e) => setMargin(Number(e.target.value))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
                  />
                </div>
              )}

              {/* Log retention */}
              <div>
                <label className="text-xs text-white/50 block mb-2">Log retention</label>
                <div className="flex gap-2 mb-2">
                  {(["default", "custom"] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setLogRetention(opt)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors border ${
                        logRetention === opt
                          ? "bg-blue-500/30 text-blue-300 border-blue-500/40"
                          : "bg-white/5 text-white/50 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {opt === "default" ? "Default (from Settings)" : "Custom"}
                    </button>
                  ))}
                </div>
                {logRetention === "custom" && (
                  <div className="flex items-center gap-2 mt-2">
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
                  </div>
                )}
              </div>

              {/* Recurrency */}
              <div>
                <label className="text-xs text-white/50 block mb-2">Update frequency</label>
                <div className="flex gap-2">
                  {(
                    [
                      { id: "high", label: "High", hint: "Weekly" },
                      { id: "normal", label: "Normal", hint: "Monthly" },
                      { id: "low", label: "Low", hint: "Quarterly" },
                      { id: "none", label: "None", hint: "Manual only" },
                    ] as { id: Recurrency; label: string; hint: string }[]
                  ).map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setRecurrency(r.id)}
                      className={`flex-1 py-2 rounded-xl text-xs font-medium transition-colors ${
                        recurrency === r.id
                          ? "bg-blue-500/30 text-blue-300 border border-blue-500/40"
                          : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {r.label}
                      <span className="block text-white/30 font-normal">{r.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 3: Review ── */}
          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">
                {coverageName ||
                  (areaTab === "presets"
                    ? selectedPresets.size === 1
                      ? PRESETS.find((p) => p.id === [...selectedPresets][0])?.name
                      : `${selectedPresets.size} regions`
                    : customName || "Custom area")}
              </h3>

              <div className="space-y-2">
                <Row label="Regions">
                  {regions.length === 1
                    ? regions[0].name
                    : `${regions.length} regions`}
                </Row>
                <Row label="Zoom range">
                  z{effectiveZoomMin} – z{effectiveZoomMax}
                </Row>
                <Row label="Tile source">
                  {tileSourceId === "custom" ? "Custom" : selectedSource.label}
                </Row>
                <Row label="Workers">{workers}</Row>
                <Row label="Max calls/min">{maxCallsPerMinute === 0 ? "unlimited" : maxCallsPerMinute}</Row>
                <Row label="Margin">
                  {areaTab === "presets" ? margin : customMargin} km
                </Row>
                <Row label="Log retention">
                  {logRetention === "custom"
                    ? `${logRetentionValue} ${logRetentionUnit}`
                    : "Default (from Settings)"}
                </Row>
                <Row label="Update frequency">
                  {recurrency === "high"
                    ? "High (weekly)"
                    : recurrency === "normal"
                      ? "Normal (monthly)"
                      : recurrency === "low"
                        ? "Low (quarterly)"
                        : "None (manual only)"}
                </Row>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
                <p className="text-xs text-white/50">Estimate (land tiles only)</p>
                {estimating || estimatedTiles == null ? (
                  <p className="text-sm text-white/30">{estimating ? "Calculating…" : "—"}</p>
                ) : (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">
                      {estimatedTiles.toLocaleString()}
                      <span className="text-sm font-normal text-white/40 ml-2">tiles</span>
                    </p>
                    <p className="text-xs text-white/30">
                      ~{fmtBytes(estimatedTiles * AVG_TILE_BYTES)} at ~15 KB/tile
                    </p>
                    {estimatedTiles > 5_000_000 && (
                      <p className="text-xs text-yellow-400 mt-1">
                        Large download. Consider reducing zoom or splitting into multiple coverages.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Confirmation panel (edit + active run) */}
        {showCancelConfirm && (
          <div className="px-6 py-4 border-t border-white/10 bg-red-500/5 flex-shrink-0">
            <p className="text-xs text-red-400 mb-3">
              This coverage has an active run. Saving changes will cancel it. Continue?
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white/70 transition-colors"
              >
                Keep running
              </button>
              <button
                onClick={handleConfirmedSubmit}
                className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-colors"
              >
                Cancel run & save
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10 flex-shrink-0">
          <button
            onClick={() => (step > 1 ? setStep((s) => (s - 1) as 1 | 2 | 3) : onClose())}
            className="px-4 py-2 rounded-xl text-sm text-white/40 hover:text-white/70 transition-colors"
          >
            {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 3 ? (
            <button
              onClick={() => setStep((s) => (s + 1) as 2 | 3)}
              disabled={step === 1 ? !step1Valid : !step2Valid}
              className="px-5 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium transition-colors hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={showCancelConfirm}
              className="px-5 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium transition-colors hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isEditing ? "Save Changes" : "Create Coverage"}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-white/40">{label}</span>
      <span className="text-white/80 text-right">{children}</span>
    </div>
  )
}
