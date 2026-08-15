export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export function fmtRelative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs <= 0) return "overdue"
  const diffMin = Math.round(diffMs / 60_000)
  if (diffMin < 60) return `in ${diffMin}m`
  const diffH = Math.round(diffMs / 3_600_000)
  if (diffH < 24) return `in ${diffH}h`
  const diffD = Math.round(diffMs / 86_400_000)
  if (diffD === 1) return "tomorrow"
  if (diffD < 14) return `in ${diffD}d`
  const diffW = Math.round(diffD / 7)
  if (diffW < 8) return `in ${diffW}w`
  const diffMo = Math.round(diffD / 30)
  if (diffMo < 24) return `in ${diffMo}mo`
  return `in ${Math.round(diffD / 365)}y`
}

export function fmtDatetime(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  )
}
