// Creates one coverage per region-and-zoom-band entry.
//
// The companion to seed-hot-zones.ts, which handles city-and-radius lists. This
// one takes whole regions: a bbox given directly, or the id of a preset from
// src/presets.ts so the bbox is the one already in the repo rather than a
// number typed in twice.
//
// Bands are separate coverages rather than one coverage spanning z9 to z13,
// because each zoom holds roughly four times the tiles of the one below it. A
// band that finishes is coverage you actually have, where a single wide
// coverage is all or nothing and re-walks everything to resume.
//
// Usage:
//   bun run scripts/seed-regions.ts <spec.json> --map <mapId> [--confirm]

import { PRESETS } from "../src/presets"

type Entry = {
  name: string
  preset?: string
  bbox?: { north: number; south: number; west: number; east: number }
  marginKm?: number
  zoomMin: number
  zoomMax: number
  priority: number
}

type Spec = {
  tileSource: string
  tileSubdomains?: string[]
  transport?: "default" | "clearnet" | "tor"
  maxCallsPerMinute?: number
  workers?: number
  recurrency?: "high" | "normal" | "low" | "none"
  entries: Entry[]
}

const args = process.argv.slice(2)
const filePath = args.find((a) => !a.startsWith("--"))
const mapIdx = args.indexOf("--map")
const mapId = mapIdx === -1 ? undefined : args[mapIdx + 1]
const confirm = args.includes("--confirm")
const baseUrl = process.env.MAPS_URL ?? "http://127.0.0.1:3001"
const token = process.env.MAPS_TOKEN?.trim()

if (!filePath || !mapId) {
  console.error("usage: bun run scripts/seed-regions.ts <spec.json> --map <mapId> [--confirm]")
  process.exit(2)
}

const spec: Spec = JSON.parse(await Bun.file(filePath).text())

function regionFor(e: Entry) {
  if (e.bbox) return { name: e.name, bbox: e.bbox, marginKm: e.marginKm ?? 0 }
  const preset = PRESETS.find((p) => p.id === e.preset)
  if (!preset) {
    console.error(`no preset "${e.preset}" for entry "${e.name}"`)
    process.exit(1)
  }
  return { name: e.name, bbox: preset.bbox, marginKm: e.marginKm ?? preset.defaultMarginKm }
}

console.log(`${spec.entries.length} coverages, map ${mapId}\n`)

for (const e of spec.entries) {
  const region = regionFor(e)
  const label = `${e.name} z${e.zoomMin}${e.zoomMax === e.zoomMin ? "" : `-${e.zoomMax}`}`
  const body = {
    mapId,
    name: label,
    type: "custom",
    regions: [region],
    zoomMin: e.zoomMin,
    zoomMax: e.zoomMax,
    tileSource: spec.tileSource,
    tileSubdomains: spec.tileSubdomains ?? ["a"],
    // Never "none": applySchedule skips a coverage that does not recur, so it
    // would get no retry on failure and no short retry after a partial run.
    recurrency: spec.recurrency ?? "low",
    priority: e.priority,
    workers: spec.workers ?? 4,
    maxCallsPerMinute: spec.maxCallsPerMinute ?? 120,
    transport: spec.transport ?? "default",
  }

  if (!confirm) {
    console.log(`[dry run] would create "${label}" priority ${e.priority}`)
    continue
  }

  const res = await fetch(`${baseUrl}/api/coverages/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`failed to create "${label}": ${res.status} ${JSON.stringify(json)}`)
    process.exit(1)
  }
  console.log(`created "${label}" priority ${e.priority}, ${json.coverage?.totalTilesExpected?.toLocaleString() ?? "?"} tiles expected`)
}

if (!confirm) console.log("\nnothing written. re-run with --confirm to create these.")
