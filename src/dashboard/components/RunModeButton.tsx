import { useEffect, useRef, useState } from "react"
import type { RunMode } from "../../types"
import { MODE_INFO } from "../constants"

type Props = {
  hasRun: boolean
  smartMode: RunMode
  showValidate?: boolean
  onRun: (mode: RunMode) => void
  dropdownPosition?: "above-left" | "below-right"
}

export function RunModeButton({ hasRun, smartMode, showValidate, onRun, dropdownPosition = "below-right" }: Props) {
  const [showMenu, setShowMenu] = useState(false)
  const [selectedMode, setSelectedMode] = useState<RunMode>(smartMode)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showMenu) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setShowMenu(false)
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [showMenu])

  const dropdownClass =
    dropdownPosition === "above-left"
      ? "absolute bottom-full left-0 mb-1 z-20"
      : "absolute top-full right-0 mt-1 z-20"

  return (
    <div className="relative flex" ref={menuRef}>
      <button
        onClick={() => onRun(hasRun ? selectedMode : "resume")}
        className="px-3 py-1.5 rounded-l-lg bg-blue-500/20 text-blue-400 text-xs font-medium transition-colors hover:bg-blue-500/30"
      >
        {hasRun ? MODE_INFO[selectedMode].label : "Run now"}
      </button>
      {hasRun && (
        <button
          onClick={() => setShowMenu((v) => !v)}
          className="px-1.5 py-1.5 rounded-r-lg bg-blue-500/20 text-blue-400 text-xs transition-colors hover:bg-blue-500/30 border-l border-blue-500/30"
          title="Choose run mode"
        >
          ▾
        </button>
      )}
      {showMenu && (
        <div className={`${dropdownClass} bg-[#1c1c1c] border border-white/10 rounded-xl shadow-2xl overflow-hidden min-w-[200px]`}>
          {(["resume", "update", "reset"] as RunMode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setSelectedMode(m); setShowMenu(false) }}
              className={`w-full text-left px-4 py-2.5 text-xs transition-colors hover:bg-white/5 flex flex-col gap-0.5 ${m === "reset" ? "hover:text-red-400" : "hover:text-white/80"}`}
            >
              <span className={`font-medium ${m === selectedMode ? "text-blue-400" : "text-white/70"}`}>
                {MODE_INFO[m].label}
                {m === smartMode && <span className="ml-1.5 text-[10px] text-blue-400/60">default</span>}
              </span>
              <span className="text-white/30">{MODE_INFO[m].desc}</span>
            </button>
          ))}
          {showValidate && (
            <>
              <div className="border-t border-white/10" />
              <button
                onClick={() => { onRun("validate"); setShowMenu(false) }}
                className="w-full text-left px-4 py-2.5 text-xs transition-colors hover:bg-white/5 hover:text-white/80 flex flex-col gap-0.5"
              >
                <span className="font-medium text-white/70">{MODE_INFO.validate.label}</span>
                <span className="text-white/30">{MODE_INFO.validate.desc}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
