#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SERVER_PID=""
CLEANED_UP="false"

cleanup() {
  if [[ "${CLEANED_UP}" == "true" ]]; then
    return
  fi
  CLEANED_UP="true"

  local exit_code=$?
  echo
  echo "[launch-local] Shutting down..."

  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi

  exit "${exit_code}"
}

trap cleanup INT TERM EXIT

if ! command -v npm >/dev/null 2>&1; then
  echo "[launch-local] npm is required but not found on PATH."
  exit 1
fi

if [[ ! -f ".env" ]]; then
  echo "[launch-local] Creating .env from .env.example"
  cp .env.example .env
fi

check_sqlite_binding() {
  node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();" >/dev/null 2>&1
}

if [[ ! -d "node_modules" ]]; then
  echo "[launch-local] Installing dependencies..."
  npm install
else
  echo "[launch-local] Syncing dependencies..."
  npm install --no-audit --no-fund >/dev/null
fi

if ! check_sqlite_binding; then
  echo "[launch-local] better-sqlite3 binary missing. Rebuilding..."
  missing_tools=()
  command -v g++ >/dev/null 2>&1 || missing_tools+=("g++")
  command -v make >/dev/null 2>&1 || missing_tools+=("make")
  command -v python3 >/dev/null 2>&1 || missing_tools+=("python3")

  if (( ${#missing_tools[@]} > 0 )); then
    echo "[launch-local] Missing required build tools: ${missing_tools[*]}"
    echo "[launch-local] Install build tools, then rerun:"
    echo "  Fedora: sudo dnf install -y gcc-c++ make python3"
    echo "  Ubuntu/Debian: sudo apt-get install -y build-essential python3 make g++"
    exit 1
  fi

  if command -v timeout >/dev/null 2>&1; then
    timeout 180s npm rebuild better-sqlite3 --build-from-source || true
  else
    npm rebuild better-sqlite3 --build-from-source || true
  fi

  if ! check_sqlite_binding; then
    echo "[launch-local] Failed to build better-sqlite3 for Node $(node -v)."
    echo "[launch-local] Install build tools, then rerun:"
    echo "  Fedora: sudo dnf install -y gcc-c++ make python3"
    echo "  Ubuntu/Debian: sudo apt-get install -y build-essential python3 make g++"
    echo "[launch-local] Optional manual rebuild command:"
    echo "  npm rebuild better-sqlite3 --build-from-source"
    exit 1
  fi
fi

mkdir -p data

echo "[launch-local] Starting app..."
export DATABASE_URL=""
export SEED_DEFAULT_TYPES="false"
npm run dev &
SERVER_PID=$!

echo "[launch-local] App is running."
echo "[launch-local] Dashboard: http://localhost:3000/"
echo "[launch-local] Booking page: http://localhost:3000/book"
echo "[launch-local] Press Ctrl+C to stop."

wait "${SERVER_PID}"
