import type { Environment } from "@paperclipai/shared";

/**
 * The managed-sandbox-only policy hides the local environment and runs every
 * agent in the managed sandbox, but no managed sandbox environment is
 * available. The Test resolution throws this error so the Test surfaces a
 * fail-closed message, the same way a real run fails closed. The Test must not
 * fall back to a local host probe, because a host probe would report a result
 * for a target the real run never uses.
 */
export class ManagedSandboxUnavailableForTestError extends Error {
  constructor() {
    super(
      "This instance runs agents only in its managed sandbox environment, but no " +
        "managed sandbox environment is available to test in. Check that the managed " +
        "sandbox provider is active, then retry the test.",
    );
    this.name = "ManagedSandboxUnavailableForTestError";
  }
}

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
 *
 * The managed-sandbox-only policy (`enableManagedSandboxOnly`) redirects a
 * resolution that lands on the local environment to the managed sandbox
 * environment, and it fails closed when no managed sandbox exists. This
 * function mirrors that redirect. A resolution that lands on the local
 * environment — the local tier, or no tier at all because the policy hides the
 * local tier — resolves to the managed sandbox environment instead. With no
 * managed sandbox environment the function throws, so the Test does not probe
 * the local host that the real run rejects. A resolution that lands on a
 * non-local environment (an agent or instance default that names an ssh or a
 * user sandbox) is untouched, because the policy hides local, it does not
 * forbid other environments.
 *
 * The policy hides the local environment from the client, so the resolved id
 * can name a local row the client cannot see (an agent default that still
 * points at the hidden local row). The `visibleEnvironmentIds` list closes that
 * gap: under the policy a resolved id that names no visible environment is the
 * hidden local row, or a stale reference, so the function redirects it to the
 * managed sandbox too. Omit the list to skip this visibility check.
 */
export function resolveAdapterTestEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null | undefined;
  instanceDefaultEnvironmentId: string | null | undefined;
  localDefaultEnvironmentId: string | null | undefined;
  managedSandboxOnly?: boolean;
  managedSandboxEnvironmentId?: string | null | undefined;
  visibleEnvironmentIds?: readonly string[] | null | undefined;
}): string | null {
  const resolved =
    input.agentDefaultEnvironmentId ||
    input.instanceDefaultEnvironmentId ||
    input.localDefaultEnvironmentId ||
    null;
  if (input.managedSandboxOnly !== true) {
    return resolved;
  }
  const localDefaultId = input.localDefaultEnvironmentId || null;
  const resolvedNamesVisibleEnvironment =
    input.visibleEnvironmentIds == null ||
    resolved === null ||
    input.visibleEnvironmentIds.includes(resolved);
  const landsOnLocal =
    resolved === null || resolved === localDefaultId || !resolvedNamesVisibleEnvironment;
  if (!landsOnLocal) {
    return resolved;
  }
  if (!input.managedSandboxEnvironmentId) {
    throw new ManagedSandboxUnavailableForTestError();
  }
  return input.managedSandboxEnvironmentId;
}

/**
 * Find the active managed sandbox environment id in an environment list. The
 * platform provisioner stamps the managed environment with
 * `metadata.managedByPaperclip` (see `isPlatformManagedEnvironment`). The
 * local-default environment also carries that stamp, so this function excludes
 * the `local` driver and returns the non-local managed environment. The function
 * selects only an `active` environment, never an `archived` one, so the Test
 * resolution matches the server run-time resolver that requires an active
 * managed sandbox (see `findManagedSandboxEnvironment`). The Test resolution
 * uses this id as the redirect target under the managed-sandbox-only policy. The
 * function returns `null` when the list holds no active managed sandbox
 * environment.
 */
export function resolveManagedSandboxEnvironmentId(
  environments: readonly Environment[] | null | undefined,
): string | null {
  if (!environments) return null;
  const managed = environments.find(
    (environment) =>
      environment.driver !== "local" &&
      environment.status === "active" &&
      environment.metadata?.managedByPaperclip === true,
  );
  return managed?.id ?? null;
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
