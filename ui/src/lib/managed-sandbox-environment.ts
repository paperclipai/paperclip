import type { Environment } from "@paperclipai/shared";

/**
 * True iff the environment row was provisioned by the platform (the
 * managed-config environment provisioner stamps `metadata.managedByPaperclip`).
 * The server enforces the write floor on these rows — everything except env
 * vars is rejected — so the UI renders them locked instead of letting a
 * save fail at the API.
 */
export function isPlatformManagedEnvironment(
  environment: Pick<Environment, "metadata"> | null | undefined,
): boolean {
  return environment?.metadata?.managedByPaperclip === true;
}

/**
 * Display label for an environment in selectors and lists. Platform-managed
 * rows render their name alone: their name is the product name for the
 * default Paperclip environment, and the raw driver key ("sandbox") is
 * infrastructure vocabulary we don't surface next to it. User-created rows
 * keep the driver suffix so mixed lists (ssh vs sandbox) stay tellable apart.
 */
export function environmentDisplayLabel(
  environment: Pick<Environment, "name" | "driver" | "metadata">,
): string {
  if (isPlatformManagedEnvironment(environment)) return environment.name;
  return `${environment.name} · ${environment.driver}`;
}

/**
 * Client-side mirror of the server's managed-sandbox-only read filter: the
 * local environment never renders when `enableManagedSandboxOnly` is on.
 * The server already omits local rows from the environments API under the
 * same flag, so this is defense in depth for cached or stale lists.
 */
export function filterManagedSandboxSelectableEnvironments<
  T extends Pick<Environment, "driver">,
>(environments: readonly T[], managedSandboxOnly: boolean): T[] {
  return managedSandboxOnly
    ? environments.filter((environment) => environment.driver !== "local")
    : [...environments];
}
