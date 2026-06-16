#!/usr/bin/env bash
# paperclip-consult-codex — claude_k8s agent → Codex second-opinion wrapper.
# BLO-2413. See .planning/codex-second-opinion.md (in the k8s repo) for design.
#
# Usage (stdin = prompt, stdout = codex JSONL stream):
#   echo "<prompt>" | paperclip-consult-codex [--model M] [--effort E]
#
# Execs `codex exec` with --json --dangerously-bypass-approvals-and-sandbox.
# Bypass is safe because the Job pod is already the sandbox; the agent can't
# escape it. Older images used local ccrotate here; production images now rely
# on ccrotate-serve/state and omit the local CLI, so the preflight below is
# strictly best-effort when the binary exists in a developer image.
#
# MCP fleet inheritance: the wrapper reads the same MCP servers claude is
# using inside this Job (per-agent merged at /tmp/prompt/mcp.json when the
# adapter has layered an override, otherwise the shared seed-init baseline
# at /paperclip/.mcp.json), translates the JSON to codex's TOML schema,
# and points codex at a per-invocation CODEX_HOME that contains:
#   - config.toml — translated [mcp_servers.*] blocks
#   - auth.json + everything else — symlinked from $CODEX_HOME so creds
#     stay current in the canonical home
# Each invocation gets its own CODEX_HOME under /tmp/codex-run-* so
# parallel `consult-codex` calls in the same pod don't fight over a
# shared config.toml.
#
# Cred isolation:
#   - claude credentials  : /paperclip/.claude/.credentials.json
#   - codex credentials   : /paperclip/.codex/auth.json
# Local ccrotate, when present in a developer image, only touches
# /paperclip/.codex/, so claude is unaffected. `flock` on
# /paperclip/.codex/.ccrotate.lock prevents parallel Job pods from corrupting
# auth.json during that legacy preflight.
#
# Failure modes:
#   - local ccrotate missing or all codex accounts exhausted → legacy refresh
#     is skipped (|| true), then codex exec runs with whatever creds are on
#     disk. Operator gets a meaningful 401-from-codex instead of an opaque
#     hang.
#   - mcp.json missing/malformed → wrapper still runs codex, just without
#     any MCP servers (text-only second opinion).
#   - SSE-typed entries (e.g. kubernetes-mcp's /sse endpoint) get emitted
#     as plain `url = "..."`; codex's MCP client may surface a transport
#     error at startup if it can't negotiate SSE. The other servers
#     remain usable.

set -uo pipefail

MODEL=""
EFFORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model)  MODEL="$2"; shift 2 ;;
    --effort) EFFORT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "paperclip-consult-codex: unknown flag '$1'" >&2
      exit 64
      ;;
  esac
done

export CCROTATE_TARGET=codex
export CODEX_HOME="${CODEX_HOME:-/paperclip/.codex}"
mkdir -p "${CODEX_HOME}" 2>/dev/null || true

# Cross-pod serialization for the legacy local ccrotate preflight. flock is
# best-effort: if /paperclip is unwritable for any reason we still want codex
# to attempt the call rather than fail before the prompt is even sent.
LOCKFILE="${CODEX_HOME}/.ccrotate.lock"
(
  flock -w 10 9 2>/dev/null || true
  if command -v ccrotate >/dev/null 2>&1; then
    ccrotate --target codex snap --force >/dev/null 2>&1 || true
    ccrotate --target codex next --yes  >/dev/null 2>&1 || true
  fi
) 9>"${LOCKFILE}"

# Locate the MCP source-of-truth for this invocation. The adapter writes
# /tmp/prompt/mcp.json when adapterConfig.mcpServers is set (per-agent
# layered baseline); otherwise the seed-init's shared baseline is used.
MCP_SRC=""
if [ -f /tmp/prompt/mcp.json ]; then
  MCP_SRC=/tmp/prompt/mcp.json
elif [ -f /paperclip/.mcp.json ]; then
  MCP_SRC=/paperclip/.mcp.json
fi

# Per-invocation CODEX_HOME so parallel calls don't stomp on each other's
# config.toml. Symlink everything from the canonical home so auth.json remains
# the same store; replace just config.toml.
RUN_HOME="$(mktemp -d /tmp/codex-run-XXXXXX)"
shopt -s nullglob dotglob
for src in "$CODEX_HOME"/*; do
  base="$(basename "$src")"
  [ "$base" = "config.toml" ] && continue
  ln -sfn "$src" "$RUN_HOME/$base"
done
shopt -u dotglob

if [ -n "$MCP_SRC" ]; then
  python3 - "$MCP_SRC" > "$RUN_HOME/config.toml" 2>/dev/null <<'PY' || rm -f "$RUN_HOME/config.toml"
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        doc = json.load(f)
except Exception:
    sys.exit(0)
servers = doc.get("mcpServers") if isinstance(doc, dict) else None
if not isinstance(servers, dict):
    sys.exit(0)

def toml_str(v):
    s = str(v).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'

for name, spec in servers.items():
    if not isinstance(spec, dict):
        continue
    # Skip SSE entries — codex's "remote" MCP transport speaks streamable
    # HTTP, not SSE, and tries to load the URL as an MCP-over-HTTP endpoint.
    # The kubernetes-mcp-server we run only exposes /sse, which produces a
    # noisy per-server `UnexpectedContentType ... sessionid must be provided`
    # error at startup. Better to drop the entry than ship a broken wire.
    # When kubernetes-mcp-server gains a streamable-HTTP endpoint, drop this.
    if spec.get("type") == "sse" or (
        isinstance(spec.get("url"), str) and spec["url"].rstrip("/").endswith("/sse")
    ):
        continue
    print(f"[mcp_servers.{name}]")
    if "command" in spec:
        print(f"command = {toml_str(spec['command'])}")
        args = spec.get("args") or []
        if isinstance(args, list):
            print("args = [" + ", ".join(toml_str(a) for a in args) + "]")
        env = spec.get("env") or {}
        if isinstance(env, dict) and env:
            print(f"[mcp_servers.{name}.env]")
            for k, v in env.items():
                print(f"{k} = {toml_str(v)}")
    elif "url" in spec:
        # streamable HTTP (codex's --url) — codex may not negotiate SSE
        # transport; that's surfaced as a per-server startup error and
        # leaves the other servers usable.
        print(f"url = {toml_str(spec['url'])}")
    print()
PY
fi

CODEX_ARGS=(exec --json --dangerously-bypass-approvals-and-sandbox)
[ -n "${MODEL}" ]  && CODEX_ARGS+=(--model "${MODEL}")
[ -n "${EFFORT}" ] && CODEX_ARGS+=(-c "model_reasoning_effort=\"${EFFORT}\"")
CODEX_ARGS+=(-)  # read prompt from stdin

CODEX_HOME="$RUN_HOME" exec codex "${CODEX_ARGS[@]}"
