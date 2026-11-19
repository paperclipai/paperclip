import { readEnvironmentResumeErrorDiagnostic } from "@paperclipai/plugin-sdk";
import { sandboxProviderFailureLabel } from "./remote-workspace-transport.js";

/**
 * Setup failure code for a preserved reusable sandbox that could not be
 * resumed before provider work began, where replacing it was not safe (see
 * `reusable-sandbox-resume-replacement.ts`). The failure is retried with the
 * bounded bootstrap budget; it never authorizes a replacement sandbox.
 */
export const REUSABLE_SANDBOX_RESUME_FAILED_CODE = "reusable_sandbox_resume_failed";

/** A reusable sandbox could not be resumed, but has not been proven lost. */
export class ReusableSandboxResumeError extends Error {
  readonly code = REUSABLE_SANDBOX_RESUME_FAILED_CODE;
  readonly provider: string;
  readonly providerLeaseId: string;

  constructor(input: {
    provider: string;
    providerLeaseId: string;
    cause?: unknown;
  }) {
    // Record why the provider refused with closed labels only. The provider
    // message stays on `cause` and off the run record.
    const failure = input.cause === undefined ? null : sandboxProviderFailureLabel(input.cause);
    // A plugin worker refusal crosses JSON-RPC with only a message and an RPC
    // code; its safe status and errno travel in the validated error envelope.
    const envelope = input.cause === undefined ? null : readEnvironmentResumeErrorDiagnostic(input.cause);
    if (failure && envelope) {
      failure.status ??= envelope.httpStatus ?? null;
      failure.code ??= envelope.errorCode ?? null;
    }
    const detail = failure
      ? ` (cause=${failure.label}${failure.status !== null ? ` status=${failure.status}` : ""}${failure.code ? ` code=${failure.code}` : ""})`
      : "";
    super(
      `Reusable sandbox lease "${input.providerLeaseId}" could not be resumed${detail}; ` +
        "the lease was preserved and no replacement was created.",
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "ReusableSandboxResumeError";
    this.provider = input.provider;
    this.providerLeaseId = input.providerLeaseId;
  }
}

/** Find a resume failure through the orchestrator's error wrappers. */
export function findReusableSandboxResumeError(error: unknown): ReusableSandboxResumeError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof ReusableSandboxResumeError) return cause;
  }
  return null;
}
