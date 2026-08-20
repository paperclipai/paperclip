import type { Environment } from "@paperclipai/shared";

/**
 * Which environment should an adapter "Test" probe?
 *
 * The resolution mirrors the server run-time resolution
 * (`resolveExecutionWorkspaceEnvironmentId`) across all three tiers: the
 * agent's own environment wins, otherwise the instance default, otherwise the
 * instance local-default environment. The server always resolves a run to one
 * of these three tiers, so the Test must probe the same target. Without the
 * local-default tier the Test would send no environment id and probe the
 * Paperclip host, even though a real run resolves to the local-default
 * environment. The two paths must match, so a Test result reflects a real run.
 */
export function resolveAdapterTestEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null | undefined;
  instanceDefaultEnvironmentId: string | null | undefined;
  localDefaultEnvironmentId: string | null | undefined;
}): string | null {
  return (
    input.agentDefaultEnvironmentId ||
    input.instanceDefaultEnvironmentId ||
    input.localDefaultEnvironmentId ||
    null
  );
}

/**
 * Find the instance local-default environment id in an environment list. The
 * server auto-creates one `local` driver environment and stamps it with
 * `metadata.defaultForInstance: true` (see `ensureLocalEnvironment`). The Test
 * resolution uses this id as the final tier, so it probes the same environment
 * a real run resolves to when neither an agent default nor an instance default
 * is set. The function returns `null` when the list holds no such environment.
 */
export function resolveLocalDefaultEnvironmentId(
  environments: readonly Environment[] | null | undefined,
): string | null {
  if (!environments) return null;
  const local = environments.find(
    (environment) =>
      environment.driver === "local" && environment.metadata?.defaultForInstance === true,
  );
  return local?.id ?? null;
}
