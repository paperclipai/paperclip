#!/usr/bin/env bash
set -euo pipefail

# Prove that `onboard --install-service` on a released artifact leaves a
# working background service. The Docker onboard smoke can never cover this
# leg: containers have no service manager, so a release whose service install
# crash-loops on a missing shim (v2026.824.0) still passes every golden-path
# check. This script runs the published npm artifact, or the supported exact
# git install for source qualification, on a real systemd user session and
# fails unless the installed service itself ends up serving /api/health.
#
# Requirements: a Linux host with a user systemd session. In CI that means
# `loginctl enable-linger` plus XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS
# pointing at /run/user/<uid>; see the smoke_service job in
# .github/workflows/release-smoke.yml.

PAPERCLIPAI_VERSION="${PAPERCLIPAI_VERSION:-latest}"
DATA_DIR="${DATA_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/paperclip-service-smoke.XXXXXX")}"
ONBOARD_TIMEOUT_SECONDS="${ONBOARD_TIMEOUT_SECONDS:-600}"
SMOKE_READY_TIMEOUT_SECONDS="${SMOKE_READY_TIMEOUT_SECONDS:-420}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
SERVICE_NAME="paperclipai.service"
SHIM_PATH="${PAPERCLIP_SHIM_PATH:-$HOME/.local/bin/paperclipai}"
# Cleanup defaults to on so a local run does not leave a service behind; CI
# disables it so the diagnostics step can still inspect the unit.
SMOKE_CLEANUP="${SMOKE_CLEANUP:-true}"
SMOKE_FORCE="${SMOKE_FORCE:-false}"
SOURCE_SHA="${SOURCE_SHA:-}"
PAPERCLIPAI_CLI_PATH="${PAPERCLIPAI_CLI_PATH:-}"
SOURCE_INSTALL_TIMEOUT_SECONDS="${SOURCE_INSTALL_TIMEOUT_SECONDS:-1800}"
SERVICE_PROBE_PATH="${SERVICE_PROBE_PATH:-$(cd "$(dirname "$0")/.." && pwd)/tests/release-smoke/installed-cli-probe.mjs}"
SERVICE_QUALIFICATION_RECEIPT="${SERVICE_QUALIFICATION_RECEIPT:-$DATA_DIR/service-qualification.json}"
SERVICE_SMOKE_OWNERSHIP_FILE="${SERVICE_SMOKE_OWNERSHIP_FILE:-$DATA_DIR/service-smoke-owned}"
owns_service=false

fail() {
  echo "Service smoke failed: $*" >&2
  exit 1
}

diagnostics() {
  echo "--- systemctl --user status $SERVICE_NAME ---" >&2
  systemctl --user --no-pager status "$SERVICE_NAME" >&2 || true
  echo "--- journalctl --user -u $SERVICE_NAME (last 100 lines) ---" >&2
  journalctl --user -u "$SERVICE_NAME" --no-pager -n 100 >&2 || true
}

cleanup() {
  if [[ "$SMOKE_CLEANUP" == "true" && "$owns_service" == "true" && -f "$SERVICE_SMOKE_OWNERSHIP_FILE" ]] \
    && [[ "$(cat "$SERVICE_SMOKE_OWNERSHIP_FILE")" == "$SERVICE_NAME" ]]; then
    if [[ -x "$SHIM_PATH" ]]; then
      PAPERCLIP_HOME="$DATA_DIR" "$SHIM_PATH" service uninstall --instance default >/dev/null 2>&1 || true
    fi
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "$SOURCE_SHA" ]]; then
  [[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail "source qualification requires a full source SHA"
  [[ "$PAPERCLIPAI_CLI_PATH" == /* && -f "$PAPERCLIPAI_CLI_PATH" ]] \
    || fail "source qualification requires the candidate CLI bootstrap"
fi

command -v systemctl >/dev/null 2>&1 || fail "systemctl is not available on this host"
systemctl --user show-environment >/dev/null 2>&1 \
  || fail "no user systemd session; enable lingering and export XDG_RUNTIME_DIR first"

# Refuse to smoke over a host that already has a managed install: the
# assertions below would prove nothing, and cleanup would tear down a real
# service.
if [[ "$SMOKE_FORCE" != "true" ]]; then
  if [[ -e "$SHIM_PATH" ]]; then
    fail "$SHIM_PATH already exists; set SMOKE_FORCE=true to smoke over it"
  fi
  if systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
    fail "$SERVICE_NAME is already installed; set SMOKE_FORCE=true to smoke over it"
  fi
fi

mkdir -p "$DATA_DIR"
if [[ -n "$SOURCE_SHA" ]]; then
  echo "==> Installing paperclipai from exact git source $SOURCE_SHA"
  # Use the public, supported installer to create the manifest, payload,
  # current link and real shim. A tarball-only shim would skip this contract.
  if ! PAPERCLIP_HOME="$DATA_DIR" PAPERCLIP_BUILD_COMMIT="$SOURCE_SHA" \
    timeout "$SOURCE_INSTALL_TIMEOUT_SECONDS" node "$PAPERCLIPAI_CLI_PATH" \
      install --repo paperclipai/paperclip --ref "$SOURCE_SHA" --yes; then
    fail "exact git installation exited non-zero"
  fi
  [[ -x "$SHIM_PATH" ]] || fail "no executable shim at $SHIM_PATH after exact git installation"
  onboard_command=("$SHIM_PATH")
else
  onboard_command=(npx --yes "paperclipai@${PAPERCLIPAI_VERSION}")
fi

echo "==> Onboarding with --install-service"
echo "    Data dir: $DATA_DIR"
owns_service=true
printf '%s\n' "$SERVICE_NAME" > "$SERVICE_SMOKE_OWNERSHIP_FILE"
if ! timeout "$ONBOARD_TIMEOUT_SECONDS" \
  "${onboard_command[@]}" onboard --yes --install-service --data-dir "$DATA_DIR"; then
  diagnostics
  fail "onboard exited non-zero"
fi

echo "==> Verifying the managed shim"
if [[ ! -x "$SHIM_PATH" ]]; then
  diagnostics
  fail "no executable shim at $SHIM_PATH after onboarding"
fi

echo "==> Waiting for $SERVICE_NAME to serve $HEALTH_URL"
for ((i = 1; i <= SMOKE_READY_TIMEOUT_SECONDS; i += 1)); do
  state="$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)"
  if [[ "$state" == "failed" ]]; then
    diagnostics
    fail "$SERVICE_NAME entered the failed state"
  fi
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    if [[ "$state" != "active" ]]; then
      diagnostics
      fail "$HEALTH_URL answers but $SERVICE_NAME is '$state' - something other than the service is serving"
    fi
    if [[ -n "$SOURCE_SHA" ]]; then
      service_pid="$(systemctl --user show "$SERVICE_NAME" --property=MainPID --value)"
      if ! node "$SERVICE_PROBE_PATH" --inspect-service "$SOURCE_SHA" \
        "$DATA_DIR/cli/install.json" "$SHIM_PATH" \
        "$DATA_DIR/instances/default/runtime-info.json" "$service_pid" "${HEALTH_URL%/api/health}" \
        > "$SERVICE_QUALIFICATION_RECEIPT"; then
        diagnostics
        fail "exact-source managed service qualification failed"
      fi
    fi
    echo "==> Service smoke passed: $SERVICE_NAME is active and serving $HEALTH_URL"
    exit 0
  fi
  sleep 1
done

diagnostics
fail "$HEALTH_URL not ready after ${SMOKE_READY_TIMEOUT_SECONDS}s (unit state: $(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || echo unknown))"
