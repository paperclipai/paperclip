#!/usr/bin/env bash
set -euo pipefail

NONCE="${1:?nonce required}"
RUNROOT="${2:-/opt/pkst}"
LABEL="${3:-smoke}"

AG_DIR="$RUNROOT/agent"
KOWD_DIR="$RUNROOT/kowd"
AGENTPID_FILE="$AG_DIR/agent-$LABEL.agentpid"
RESULT_FILE="$AG_DIR/result-$LABEL.json"
AGENT_LOG="$AG_DIR/agent-$LABEL.log"
SECRETS_FILE="$KOWD_DIR/static-secrets.yaml"

real=$(awk '/TEST_API_KEY:/{print $2; exit}' "$SECRETS_FILE" 2>/dev/null || true)
if [ -z "$real" ]; then
  echo "collect-evidence: cannot read real secret from $SECRETS_FILE" >&2
  exit 3
fi

pid=""
pid_found=false
if [ -s "$AGENTPID_FILE" ]; then
  pid=$(tr -dc '0-9' < "$AGENTPID_FILE")
fi
if [ -n "$pid" ]; then
  pid_found=true
fi

proc_alive=false
if [ "$pid_found" = true ] && kill -0 "$pid" 2>/dev/null; then
  proc_alive=true
fi

scan_file() {
  local path="$1" hits rc
  set +e
  hits=$(printf '%s' "$real" | LC_ALL=C grep -Fac -f - "$path" 2>/dev/null)
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    printf 'true %s\n' "$hits"
  elif [ "$rc" -eq 1 ]; then
    printf 'true 0\n'
  else
    printf 'false 0\n'
  fi
}

env_readable=false
env_hits=0
cmdline_readable=false
cmdline_hits=0
agent_identity_ok=false
if [ "$proc_alive" = true ]; then
  read -r env_readable env_hits < <(scan_file "/proc/$pid/environ")
  read -r cmdline_readable cmdline_hits < <(scan_file "/proc/$pid/cmdline")
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
  exe_base=${exe##*/}
  owner=$(stat -c %U "/proc/$pid" 2>/dev/null || true)
  if [[ "$exe_base" =~ ^node(js)?$ ]] && [ "$owner" = "agent" ]; then
    agent_identity_ok=true
  fi
fi

log_readable=false
log_hits=0
if [ -f "$AGENT_LOG" ]; then
  read -r log_readable log_hits < <(scan_file "$AGENT_LOG")
fi

result_found=false
result_bytes=0
result_hits=0
result_readable=false
result_nonce_ok=false
if [ -s "$RESULT_FILE" ]; then
  result_found=true
  result_bytes=$(wc -c < "$RESULT_FILE" | tr -d ' ')
  read -r result_readable result_hits < <(scan_file "$RESULT_FILE")
  result_nonce=$(node -e 'const fs=require("fs");try{const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o.nonce==null?"":o.nonce))}catch(e){process.stdout.write("")}' "$RESULT_FILE" 2>/dev/null || true)
  if [ "$result_nonce" = "$NONCE" ]; then
    result_nonce_ok=true
  fi
fi

printf '{"pid_found":%s,"proc_alive":%s,"result_found":%s,"result_bytes":%s,"env_readable":%s,"env_hits":%s,"cmdline_readable":%s,"cmdline_hits":%s,"result_hits":%s,"result_readable":%s,"result_nonce_ok":%s,"log_readable":%s,"log_hits":%s,"agent_identity_ok":%s}\n' \
  "$pid_found" "$proc_alive" "$result_found" "$result_bytes" \
  "$env_readable" "$env_hits" "$cmdline_readable" "$cmdline_hits" "$result_hits" \
  "$result_readable" "$result_nonce_ok" "$log_readable" "$log_hits" "$agent_identity_ok"

fail=0
if [ "$pid_found" != true ]; then fail=1; fi
if [ "$proc_alive" != true ]; then fail=1; fi
if [ "$result_found" != true ] || [ "$result_bytes" -eq 0 ]; then fail=1; fi
if [ "$result_readable" != true ]; then fail=1; fi
if [ "$result_nonce_ok" != true ]; then fail=1; fi
if [ "$env_readable" != true ]; then fail=1; fi
if [ "$cmdline_readable" != true ]; then fail=1; fi
if [ "$log_readable" != true ]; then fail=1; fi
if [ "$agent_identity_ok" != true ]; then fail=1; fi

exit "$fail"
