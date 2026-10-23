#!/usr/bin/env bash
set -euo pipefail

RUNROOT="${1:-/opt/pkst}"
SECRET="${2:-TEST_API_KEY}"
HOST="${3:-vault-echo.test}"
WANT_PATH="${4:-}"
WANT_METHOD="${5:-}"
AUDIT="$RUNROOT/kowd/audit.jsonl"

if [ ! -s "$AUDIT" ]; then
  printf '{"matching":0,"total_allowed":0,"unexpected":0,"malformed":0}\n'
  exit 0
fi

AUDIT="$AUDIT" SECRET="$SECRET" HOST="$HOST" WANT_PATH="$WANT_PATH" WANT_METHOD="$WANT_METHOD" node <<'NODE'
const fs = require("fs");
const file = process.env.AUDIT;
const wantSecret = process.env.SECRET;
const wantHost = process.env.HOST;
const wantPath = process.env.WANT_PATH || "";
const wantMethod = process.env.WANT_METHOD || "";
let matching = 0;
let totalAllowed = 0;
let malformed = 0;
const seenPaths = new Set();
const seenMethods = new Set();
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let rec;
  try { rec = JSON.parse(trimmed); } catch { malformed++; continue; }
  if (rec.type !== "inject_decision" || rec.decision !== "allowed") continue;
  totalAllowed++;
  const dest = rec.destination || {};
  const host = dest.host || rec.host || "";
  if (rec.secret_name !== wantSecret || host !== wantHost) continue;
  const recPath = dest.path_prefix || "";
  const recMethod = (rec.method || dest.method || "").toUpperCase();
  seenPaths.add(recPath);
  if (recMethod) seenMethods.add(recMethod);
  if (wantPath && recPath && recPath !== wantPath) continue;
  if (wantMethod && recMethod && recMethod !== wantMethod.toUpperCase()) continue;
  matching++;
}
const unexpected = totalAllowed - matching;
process.stdout.write(JSON.stringify({ matching, total_allowed: totalAllowed, unexpected, malformed, seen_paths: [...seenPaths], seen_methods: [...seenMethods] }) + "\n");
if (malformed > 0) process.exit(2);
NODE
