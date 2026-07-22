#!/usr/bin/env bash
# Redeploy the modder-hosting backend on the box (run as root): pull, install, restart.
#   ssh root@<box> /opt/rcpz-tools/tools/modhost/redeploy.sh
set -euo pipefail
DIR=/opt/rcpz-tools

echo "==> git pull"
git -C "$DIR" pull --ff-only

echo "==> npm install"
( cd "$DIR" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund )

echo "==> ownership"
chown -R rcpz:rcpz "$DIR"

echo "==> restart"
systemctl daemon-reload
systemctl restart rcpz-modhost.service
sleep 1
systemctl --no-pager --lines=8 status rcpz-modhost.service | tail -10
