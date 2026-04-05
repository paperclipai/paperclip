#!/usr/bin/env bash
set -euo pipefail

SOURCE_HOME="${SOURCE_HERMES_HOME:-${HERMES_SOURCE_HOME:-$HOME/.hermes}}"
TARGET_HOME="${TARGET_HERMES_HOME:-$(mktemp -d /tmp/hermes-smoke-home-XXXXXX)}"
WORKDIR="${HERMES_SMOKE_WORKDIR:-$(mktemp -d /tmp/hermes-skill-work-XXXXXX)}"
KEEP_HOME="${KEEP_HERMES_SMOKE_HOME:-0}"
KEEP_WORKDIR="${KEEP_HERMES_SMOKE_WORKDIR:-0}"

SKILL_IDENTIFIER="${HERMES_SMOKE_SKILL_IDENTIFIER:-executing-plans}"
SKILL_NAME="${HERMES_SMOKE_SKILL_NAME:-executing-plans}"
SKILL_PROOF_TOKEN="${HERMES_SKILL_PROOF_TOKEN:-EXECUTING_PLANS_SMOKE_OK}"
CRON_PROOF_TOKEN="${HERMES_CRON_PROOF_TOKEN:-CRON_SMOKE_OK}"

cleanup() {
  if [[ "$KEEP_HOME" != "1" ]]; then
    rm -rf "$TARGET_HOME"
  fi
  if [[ "$KEEP_WORKDIR" != "1" ]]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

copy_optional_path() {
  local source_path="$1"
  local target_path="$2"
  if [[ -e "$source_path" ]]; then
    mkdir -p "$(dirname "$target_path")"
    cp -a "$source_path" "$target_path"
  fi
}

mkdir -p "$TARGET_HOME/skills" "$TARGET_HOME/cron" "$TARGET_HOME/logs" "$TARGET_HOME/sessions"
copy_optional_path "$SOURCE_HOME/config.yaml" "$TARGET_HOME/config.yaml"
copy_optional_path "$SOURCE_HOME/.env" "$TARGET_HOME/.env"
copy_optional_path "$SOURCE_HOME/auth.json" "$TARGET_HOME/auth.json"
copy_optional_path "$SOURCE_HOME/oauth.json" "$TARGET_HOME/oauth.json"
copy_optional_path "$SOURCE_HOME/active_profile" "$TARGET_HOME/active_profile"
if [[ -d "$SOURCE_HOME/profiles" ]]; then
  rm -rf "$TARGET_HOME/profiles"
  cp -a "$SOURCE_HOME/profiles" "$TARGET_HOME/profiles"
fi

echo "Using isolated HERMES_HOME=$TARGET_HOME"
echo "Using isolated workspace=$WORKDIR"

INSTALL_OUTPUT="$(HERMES_HOME="$TARGET_HOME" hermes skills install "$SKILL_IDENTIFIER" --yes)"
printf '%s\n' "$INSTALL_OUTPUT"
HERMES_HOME="$TARGET_HOME" hermes skills list

cat >"$WORKDIR/plan.md" <<EOF
# Executing Plans Smoke Test

### Task 1: Write the proof file
- Write a file named execution-proof.txt in the current working directory.
- The file content must be exactly $SKILL_PROOF_TOKEN.
- Run cat execution-proof.txt to verify the contents.
EOF

read -r -d '' SKILL_PROMPT <<EOF || true
Use the installed $SKILL_NAME skill to execute the plan in ./plan.md.
The human pre-approved completing the whole one-task plan in a single batch.
When finished, reply with the exact contents of execution-proof.txt and nothing else.
EOF

SKILL_OUTPUT="$(
  cd "$WORKDIR"
  HERMES_HOME="$TARGET_HOME" hermes chat -q "$SKILL_PROMPT" -s "$SKILL_NAME"
)"
printf '%s\n' "$SKILL_OUTPUT"

if [[ ! -f "$WORKDIR/execution-proof.txt" ]]; then
  echo "Skill smoke failed: execution-proof.txt was not created." >&2
  exit 1
fi
if ! grep -Fxq "$SKILL_PROOF_TOKEN" "$WORKDIR/execution-proof.txt"; then
  echo "Skill smoke failed: execution-proof.txt does not contain the expected token." >&2
  exit 1
fi
if ! printf '%s\n' "$SKILL_OUTPUT" | grep -Fq "$SKILL_PROOF_TOKEN"; then
  echo "Skill smoke failed: Hermes did not echo the expected proof token." >&2
  exit 1
fi

CRON_CREATE_OUTPUT="$(
  HERMES_HOME="$TARGET_HOME" hermes cron create --name cron-smoke 30m \
    "Reply with exactly $CRON_PROOF_TOKEN and nothing else."
)"
printf '%s\n' "$CRON_CREATE_OUTPUT"

JOB_ID="$(printf '%s\n' "$CRON_CREATE_OUTPUT" | awk -F': ' '/^Created job:/ { print $2; exit }')"
if [[ -z "$JOB_ID" ]]; then
  echo "Cron smoke failed: could not parse job id." >&2
  exit 1
fi

HERMES_HOME="$TARGET_HOME" hermes cron run "$JOB_ID"
HERMES_HOME="$TARGET_HOME" hermes cron tick

LATEST_OUTPUT="$(ls -1t "$TARGET_HOME/cron/output/$JOB_ID"/*.md | head -n1)"
if [[ -z "$LATEST_OUTPUT" || ! -f "$LATEST_OUTPUT" ]]; then
  echo "Cron smoke failed: no cron output artifact was produced." >&2
  exit 1
fi

sed -n '1,200p' "$LATEST_OUTPUT"
if ! grep -Fxq "$CRON_PROOF_TOKEN" <(awk '/^## Response/{flag=1; next} flag {print}' "$LATEST_OUTPUT" | sed '/^$/d'); then
  echo "Cron smoke failed: cron output artifact does not contain the expected response token." >&2
  exit 1
fi

echo
echo "Hermes native smoke passed."
echo "  skill artifact: $WORKDIR/execution-proof.txt"
echo "  cron artifact:  $LATEST_OUTPUT"
