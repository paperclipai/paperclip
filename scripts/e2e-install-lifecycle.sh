#!/usr/bin/env bash
# End-to-end proof of the paperclipai managed install lifecycle on a CLEAN machine.
#
# Exercises the real user journey against real GitHub + real npm:
#   bootstrap build -> install (npm latest) -> install --ref (build-from-source)
#   -> update --check -> update --rollback -> reinstall (payload reuse)
#   -> bad-ref failure hygiene -> service lifecycle -> uninstall (data preserved)
#
# Machine requirements: bash, curl, tar, node >= 20 (with corepack), npm.
# The machine's $HOME must not already contain a managed install.
#
# Env knobs:
#   E2E_REPO          GitHub repo to install from (default: paperclipai/paperclip)
#   E2E_REF           branch/tag/sha to install   (default: master)
#   E2E_SKIP_NPM=1      skip the npm-channel install step (canary is tested separately;
#                       the npm leg uses the latest channel)
#   E2E_SKIP_SERVICE=1  skip the service lifecycle step
#   E2E_ENABLE_LINGER=1 require and exercise user lingering on the Linux runner
#   E2E_SERVICE_TIMEOUT_SECS  how long to wait for the service to go active (default 300)
#   E2E_DECISION_SIGNING_SECRET  disposable decision-signing secret for the isolated instance
set -uo pipefail

E2E_REPO="${E2E_REPO:-paperclipai/paperclip}"
E2E_REF="${E2E_REF:-master}"
E2E_SERVICE_TIMEOUT_SECS="${E2E_SERVICE_TIMEOUT_SECS:-300}"

# A clean environment: no inherited Paperclip or build-mode state.
for var in $(env | grep -o '^PAPERCLIP_[A-Z_]*' || true); do unset "$var"; done
unset NODE_ENV npm_config_prefix 2>/dev/null || true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI="${CI:-1}"
export PAPERCLIP_DECISION_SIGNING_SECRET="${E2E_DECISION_SIGNING_SECRET:-install-e2e-decision-signing-secret-0000000000}"

SHIM="$HOME/.local/bin/paperclipai"
STORE="$HOME/.paperclip/cli"
RESULTS=()
FAILED=0

