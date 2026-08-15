import type { TileMap, Coverage, CoverageRun } from "../../types"
import { fmtBytes } from "../utils"

type Props = {
  map: TileMap
  coverages: Coverage[]
  activeRuns: CoverageRun[]
  deleting?: boolean
  onClick: () => void
  onDelete: () => void
  onToggleDiscoverable: () => void
  onShare: () => void
}

export function MapCard({ map, coverages, activeRuns, deleting, onClick, onDelete, onToggleDiscoverable, onShare }: Props) {
  const coverageIds = new Set(coverages.map((c) => c.id))
  const mapRuns = activeRuns.filter((r) => coverageIds.has(r.coverageId))
  const runningCount = mapRuns.filter((r) => r.status === "running" || r.status === "paused").length
  const queuedCount = mapRuns.filter((r) => r.status === "queued").length
  const totalTilesOnDisk = coverages.reduce((sum, c) => sum + c.tilesOnDisk, 0)
  const totalSizeBytes = coverages.reduce((sum, c) => sum + c.sizeBytes, 0)
  const lastRunAt =
    coverages
      .map((c) => c.lastRunAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? null

  return (
    <div
      className={`relative bg-black/30 border rounded-2xl p-5 transition-colors ${deleting ? "border-white/5 opacity-50 cursor-default" : "border-white/10 cursor-pointer hover:border-white/20"}`}
      onClick={deleting ? undefined : onClick}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">{map.name}</h3>
            {deleting ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/30 border border-white/10">
                Deleting…
              </span>
            ) : (
              <>
                {runningCount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                    {runningCount} running
                  </span>
                )}
                {queuedCount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30">
                    {queuedCount} queued
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleDiscoverable() }}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                    map.discoverable
                      ? "bg-green-500/15 text-green-400 border-green-500/25 hover:bg-green-500/25"
                      : "bg-white/5 text-white/20 border-white/10 hover:text-white/40"
                  }`}
                  title={map.discoverable ? "Discoverable, click to hide" : "Hidden, click to make discoverable"}
                >
                  {map.discoverable ? "discoverable" : "hidden"}
                </button>
              </>
            )}
          </div>
          {map.description && (
            <p className="text-xs text-white/40 mt-0.5 truncate">{map.description}</p>
          )}
          <div className="flex items-center gap-2 mt-2 text-xs text-white/30 flex-wrap">
            <span>
              {coverages.length} coverage{coverages.length !== 1 ? "s" : ""}
            </span>
            {totalTilesOnDisk > 0 && (
              <>
                <span>·</span>
                <span>{totalTilesOnDisk.toLocaleString()} tiles</span>
                <span>·</span>
                <span>{fmtBytes(totalSizeBytes)}</span>
              </>
            )}
            {lastRunAt && (
              <>
                <span>·</span>
                <span>Last run {new Date(lastRunAt).toLocaleDateString()}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {!deleting && (
            <button
              className="text-white/20 hover:text-white/60 transition-colors text-sm leading-none"
              onClick={(e) => { e.stopPropagation(); onShare() }}
              title="Share map"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="10.5" cy="2.5" r="1.75" stroke="currentColor" strokeWidth="1.25"/>
                <circle cx="10.5" cy="10.5" r="1.75" stroke="currentColor" strokeWidth="1.25"/>
                <circle cx="2.5" cy="6.5" r="1.75" stroke="currentColor" strokeWidth="1.25"/>
                <line x1="4.2" y1="5.6" x2="8.8" y2="3.4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
                <line x1="4.2" y1="7.4" x2="8.8" y2="9.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
              </svg>
            </button>
          )}
          {!deleting && runningCount === 0 && queuedCount === 0 && (
            <button
              className="text-white/20 hover:text-white/60 transition-colors text-xl leading-none"
              onClick={(e) => { e.stopPropagation(); onDelete() }}
            >
              ×
            </button>
          )}
          {!deleting && <span className="text-white/20 text-sm">→</span>}
        </div>
      </div>
    </div>
  )
}
