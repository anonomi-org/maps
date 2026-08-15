import { useEffect, useRef, useState } from "react"

type Props = {
  onClose: () => void
  onSubmit: (data: { name: string; description: string; discoverable: boolean }) => void
}

export function NewMapModal({ onClose, onSubmit }: Props) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [discoverable, setDiscoverable] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  function handleSubmit() {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), description: description.trim(), discoverable })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-md bg-[#111] border border-white/10 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-sm font-semibold">New Map</h2>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white/70 transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="text-xs text-white/50 block mb-1.5">Name</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="Europe 2026"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 block mb-1.5">
              Description <span className="text-white/20">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="Offline map for Europe trip"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-white/50">Discoverable</p>
              <p className="text-xs text-white/25 mt-0.5">Listed in disco.json for Anonomi Messenger</p>
            </div>
            <button
              type="button"
              onClick={() => setDiscoverable((v) => !v)}
              className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${discoverable ? "bg-blue-500" : "bg-white/10"}`}
            >
              <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${discoverable ? "left-5" : "left-1"}`} />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-white/40 hover:text-white/70 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="px-5 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium transition-colors hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Create Map
          </button>
        </div>
      </div>
    </div>
  )
}