note()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
pass()  { RESULTS+=("PASS  $1"); printf '\033[1;32mPASS\033[0m %s\n' "$1"; }
fail_() { RESULTS+=("FAIL  $1"); printf '\033[1;31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip_() { RESULTS+=("SKIP  $1${2:+ — $2}"); printf '\033[1;33mSKIP\033[0m %s%s\n' "$1" "${2:+ — $2}"; }

shim() { "$SHIM" "$@"; }
current_target() { readlink "$STORE/current" 2>/dev/null || echo "<missing>"; }

wait_service_active() {
  local deadline=$(( $(date +%s) + E2E_SERVICE_TIMEOUT_SECS )) status_json=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status_json="$(shim service status --json 2>/dev/null || true)"
    if echo "$status_json" | grep -q '"active"[[:space:]]*:[[:space:]]*true'; then
      printf '%s\n' "$status_json"
      return 0
    fi
    sleep 2
  done
  echo "last status: ${status_json:-<none>}" >&2
  shim service logs -n 80 >&2 || true
  return 1
}

json_field() {
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    let current = value;
    for (const part of process.argv[1].split(".")) current = current?.[part];
    if (current !== undefined && current !== null) process.stdout.write(String(current));
  ' "$1"
}

api_post() {
  local path="$1" body="$2"
  curl --fail --silent --show-error \
    --request POST \
    --header "Content-Type: application/json" \
    --header "Origin: http://127.0.0.1:3100" \
    --data "$body" \
    "http://127.0.0.1:3100${path}"
}

note "0. Preflight — this machine"
uname -a
node --version && npm --version && curl --version | head -1
command -v corepack >/dev/null || npm install -g corepack
[ -e "$SHIM" ] && { echo "shim already exists at $SHIM — not a clean machine"; exit 2; }
[ -d "$STORE" ] && { echo "store already exists at $STORE — not a clean machine"; exit 2; }
echo "repo=$E2E_REPO ref=$E2E_REF home=$HOME"

note "1. Bootstrap: build the new CLI from the GitHub tarball of $E2E_REF"
# Nothing published on npm has the install/update/service commands yet, so the
# bootstrap simulates what `npx paperclipai@<channel> install` will run post-release:
# the same CLI code, built from the exact ref under test.
BOOT="$HOME/e2e-bootstrap"
mkdir -p "$BOOT"
if curl --fail --silent --show-error --location \
    "https://codeload.github.com/$E2E_REPO/tar.gz/$E2E_REF" \
    | tar -xz --strip-components=1 -C "$BOOT"; then
  pass "1a bootstrap tarball downloaded from codeload"
else
  fail_ "1a bootstrap tarball download"; exit 1
fi
cd "$BOOT"
if corepack pnpm install --frozen-lockfile > "$HOME/e2e-bootstrap-install.log" 2>&1; then
  pass "1b bootstrap pnpm install"
else
  tail -40 "$HOME/e2e-bootstrap-install.log"; fail_ "1b bootstrap pnpm install"; exit 1
fi
if bash scripts/build-npm.sh --skip-checks --skip-typecheck > "$HOME/e2e-bootstrap-build.log" 2>&1; then
  pass "1c bootstrap build-npm.sh"
else
  tail -40 "$HOME/e2e-bootstrap-build.log"; fail_ "1c bootstrap build-npm.sh"; exit 1
fi
# The in-checkout dist resolves externals against the publishable package.json,
# so run the bootstrap exactly the way npm users get it: pack + install the tarball.
TARBALL="$(cd "$BOOT/cli" && npm pack --silent 2>/dev/null | tail -1)"
mkdir -p "$HOME/e2e-bootstrap-cli"
if (cd "$HOME/e2e-bootstrap-cli" && npm install --no-fund --no-audit "$BOOT/cli/$TARBALL" > "$HOME/e2e-bootstrap-npm.log" 2>&1); then
  pass "1d bootstrap CLI packed + npm-installed ($TARBALL)"
else
  tail -40 "$HOME/e2e-bootstrap-npm.log"; fail_ "1d bootstrap CLI npm install"; exit 1
fi
BOOTSTRAP_CLI="$HOME/e2e-bootstrap-cli/node_modules/paperclipai/dist/index.js"
node "$BOOTSTRAP_CLI" --version >/dev/null || { fail_ "1e bootstrap CLI smoke"; exit 1; }
cd "$HOME"

if [ "${E2E_SKIP_NPM:-0}" != "1" ]; then
  note "2. install (published npm latest channel; proves the npm install mechanism)"
  if node "$BOOTSTRAP_CLI" install --yes; then
    pass "2a install (latest) exits 0"
  else
    fail_ "2a install (latest) exits 0"
  fi
  [ -x "$SHIM" ] && pass "2b shim created at ~/.local/bin/paperclipai" || fail_ "2b shim created"
  case "$(current_target)" in
    *"installs/npm/"*) pass "2c current -> installs/npm/<version> ($(basename "$(current_target)"))" ;;
    *) fail_ "2c current -> installs/npm/<version> (got: $(current_target))" ;;
  esac
  [ -f "$STORE/install.json" ] && pass "2d install.json manifest present" || fail_ "2d install.json manifest present"
  NPM_VERSION="$("$SHIM" --version 2>/dev/null || true)"
  [ -n "$NPM_VERSION" ] && pass "2e shim runs: paperclipai --version = $NPM_VERSION" || fail_ "2e shim runs paperclipai --version"
else
  skip_ "2 install (npm latest)" "E2E_SKIP_NPM=1"
fi

note "3. install --ref $E2E_REF (real build-from-GitHub-source into the managed store)"
if node "$BOOTSTRAP_CLI" install --repo "$E2E_REPO" --ref "$E2E_REF" --yes; then
  pass "3a install --ref exits 0"
else
  fail_ "3a install --ref exits 0"
fi
case "$(current_target)" in
  *"installs/git/"*) pass "3b current -> installs/git/<sha> ($(basename "$(current_target)"))" ;;
  *) fail_ "3b current -> installs/git/<sha> (got: $(current_target))" ;;
