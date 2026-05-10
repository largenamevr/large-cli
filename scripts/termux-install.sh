#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TERMUX_VERSION:-}" && ! "${PREFIX:-}" =~ termux ]]; then
  echo "This script is meant to run inside Termux." >&2
fi

pkg update -y
pkg install -y nodejs git

cd "$(dirname "$0")/.."
npm install

echo "\nDone. Launch with:"
echo "  ./scripts/termux-launch.sh"
echo "or"
echo "  npm start"
