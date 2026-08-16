#!/usr/bin/env bash
# Run the managed-install acceptance harnesses inside a real systemd user
# manager without mutating the host's Paperclip service or home directory.
set -euo pipefail

MODE="${1:-all}"
case "$MODE" in
  lifecycle|migration|all) ;;
  *) echo "usage: $0 [lifecycle|migration|all]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="${E2E_RESULTS_DIR:-$REPO_ROOT/install-e2e-artifacts}"
IMAGE="${E2E_SYSTEMD_IMAGE:-paperclip-install-e2e-systemd:local}"
CONTAINER_PREFIX="paperclip-install-e2e-${$}"
ACTIVE_CONTAINERS=()

mkdir -p "$RESULTS_DIR"

cleanup() {
  local container
  for container in "${ACTIVE_CONTAINERS[@]}"; do
    docker rm --force "$container" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

docker build \
  --file "$REPO_ROOT/scripts/install-e2e-systemd.Dockerfile" \
  --tag "$IMAGE" \
  "$REPO_ROOT"

run_one() {
  local mode="$1" script container transcript status=0
  case "$mode" in
    lifecycle) script="e2e-install-lifecycle.sh" ;;
    migration) script="e2e-update-migrations.sh" ;;
  esac
  container="${CONTAINER_PREFIX}-${mode}"
  transcript="$RESULTS_DIR/${mode}.log"
  ACTIVE_CONTAINERS+=("$container")

  docker run --detach \
    --name "$container" \
    --privileged \
    --cgroupns=host \
    --tmpfs /run \
    --tmpfs /run/lock \
    --volume /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --volume "$REPO_ROOT:/workspace:ro" \
    "$IMAGE" >/dev/null

  local deadline=$(( $(date +%s) + 60 )) system_state=""
  while true; do
    system_state="$(docker exec "$container" systemctl is-system-running 2>/dev/null || true)"
    case "$system_state" in running|degraded) break ;; esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      docker logs "$container" >&2 || true
      echo "systemd did not become ready in $container (state: ${system_state:-unknown})" >&2
      return 1
    fi
    sleep 1
  done

  docker exec "$container" loginctl enable-linger e2e
  docker exec "$container" systemctl start user@1000.service
  deadline=$(( $(date +%s) + 30 ))
  until docker exec "$container" test -S /run/user/1000/bus; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      docker exec "$container" systemctl status user@1000.service --no-pager >&2 || true
      echo "systemd user bus did not become ready in $container" >&2
      return 1
    fi
    sleep 1
  done
  docker exec "$container" loginctl show-user e2e -p Linger

  local docker_env=(
    --env HOME=/home/e2e
    --env USER=e2e
    --env LOGNAME=e2e
    --env XDG_RUNTIME_DIR=/run/user/1000
    --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
    --env E2E_SERVICE_TIMEOUT_SECS="${E2E_SERVICE_TIMEOUT_SECS:-300}"
  )
  if [ -n "${GH_TOKEN:-}" ]; then docker_env+=(--env GH_TOKEN); fi

  if [ "$mode" = "lifecycle" ]; then
    docker_env+=(
      --env E2E_REPO="${E2E_REPO:-paperclipai/paperclip}"
      --env E2E_REF="${E2E_REF:-master}"
      --env E2E_SKIP_NPM="${E2E_SKIP_NPM:-1}"
      --env E2E_ENABLE_LINGER=1
    )
  else
    docker_env+=(
      --env E2E_REPO="${E2E_REPO:-paperclipai/paperclip}"
      --env E2E_UPDATE_BASE_REF="${E2E_UPDATE_BASE_REF:-test/e2e-update-base}"
      --env E2E_UPDATE_NEXT_REF="${E2E_UPDATE_NEXT_REF:-test/e2e-update-next}"
    )
  fi

  set +e
  docker exec --user e2e "${docker_env[@]}" "$container" \
    bash "/workspace/scripts/$script" 2>&1 | tee "$transcript"
  status=${PIPESTATUS[0]}
  set -e

  docker exec --user e2e \
    --env HOME=/home/e2e \
    --env XDG_RUNTIME_DIR=/run/user/1000 \
    --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    "$container" journalctl --user --no-pager -u paperclipai.service \
    > "$RESULTS_DIR/${mode}-journal.log" 2>&1 || true

  local report_path
  if [ "$mode" = "migration" ]; then
    report_path="/home/e2e/.paperclip-e2e-update/instances/default/hot-restart-report.json"
  else
    report_path="/home/e2e/.paperclip/instances/default/hot-restart-report.json"
  fi
  if docker exec "$container" test -f "$report_path"; then
    docker cp "$container:$report_path" "$RESULTS_DIR/${mode}-hot-restart-report.json"
  fi

  docker rm --force "$container" >/dev/null
  ACTIVE_CONTAINERS=("${ACTIVE_CONTAINERS[@]/$container}")
  return "$status"
}

FAILED=0
if [ "$MODE" = "lifecycle" ] || [ "$MODE" = "all" ]; then
  run_one lifecycle || FAILED=1
fi
if [ "$MODE" = "migration" ] || [ "$MODE" = "all" ]; then
  run_one migration || FAILED=1
fi

exit "$FAILED"