esac
GIT_VERSION="$("$SHIM" --version 2>/dev/null || true)"
[ -n "$GIT_VERSION" ] && pass "3c shim runs git payload: --version = $GIT_VERSION" || fail_ "3c shim runs git payload"
[ -x "$SHIM" ] && pass "3d shim still in place" || fail_ "3d shim still in place"

note "4. update --check from the managed shim"
shim update --check --json; CHECK_EXIT=$?
if [ "$CHECK_EXIT" -eq 0 ] || [ "$CHECK_EXIT" -eq 10 ]; then
  pass "4a update --check exits $CHECK_EXIT (0=current, 10=update available)"
else
  fail_ "4a update --check exit code (got $CHECK_EXIT)"
fi

if [ "${E2E_SKIP_NPM:-0}" != "1" ]; then
  note "5. update --rollback (git payload -> previous npm payload)"
  if shim update --rollback; then
    pass "5a update --rollback exits 0"
  else
    fail_ "5a update --rollback exits 0"
  fi
  case "$(current_target)" in
    *"installs/npm/"*) pass "5b rollback restored npm payload ($(basename "$(current_target)"))" ;;
    *) fail_ "5b rollback restored npm payload (got: $(current_target))" ;;
  esac
  ROLLED_VERSION="$("$SHIM" --version 2>/dev/null || true)"
  [ "$ROLLED_VERSION" = "$NPM_VERSION" ] \
    && pass "5c version after rollback matches npm payload ($ROLLED_VERSION)" \
    || fail_ "5c version after rollback ($ROLLED_VERSION != $NPM_VERSION)"

  note "6. reinstall the git ref (payload retained -> reused, no rebuild)"
  REINSTALL_START=$(date +%s)
  if node "$BOOTSTRAP_CLI" install --repo "$E2E_REPO" --ref "$E2E_REF" --yes; then
    REINSTALL_SECS=$(( $(date +%s) - REINSTALL_START ))
    pass "6a reinstall exits 0 (${REINSTALL_SECS}s — reused payload should be fast)"
  else
    fail_ "6a reinstall exits 0"
  fi
  case "$(current_target)" in
    *"installs/git/"*) pass "6b back on git payload" ;;
    *) fail_ "6b back on git payload (got: $(current_target))" ;;
  esac
else
  skip_ "5-6 rollback/reinstall" "E2E_SKIP_NPM=1"
fi

note "7. failure hygiene: install --ref <nonexistent> must fail cleanly"
BEFORE_DIRS="$(ls "$STORE/installs/git" 2>/dev/null | sort)"
if node "$BOOTSTRAP_CLI" install --ref e2e-definitely-not-a-ref-xyz --yes 2>&1; then
  fail_ "7a bad ref rejected (command unexpectedly succeeded)"
else
  pass "7a bad ref rejected with nonzero exit"
fi
AFTER_DIRS="$(ls "$STORE/installs/git" 2>/dev/null | sort)"
[ "$BEFORE_DIRS" = "$AFTER_DIRS" ] && pass "7b no partial install dir left behind" || fail_ "7b no partial install dir left behind"
"$SHIM" --version >/dev/null 2>&1 && pass "7c existing install still healthy" || fail_ "7c existing install still healthy"

if [ "${E2E_SKIP_SERVICE:-0}" = "1" ]; then
  skip_ "8 service lifecycle" "E2E_SKIP_SERVICE=1"
