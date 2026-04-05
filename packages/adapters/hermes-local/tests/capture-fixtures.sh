#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$ROOT/fixtures"
WORKDIR="${HERMES_CAPTURE_WORKDIR:-/tmp/hermes-fixture-capture}"
MODEL="${HERMES_CAPTURE_MODEL:-}"
PROVIDER="${HERMES_CAPTURE_PROVIDER:-}"
COMMON_ARGS=(chat -Q --source tool --yolo)

mkdir -p "$FIXTURES_DIR" "$WORKDIR"
rm -rf "$WORKDIR"/*

if [[ -n "$MODEL" ]]; then
  COMMON_ARGS+=( -m "$MODEL" )
fi
if [[ -n "$PROVIDER" ]]; then
  COMMON_ARGS+=( --provider "$PROVIDER" )
fi

normalize_fixture() {
  local src="$1"
  local dest="$2"
  python3 - "$src" "$dest" <<'PY'
from pathlib import Path
import re
import sys
src, dest = sys.argv[1], sys.argv[2]
text = Path(src).read_text(encoding='utf-8')
text = text.replace('\r\n', '\n').replace('\r', '\n')
text = re.sub(r'\b\d{8}_\d{6}_[0-9a-f]{6}\b', 'SESSION_ID', text)
Path(dest).write_text(text, encoding='utf-8')
PY
}

run_capture() {
  local name="$1"
  local prompt="$2"
  shift 2
  local extra_args=("$@")
  local raw="$WORKDIR/$name.raw"
  (
    cd "$WORKDIR"
    hermes "${COMMON_ARGS[@]}" "${extra_args[@]}" -q "$prompt" > "$raw"
  )
  normalize_fixture "$raw" "$FIXTURES_DIR/$name.stdout"
}

run_capture "quiet-simple" "Reply with exactly: OK"
run_capture "quiet-tool" "Run pwd using your shell/tooling, then tell me the working directory in one short sentence."
run_capture "quiet-failed-shell" "Run a shell command that exits with code 7, then briefly report that it failed."
run_capture "quiet-write-diff" "Create a file named hello.txt containing exactly the text hello world and then tell me you created it." --toolsets file,terminal

# Non-quiet captures preserve the startup banner and resume hint.
NONQUIET_COMMON=(chat --source tool --yolo)
if [[ -n "$MODEL" ]]; then
  NONQUIET_COMMON+=( -m "$MODEL" )
fi
if [[ -n "$PROVIDER" ]]; then
  NONQUIET_COMMON+=( --provider "$PROVIDER" )
fi
(
  cd "$WORKDIR"
  hermes "${NONQUIET_COMMON[@]}" -q "Reply with exactly: OK" > "$WORKDIR/banner-simple.raw"
  hermes "${NONQUIET_COMMON[@]}" -q "Run pwd using your shell/tooling, then tell me the working directory in one short sentence." > "$WORKDIR/banner-tool.raw"
)
normalize_fixture "$WORKDIR/banner-simple.raw" "$FIXTURES_DIR/banner-simple.stdout"
normalize_fixture "$WORKDIR/banner-tool.raw" "$FIXTURES_DIR/banner-tool.stdout"

echo "Refreshed Hermes fixtures in $FIXTURES_DIR"
