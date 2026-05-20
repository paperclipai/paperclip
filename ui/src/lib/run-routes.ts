/** Company-level run list and detail paths (运行清单). */
export const RUN_LIST_PATH = "/runs";

export function runDetailPath(runId: string): string {
  return `${RUN_LIST_PATH}/${runId}`;
}

/** @deprecated Use {@link RUN_LIST_PATH} / {@link runDetailPath}. */
export const LEGACY_ORCHESTRATION_INJECTION_PATH = "/orchestration-injection";

/** @deprecated Use {@link runDetailPath}. */
export function legacyOrchestrationInjectionRunDetailPath(runId: string): string {
  return `${LEGACY_ORCHESTRATION_INJECTION_PATH}/runs/${runId}`;
}
