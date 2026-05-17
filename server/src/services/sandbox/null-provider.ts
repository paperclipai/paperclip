import { randomUUID } from "node:crypto";
import type {
  EnvironmentProbeResult,
  SandboxEnvironmentConfig,
} from "@paperclipai/shared";
import type {
  AcquireSandboxLeaseInput,
  DestroySandboxLeaseInput,
  PrepareSandboxWorkspaceInput,
  PreparedSandboxWorkspace,
  ReadSandboxLogsInput,
  ReleaseSandboxLeaseInput,
  ResumeSandboxLeaseInput,
  SandboxExecuteInput,
  SandboxExecuteResult,
  SandboxLeaseHandle,
  SandboxProvider,
  SandboxProviderCapabilityFlags,
  SandboxProviderLogsResult,
  SandboxProviderStatusSnapshot,
  SandboxProviderStreamEvent,
  SandboxProviderValidationIssue,
  SandboxProviderValidationResult,
  StartSandboxLeaseInput,
  StopSandboxLeaseInput,
  StreamSandboxEventsInput,
} from "./provider-contract.js";
import {
  PREVIEW_NO_SECRET_INJECTION,
  SandboxProviderError,
  previewSandboxProviderStatus,
  throwIfAborted,
} from "./provider-contract.js";

export const NULL_SANDBOX_PROVIDER_KEY = "null" as const;

function readReuseLease(config: SandboxEnvironmentConfig): boolean {
  return (config as { reuseLease?: unknown }).reuseLease === true;
}

function readImage(config: SandboxEnvironmentConfig): string | undefined {
  const image = (config as { image?: unknown }).image;
  return typeof image === "string" && image.trim().length > 0 ? image.trim() : undefined;
}

export class NullSandboxProvider implements SandboxProvider {
  readonly provider = NULL_SANDBOX_PROVIDER_KEY;
  readonly kind = "builtin" as const;
  readonly capabilities: SandboxProviderCapabilityFlags = {
    lease: true,
    start: false,
    exec: false,
    readLogs: true,
    streamEvents: true,
    stop: true,
    destroy: true,
  };
  readonly secretInjection = PREVIEW_NO_SECRET_INJECTION;

  status(): SandboxProviderStatusSnapshot {
    return previewSandboxProviderStatus({
      provider: this.provider,
      enabled: false,
      capabilities: this.capabilities,
      secretInjection: this.secretInjection,
    });
  }

  async validateConfig(config: SandboxEnvironmentConfig): Promise<SandboxProviderValidationResult> {
    const issues: SandboxProviderValidationIssue[] = [];
    if ((config as { provider?: unknown }).provider !== this.provider) {
      issues.push({ path: "provider", message: 'Null sandbox configs must use provider="null".' });
    }
    return {
      ok: issues.length === 0,
      summary: issues.length === 0
        ? "Null sandbox provider config is valid for no-op preview use."
        : "Null sandbox provider config is invalid.",
      issues,
      details: {
        provider: this.provider,
        previewOnly: true,
        noOp: true,
      },
      normalizedConfig: issues.length === 0
        ? { ...config, provider: this.provider, reuseLease: readReuseLease(config) }
        : undefined,
    };
  }

  async probe(config: SandboxEnvironmentConfig): Promise<EnvironmentProbeResult> {
    const validation = await this.validateConfig(config);
    return {
      ok: validation.ok,
      driver: "sandbox",
      summary: validation.ok
        ? "Null sandbox provider is available for no-op preview use."
        : validation.summary,
      details: {
        provider: this.provider,
        previewOnly: true,
        noOp: true,
        issues: validation.issues ?? [],
      },
    };
  }

  async lease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    return this.acquireLease(input);
  }

  async acquireLease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    const validation = await this.validateConfig(input.config);
    if (!validation.ok) {
      throw new SandboxProviderError("CONFIG_INVALID", validation.summary, {
        details: { issues: validation.issues ?? [] },
      });
    }
    const reusable = readReuseLease(input.config);
    const providerLeaseId = reusable
      ? `sandbox://null/${input.environmentId}`
      : `sandbox://null/${input.heartbeatRunId}/${randomUUID()}`;
    const metadata: Record<string, unknown> = {
      provider: this.provider,
      kind: "null",
      reuseLease: reusable,
      sandboxState: "requested",
      previewOnly: true,
      noOp: true,
      capabilities: {
        rootless: true,
        dropAllCapabilities: true,
        seccompProfile: "default",
        readOnlyRootfs: true,
        noNewPrivileges: true,
        cgroupsVersion: "v2",
      },
      quotas: {},
      network: {
        mode: "none",
        egressAllowlist: [],
        dnsAllowlist: [],
        allowLoopback: false,
        allowInboundPorts: [],
      },
    };
    const image = readImage(input.config);
    if (image) metadata.image = image;
    return { providerLeaseId, metadata };
  }

  async resumeLease(input: ResumeSandboxLeaseInput): Promise<SandboxLeaseHandle | null> {
    throwIfAborted(undefined);
    const validation = await this.validateConfig(input.config);
    if (!validation.ok || !input.providerLeaseId) return null;
    return {
      providerLeaseId: input.providerLeaseId,
      metadata: {
        provider: this.provider,
        kind: "null",
        reuseLease: readReuseLease(input.config),
        sandboxState: "requested",
        previewOnly: true,
        noOp: true,
        resumedLease: true,
      },
    };
  }

  async start(input: StartSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    throwIfAborted(input.signal);
    return input.lease;
  }

  async exec(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    throwIfAborted(input.signal);
    throw new SandboxProviderError(
      "EXEC_UNSUPPORTED",
      "Null sandbox provider does not execute commands.",
      { details: { provider: this.provider } },
    );
  }

  async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    return this.exec(input);
  }

  async readLogs(input: ReadSandboxLogsInput): Promise<SandboxProviderLogsResult> {
    throwIfAborted(input.signal);
    return { lines: [], nextCursor: null, truncated: false };
  }

  async *streamEvents(input: StreamSandboxEventsInput): AsyncIterable<SandboxProviderStreamEvent> {
    throwIfAborted(input.signal);
  }

  async stop(input: StopSandboxLeaseInput): Promise<void> {
    throwIfAborted(input.signal);
  }

  async destroy(input: StopSandboxLeaseInput): Promise<void> {
    throwIfAborted(input.signal);
  }

  async releaseLease(_input: ReleaseSandboxLeaseInput): Promise<void> {
    return;
  }

  async destroyLease(_input: DestroySandboxLeaseInput): Promise<void> {
    return;
  }

  matchesReusableLease(input: {
    config: SandboxEnvironmentConfig;
    lease: { providerLeaseId: string | null; metadata: Record<string, unknown> | null };
  }): boolean {
    return (
      readReuseLease(input.config) &&
      input.lease.providerLeaseId !== null &&
      input.lease.metadata?.provider === this.provider &&
      input.lease.metadata?.reuseLease === true
    );
  }

  configFromLeaseMetadata(metadata: Record<string, unknown>): SandboxEnvironmentConfig | null {
    if (metadata.provider !== this.provider) return null;
    const image = typeof metadata.image === "string" ? metadata.image : undefined;
    return image
      ? { provider: this.provider, image, reuseLease: metadata.reuseLease === true }
      : { provider: this.provider, reuseLease: metadata.reuseLease === true };
  }

  async prepareWorkspace(_input: PrepareSandboxWorkspaceInput): Promise<PreparedSandboxWorkspace> {
    return { remotePath: null, metadata: { provider: this.provider, noOp: true, previewOnly: true } };
  }
}
