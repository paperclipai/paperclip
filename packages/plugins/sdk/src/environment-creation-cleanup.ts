/** Non-secret ownership evidence for an allocation whose creation failed. */
export interface PluginEnvironmentCreationCleanup {
  providerLeaseId: string;
  /** Provider ID observed with matching ownership, distinct from a provisional creation name. */
  observedProviderLeaseId?: string;
  companyId: string;
  environmentId: string;
  runId?: string;
  attemptId: string;
  accountFingerprint: string;
  labels: Record<string, string>;
}

const SCHEMA = "paperclip/environment-creation-cleanup/v1";

/** The step observed at the first acquisition failure, not its upstream cause. */
export interface PluginEnvironmentAcquisitionDiagnostic {
  phase: "create" | "workspace" | "shell" | "expiry" | "sentinel";
  /** Milliseconds from acquisition start to the first failure, before cleanup. */
  elapsedMs: number;
  budgetMs: number;
}

export function readEnvironmentAcquisitionDiagnostic(error: unknown): PluginEnvironmentAcquisitionDiagnostic | null {
  try {
    // Diagnostics never make an invalid ownership envelope usable for cleanup.
    if (!readEnvironmentCreationCleanupError(error)) return null;
    const container = error instanceof PluginEnvironmentCreationCleanupError
      ? error : (error as { data?: object }).data;
    const value = container && Object.getOwnPropertyDescriptor(container, "acquisitionDiagnostic")?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const phase = fields.phase?.value;
    const elapsedMs = fields.elapsedMs?.value;
    const budgetMs = fields.budgetMs?.value;
    if (!["create", "workspace", "shell", "expiry", "sentinel"].includes(phase as string) ||
        typeof elapsedMs !== "number" || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 604_800_000 ||
        typeof budgetMs !== "number" || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 86_400_000) return null;
    return { phase: phase as PluginEnvironmentAcquisitionDiagnostic["phase"], elapsedMs, budgetMs };
  } catch { return null; }
}

/**
 * Never serialize the provider exceptions: they may contain credentials.
 * The host persists only this explicit ownership envelope, then retries teardown.
 */
export class PluginEnvironmentCreationCleanupError extends AggregateError {
  readonly cleanup: PluginEnvironmentCreationCleanup;
  readonly acquisitionDiagnostic?: PluginEnvironmentAcquisitionDiagnostic;

  constructor(errors: unknown[], message: string, cleanup: PluginEnvironmentCreationCleanup,
    acquisitionDiagnostic?: PluginEnvironmentAcquisitionDiagnostic) {
    super(errors, message);
    this.name = "PluginEnvironmentCreationCleanupError";
    this.cleanup = cleanup;
    this.acquisitionDiagnostic = acquisitionDiagnostic;
  }
}

export function environmentCreationCleanupErrorData(error: unknown, includeAcquisitionDiagnostic = false): unknown {
  if (!(error instanceof PluginEnvironmentCreationCleanupError)) return undefined;
  const cleanup = readEnvironmentCreationCleanupError(error);
  const acquisitionDiagnostic = includeAcquisitionDiagnostic ? readEnvironmentAcquisitionDiagnostic(error) : null;
  return cleanup ? { schema: SCHEMA, cleanup, ...(acquisitionDiagnostic ? { acquisitionDiagnostic } : {}) } : undefined;
}

export function readEnvironmentCreationCleanupError(error: unknown): PluginEnvironmentCreationCleanup | null {
  const data = error instanceof PluginEnvironmentCreationCleanupError
    ? { schema: SCHEMA, cleanup: error.cleanup }
    : error && typeof error === "object" && "data" in error ? error.data : null;
  if (!data || typeof data !== "object" || !("schema" in data) || data.schema !== SCHEMA || !("cleanup" in data)) return null;
  const value = data.cleanup;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
  if (![row.providerLeaseId, row.companyId, row.environmentId, row.attemptId].every(identifier)) return null;
  if (row.runId !== undefined && !identifier(row.runId)) return null;
  if (row.observedProviderLeaseId !== undefined && !identifier(row.observedProviderLeaseId)) return null;
  if (typeof row.accountFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.accountFingerprint)) return null;
  if (!row.labels || typeof row.labels !== "object" || Array.isArray(row.labels)) return null;
  const labels = row.labels as Record<string, unknown>;
  if (Object.keys(labels).length > 16 || Object.entries(labels).some(([key, value]) => !/^paperclip-[a-z-]+$/.test(key) || !identifier(value))) return null;
  return {
    providerLeaseId: row.providerLeaseId as string,
    ...(typeof row.observedProviderLeaseId === "string" ? { observedProviderLeaseId: row.observedProviderLeaseId } : {}),
    companyId: row.companyId as string,
    environmentId: row.environmentId as string,
    ...(typeof row.runId === "string" ? { runId: row.runId } : {}),
    attemptId: row.attemptId as string,
    accountFingerprint: row.accountFingerprint,
    labels: { ...labels } as Record<string, string>,
  };
}
