/**
 * Phase 4A-S1: backend-agnostic sandbox provider contract.
 *
 * This file is intentionally data-plane agnostic. Implementations can be local
 * Docker scaffolds, managed runtimes, or no-op preview providers, but the
 * control plane always sees the same lease/start/exec/log/event/cleanup shape.
 *
 * Contract notes:
 * - validateConfig/probe are preview-safe and must not start runtimes, open
 *   network sockets, execute user commands, or leak raw secrets.
 * - acquireLease/lease must be idempotent for reusable configs when the caller
 *   supplies a reusable provider lease id; stop/destroy must be idempotent
 *   cleanup boundaries.
 * - long-running providers should honor AbortSignal where available and report
 *   cancellation as SandboxProviderError code CANCELLED.
 * - public REST/SSE/read-model surfaces must redact provider details before
 *   returning them. Providers declaring secretInjection.mode="none" must never
 *   receive raw secret bytes.
 */

import type {
  EnvironmentLeaseStatus,
  EnvironmentProbeResult,
  SandboxEnvironmentConfig,
  SandboxEnvironmentProvider,
} from "@paperclipai/shared";

export interface SandboxProviderValidationIssue {
  path: string;
  message: string;
}

export interface SandboxProviderValidationResult {
  ok: boolean;
  summary: string;
  issues?: SandboxProviderValidationIssue[];
  /** Safe, redacted provider metadata for preview/diagnostics only. */
  details?: Record<string, unknown> | null;
  normalizedConfig?: SandboxEnvironmentConfig;
}

export interface SandboxProviderCapabilityFlags {
  /** Provider can create or reuse a provider lease record. */
  lease: boolean;
  /** Provider can start a real runtime for an existing lease. */
  start: boolean;
  /** Provider can execute commands in an active runtime. */
  exec: boolean;
  /** Provider can return log slices for a runtime. */
  readLogs: boolean;
  /** Provider can expose an event stream for a runtime. */
  streamEvents: boolean;
  /** Provider can stop a runtime while preserving retained artifacts/state. */
  stop: boolean;
  /** Provider can destructively clean up runtime resources. */
  destroy: boolean;
}

export interface SandboxProviderSecretInjectionContract {
  /**
   * Transport the provider accepts for secrets. `none` means callers must not
   * pass raw secrets across the provider boundary.
   */
  mode: "none" | "environment" | "provider-secret-ref";
  /** True only if the provider boundary is allowed to receive raw secret bytes. */
  acceptsRawSecrets: boolean;
  /** True when the caller must resolve secret refs before invoking the provider. */
  requiresResolvedSecrets: boolean;
  /** Boundary where public redaction must happen. */
  redactionBoundary: "before-provider" | "provider-owned";
}

export interface SandboxProviderStatusSnapshot {
  provider: string;
  kind: "builtin";
  enabled: boolean;
  /** True for providers that cannot drive a real runtime in this phase. */
  previewOnly: boolean;
  capabilities: SandboxProviderCapabilityFlags;
  secretInjection: SandboxProviderSecretInjectionContract;
}

export type SandboxProviderErrorCode =
  | "CONFIG_INVALID"
  | "PROVIDER_DISABLED"
  | "LEASE_NOT_FOUND"
  | "START_UNSUPPORTED"
  | "EXEC_UNSUPPORTED"
  | "READ_LOGS_UNSUPPORTED"
  | "STREAM_EVENTS_UNSUPPORTED"
  | "STOP_UNSUPPORTED"
  | "DESTROY_UNSUPPORTED"
  | "CANCELLED"
  | "TIMEOUT"
  | "PROVIDER_FAILURE";

export class SandboxProviderError extends Error {
  readonly code: SandboxProviderErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;

  constructor(
    code: SandboxProviderErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = "SandboxProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }
}

export interface AcquireSandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  environmentId: string;
  heartbeatRunId: string;
  issueId: string | null;
}

export interface ResumeSandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string;
}

export interface ReleaseSandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
}

export interface DestroySandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
}

export interface PrepareSandboxWorkspaceInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface SandboxExecuteInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxLeaseHandle {
  providerLeaseId: string;
  metadata: Record<string, unknown>;
}

export interface PreparedSandboxWorkspace {
  remotePath?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SandboxExecuteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface StartSandboxLeaseInput {
  lease: SandboxLeaseHandle;
  signal?: AbortSignal;
}

export interface StopSandboxLeaseInput {
  providerLeaseId: string | null;
  reason?: string | null;
  signal?: AbortSignal;
}

export interface ReadSandboxLogsInput {
  providerLeaseId: string | null;
  tail?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export interface SandboxProviderLogLine {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface SandboxProviderLogsResult {
  lines: SandboxProviderLogLine[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface StreamSandboxEventsInput {
  providerLeaseId: string | null;
  signal?: AbortSignal;
}

export interface SandboxProviderStreamEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export const PREVIEW_NO_SECRET_INJECTION: SandboxProviderSecretInjectionContract = Object.freeze({
  mode: "none",
  acceptsRawSecrets: false,
  requiresResolvedSecrets: false,
  redactionBoundary: "before-provider",
});

export function previewSandboxProviderStatus(input: {
  provider: string;
  enabled?: boolean;
  capabilities: SandboxProviderCapabilityFlags;
  secretInjection?: SandboxProviderSecretInjectionContract;
}): SandboxProviderStatusSnapshot {
  return {
    provider: input.provider,
    kind: "builtin",
    enabled: input.enabled ?? false,
    previewOnly: true,
    capabilities: input.capabilities,
    secretInjection: input.secretInjection ?? PREVIEW_NO_SECRET_INJECTION,
  };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SandboxProviderError("CANCELLED", "Sandbox provider operation was cancelled.");
  }
}

export interface SandboxProvider {
  readonly provider: SandboxEnvironmentProvider;
  readonly kind: "builtin";
  readonly capabilities: SandboxProviderCapabilityFlags;
  readonly secretInjection: SandboxProviderSecretInjectionContract;

  status(): SandboxProviderStatusSnapshot;
  validateConfig(config: SandboxEnvironmentConfig): Promise<SandboxProviderValidationResult>;
  probe(config: SandboxEnvironmentConfig): Promise<EnvironmentProbeResult>;

  /** Canonical lease lifecycle. */
  lease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle>;
  start(input: StartSandboxLeaseInput): Promise<SandboxLeaseHandle>;
  exec(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
  readLogs(input: ReadSandboxLogsInput): Promise<SandboxProviderLogsResult>;
  streamEvents(input: StreamSandboxEventsInput): AsyncIterable<SandboxProviderStreamEvent>;
  stop(input: StopSandboxLeaseInput): Promise<void>;
  destroy(input: StopSandboxLeaseInput): Promise<void>;

  /** Backward-compatible control-plane names used by existing runtime code. */
  acquireLease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle>;
  resumeLease(input: ResumeSandboxLeaseInput): Promise<SandboxLeaseHandle | null>;
  releaseLease(input: ReleaseSandboxLeaseInput): Promise<void>;
  destroyLease(input: DestroySandboxLeaseInput): Promise<void>;

  matchesReusableLease(input: {
    config: SandboxEnvironmentConfig;
    lease: { providerLeaseId: string | null; metadata: Record<string, unknown> | null };
  }): boolean;
  configFromLeaseMetadata(metadata: Record<string, unknown>): SandboxEnvironmentConfig | null;
  prepareWorkspace?(input: PrepareSandboxWorkspaceInput): Promise<PreparedSandboxWorkspace>;
  execute?(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
}
