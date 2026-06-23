#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  PAPERCLIP_RUNTIME_ROLE=<primary|api-only|scheduler-only|staged> \
    scripts/ops/paperclip-runtime-role-preflight.sh [--url http://127.0.0.1:3100] [--production-db-host HOST]

Checks that a runtime host declares an explicit role and that /api/health reports
the same role and expected startup controls. This script prints only sanitized
role/host/status data. It never prints DATABASE_URL or secrets.
EOF
}

url="http://127.0.0.1:3100"
production_db_host="${PAPERCLIP_PRODUCTION_DB_HOST:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      url="${2:?missing URL for --url}"
      shift 2
      ;;
    --production-db-host)
      production_db_host="${2:?missing host for --production-db-host}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

role="${PAPERCLIP_RUNTIME_ROLE:-}"
case "$role" in
  primary|api-only|scheduler-only|staged) ;;
  "")
    echo "FAIL: PAPERCLIP_RUNTIME_ROLE must be explicitly set before runtime preflight" >&2
    exit 1
    ;;
  *)
    echo "FAIL: invalid PAPERCLIP_RUNTIME_ROLE=$role" >&2
    exit 1
    ;;
esac

if [[ -n "$production_db_host" && -n "${DATABASE_URL:-}" ]]; then
  db_host="$(
    node -e 'try { const u = new URL(process.env.DATABASE_URL || ""); process.stdout.write(u.hostname); } catch { process.exit(3); }'
  )"
  if [[ "$db_host" == "$production_db_host" && -z "${PAPERCLIP_RUNTIME_ROLE:-}" ]]; then
    echo "FAIL: production DB target requires explicit PAPERCLIP_RUNTIME_ROLE" >&2
    exit 1
  fi
fi

health_json="$(curl -fsS --max-time 10 "$url/api/health")"

node - "$role" "$health_json" <<'NODE'
const expectedRole = process.argv[2];
const health = JSON.parse(process.argv[3]);
const runtime = health.runtime;
if (!runtime) {
  throw new Error("/api/health did not include runtime status");
}
if (runtime.runtimeRole !== expectedRole) {
  throw new Error(`health runtimeRole=${runtime.runtimeRole} does not match PAPERCLIP_RUNTIME_ROLE=${expectedRole}`);
}

const passiveRoles = new Set(["api-only", "staged"]);
if (passiveRoles.has(expectedRole)) {
  const unsafeEnabled = [
    "heartbeatSchedulerEnabled",
    "routineSchedulerEnabled",
    "pluginSchedulerEnabled",
    "pluginWorkersEnabled",
    "pluginAutoInstallEnabled",
    "databaseBackupSchedulerEnabled",
    "startupRecoveryEnabled",
    "startupReconciliationEnabled",
  ].filter((key) => runtime[key] === true);
  if (unsafeEnabled.length > 0) {
    throw new Error(`${expectedRole} has unsafe producers enabled: ${unsafeEnabled.join(", ")}`);
  }
  if (runtime.migrationMode !== "refuse") {
    throw new Error(`${expectedRole} must report migrationMode=refuse`);
  }
}

console.log(JSON.stringify({
  status: health.status,
  runtimeRole: runtime.runtimeRole,
  heartbeatSchedulerEnabled: runtime.heartbeatSchedulerEnabled,
  routineSchedulerEnabled: runtime.routineSchedulerEnabled,
  pluginSchedulerEnabled: runtime.pluginSchedulerEnabled,
  pluginWorkersEnabled: runtime.pluginWorkersEnabled,
  databaseBackupSchedulerEnabled: runtime.databaseBackupSchedulerEnabled,
  startupRecoveryEnabled: runtime.startupRecoveryEnabled,
  startupReconciliationEnabled: runtime.startupReconciliationEnabled,
  migrationMode: runtime.migrationMode,
}));
NODE
