#!/usr/bin/env bash
set -euo pipefail

: "${DOKPLOY_API_KEY:?DOKPLOY_API_KEY is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

dokploy_url="${DOKPLOY_URL:-https://dokploy.zenova.id}"
project_name="paperclip-ci"
compose_name="paperclip-github-actions-runner"
app_name="paperclip-ci-runner"
runner_name="paperclip-dokploy-ci-1"

dokploy_get() {
  curl --silent --show-error --fail-with-body \
    --header "X-API-Key: ${DOKPLOY_API_KEY}" \
    "${dokploy_url}/api/trpc/$1"
}

dokploy_post() {
  local route="$1"
  local payload="$2"
  curl --silent --show-error --fail-with-body \
    --request POST \
    --header "X-API-Key: ${DOKPLOY_API_KEY}" \
    --header "Content-Type: application/json" \
    --data "${payload}" \
    "${dokploy_url}/api/trpc/${route}"
}

projects="$(dokploy_get project.all)"
project="$(jq -ce --arg name "${project_name}" '
  .result.data.json[] | select(.name == $name)
' <<<"${projects}" || true)"

if [[ -z "${project}" ]]; then
  project="$(dokploy_post project.create "$(jq -cn --arg name "${project_name}" --arg description "Private GitHub Actions runner for trusted Paperclip CI" '{json: {name: $name, description: $description}}')" | jq -ce '.result.data.json')"
fi

environment_id="$(jq -er '
  (.environments // [])
  | (map(select(.name == "production"))[0] // .[0])
  | .environmentId
' <<<"${project}")"

runner_token="$(curl --silent --show-error --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${GITHUB_TOKEN}" \
  --header "Accept: application/vnd.github+json" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runners/registration-token" \
  | jq -er '.token')"

compose_file="$(jq -nr --arg repo "https://github.com/${GITHUB_REPOSITORY}" --arg runner_name "${runner_name}" --arg runner_token "${runner_token}" '
"services:\n  runner:\n    image: myoung34/github-runner:2.329.0\n    restart: unless-stopped\n    environment:\n      RUN_AS_ROOT: \"false\"\n      REPO_URL: \($repo)\n      RUNNER_NAME: \($runner_name)\n      RUNNER_TOKEN: \($runner_token)\n      LABELS: \"paperclip-ci,linux,x64\"\n      RUNNER_WORKDIR: /_work\n      CONFIGURED_ACTIONS_RUNNER_FILES_DIR: /runner-config\n      UNSET_CONFIG_VARS: \"true\"\n      DISABLE_AUTO_UPDATE: \"true\"\n    volumes:\n      - runner-config:/runner-config\n      - runner-work:/_work\nvolumes:\n  runner-config:\n  runner-work:\n"
')"

compose="$(jq -ce --arg name "${compose_name}" '
  .result.data.json[]?.environments[]?.compose[]? | select(.name == $name)
' <<<"${projects}" || true)"

if [[ -z "${compose}" ]]; then
  compose="$(dokploy_post compose.create "$(jq -cn \
    --arg name "${compose_name}" \
    --arg app_name "${app_name}" \
    --arg environment_id "${environment_id}" \
    --arg compose_file "${compose_file}" \
    '{json: {name: $name, appName: $app_name, environmentId: $environment_id, composeType: "docker-compose", composeFile: $compose_file}}')" | jq -ce '.result.data.json')"
else
  compose="$(dokploy_post compose.update "$(jq -cn \
    --arg compose_id "$(jq -er '.composeId' <<<"${compose}")" \
    --arg compose_file "${compose_file}" \
    '{json: {composeId: $compose_id, sourceType: "raw", composeType: "docker-compose", composeFile: $compose_file}}')" | jq -ce '.result.data.json')"
fi

compose_id="$(jq -er '.composeId' <<<"${compose}")"
curl --silent --show-error --fail-with-body \
  --request POST \
  --header "X-API-Key: ${DOKPLOY_API_KEY}" \
  --header "Content-Type: application/json" \
  --data "$(jq -cn --arg compose_id "${compose_id}" '{composeId: $compose_id}')" \
  "${dokploy_url}/api/compose.deploy" >/dev/null

printf 'Provisioned Dokploy CI runner compose %s for %s\n' "${compose_id}" "${GITHUB_REPOSITORY}"
