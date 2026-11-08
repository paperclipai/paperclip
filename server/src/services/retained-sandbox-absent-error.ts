/**
 * The provider confirmed that a retained sandbox no longer exists: its resume
 * reply named no provider lease and marked the lease expired. Resume never
 * acquires a replacement; callers decide what confirmed absence permits.
 */
export class RetainedSandboxAbsentError extends Error {
  constructor() {
    super("The provider confirmed the retained sandbox no longer exists. No replacement was acquired.");
    this.name = "RetainedSandboxAbsentError";
  }
}

/** A resume reply that confirms the sandbox is gone, as sandbox providers report it. */
export function resumeReplyConfirmsAbsence(reply: unknown): boolean {
  if (!reply || typeof reply !== "object") return false;
  const value = reply as { providerLeaseId?: unknown; metadata?: unknown };
  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {};
  return (value.providerLeaseId === null || value.providerLeaseId === undefined) && metadata.expired === true;
}
