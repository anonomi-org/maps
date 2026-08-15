#!/usr/bin/env bash
# Build the dashboard and push maps to a server over ssh.
set -euo pipefail

# Override per deployment: DEPLOY_HOST=myhost DEPLOY_PATH=/srv/maps ./deploy.sh
HOST="${DEPLOY_HOST:?set DEPLOY_HOST to an ssh target}"
REMOTE="${DEPLOY_PATH:-/opt/maps}"
SERVICE="${DEPLOY_SERVICE:-maps}"
# Account that owns the deployed tree, usually the one the unit runs as, not
# the account you ssh in with.
RUN_AS="${DEPLOY_USER:-maps}"
STAGING="/tmp/maps-deploy.$$"

echo "Building dashboard..."
~/.bun/bin/bun run build

# State lives on the server: config, credentials, the database and its WAL files
# under both the current and the pre-rename name, logs, and any legacy JSON left
# over from older versions.
#
# Whatever a clone keeps out of git is kept off the server too: local notes and
# tooling config carry host detail and have no business on a deployed box. git's
# per-clone ignore file is handed to rsync directly, since rsync does not read
# git's ignore rules on its own, and falls back to an empty list for a clone that
# has no such file, since rsync treats a missing --exclude-from as a fatal error.
LOCAL_EXCLUDES=/dev/null
if [ -f .git/info/exclude ]; then LOCAL_EXCLUDES=.git/info/exclude; fi

echo "Staging on $HOST..."
ssh "$HOST" "rm -rf '$STAGING' && mkdir -p '$STAGING'"
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.*/' \
  --exclude-from="$LOCAL_EXCLUDES" \
  --exclude='config.json' \
  --exclude='auth.json' \
  --exclude='maps.db*' \
  --exclude='maps-manager.db*' \
  --exclude='maps.json' \
  --exclude='coverages.json' \
  --exclude='runs.json' \
  --exclude='logs/' \
  ./ "$HOST:$STAGING/"

# Two hops rather than one: the deploy target is owned by the service account,
# so the ssh user cannot rsync into it directly. Staging somewhere writable and
# moving it in with sudo is what makes that work.
#
# .bun/ is held back from --delete because some hosts keep the bun runtime
# inside the deploy directory, and it is not ours to remove.
echo "Installing into $REMOTE..."
ssh "$HOST" "sudo rsync -a --delete --exclude='.bun/' '$STAGING'/ '$REMOTE'/ \
  && sudo chown -R '$RUN_AS':'$RUN_AS' '$REMOTE' \
  && rm -rf '$STAGING'"

# There is deliberately no dependency install step. The server imports only Bun
# and node builtins, and everything the dashboard needs is bundled into dist/ at
# build time, so a deployed host has no node_modules at all. Add a runtime
# dependency and this needs to come back.

# The systemd unit is deliberately NOT copied. maps.service in this repo
# is an example; a deployed host's unit generally carries local changes (the
# sandboxing block, the bun path, mount ordering, the state directory) that
# this file knows nothing about, and overwriting it drops them silently. Install
# it by hand on first deploy, then leave it alone.
echo "Restarting $SERVICE..."
ssh "$HOST" "sudo systemctl restart '$SERVICE'"
sleep 3
ssh "$HOST" "systemctl is-active '$SERVICE' && sudo systemctl status '$SERVICE' --no-pager | head -5"

echo "Done."