else
  if [ "$(uname -s)" = "Linux" ] && [ ! -S "/run/user/$(id -u)/bus" ]; then
    skip_ "8 service lifecycle" "no systemd user bus at /run/user/$(id -u)/bus"
  else
    note "8. service lifecycle ($(uname -s): systemd/launchd)"
    # `onboard --yes` starts a foreground server. Opt into the managed service so
    # noninteractive onboarding returns, then repeat `service install` below to
    # prove the explicit operation is idempotent and leaves it enabled + active.
    INSTANCE_ENV="$HOME/.paperclip/instances/default/.env"
    mkdir -p "$(dirname "$INSTANCE_ENV")"
    printf 'PAPERCLIP_DECISION_SIGNING_SECRET=%s\n' \
      "$PAPERCLIP_DECISION_SIGNING_SECRET" > "$INSTANCE_ENV"
    chmod 600 "$INSTANCE_ENV"
    if shim onboard --yes --install-service; then
      pass "8a noninteractive onboard installs and starts the service"
    else
      fail_ "8a noninteractive onboard installs and starts the service"
    fi

    # The isolated runner pre-enables linger as root; requesting it again as the
    # unprivileged test user would spuriously require a polkit interaction.
    if shim service install --json; then
      pass "8b explicit service install is idempotent and leaves the service started"
    else
      fail_ "8b explicit service install is idempotent and leaves the service started"
    fi

    if STATUS_JSON="$(wait_service_active)"; then
      pass "8c service reached active within ${E2E_SERVICE_TIMEOUT_SECS}s"
    else
      STATUS_JSON=""
      fail_ "8c service reached active"
    fi

    if echo "$STATUS_JSON" | grep -q '"enabled"[[:space:]]*:[[:space:]]*true'; then
      pass "8d service is enabled for login/startup"
    else
      fail_ "8d service is enabled for login/startup"
    fi

    if [ "$(uname -s)" = "Linux" ] && [ "${E2E_ENABLE_LINGER:-0}" = "1" ]; then
      if loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null | grep -qx yes; then
        pass "8e systemd lingering is enabled"
      else
        fail_ "8e systemd lingering is enabled"
      fi
    else
      skip_ "8e systemd lingering" "not requested on this runner"
    fi

    note "8f. crash-kill: systemd must respawn the server"
    OLD_PID="$(printf '%s' "$STATUS_JSON" | json_field pid 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -9 "$OLD_PID" 2>/dev/null; then
      DEADLINE=$(( $(date +%s) + E2E_SERVICE_TIMEOUT_SECS ))
      NEW_PID=""
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        STATUS_JSON="$(shim service status --json 2>/dev/null || true)"
        NEW_PID="$(printf '%s' "$STATUS_JSON" | json_field pid 2>/dev/null || true)"
        if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ] \
          && echo "$STATUS_JSON" | grep -q '"active"[[:space:]]*:[[:space:]]*true'; then
          break
        fi
        sleep 2
      done
      if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ]; then
        pass "8f crash-killed service respawned ($OLD_PID -> $NEW_PID)"
      else
        fail_ "8f crash-killed service respawned (old pid $OLD_PID, new pid ${NEW_PID:-<none>})"
      fi
    else
      fail_ "8f service exposes a killable supervisor PID"
    fi

    if [ "$(uname -s)" = "Linux" ] && [ "${E2E_ENABLE_LINGER:-0}" = "1" ]; then
      note "8g. login-session survival: restart the lingering user manager"
      if sudo systemctl restart "user@$(id -u).service"; then
        DEADLINE=$(( $(date +%s) + E2E_SERVICE_TIMEOUT_SECS ))
        while [ "$(date +%s)" -lt "$DEADLINE" ] && [ ! -S "/run/user/$(id -u)/bus" ]; do sleep 1; done
        if wait_service_active >/dev/null; then
          pass "8g service survived a user-manager/login-session restart with linger"
        else
          fail_ "8g service survived a user-manager/login-session restart with linger"
        fi
      else
        fail_ "8g restart lingering user manager"
      fi
    else
      skip_ "8g login-session survival" "requires the isolated Linux linger runner"
    fi

    note "8h. single-writer guard: foreground run must refuse an active service"
    if RUN_OUT="$(timeout 20 "$SHIM" run 2>&1)"; then
      echo "$RUN_OUT"
      fail_ "8h foreground run refused while service is active"
    elif echo "$RUN_OUT" | grep -qi "already running"; then
      pass "8h foreground run refused while service is active"
    else
      echo "$RUN_OUT"
      fail_ "8h foreground run returned the single-writer diagnostic"
    fi

    note "8i. hot restart: adopt a live local CLI-agent run"
    FAKE_CLAUDE="$HOME/.paperclip-e2e-fake-claude"
    cat > "$FAKE_CLAUDE" <<'EOF'
