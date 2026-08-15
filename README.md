# Maps

Offline tile downloader and server manager for the [Anonomi](https://anonomi.org) onion maps service.

Downloads map tiles from any XYZ tile source to network storage and serves them as static files over a Tor hidden service. The dashboard lets you create maps, define coverage areas, run and monitor download jobs, and share maps via QR codes.

---

## Stack

- **Backend**: Bun, TypeScript
- **Dashboard**: React 18, Vite, Tailwind v4
- **Storage**: SQLite for metadata, tiles straight to disk as `{z}/{x}/{y}.png`
- **Auth**: Single admin, bcrypt password, 7-day session tokens

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- A network storage or local disk path for tile storage
- (Production) A Tor hidden service pointing at the output directory

---

## Setup

```bash
git clone https://github.com/anonomi-org/maps.git
cd maps
bun install
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "outputDir": "/Volumes/YourDisk/tiles",
  "onionUrl": "",
  "internalSecret": "",
  "maxConcurrentRuns": 2
}
```

| Key | Required | Description |
|---|---|---|
| `outputDir` | Yes | Absolute path to the tile storage directory |
| `onionUrl` | No | Tor onion URL prefix, no trailing slash. Builds `tileUrl` in each map's `map.json` |
| `internalSecret` | Production | Shared secret runners use to report back. Generated per-start if unset, which breaks in-flight runs across a restart |
| `maxConcurrentRuns` | No | How many coverages download at once (default 2). The rest wait their turn |
| `tileTransport` | No | `clearnet` (default) or `tor`. Server-wide default for tile fetches; each coverage can override it |
| `torProxyUrl` | No | Tor's HTTP tunnel, default `http://127.0.0.1:9080`. Set `HTTPTunnelPort 9080` in torrc |

Log retention is managed from the dashboard and written back to `config.json`.

Three environment variables matter in production:

| Var | Default | Description |
|---|---|---|
| `STATE_DIR` | repo root | Where `config.json`, `auth.json`, the database and `logs/` live. Point it outside the source tree so a deploy that syncs with `--delete` cannot remove them |
| `PORT` | `3001` | Port the server listens on |
| `BIND_HOST` | `127.0.0.1` | Interface to listen on. Loopback by default: this is a single-admin dashboard, and putting its login form on the network is not something you should have to opt out of. Reach it over an SSH tunnel (`ssh -L 3001:localhost:3001 yourhost`), or set `0.0.0.0` to listen everywhere |

### First run

A server with no admin account yet prints a one-time setup code:

```
│      setup code:  QQED-RC72                  │
```

Enter it in the dashboard to create the account. Under systemd it goes to the
journal, so read it with `journalctl -u maps`. It is held in memory, so restarting
issues a new one, and it stops working the moment an account exists. Without
this, the first person to reach the port owns the instance.

---

## Running

In development the backend runs on :3001 and the dashboard on :5173 with hot reload:

```bash
bun run dev
# open http://localhost:5173
```

In production a single process serves the built dashboard:

```bash
bun run build
bun run start
# open http://localhost:3001
```

On first access you'll be prompted to create an admin account.

```bash
bun run test        # tile math
bun run typecheck
```

---

## Deploying

```bash
DEPLOY_HOST=myserver ./deploy.sh
```

Builds the dashboard, stages it on the host, moves it into place, and restarts the systemd service. `DEPLOY_PATH` defaults to `/opt/maps`, `DEPLOY_SERVICE` to `maps`, and `DEPLOY_USER`, the account that should own the deployed tree, to `maps`. Config, credentials, the database, and logs stay on the server and are never overwritten.

There is no dependency install step: the server imports only Bun and node builtins, and the dashboard's dependencies are bundled into `dist/` at build time.

`maps.service` in the repo root is an example unit, so adjust the user and paths before installing it. The deploy script deliberately does not copy it over an installed one, because a running host's unit usually carries local changes this repo knows nothing about.

---

## How it works

1. **Create a map.** It gets a UUID v4 for its ID, which doubles as the tile folder name and is unguessable on purpose
2. **Add a coverage.** One or more bounding boxes, a zoom range, a tile source, and a schedule
3. **Run.** The server spawns `src/runner.ts` as a child process per run. Workers inside it download tiles in parallel, in resume / update / reset / validate modes. Ocean tiles are skipped via a land mask, so the count downloaded matches the estimate shown when the coverage was created
4. **Share.** QR codes pointing at `{onionUrl}/{mapId}` for a single map, or `{onionUrl}` for server discovery

Tiles land in `{outputDir}/{mapId}/{z}/{x}/{y}.png`. A static `map.json` per map and a top-level `disco.json` are kept in sync with map metadata.

For the integration spec used by Anonomi Messenger on Android, see [MAPS_INTEGRATION.md](MAPS_INTEGRATION.md).

### Runs

Each run is its own process, which keeps a stalled network write or a crashed download from taking the dashboard with it. The server talks to runners over loopback HTTP:

| Route | Purpose |
|---|---|
| `POST /api/internal/progress` | Counter updates, forwarded to the dashboard over SSE |
| `GET /api/internal/run-control` | Runners poll for pause / cancel |
| `POST /api/internal/run-complete` | Final counters and status |
| `POST /api/internal/fetch-tile` | Tile fetches, so one token bucket per host covers every run |

Runners never fetch tiles directly. Routing them through the proxy is what keeps a shared rate limit meaningful when several runs target the same tile server: the strictest configured rate among active runs wins. It is also the single place transport policy is enforced, so a runner cannot bypass it.

### Fetching over Tor

Which regions a server covers is a fingerprint of that server. Downloading the corpus over clearnet ties that fingerprint to your egress IP, so a hidden service can be matched against whoever fetched exactly those tiles. Setting `tileTransport` to `tor` routes every fetch through a local Tor HTTP tunnel and breaks that link.

Bun's `fetch` does not support SOCKS, so this uses Tor's `HTTPTunnelPort` rather than its SOCKS port:

```
# torrc: a client-only tor, no relay, no onion services
SocksPort 0
ORPort 0
ExitRelay 0
HTTPTunnelPort 9080
```

It **fails closed**. If the tunnel is unreachable the fetch errors and the run records failures; it never retries over clearnet, because a silent fallback would leak at exactly the moment you stopped watching. The server probes the tunnel at startup and checks that it really is Tor, not just something listening on the port.

Two caveats worth being honest about. Tor does not make bulk-downloading a public tile service *permitted*. It makes it unattributable, which is not the same thing, so use a source that allows bulk download. And many tile CDNs block Tor exit nodes outright.

Pausing exits the runner rather than idling it. Tiles already on disk are the resume point, so resuming just starts a fresh process in `resume` mode and skips what's there.

---

## Data files

Created at runtime under `STATE_DIR` (the project root by default), all gitignored:

| File | Contents |
|---|---|
| `config.json` | Output directory, onion URL, secret, concurrency |
| `auth.json` | Hashed admin credentials |
| `maps.db` | Maps, coverages, and run history (capped at 50 per coverage) |
| `logs/` | Per-run log files |
| `land-mask.bin` | Land mask cache. Derived from `land.json`, so it sits next to the source rather than under `STATE_DIR`. Without it, first boot re-downloads Natural Earth |

Older versions kept state in `maps.json`, `coverages.json`, and `runs.json`. Those are imported automatically the first time the server starts against an empty database, then left alone.

---

## License

MIT. See [LICENSE](LICENSE).
