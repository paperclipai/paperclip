import type { RunnerE2EResult } from "./types.js";

type RunnerE2ESource = NonNullable<RunnerE2EResult["source"]>;

function nonEmpty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function workflowRunUrl(environment: NodeJS.ProcessEnv) {
  const serverUrl = nonEmpty(environment.GITHUB_SERVER_URL);
  const repository = nonEmpty(environment.GITHUB_REPOSITORY);
  const runId = nonEmpty(environment.GITHUB_RUN_ID);
  return serverUrl && repository && runId
    ? `${serverUrl}/${repository}/actions/runs/${runId}`
    : null;
}

export function resolveRunnerE2ESource(
  existing?: RunnerE2ESource | null,
  environment: NodeJS.ProcessEnv = process.env,
): RunnerE2ESource {
  return {
    sha:
      nonEmpty(environment.PAPERCLIP_RUNNER_E2E_SOURCE_SHA) ??
      nonEmpty(existing?.sha) ??
      nonEmpty(environment.GITHUB_SHA),
    ref:
      nonEmpty(environment.PAPERCLIP_RUNNER_E2E_SOURCE_REF) ??
      nonEmpty(existing?.ref) ??
      nonEmpty(environment.GITHUB_REF),
    workflowRunUrl:
      workflowRunUrl(environment) ?? nonEmpty(existing?.workflowRunUrl),
  };
}
