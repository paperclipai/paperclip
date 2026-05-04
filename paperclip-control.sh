#!/usr/bin/env bash
#
# Lifecycle wrapper for the linkcast Paperclip instance.
#
# Layered compose: upstream `docker/docker-compose.yml` (the base, kept as
# shipped) + `paperclip-boot-linkcast.yaml` (this checkout's overlay — env,
# external volume bindings).
#
# Secret model: `.env` holds 1Password URIs (op://paperclip/...). For commands
# that need them resolved (start, restart) we wrap docker compose with `op run`,
# which fetches the secrets at invocation time and exposes them only to the
# resulting compose process — they're never written to disk and never enter the
# user's interactive shell.
#
set -euo pipefail

# All paths below are relative to the script's own directory so the script
# works regardless of the caller's cwd.
cd "$(dirname "$0")"

# ── Parse flags early so VERBOSE is available for all init messages ───────────
VERBOSE=false
while [[ "${1:-}" == -* ]]; do
  case "$1" in
    -v|--verbose) VERBOSE=true; shift ;;
    *)            echo "Unknown flag: $1" >&2
                  echo "usage: $(basename "$0") [-v|--verbose] {start|stop|restart|teardown|build|status|logs|env}" >&2
                  exit 1 ;;
  esac
done

# Direnv's prompt hook only fires in interactive shells.  When this script is
# invoked from outside the repo directory (e.g. cron, launchd, another script)
# OP_SERVICE_ACCOUNT_TOKEN won't be in the environment.  Always source .envrc
# — it's authoritative for this project and must override any token the user's
# shell may have inherited from a different 1Password account.
if [[ -f .envrc ]]; then
  $VERBOSE && echo "  Sourcing .envrc (authoritative OP_SERVICE_ACCOUNT_TOKEN for this project)"
  # shellcheck source=.envrc
  source .envrc
  export OP_SERVICE_ACCOUNT_TOKEN
fi

# `PROJECT` becomes the docker compose project name; it prefixes all container
# and network names so multiple paperclip instances (e.g. linkcast vs. a future
# SDLC instance) can coexist on one host.
PROJECT="paperclip-linkcast"

# Order matters: later files override earlier ones in compose's merge. The
# overlay must come after the upstream base.
COMPOSE_FILES=(docker/docker-compose.yml paperclip-boot-linkcast.yaml)

