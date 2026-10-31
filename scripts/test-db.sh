#!/usr/bin/env bash
# Throwaway MySQL for integration tests (127.0.0.1:3320): bash scripts/test-db.sh up|down|reset
set -euo pipefail
cd "$(dirname "$0")/.."
F=test/db/docker-compose.test.yml
case "${1:-up}" in
  up) docker compose -f "$F" up -d --wait ;;
  down) docker compose -f "$F" down ;;
  reset) docker compose -f "$F" down; docker compose -f "$F" up -d --wait ;;
  *) echo "usage: $0 up|down|reset"; exit 2 ;;
esac
