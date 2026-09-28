export const RUNNER_API_RESPONSE_MAX_BYTES = 1024 * 1024 * 1024;
export const RUNNER_API_RESPONSE_RUN_MAX_BYTES = 4 * RUNNER_API_RESPONSE_MAX_BYTES;
export const RUNNER_API_RESPONSE_DEADLINE_MS = 10 * 60_000;

export class RunnerApiResponseLimitError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

// Hold a slot until the temporary file is removed, including storage upload.
// These limits are per server process; the run byte budget is database-backed.
const activeByCompany = new Map<string, number>();
let active = 0;
export function acquireRunnerApiResponseSlot(companyId: string): () => void {
  const companyActive = activeByCompany.get(companyId) ?? 0;
  if (active >= 4 || companyActive >= 2) {
    throw new RunnerApiResponseLimitError("api_response_capture_busy", "Large API response capture is busy. Wait for another capture to finish before retrying a read.");
  }
  active++;
  activeByCompany.set(companyId, companyActive + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    const remaining = activeByCompany.get(companyId)! - 1;
    if (remaining) activeByCompany.set(companyId, remaining);
    else activeByCompany.delete(companyId);
  };
}