# If a paperclip overlay is configured, include it.
# PAPERCLIP_OVERLAY_PATH points to the paperclip/companies folder in the crew
# repo (e.g. ~/Projects/linkcast/crew/paperclip/companies). The compose overlay
# file lives one level up in the paperclip/ directory.
# We extract the value from .env manually as op run resolves secrets later.
_PAPERCLIP_OVERLAY_PATH=$(grep -E '^PAPERCLIP_OVERLAY_PATH=' .env 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
if [[ -n "${_PAPERCLIP_OVERLAY_PATH:-}" ]]; then
  _OVERLAY_COMPOSE="$(dirname "${_PAPERCLIP_OVERLAY_PATH}")/docker-compose-overlay.yaml"
  if [[ -f "${_OVERLAY_COMPOSE}" ]]; then
    COMPOSE_FILES+=("${_OVERLAY_COMPOSE}")
  fi
fi

# Build the docker-compose invocation prefix once. Every subcommand below uses
# `"${COMPOSE[@]}" ...` to inherit project name and file list.
COMPOSE=(docker compose -p "$PROJECT")
for _f in "${COMPOSE_FILES[@]}"; do COMPOSE+=(-f "$_f"); done

# `op run` needs OP_SERVICE_ACCOUNT_TOKEN.  Normally sourced from .envrc above,
# but if both direnv and .envrc are unavailable this is the hard stop.
require_op_token() {
  if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    echo "OP_SERVICE_ACCOUNT_TOKEN is not set. Can't inject secrets. Aborting." >&2
    exit 1
  fi
}

# Format a key=value pair for display, redacting sensitive values.
# Rules:
#   - op:// URIs are shown in full (they're references, not secrets)
#   - ${VAR} compose interpolation refs are shown in full
#   - Keys matching sensitive patterns get prefix••••suffix treatment
#   - Everything else is shown verbatim
# Usage: format_kv KEY VALUE [SUFFIX]
#   SUFFIX is optional trailing annotation, e.g. "  (shell)" or "  (1Password)"
format_kv() {
  local key="$1" value="$2" suffix="${3:-}"
  # Strip surrounding double quotes (common in .env files).
  value="${value#\"}"   # leading "
  value="${value%\"}"   # trailing "
  if [[ "$value" == op://* ]]; then
    echo "  ${key}=${value}${suffix:+  ${suffix}}"
  elif [[ "$value" == \$\{* ]]; then
    echo "  ${key}=${value}${suffix:+  ${suffix}}"
  else
    case "$key" in
      *SECRET*|*TOKEN*|*KEY*|*PASSWORD*|*CREDENTIAL*)
        local len=${#value}
        if (( len > 10 )); then
          echo "  ${key}=${value:0:4}••••••••${value: -4}${suffix:+  ${suffix}}"
        else
          echo "  ${key}=••••••••${suffix:+  ${suffix}}"
        fi
        ;;
      *) echo "  ${key}=${value}${suffix:+  ${suffix}}" ;;
    esac
  fi
}

# Neutralise every KEY that .env defines so the inherited shell environment
# cannot shadow values that `op run` (or compose defaults) will provide.
#
# Two modes, selected by the first argument:
#   unset  (default) — remove the variable entirely.  Used by with_secrets
#          where `op run` will inject the authoritative values.
#   stub   — export an empty string (or a non-empty dummy for vars that use
#          the :? required syntax in compose).  Used by without_secrets so
#          compose config validation passes without real secrets.
#
# Both modes prevent the user's interactive shell from leaking values into
# the compose process.
strip_dotenv_keys() {
  local mode="${1:-unset}"
  [[ -f .env ]] || return 0
  while IFS= read -r k; do
    [[ -n "$k" ]] || continue
    if [[ "$mode" == "stub" ]]; then
      $VERBOSE && echo "  Stubbing: $k"
      export "$k="
    else
      $VERBOSE && echo "  Unsetting: $k"
      unset "$k"
    fi
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env | cut -d= -f1)

  # The base compose uses ${BETTER_AUTH_SECRET:?...} which rejects empty
  # strings.  In stub mode, provide a harmless non-empty dummy.
  if [[ "$mode" == "stub" ]]; then
    export BETTER_AUTH_SECRET="unused-not-started"
  fi
}

# Pre-flight: BETTER_AUTH_SECRET must be declared (even as an op:// URI that
# `op run` will resolve later).  Without it paperclip cannot start.
require_auth_secret() {
  if ! grep -qE '^BETTER_AUTH_SECRET=' .env 2>/dev/null; then
    echo "BETTER_AUTH_SECRET is not set. Can't start paperclip. Aborting." >&2
    exit 1
  fi
}

# If GH_TOKEN is unset or empty after stripping, export a descriptive
# placeholder so compose interpolation doesn't produce a bare warning.
# Paperclip will still work but GitHub features (clone, PR, etc.) won't.
# Silent on purpose — the user-facing warning belongs on start/restart paths
# only and lives in warn_missing_gh_token below.
ensure_gh_token() {
  if [[ -z "${GH_TOKEN:-}" ]]; then
    export GH_TOKEN="Set this in .env for GitHub for paperclip to work with github"
  fi
}

# Unconditionally warn (regardless of $VERBOSE) when .env doesn't declare
# GH_TOKEN. Only called from the start/restart paths so users aren't nagged
# on stop/teardown/status/logs.
warn_missing_gh_token() {
  if ! grep -qE '^GH_TOKEN=' .env 2>/dev/null; then
    echo "  ⚠ GH_TOKEN is not configured in .env — GitHub features will be unavailable." >&2
  fi
}

# Run a docker compose subcommand with .env's op:// URIs resolved.
#
# Subtlety: `op run` resolves EVERY op:// reference it finds in the env passed
# to the child — including ones inherited from the user's shell (e.g. an
# unrelated OPENROUTER_API_KEY in .zshenv used by other tools). If any single
# resolution fails (wrong vault, wrong item, etc.) `op run` aborts before the
# child even launches.
#
# To stay isolated from the interactive shell's secrets we strip exactly the
# keys that .env defines from the inherited env right before invoking op run.
# Net effect: paperclip-managed keys come authoritatively from .env, but any
# OTHER inherited op:// refs are still resolved (and will still error loudly
# if broken — we don't want to silently mask real misconfiguration).
with_secrets() {
  require_op_token
  require_auth_secret
  warn_missing_gh_token
  strip_dotenv_keys unset
  ensure_gh_token

  # Warn about stray op:// references in the inherited shell environment that
  # are NOT declared in .env.  op run will try to resolve them and abort if the
  # service account can't access the referenced vault/item.
  local stray
  stray=$(
    env | grep -E '^[A-Z_].*=op://' | cut -d= -f1 | while read -r k; do
      grep -qE "^${k}=" .env 2>/dev/null || echo "$k"
    done || true
  )
  if [[ -n "$stray" ]]; then
    echo "  ⚠ Non-.env op:// references in shell (may cause op run to fail):" >&2
    printf '    %s\n' $stray >&2
  fi

  op run --env-file=.env -- "${COMPOSE[@]}" "$@"
}

# Run a compose subcommand that does NOT need real secret values.
# strip_dotenv_keys in stub mode exports empty strings for every .env key,
# which satisfies compose interpolation without leaking shell values.
# BETTER_AUTH_SECRET gets a non-empty dummy (handled inside strip_dotenv_keys)
# because the base compose uses the :? required-variable syntax.
without_secrets() {
  strip_dotenv_keys stub
  ensure_gh_token
  "${COMPOSE[@]}" "$@"
}

# Print which environment variables compose will inject, grouped by source file.
# Only called when VERBOSE is true.
print_env_summary() {
  $VERBOSE || return 0
  echo
  echo "Starting $PROJECT instance with environment:"
  echo "─────────────────────────────────────────────"
  if [[ -f .env ]]; then
    while IFS='=' read -r key value; do
      [[ -z "$key" ]] && continue
      format_kv "$key" "$value"
    done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env)
  else
    echo "  (.env file not found)"
  fi

  echo
  echo "Overlay files:"
  for _f in "${COMPOSE_FILES[@]}"; do echo "  $_f"; done
  echo "─────────────────────────────────────────────"
  echo
}

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") [-v|--verbose] {start|stop|restart|teardown|build|status|logs [service]|env}

  -v, --verbose  Show environment summary on start/restart and log each
                 shell variable that is unset before invoking compose.

  start     Bring the stack up in the background (resolves 1Password secrets).
  stop      Stop containers; keep them and all volumes.
  restart   stop, then start.
  teardown  docker compose down (removes containers, KEEPS volumes).
  build     Rebuild the server image (no cache reuse for app source layers).
            Run after pulling/cherry-picking changes to server or UI source.
            Does not start or restart containers — follow with `start` or
            `restart` to pick up the new image.
  status    docker compose ps.
  logs      Tail logs (optional service name).
  env       Print env diagnostics: op:// refs by source, and the env block
            that each service will receive from compose (no secret values).
EOF
  exit 1
}

