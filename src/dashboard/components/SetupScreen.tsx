import { useState } from "react"

export function SetupScreen({ onDone }: { onDone: (token: string) => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [setupCode, setSetupCode] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirm) {
      setError("Passwords do not match.")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, setupCode: setupCode.trim().toUpperCase() }),
      })
      const data = await res.json()
      if (res.ok && data.token) {
        onDone(data.token)
      } else {
        setError(data.error ?? "Setup failed. Please try again.")
      }
    } catch {
      setError("Network error. Is the server running?")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-white/10 bg-black/30 p-8">
          <h1 className="text-lg font-semibold tracking-tight mb-1">Set up Maps</h1>
          <p className="text-white/40 text-sm mb-6">Create your admin account to get started.</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs font-medium text-white/50 block mb-1">Setup code</label>
              <input
                type="text"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                required
                autoFocus
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono tracking-widest uppercase placeholder-white/20 focus:outline-none focus:border-white/30"
              />
              <p className="text-xs text-white/25 mt-1">
                Printed in the server's log when it starts without an account.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-white/50 block mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-white/50 block mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
              />
              <p className="text-xs text-white/25 mt-1">Minimum 8 characters</p>
            </div>
            <div>
              <label className="text-xs font-medium text-white/50 block mb-1">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30"
              />
            </div>
            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || !setupCode || !username || !password || !confirm}
              className="w-full px-4 py-2.5 rounded-xl bg-blue-500 text-white text-sm font-medium transition-colors hover:bg-blue-400 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
