export interface CleanupCheck { id: string; passed: boolean; detail: string }
export type CleanupAssertion = () => Promise<CleanupCheck[]>;

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
