import { useState } from "react"
import { QRCodeImage } from "./QRCodeImage"

type Props = {
  title: string
  url: string | null  // null = onionUrl not configured
  hint: string
  onClose: () => void
}

export function ShareModal({ title, url, hint, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    if (!url) return
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-sm bg-[#111] border border-white/10 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-sm font-semibold truncate pr-4">{title}</h2>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white/70 transition-colors text-xl leading-none flex-shrink-0"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-6 flex flex-col items-center gap-4">
          {url ? (
            <>
              <QRCodeImage value={url} size={200} />

              <div className="w-full">
                <p className="text-xs text-white/30 font-mono break-all text-center mb-3">{url}</p>
                <button
                  onClick={handleCopy}
                  className="w-full px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white/60 hover:text-white/90 hover:border-white/20 transition-colors"
                >
                  {copied ? "✓ Copied" : "Copy URL"}
                </button>
              </div>

              <p className="text-xs text-white/25 text-center">{hint}</p>
            </>
          ) : (
            <div className="py-4 text-center">
              <p className="text-sm text-white/50 mb-1">No onion URL configured</p>
              <p className="text-xs text-white/25">Set your onion URL in Settings to share.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
