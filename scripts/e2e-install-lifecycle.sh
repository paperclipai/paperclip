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
#   E2E_SERVICE_TIMEOUT_SECS  how long to wait for the service to go active (default 300)
set -uo pipefail

E2E_REPO="${E2E_REPO:-paperclipai/paperclip}"
E2E_REF="${E2E_REF:-master}"
E2E_SERVICE_TIMEOUT_SECS="${E2E_SERVICE_TIMEOUT_SECS:-300}"

# A clean environment: no inherited Paperclip or build-mode state.
for var in $(env | grep -o '^PAPERCLIP_[A-Z_]*' || true); do unset "$var"; done
unset NODE_ENV npm_config_prefix 2>/dev/null || true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI="${CI:-1}"

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
    # Real quickstart path: onboard with defaults, then install + start the service.
    if shim onboard --yes --install-service; then
      pass "8a onboard --yes --install-service exits 0"
    else
      fail_ "8a onboard --yes --install-service exits 0"
    fi
    DEADLINE=$(( $(date +%s) + E2E_SERVICE_TIMEOUT_SECS ))
    ACTIVE=0
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
      STATUS_JSON="$(shim service status --json 2>/dev/null || true)"
      if echo "$STATUS_JSON" | grep -q '"active"[[:space:]]*:[[:space:]]*true'; then ACTIVE=1; break; fi
      sleep 5
    done
    if [ "$ACTIVE" = "1" ]; then
      pass "8b service reached active within ${E2E_SERVICE_TIMEOUT_SECS}s"
    else
      echo "last status: ${STATUS_JSON:-<none>}"
      shim service logs -n 60 || true
      fail_ "8b service reached active"
    fi
    shim service logs -n 20 >/dev/null 2>&1 && pass "8c service logs readable" || fail_ "8c service logs readable"
    if shim service stop; then pass "8d service stop exits 0"; else fail_ "8d service stop exits 0"; fi
    if shim service uninstall; then pass "8e service uninstall exits 0"; else fail_ "8e service uninstall exits 0"; fi
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
