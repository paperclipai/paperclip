export interface CleanupCheck { id: string; passed: boolean; detail: string }
export type CleanupAssertion = () => Promise<CleanupCheck[]>;

export function mayAllocateRemoteResources(environment: string) {
  return environment === "daytona";
}

/** Diagnostic retention follows the final verdict, including publication errors. */
export function shouldKeepFailedDiagnostics(input: {
  enabled: boolean;
  expectedResults: number;
  results: readonly { status: string }[];
}) {
  return input.enabled && (input.results.length !== input.expectedResults ||
    input.results.some(result => result.status === "failed"));
}

/** A stopped controller does not prove remote resources were retired. Retain
 * its private recovery database whenever a cell lacks confirmed cleanup. */
export function mustPreserveRecoveryState(input: {
  processCleanupFailed: boolean;
  resourceAdmissionStarted?: boolean;
  results: readonly { cleanup: string; synthetic?: boolean }[];
}) {
  return input.processCleanupFailed || input.results.some(result => result.cleanup === "failed")
    || (input.resourceAdmissionStarted === true && (input.results.length === 0 || input.results.some(result => result.synthetic)));
}

/** Always finish every registered observer, even when an earlier proof fails. */
export async function verifyCleanupAssertions(assertions: readonly CleanupAssertion[]) {
  const checks: CleanupCheck[] = [], errors: unknown[] = [];
  for (const [index, assertion] of assertions.entries()) {
    try {
      const result = await assertion();
      if (!Array.isArray(result) || result.length === 0 || result.some(check =>
        !check || typeof check.id !== "string" || !check.id || typeof check.passed !== "boolean" || typeof check.detail !== "string")) {
        throw new Error("Cleanup assertion did not return complete checks");
      }
      checks.push(...result);
      if (result.some(check => !check.passed)) throw new Error("Cleanup assertion reported a failed check");
    } catch (error) {
      errors.push(error);
      checks.push({ id: `assertion-${index}-completed`, passed: false, detail: error instanceof Error ? error.message : "Cleanup assertion failed" });
    }
  }
  return { checks, errors };
}

/** Collect remote proof before destroying its environment, even if cancellation
 * fails. A missing proof fails qualification but never skips owned teardown. */
export async function runCleanupWithObservers(input: {
  retireRuns(): Promise<void>;
  assertions: readonly CleanupAssertion[];
  teardown(): Promise<void>;
}) {
  const errors: unknown[] = [];
  try { await input.retireRuns(); } catch (error) { errors.push(error); }
  const verification = await verifyCleanupAssertions(input.assertions);
  errors.push(...verification.errors);
  try { await input.teardown(); } catch (error) { errors.push(error); }
  return { checks: verification.checks, errors };
}
