/**
 * Which environment should an adapter "Test" probe?
 *
 * Mirrors the server's run-time resolution
 * (`resolveExecutionWorkspaceEnvironmentId`): the agent's own environment
 * wins, otherwise the instance default, otherwise none (the server probes
 * the Paperclip host). Without the instance-default fallback, the Test
 * button probes the host for agents that rely on the instance default and
 * fails on commands that only exist inside the default environment — for
 * example a sandbox image with an extra CLI installed — even though a real
 * run would have resolved to that environment and succeeded.
 */
export function resolveAdapterTestEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null | undefined;
  instanceDefaultEnvironmentId: string | null | undefined;
}): string | null {
  return input.agentDefaultEnvironmentId || input.instanceDefaultEnvironmentId || null;
}