#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hot restart adoption e2e complete",
    session_id: "paperclip-install-e2e",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  }));
  process.exit(0);
}, 180000);
EOF
    chmod 700 "$FAKE_CLAUDE"
    COMPANY_JSON="$(api_post /api/companies '{"name":"Install E2E hot restart"}' 2>/dev/null || true)"
    COMPANY_ID="$(printf '%s' "$COMPANY_JSON" | json_field id 2>/dev/null || true)"
    AGENT_JSON=""
    AGENT_ID=""
    RUN_JSON=""
    RUN_ID=""
    if [ -n "$COMPANY_ID" ]; then
      AGENT_PAYLOAD="$(node -e '
        process.stdout.write(JSON.stringify({
          name: "Hot restart sleeper",
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli", command: process.argv[1], timeoutSec: 120 },
        }));
      ' "$FAKE_CLAUDE")"
      AGENT_JSON="$(api_post "/api/companies/$COMPANY_ID/agents" "$AGENT_PAYLOAD" 2>/dev/null || true)"
      AGENT_ID="$(printf '%s' "$AGENT_JSON" | json_field id 2>/dev/null || true)"
    fi
    if [ -n "$AGENT_ID" ]; then
      RUN_JSON="$(api_post "/api/agents/$AGENT_ID/heartbeat/invoke" '{}' 2>/dev/null || true)"
      RUN_ID="$(printf '%s' "$RUN_JSON" | json_field id 2>/dev/null || true)"
    fi
    if [ -n "$RUN_ID" ]; then
      DEADLINE=$(( $(date +%s) + 30 ))
      RUN_STATUS=""
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        RUN_STATUS="$(curl --fail --silent --show-error "http://127.0.0.1:3100/api/heartbeat-runs/$RUN_ID" 2>/dev/null | json_field status 2>/dev/null || true)"
        [ "$RUN_STATUS" = "running" ] && break
        sleep 1
      done
      if [ "$RUN_STATUS" = "running" ]; then
        pass "8i live local CLI-agent run reached running state"
      else
        fail_ "8i live local CLI-agent run reached running state (got ${RUN_STATUS:-<none>})"
      fi
    else
      fail_ "8i created a live local CLI-agent run"
    fi

    RESTART_JSON="$(shim service restart --json 2>/dev/null || true)"
    echo "$RESTART_JSON"
    HOT_REPORT="$HOME/.paperclip/instances/default/hot-restart-report.json"
    DEADLINE=$(( $(date +%s) + E2E_SERVICE_TIMEOUT_SECS ))
    while [ -n "$RUN_ID" ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do
      if [ -f "$HOT_REPORT" ] && node -e '
        const fs = require("fs");
        const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.exit(report.adoptedRunIds?.includes(process.argv[2]) ? 0 : 1);
      ' "$HOT_REPORT" "$RUN_ID"; then
        break
      fi
      sleep 1
    done
    if [ -n "$RUN_ID" ] && [ -f "$HOT_REPORT" ] \
      && node -e '
        const fs = require("fs");
        const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.exit(report.adoptedRunIds?.includes(process.argv[2]) ? 0 : 1);
      ' "$HOT_REPORT" "$RUN_ID"; then
      pass "8j service restart hot-restart report adopted the live run"
    else
      [ -f "$HOT_REPORT" ] && cat "$HOT_REPORT"
      fail_ "8j service restart hot-restart report adopted the live run"
    fi

    if wait_service_active >/dev/null; then
      pass "8k service healthy after hot restart"
    else
      fail_ "8k service healthy after hot restart"
    fi

    if [ -n "$RUN_ID" ]; then
      RUN_DETAIL="$(curl --fail --silent --show-error "http://127.0.0.1:3100/api/heartbeat-runs/$RUN_ID" 2>/dev/null || true)"
      RUN_STATUS="$(printf '%s' "$RUN_DETAIL" | json_field status 2>/dev/null || true)"
      RUN_ADOPTED="$(printf '%s' "$RUN_DETAIL" | json_field resultJson.hotRestart.adopted 2>/dev/null || true)"
      if [ "$RUN_STATUS" = "running" ] && [ "$RUN_ADOPTED" = "true" ]; then
        pass "8l adopted live run remains protected from orphan reaping"
      else
        fail_ "8l adopted live run remains protected from orphan reaping (status=${RUN_STATUS:-<none>} adopted=${RUN_ADOPTED:-<none>})"
      fi
    fi

    shim service logs -n 40 >/dev/null 2>&1 && pass "8m service logs readable" || fail_ "8m service logs readable"
    POSTGRES_PID_FILE="$HOME/.paperclip/instances/default/db/postmaster.pid"
    MANAGED_POSTGRES_PID="$(head -n 1 "$POSTGRES_PID_FILE" 2>/dev/null || true)"
    if shim service uninstall; then
      pass "8n service uninstall exits 0"
    else
      fail_ "8n service uninstall exits 0"
    fi
    STATUS_JSON="$(shim service status --json 2>/dev/null || true)"
    if echo "$STATUS_JSON" | grep -q '"installed"[[:space:]]*:[[:space:]]*false' \
      && echo "$STATUS_JSON" | grep -q '"active"[[:space:]]*:[[:space:]]*false'; then
      pass "8o uninstall leaves no service loaded or active"
    else
      echo "$STATUS_JSON"
      fail_ "8o uninstall leaves no service loaded or active"
    fi
    if [ -z "$MANAGED_POSTGRES_PID" ]; then
      fail_ "8p captured embedded PostgreSQL pid before uninstall"
    else
      DEADLINE=$(( $(date +%s) + 30 ))
      while [ "$(date +%s)" -lt "$DEADLINE" ] && kill -0 "$MANAGED_POSTGRES_PID" 2>/dev/null; do
        sleep 1
      done
      if kill -0 "$MANAGED_POSTGRES_PID" 2>/dev/null; then
        fail_ "8p uninstall stopped crash-surviving embedded PostgreSQL (pid $MANAGED_POSTGRES_PID still running)"
      else
        pass "8p uninstall stopped crash-surviving embedded PostgreSQL"
      fi
    fi
  fi
fi

note "9. installer script guardrails (from the bootstrap checkout)"
# Capture first: under pipefail, install.sh's expected exit 1 would fail the pipeline.
GUARD_OUT="$(bash "$BOOT/scripts/install.sh" --ref deadbeef 2>&1 || true)"
if echo "$GUARD_OUT" | grep -qi "not supported"; then
  pass "9a install.sh rejects --ref with guidance to npx path"
else
  echo "$GUARD_OUT" | tail -3
  fail_ "9a install.sh rejects --ref"
fi

note "10. uninstall preserves user data"
mkdir -p "$HOME/.paperclip" && touch "$HOME/.paperclip/e2e-user-data-marker"
if shim uninstall; then
  pass "10a uninstall exits 0"
else
  fail_ "10a uninstall exits 0"
fi
[ ! -e "$SHIM" ] && pass "10b shim removed" || fail_ "10b shim removed"
[ ! -d "$STORE" ] && pass "10c managed store removed" || fail_ "10c managed store removed"
[ -f "$HOME/.paperclip/e2e-user-data-marker" ] && pass "10d user data under ~/.paperclip preserved" || fail_ "10d user data preserved"

note "RESULTS ($E2E_REPO@$E2E_REF on $(uname -sm))"
printf '%s\n' "${RESULTS[@]}"
if [ "$FAILED" = "1" ]; then echo; echo "OVERALL: FAIL"; exit 1; fi
echo; echo "OVERALL: PASS"
