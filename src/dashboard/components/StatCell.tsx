export function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/5 px-3 py-2.5">
      <p className="text-xs text-white/30 mb-0.5">{label}</p>
      <p className="text-sm font-medium text-white/80">{value}</p>
    </div>
  )
}