# Read-only diagnostic. Three sections, each progressively closer to what the
# server container will actually see at start time:
#   1. All variables declared in .env (values redacted for sensitive keys)
#   2. Shell variables that shadow .env keys (potential conflicts)
#   3. The merged compose `environment:` block per service, with each line
#      annotated by the compose file that owns the final value.
env_diagnostics() {
  echo "=== Variables declared in .env ==="
  if [[ -f .env ]]; then
    local any=false
    while IFS='=' read -r key value; do
      [[ -z "$key" ]] && continue
      any=true
      format_kv "$key" "$value"
    done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env)
    $any || echo "  (none)"
  else
    echo "  (.env not found)"
  fi

  echo
  echo "=== Shell variables that shadow .env keys ==="
  echo "(These will be stripped by strip_dotenv_keys before compose runs.)"
  if [[ -f .env ]]; then
    local shadow_found=false
    while IFS= read -r k; do
      [[ -n "$k" ]] || continue
      local shell_val="${!k:-}"
      if [[ -n "$shell_val" ]]; then
        shadow_found=true
        format_kv "$k" "$shell_val" "(shell)"
      fi
    done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env | cut -d= -f1)
    $shadow_found || echo "  (none)"
  else
    echo "  (no .env — nothing to compare)"
  fi

  echo
  echo "=== Variables that will be set on each service ==="
  echo "(rendered with --no-interpolate; each line prefixed with the compose file"
  echo " that owns the final value. Cross-reference \${VAR} refs with the .env section above."
  echo " Caveat: an overlay restating the same value as the base is masked — it appears as"
  echo " owned by the base.)"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  jq not installed — falling back to raw merged YAML (no source attribution):"
    "${COMPOSE[@]}" config --no-interpolate 2>/dev/null
    return
  fi

  # Source attribution strategy: render `docker compose config` for each
  # CUMULATIVE prefix of COMPOSE_FILES. So with files [base, overlay] we get
  # two renders: just `base`, then `base + overlay`. By walking the renders
  # in order and noting when a (service, key) value first appears or changes,
  # we can attribute each var to the file that introduced or changed it.
  #
  # We can't render the overlay alone because docker validates each compose
  # config independently and would reject a service definition without an
  # image/build (which the overlay typically lacks).
  #
  # Limitation (the "masking" caveat above): if the overlay declares the same
  # key with the same value as the base, the value didn't change — so the
  # attribution sticks with the base. To do "last file that MENTIONED it" we'd
  # need to parse each YAML file directly; not worth the complexity here.
  {
    local i j prefix_args=()
    for ((i=0; i<${#COMPOSE_FILES[@]}; i++)); do
      prefix_args=()
      for ((j=0; j<=i; j++)); do prefix_args+=(-f "${COMPOSE_FILES[j]}"); done
      docker compose -p "$PROJECT" "${prefix_args[@]}" config --no-interpolate --format json 2>/dev/null \
        | jq --arg src "${COMPOSE_FILES[i]}" '{src: $src, services: .services}'
    done
  } | jq -s -r '
      # Compose YAML allows env blocks in two shapes:
      #   environment: { KEY: value, ... }   (mapping)
      #   environment: [ "KEY=value", ... ]  (list — kept verbatim by
      #                                       --no-interpolate when the value
      #                                       contains ${VAR} references)
      # Normalise both to a list of {key, value} pairs so the rest of the
      # pipeline can treat them uniformly.
      def env_to_pairs:
        if type == "array" then
          map(. as $e | ($e | split("=")) | {key: .[0], value: (.[1:] | join("="))})
        elif type == "object" then to_entries
        else [] end;

      # Walk each cumulative-prefix render in order. For each step, record
      # any (service, key) whose value is new or differs from what we saw at
      # the previous step — that step is the owner.
      reduce .[] as $step (
        {};
        . as $acc
        | reduce ($step.services | to_entries[]) as $svcEntry (
            $acc;
            ($svcEntry.value.environment // {} | env_to_pairs) as $vars
            | reduce $vars[] as $v (
                .;
                .[$svcEntry.key] = ((.[$svcEntry.key] // {}) |
                  if (.[$v.key].value // null) != $v.value
                  then .[$v.key] = {value: $v.value, src: $step.src}
                  else . end)
              )
          )
      )
      # Render: one block per service, vars sorted alphabetically, each line
      # prefixed with {owning compose file}.
      | (to_entries | sort_by(.key))[]
      | "[service: \(.key)]",
        ( .value
          | to_entries
          | sort_by(.key)
          | (if length == 0 then [{key:"(no environment block)", value:{value:"", src:""}}] else . end)
          | map("  {\(.value.src)} \(.key)=\(.value.value)")
          | .[] ),
        ""
    '
}

# Print the server URL after a successful start.
print_server_url() {
  local url
  url=$(grep -E '^PAPERCLIP_PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
  url="${url:-http://localhost:3100}"
  echo
  echo "  ✓ $PROJECT is running at $url"
  echo
}

# Subcommand dispatch. Only start/restart need secret resolution; the rest
# are pure docker compose pass-throughs that use `without_secrets` to satisfy
# compose's variable-required checks without needing OP_SERVICE_ACCOUNT_TOKEN.
case "${1:-}" in
  start)    print_env_summary; with_secrets up -d && print_server_url ;;
  stop)     without_secrets stop ;;
  restart)  without_secrets stop; print_env_summary; with_secrets up -d && print_server_url ;;
  teardown) without_secrets down ;;
  build)    without_secrets build server ;;
  status)   without_secrets ps ;;
  logs)     without_secrets logs -f "${@:2}" ;;
  env)      env_diagnostics ;;
  *)        usage ;;
esac
