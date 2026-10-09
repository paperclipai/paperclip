#!/usr/bin/env bash
# Credential-free setup for an explicitly selected native Hermes campaign.
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
hermes_build_root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hermes-build.XXXXXX")"
trap 'rm -rf "$hermes_build_root"' EXIT
python3 -m venv "$hermes_build_root"
"$hermes_build_root/bin/pip" install --disable-pip-version-check --no-input uv==0.12.17
PATH="$hermes_build_root/bin:$PATH" node "$repository_root/packages/paperclip-runner/scripts/provision-hermes.mjs" \
  "$repository_root/packages/paperclip-runner/provider-assets/hermes/linux-x64"
