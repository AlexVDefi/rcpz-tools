#!/usr/bin/env bash
# One-time setup of the rcpz-tools modder-hosting backend on a fresh Debian/Ubuntu box. Run as root.
#   ssh root@<box> 'bash -s' < tools/modhost/bootstrap.sh
# Idempotent: safe to re-run. After it finishes, fill /opt/rcpz-tools/tools/modhost/.env and
# `systemctl start rcpz-modhost`.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/AlexVDefi/rcpz-tools.git}"
REPO_BRANCH="${REPO_BRANCH:-modder-hosting}"
DIR=/opt/rcpz-tools
USER=rcpz

echo "==> service user"
id -u "$USER" &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin "$USER"

echo "==> steamcmd (+ 32-bit deps it needs)"
dpkg --add-architecture i386 || true
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl tar lib32gcc-s1
mkdir -p /opt/steamcmd
[ -f /opt/steamcmd/steamcmd.sh ] || curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar -xz -C /opt/steamcmd

echo "==> clone / update repo ($REPO_BRANCH)"
[ -d "$DIR/.git" ] || git clone -b "$REPO_BRANCH" "$REPO_URL" "$DIR"
git -C "$DIR" fetch origin "$REPO_BRANCH"
git -C "$DIR" checkout "$REPO_BRANCH"
git -C "$DIR" pull --ff-only origin "$REPO_BRANCH" || true

echo "==> npm install (tools only; skip the electron binary)"
( cd "$DIR" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund )

echo "==> env file"
ENVF="$DIR/tools/modhost/.env"
[ -f "$ENVF" ] || cp "$DIR/tools/modhost/.env.example" "$ENVF"

echo "==> ownership"
chown -R "$USER:$USER" "$DIR" /opt/steamcmd

echo "==> systemd unit"
ln -sf "$DIR/tools/modhost/rcpz-modhost.service" /etc/systemd/system/rcpz-modhost.service
systemctl daemon-reload
systemctl enable rcpz-modhost.service

echo "==> bootstrap complete."
grep -q PASTE "$ENVF" && echo "    NEXT: edit $ENVF (secrets), then: systemctl start rcpz-modhost" || echo "    starting: systemctl restart rcpz-modhost"
