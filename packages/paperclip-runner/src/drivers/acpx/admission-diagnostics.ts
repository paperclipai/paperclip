/** Closed startup stages, independent of provider output and credentials. */
export const ACPX_ADMISSION_CODES = {
  binding: "ACPX_ADMISSION_BINDING",
  installation: "ACPX_ADMISSION_INSTALLATION",
  sandbox: "ACPX_ADMISSION_SANDBOX",
  credential: "ACPX_ADMISSION_CREDENTIAL",
  configuration: "ACPX_ADMISSION_CONFIGURATION",
  skills: "ACPX_ADMISSION_SKILLS",
  command: "ACPX_ADMISSION_COMMAND",
  tool_bridge: "ACPX_ADMISSION_TOOL_BRIDGE",
  runtime: "ACPX_ADMISSION_RUNTIME",
  identity: "ACPX_ADMISSION_IDENTITY",
} as const;

const failures = new WeakMap<Error, keyof typeof ACPX_ADMISSION_CODES>();

/** Preserve the original error and cleanup semantics, including cancellation. */
export function recordAcpxAdmissionFailure(error: unknown, stage: keyof typeof ACPX_ADMISSION_CODES): unknown {
  if (error instanceof Error && !failures.has(error)) failures.set(error, stage);
  return error;
}

export function acpxAdmissionFailureCode(error: Error): string | undefined {
  const stage = failures.get(error);
  return stage === undefined ? undefined : ACPX_ADMISSION_CODES[stage];
}
