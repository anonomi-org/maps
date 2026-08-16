// Creates one coverage per zoom band from a list of cities, with the cities as
// regions in list order.
//
// Why bands rather than one coverage per city: the tile count per city roughly
// quadruples with each zoom, so a single z14-17 pass spends about three quarters
// of its time on z17 alone. Running the bands as separate coverages means every
// city on the list reaches a usable zoom before any city reaches the deepest
// one, and a band can be dropped without unpicking anything.
//
// Why one coverage per band rather than one per city per band: the runner walks
// regions in array order (collectAllTiles in runner.ts), so the list order is
// the priority order, and interrupting a run leaves a complete prefix of the
// list on disk rather than a scattering of half-done cities.
//
// Usage:
//   bun run scripts/seed-hot-zones.ts <hot-zones.json> --map <mapId> [--dry-run]
//
// It prints the plan and the tile totals, and refuses to write anything without
// --confirm, because creating coverages on a live server queues real downloads.

type City = {
  name: string
  lat: number
  lon: number
  radiusKm: number
  tier: number
}

type HotZoneFile = {
  tileSource: string
  tileSubdomains?: string[]
  transport?: "default" | "clearnet" | "tor"
  maxCallsPerMinute?: number
  workers?: number
  // One coverage is created per entry, in this order.
  bands: { zoomMin: number; zoomMax: number; priority: number }[]
  cities: City[]
}

const args = process.argv.slice(2)
const filePath = args.find((a) => !a.startsWith("--"))
const mapId = args[args.indexOf("--map") + 1]
const confirm = args.includes("--confirm")
const baseUrl = process.env.MAPS_URL ?? "http://127.0.0.1:3001"
const token = process.env.MAPS_TOKEN

if (!filePath || !mapId || args.indexOf("--map") === -1) {
  console.error("usage: bun run scripts/seed-hot-zones.ts <hot-zones.json> --map <mapId> [--confirm]")
  process.exit(2)
}

const spec: HotZoneFile = JSON.parse(await Bun.file(filePath).text())

// A city is a point plus a radius. The server expands it, and only the server's
// expansion is latitude-corrected, so this deliberately does no geometry: it
// hands over a zero-area bbox and lets marginKm do the work. Duplicating the
// conversion here is how the estimate and the download drift apart.
function regionFor(city: City) {
  return {
    name: city.name,
    bbox: { north: city.lat, south: city.lat, west: city.lon, east: city.lon },
    marginKm: city.radiusKm,
  }
}

const cities = [...spec.cities].sort((a, b) => a.tier - b.tier)
const regions = cities.map(regionFor)

console.log(`${cities.length} cities, ${spec.bands.length} bands, map ${mapId}`)
console.log(`order: ${cities.map((c) => c.name).join(", ")}\n`)

for (const band of spec.bands) {
  const name = `Hot zones z${band.zoomMin}${band.zoomMax === band.zoomMin ? "" : `-${band.zoomMax}`}`
  const body = {
    mapId,
    name,
    type: "custom",
    regions,
    zoomMin: band.zoomMin,
    zoomMax: band.zoomMax,
    tileSource: spec.tileSource,
    tileSubdomains: spec.tileSubdomains ?? ["a", "b", "c"],
    // Seed passes are one-shot. Recurrence here would re-walk the whole list on
    // a timer while later bands are still trying to finish for the first time.
    recurrency: "none",
    priority: band.priority,
    workers: spec.workers ?? 4,
    maxCallsPerMinute: spec.maxCallsPerMinute ?? 120,
    transport: spec.transport ?? "default",
  }

  if (!confirm) {
    console.log(`[dry run] would create "${name}" priority ${band.priority}`)
    continue
  }

  const res = await fetch(`${baseUrl}/api/coverages/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // getToken() reads Authorization: Bearer only. A cookie is ignored and
      // the call comes back 401.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) {
    console.error(`failed to create "${name}": ${JSON.stringify(json)}`)
    process.exit(1)
  }
  console.log(`created "${name}" priority ${band.priority}, ${json.totalTilesExpected ?? "?"} tiles expected`)
}

if (!confirm) console.log("\nnothing written. re-run with --confirm to create these.")
