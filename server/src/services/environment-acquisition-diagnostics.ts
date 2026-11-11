import type { PluginEnvironmentAcquisitionDiagnostic } from "@paperclipai/plugin-sdk";

type Scope = { companyId: string; environmentId: string; runId: string };
const evidence = new WeakMap<object, { scope: Scope; diagnostic: PluginEnvironmentAcquisitionDiagnostic }>();

/** The acquire RPC boundary validates the error class, ownership and diagnostic. */
export function captureEnvironmentAcquisitionDiagnostic(
  error: unknown, scope: Scope, diagnostic: PluginEnvironmentAcquisitionDiagnostic | null,
): void {
  if (!error || typeof error !== "object") return;
  // A reused error cannot carry an earlier receipt into a later invalid call.
  evidence.delete(error);
  if (diagnostic) evidence.set(error, { scope: { ...scope }, diagnostic: { ...diagnostic } });
}

/** Only the run that acquired this private receipt may report it. */
export function getEnvironmentAcquisitionDiagnostic(
  error: unknown, run: { id: string; companyId: string },
): PluginEnvironmentAcquisitionDiagnostic | null {
  const receipt = error && typeof error === "object" ? evidence.get(error) : undefined;
  return receipt && receipt.scope.runId === run.id && receipt.scope.companyId === run.companyId
    ? { ...receipt.diagnostic } : null;
}
