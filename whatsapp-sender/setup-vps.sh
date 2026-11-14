#!/usr/bin/env bash
# Installs and starts the MBGN WhatsApp sender on an Ubuntu or Debian VPS, and keeps it running
# across reboots. Safe to run again: it updates the code and restarts, keeping the WhatsApp login
# (auth/) and the settings (.env).
#
# scripts/whatsapp-vps.ps1 on your PC uploads this folder and runs it for you. To run it by hand,
# from this folder:  bash setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")"
NAME=mbgn-whatsapp

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script is for Ubuntu or Debian. On another system, install Node.js 22 and pm2 yourself, then: npm ci && pm2 start npm --name $NAME -- start"
  exit 1
fi

# Node.js 22.13 or newer, from NodeSource (the usual source for current Node.js on Ubuntu).
node_ok() {
  command -v node >/dev/null 2>&1 && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}
if ! node_ok; then
  step "Installing Node.js 22"
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
echo "Node.js $(node --version)"

if ! command -v pm2 >/dev/null 2>&1; then
  step "Installing pm2, which keeps the sender running"
  $SUDO npm install -g pm2 --no-audit --no-fund
fi

step "Installing the sender"
npm ci --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Fill in .env (SITE_URL and WHATSAPP_SENDER_TOKEN), then run this script again."
  exit 1
fi
chmod 600 .env

step "Starting it"
if pm2 describe "$NAME" >/dev/null 2>&1; then
  pm2 flush "$NAME" >/dev/null
  pm2 restart "$NAME" --update-env
else
  pm2 start npm --name "$NAME" --cwd "$PWD" -- start
  # Old logs are cleared automatically, so they never fill the disk.
  pm2 install pm2-logrotate >/dev/null 2>&1 || true
fi
# Back by itself after a reboot.
if ! $SUDO env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1; then
  echo "Note: could not set it to start after a reboot (no systemd here). After a reboot, run: pm2 resurrect"
fi
pm2 save >/dev/null

# Through Evolution API, the phone is linked in Evolution's manager, not here.
if grep -q '^TRANSPORT=evolution' .env; then
  step "Done. It sends through Evolution API."
  echo "  If the contest phone isn't linked yet: open Evolution's manager, open the instance, and scan its QR code."
  echo "  See what it's doing:  pm2 logs $NAME"
  echo "  In admin:             Messages > WhatsApp messages"
  exit 0
fi

linked() { [ -f auth/creds.json ] && node -e 'process.exit(require("./auth/creds.json").me ? 0 : 1)' 2>/dev/null; }
if linked; then
  step "Done. It is linked to WhatsApp and sending."
  echo "  See what it's doing:  pm2 logs $NAME"
  echo "  In admin:             Messages > WhatsApp messages"
  exit 0
fi

step "Last step: link the contest phone"
if grep -q '^PAIRING_NUMBER=[0-9]' .env; then
  echo "  A pairing code appears below. On the contest phone: WhatsApp > Linked devices > Link a device >"
  echo "  Link with phone number instead, and enter it."
else
  echo "  A QR code appears below. On the contest phone: WhatsApp > Linked devices > Link a device, and scan it."
  echo "  The code changes every 20 seconds or so; scan the newest one."
fi
echo "  When it says 'Connected to WhatsApp', press Ctrl+C. That only closes this view: the sender keeps running."
echo
sleep 3
pm2 logs "$NAME" --raw --lines 80
